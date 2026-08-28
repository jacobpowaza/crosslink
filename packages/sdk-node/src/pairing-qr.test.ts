/**
 * What the phone camera actually sees.
 *
 * These exist because the QR once stopped being scannable while every other
 * pairing test stayed green: the host was still minting correct sessions, and
 * still rendering a correct QR — of a `crosslink://` URI, which iOS Camera has
 * no handler for and silently ignores. Nothing asserted on the *decoded*
 * payload, so nothing failed.
 *
 * So the assertions here decode the rendered matrix rather than inspect the
 * string that went into the encoder, and they state the negatives explicitly:
 * the QR must not carry a pairing id, an error code, a bare numeric code or a
 * stringified object.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unwrapBootstrapUri, parsePairingUri, filterEndpointsForOrigin } from "@crosslink/core";
import { createCrosslinkServer, type CrosslinkServer } from "./server.js";
import { MemorySecretStore } from "./keychain.js";
import { decodeQrSvg } from "../../../tests/helpers/decode-qr-svg.js";

const running: CrosslinkServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop().catch(() => {})));
});

function storageDir(): string {
  return mkdtempSync(path.join(tmpdir(), "crosslink-qr-"));
}

/** A mobile entry on disk, which is what turns the built-in bootstrap on. */
function mobileEntry(): string {
  const file = path.join(storageDir(), "mobile.html");
  writeFileSync(file, "<!doctype html><title>app</title><body>hello</body>");
  return file;
}

type ServerConfig = Parameters<typeof createCrosslinkServer>[0];

async function startServer(overrides: Partial<ServerConfig> = {}): Promise<CrosslinkServer> {
  const server = createCrosslinkServer({
    application: { id: "com.example.chat", name: "Example Chat", version: "1.0.0" },
    capabilities: [{ id: "chat.read", title: "Read messages", risk: "low" }],
    storageDir: storageDir(),
    secretStore: new MemorySecretStore(),
    security: { pairingRateLimitMs: 0 },
    pairing: { autoApprove: true },
    ...overrides
  } as ServerConfig);
  running.push(server);
  await server.start();
  return server;
}

describe("the QR a phone camera scans", () => {
  it("encodes the bootstrap URL, not the pairing URI or the code", async () => {
    const server = await startServer({
      mobile: { entry: mobileEntry() },
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "local-only"
    });

    const info = await server.getPairingCode();
    const decoded = decodeQrSvg(info.qrSvg!);

    expect(decoded).toBe(info.bootstrapUri);

    // The failures this test exists to catch, named individually so a failure
    // message says which one happened.
    expect(decoded).not.toBe(info.code);
    expect(decoded).not.toBe(info.code.replace(/\D/g, ""));
    expect(decoded).not.toBe(info.psid);
    expect(decoded).not.toMatch(/^CL-P\d+$/);
    expect(decoded).not.toBe("[object Object]");
    expect(decoded).not.toBe("");
    expect(decoded.startsWith("crosslink://")).toBe(false);
  });

  it("decodes to a URL a browser can open, carrying the pairing URI in the fragment", async () => {
    const server = await startServer({
      mobile: { entry: mobileEntry() },
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "local-only"
    });

    const info = await server.getPairingCode();
    const url = new URL(decodeQrSvg(info.qrSvg!));

    expect(["http:", "https:"]).toContain(url.protocol);
    expect(url.host).toBe("192.168.1.25:8787");
    expect(url.pathname).toBe("/");

    // The fragment keeps the payload out of request lines and server logs.
    const pair = new URLSearchParams(url.hash.slice(1)).get("pair");
    expect(pair).toBeTruthy();
    const parsed = parsePairingUri(unwrapBootstrapUri(decodeURIComponent(pair!)));
    expect(parsed.code).toBe(info.code.replace(/\D/g, ""));
    expect(parsed.endpoints?.map((endpoint) => endpoint.url)).toContain("ws://192.168.1.25:8787");
  });

  it("points at the published bootstrap when one is configured", async () => {
    const server = await startServer({
      mobile: { entry: mobileEntry() },
      pairing: { autoApprove: true, bootstrapUrl: "https://example.github.io/chat" },
      tunnelUrl: "wss://desktop.example.test",
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "auto"
    });

    const decoded = decodeQrSvg((await server.getPairingCode()).qrSvg!);
    expect(decoded.startsWith("https://example.github.io/chat#pair=")).toBe(true);
  });

  it("prefers a remote route over the LAN address, so a code minted for elsewhere reaches home", async () => {
    const server = await startServer({
      mobile: { entry: mobileEntry() },
      tunnelUrl: "https://desktop.example.test",
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "auto"
    });

    const info = await server.getPairingCode(undefined, "remote");
    const url = new URL(decodeQrSvg(info.qrSvg!));

    expect(url.origin).toBe("https://desktop.example.test");
    // The LAN route is still advertised inside the payload — it is the fastest
    // route when the phone happens to be on the same network.
    expect(info.endpoints?.some((endpoint) => endpoint.kind === "lan")).toBe(true);
    expect(info.endpoints?.some((endpoint) => endpoint.kind === "tunnel")).toBe(true);
  });

  it("keeps a usable remote route after origin filtering on an https bootstrap", async () => {
    const server = await startServer({
      mobile: { entry: mobileEntry() },
      pairing: { autoApprove: true, bootstrapUrl: "https://example.github.io/chat" },
      tunnelUrl: "wss://desktop.example.test",
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "auto"
    });

    const info = await server.getPairingCode();
    const { usable, blocked } = filterEndpointsForOrigin(
      info.endpoints ?? [],
      "https://example.github.io"
    );

    // Mixed-content filtering must remove the ws:// LAN route from an https
    // page and leave the secure remote one: a filter that removed everything
    // would produce a QR that opens a page which can never connect.
    expect(usable.length).toBeGreaterThan(0);
    expect(usable.some((endpoint) => endpoint.url.startsWith("wss://"))).toBe(true);
    expect(blocked.some((entry) => entry.endpoint.kind === "lan")).toBe(true);
  });

  it("falls back to the raw pairing URI only when there is no bootstrap page to open", async () => {
    const server = await startServer({
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "local-only"
    });

    const info = await server.getPairingCode();
    expect(info.bootstrapUri ?? null).toBeNull();
    expect(decodeQrSvg(info.qrSvg!)).toBe(info.uri);
  });

  it("changes the QR and the code together on refresh", async () => {
    const server = await startServer({
      mobile: { entry: mobileEntry() },
      lan: { enabled: true, bind: "all", host: "192.168.1.25", port: 8787 },
      networkMode: "local-only"
    });

    const first = await server.getPairingCode();
    const second = await server.getPairingCode();

    expect(second.code).not.toBe(first.code);
    expect(decodeQrSvg(second.qrSvg!)).not.toBe(decodeQrSvg(first.qrSvg!));
    expect(decodeQrSvg(second.qrSvg!)).toContain(encodeURIComponent(`c=${second.code.replace(/\D/g, "")}`));
    expect(second.expiresAt).toBeGreaterThan(Date.now());
  });
});
