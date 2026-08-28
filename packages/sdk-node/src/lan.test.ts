import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { isOriginAllowed, startLanListener, type LanListener } from "./lan.js";
import type { CrosslinkTransport } from "@crosslink/core";

const running: LanListener[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((l) => l.close()));
});

async function listener(
  opts: Partial<Parameters<typeof startLanListener>[0]> = {}
): Promise<{ lan: LanListener; base: string; connections: CrosslinkTransport[] }> {
  const connections: CrosslinkTransport[] = [];
  const lan = await startLanListener({
    port: 0,
    bind: "loopback",
    onConnection: (t) => connections.push(t),
    ...opts
  });
  running.push(lan);
  return { lan, base: `ws://127.0.0.1:${lan.port}`, connections };
}

function onceClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
}

describe("LAN listener limits", () => {
  it("rejects an oversized pre-auth frame without crashing the server", async () => {
    const { base, connections } = await listener({ preAuthMaxPayloadBytes: 64 });

    const ws = new WebSocket(base);
    await new Promise((r) => ws.once("open", r));
    const closed = onceClose(ws);
    ws.send("x".repeat(200));
    const code = await closed;
    expect(code).toBe(4409);

    // The server must still work for the next, well-behaved connection.
    const ws2 = new WebSocket(base);
    await new Promise((r) => ws2.once("open", r));
    ws2.send("small");
    await new Promise((r) => setTimeout(r, 50));
    expect(connections.length).toBe(2);
    ws2.close();
  });

  it("enforces the concurrent-connection cap", async () => {
    const { base } = await listener({ maxConnections: 1 });

    const a = new WebSocket(base);
    await new Promise((r) => a.once("open", r));

    const b = new WebSocket(base);
    const code = await onceClose(b);
    expect(code).toBe(4429);

    a.close();
  });

  it("reaps a connection that never completes a handshake", async () => {
    const { base } = await listener({ handshakeTimeoutMs: 60, keepaliveIntervalMs: 20 });

    const ws = new WebSocket(base);
    await new Promise((r) => ws.once("open", r));
    const closed = onceClose(ws);
    // Deliberately send nothing.
    const code = await closed;
    // ws.terminate() tears the socket down without a clean closing
    // handshake, so the client observes an abnormal-closure code.
    expect(code).toBe(1006);
  });

  it("does not reap an established connection that stays within idle timeout", async () => {
    const { base } = await listener({
      handshakeTimeoutMs: 50,
      idleTimeoutMs: 5000,
      keepaliveIntervalMs: 20
    });

    const ws = new WebSocket(base);
    await new Promise((r) => ws.once("open", r));
    ws.send("hello");
    // Give the handshake-timeout sweep several chances to fire; it must not,
    // since this connection already sent its first frame.
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("closes cleanly so no interval keeps the process alive", async () => {
    const { lan } = await listener({ keepaliveIntervalMs: 20 });
    await lan.close();
    running.length = 0; // already closed
  });

  it("refuses a WebSocket from a third-party browser origin", async () => {
    const { base } = await listener({});
    const ws = new WebSocket(base, { origin: "https://evil.example" });
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", (err) => resolve(String((err as Error).message)));
    });
    expect(outcome).not.toBe("open");
    expect(outcome).toMatch(/403/);
  });

  it("accepts a WebSocket whose origin is the listener itself", async () => {
    const { base } = await listener({});
    const origin = base.replace(/^ws/, "http");
    const ws = new WebSocket(base, { origin });
    await new Promise((r) => ws.once("open", r));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects instead of killing the process when the port is already taken", async () => {
    const { lan } = await listener({});
    // `ws` re-emits the HTTP server's error on the WebSocketServer; an 'error'
    // event with no listener is an unhandled throw, which used to take the
    // whole process down before a caller could fall back to another port.
    await expect(
      startLanListener({ port: lan.port, bind: "loopback", onConnection: () => {} })
    ).rejects.toMatchObject({ code: "EADDRINUSE" });

    // And the fallback a caller would then take still works.
    const fallback = await startLanListener({ port: 0, bind: "loopback", onConnection: () => {} });
    running.push(fallback);
    expect(fallback.port).toBeGreaterThan(0);
  });

  describe("isOriginAllowed", () => {
    it("allows a request with no Origin at all", () => {
      // Native and CLI clients send none; its absence proves nothing either way.
      expect(isOriginAllowed(undefined, "192.168.1.50:8100", new Set())).toBe(true);
    });

    it("allows an origin that matches the Host being connected to", () => {
      expect(
        isOriginAllowed("http://192.168.1.50:8100", "192.168.1.50:8100", new Set())
      ).toBe(true);
    });

    it("refuses a different origin, port included", () => {
      expect(isOriginAllowed("http://192.168.1.50:9999", "192.168.1.50:8100", new Set())).toBe(false);
      expect(isOriginAllowed("https://evil.example", "192.168.1.50:8100", new Set())).toBe(false);
    });

    it("allows an origin that is another address this same host advertises", () => {
      // The bootstrap page a phone installs is fetched over the public address,
      // then opens a socket on the LAN one. Cross-origin by the letter of the
      // rule, and exactly what is supposed to happen.
      expect(
        isOriginAllowed(
          "http://203.0.113.9:58930",
          "192.168.1.83:58930",
          new Set(["http://192.168.1.83:58930", "http://203.0.113.9:58930"])
        )
      ).toBe(true);
    });

    it("matches an advertised address regardless of scheme", () => {
      expect(
        isOriginAllowed("https://app.example", "192.168.1.50:8100", new Set(["http://app.example"]))
      ).toBe(true);
    });

    it("allows an origin the host explicitly opted into", () => {
      expect(
        isOriginAllowed("https://app.example", "192.168.1.50:8100", new Set(["https://app.example"]))
      ).toBe(true);
    });

    it("refuses a malformed origin rather than guessing", () => {
      expect(isOriginAllowed("not a url", "192.168.1.50:8100", new Set())).toBe(false);
    });
  });
});
