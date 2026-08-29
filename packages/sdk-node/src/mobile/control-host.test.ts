// The Crosslink system endpoints the pairing card consumes. Two things matter:
// the card gets what it needs without the application writing a route, and the
// surface refuses anything that is not this machine — it mints pairing codes
// and revokes trust, so reachability from the network would be the whole
// security model undone.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import { createRequire } from "node:module";
import { createControlHandler, isLoopbackRequest, type ControlHostView } from "./control-host.js";
import type { PairingCodeInfo, DeviceSummary } from "../server.js";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as { JSDOM: any };

const devices: DeviceSummary[] = [
  { deviceId: "phone-1", name: "iPhone", caps: ["notes.read"], addedAt: 1, lastSeen: Date.now() },
  { deviceId: "gone", name: "Old", caps: [], addedAt: 1, revokedAt: 2 }
];

let server: http.Server;
let origin: string;
let mode = "auto";
let revoked: string[] = [];
let emit: ((event: { type: "pairing-invalidated" }) => void) | null = null;
let failNext: Error | null = null;
let failNextMode: Error | null = null;

const view: ControlHostView = {
  async getPairingCode(_ip, requested): Promise<PairingCodeInfo> {
    if (failNext) {
      const err = failNext;
      failNext = null;
      throw err;
    }
    return {
      code: "123456789",
      expiresAt: 1234,
      uri: "crosslink://pair?x=1",
      qrSvg: "<svg/>",
      psid: "psid-1",
      endpoints: [{ kind: "lan", url: `ws://192.168.1.5:8787?m=${requested}` }]
    };
  },
  async setNetworkMode(next) {
    if (failNextMode) {
      const err = failNextMode;
      failNextMode = null;
      throw err;
    }
    mode = next;
  },
  listDevices: () => devices,
  revokeDevice: (id) => {
    revoked.push(id);
    return true;
  },
  bootstrapOrigin: () => "https://example.github.io",
  application: () => ({
    id: "com.example.notes",
    name: "Example Notes",
    icon: "/icon-192.png",
    accentColor: "#f97316",
    backgroundColor: "#101014"
  }),
  remoteNote: () => null,
  onHostEvent: (listener) => {
    emit = listener as typeof emit;
    return () => {
      emit = null;
    };
  }
};

beforeAll(async () => {
  const handler = createControlHandler(view);
  server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Crosslink control surface", () => {
  it("mints a pairing session in the shape the card renders", async () => {
    const res = await fetch(`${origin}/__crosslink/pairing`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("123456789");
    expect(body.qrSvg).toBe("<svg/>");
    expect(body.endpoints[0].kind).toBe("lan");
    expect(body.networkMode).toBe("auto");
    // The card needs the URL the QR encodes for its "open here" fallback.
    expect(body.bootstrapUrl).toContain("https://example.github.io");
    // …and the application's identity, so the desktop page does not restate
    // the name, icon and colours the host was already configured with.
    expect(body.application).toMatchObject({
      id: "com.example.notes",
      name: "Example Notes",
      icon: "/icon-192.png",
      accentColor: "#f97316"
    });
  });

  it("applies a requested connection mode before minting", async () => {
    const res = await fetch(`${origin}/__crosslink/pairing?mode=local-only`);
    const body = await res.json();
    expect(mode).toBe("local-only");
    expect(body.networkMode).toBe("local-only");
    expect(body.endpoints[0].url).toContain("m=local-only");
  });

  it("rejects an unknown connection mode instead of guessing", async () => {
    const res = await fetch(`${origin}/__crosslink/network-mode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "sideways" })
    });
    expect(res.status).toBe(400);
  });

  it("maps a rate limit to 429 so the card can say what happened", async () => {
    failNext = new Error("pairing code rate limit exceeded; please wait 3s");
    const res = await fetch(`${origin}/__crosslink/pairing`);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("rate limit");
  });

  it("maps an unreachable-remote failure to 409", async () => {
    failNext = new Error("remote access could not be established: no reachable endpoint");
    const res = await fetch(`${origin}/__crosslink/pairing`);
    expect(res.status).toBe(409);
  });

  it("maps a failed mode change to a coded status instead of a dead request", async () => {
    // Applying a mode asks the router for a mapping and can be refused. That
    // used to escape the handler, so the widget saw a transport-level failure
    // and could only render an unknown fault beside its QR.
    failNextMode = new Error("remote access could not be established: no reachable endpoint");
    const res = await fetch(`${origin}/__crosslink/pairing?mode=remote`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("remote access");
    mode = "auto";
  });

  it("lists only devices that still have trust", async () => {
    const res = await fetch(`${origin}/__crosslink/devices`);
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].deviceId).toBe("phone-1");
    expect(body.devices[0].status).toBe("Online");
  });

  it("revokes a device", async () => {
    revoked = [];
    const res = await fetch(`${origin}/__crosslink/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "phone-1" })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deviceId: "phone-1" });
    expect(revoked).toEqual(["phone-1"]);
  });

  it("streams the events that tell the card its code went stale", async () => {
    const res = await fetch(`${origin}/__crosslink/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    await reader.read(); // the stream preamble

    await vi.waitFor(() => {
      if (!emit) throw new Error("not subscribed yet");
    });
    emit!({ type: "pairing-invalidated" });
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: crosslink.pairing-invalidated");
    await reader.cancel();
  });

  it("serves a widget bundle whose pairing card has no attribution footer", async () => {
    const res = await fetch(`${origin}/__crosslink/widget.js`);
    expect(res.status).toBe(200);
    const bundle = await res.text();
    const dom = new JSDOM('<!doctype html><div id="pairCardContainer"></div>', {
      url: origin,
      runScripts: "outside-only"
    });
    const sdk = dom.window.eval(`${bundle}\n;CrosslinkSDK;`) as typeof import("@crosslink/sdk-browser");
    expect(sdk?.createPairingCard).toBeTypeOf("function");

    const card = sdk!.createPairingCard({
      target: "#pairCardContainer",
      source: false,
      code: "123456789",
      qr: "<svg/>",
      status: "Waiting for a device to scan"
    });

    expect(card.element.textContent).not.toContain("Powered by Crosslink");
    expect(card.element.textContent).not.toContain("End-to-end encrypted with crosslink");
    expect(card.element.querySelector(".cl-pair-attribution")).toBeNull();
    expect(card.element.querySelector(".cl-powered-by-crosslink")).toBeNull();
    expect(card.element.querySelector(".cl-crosslink-attribution-footer")).toBeNull();
    expect(card.element.lastElementChild?.className).toContain("cl-pair-right");
    dom.window.close();
  });

  it("falls through to the application for anything outside its own routes", async () => {
    const handler = createControlHandler(view, {
      fallback: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("application route");
      }
    });
    const app = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const appOrigin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    expect(await (await fetch(`${appOrigin}/api/notes`)).text()).toBe("application route");
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });
});

describe("control surface is loopback-only", () => {
  const request = (remoteAddress: string): http.IncomingMessage =>
    ({ socket: { remoteAddress } }) as unknown as http.IncomingMessage;

  it("accepts this machine, including the dual-stack form of IPv4 loopback", () => {
    expect(isLoopbackRequest(request("127.0.0.1"))).toBe(true);
    expect(isLoopbackRequest(request("::1"))).toBe(true);
    // What a dual-stack listener reports for an IPv4 loopback connection;
    // refusing it would break the desktop UI on common configurations.
    expect(isLoopbackRequest(request("::ffff:127.0.0.1"))).toBe(true);
  });

  it("refuses a peer on the network", () => {
    expect(isLoopbackRequest(request("192.168.1.83"))).toBe(false);
    expect(isLoopbackRequest(request("203.0.113.10"))).toBe(false);
  });

  it("answers 403 rather than minting a code for a non-loopback peer", async () => {
    const handler = createControlHandler(view);
    const res = {
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: "",
      setHeader(k: string, v: string) {
        this.headers[k] = v;
      },
      writeHead(status: number) {
        this.statusCode = status;
        return this;
      },
      end(body: string) {
        this.body = body;
      }
    };
    await handler(
      {
        url: "/__crosslink/pairing",
        method: "GET",
        headers: {},
        socket: { remoteAddress: "192.168.1.99" }
      } as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("only answers requests from this machine");
  });
});
