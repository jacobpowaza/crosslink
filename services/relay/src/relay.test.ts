import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelayServer, type RelayServer } from "./index.js";
import WebSocket from "ws";

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) =>
    ws.once("open", resolve).once("error", reject)
  );
}

function nextOp(ws: WebSocket, op: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting ${op}`)), 5000);
    ws.on("message", function handler(raw: WebSocket.RawData, isBinary: boolean) {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.op === op) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    });
  });
}

function nextBinary(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting binary")), 5000);
    ws.on("message", function handler(raw: WebSocket.RawData, isBinary: boolean) {
      if (!isBinary) return;
      clearTimeout(timer);
      ws.off("message", handler);
      resolve(raw as Buffer);
    });
  });
}

async function createChannel(base: string): Promise<{ channel_id: string; token: string }> {
  const res = await fetch(`${base}/channels`, { method: "POST" });
  expect(res.status).toBe(201);
  return (await res.json()) as { channel_id: string; token: string };
}

describe("relay service", () => {
  let relay: RelayServer;
  let base: string;

  beforeAll(async () => {
    relay = await createRelayServer({ port: 0, maxFrameBytes: 1024 });
    base = `http://127.0.0.1:${relay.port}`;
  });

  afterAll(async () => {
    await relay.close();
  });

  it("pipes opaque frames between host and client", async () => {
    const { channel_id: channelId, token } = await createChannel(base);

    // Attach all message expectations BEFORE opening sockets: the server
    // announces synchronously on connection and early frames would otherwise
    // be missed.
    const host = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=h&token=${token}`);
    const hostReady = nextOp(host, "host_ready");
    await waitOpen(host);
    await hostReady;

    const client = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=c`);
    const hostSeesClient = nextOp(host, "peer_up");
    const clientSeesPipe = nextOp(client, "peer_up");
    await waitOpen(client);
    await Promise.all([hostSeesClient, clientSeesPipe]);

    const got = nextBinary(host);
    client.send(new Uint8Array([1, 2, 3]), { binary: true });
    expect([...await got]).toEqual([1, 2, 3]);

    const got2 = nextBinary(client);
    host.send(new Uint8Array([9, 8]), { binary: true });
    expect([...await got2]).toEqual([9, 8]);

    // stats see volume but never content
    const stats = relay.stats();
    expect(stats.bytesRelayed).toBeGreaterThanOrEqual(5);

    client.close();
    await nextOp(host, "peer_down");
    host.close();
  });

  it("rejects hosts with bad tokens and second clients while busy", async () => {
    const { channel_id: channelId, token } = await createChannel(base);
    expect(token).not.toBe("");

    const evilHost = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=h&token=wrong`);
    await new Promise((resolve) => evilHost.once("close", resolve));

    const client = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=c`);
    await waitOpen(client);

    const busy = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=c`);
    await new Promise((resolve) => busy.once("close", resolve));

    client.close();
  });

  it("enforces frame size limits", async () => {
    const { channel_id: channelId, token } = await createChannel(base);
    const host = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=h&token=${token}`);
    await waitOpen(host);
    const client = new WebSocket(`ws://127.0.0.1:${relay.port}/ws?channel=${channelId}&role=c`);
    await waitOpen(client);

    // The oversized frame makes `ws` raise on both ends. Absorb those before
    // sending, or the receiver's RangeError surfaces as an unhandled
    // exception and Vitest reports it against whichever test is running.
    host.on("error", () => {});
    client.on("error", () => {});

    client.send(new Uint8Array(2000), { binary: true }); // > maxFrameBytes 1024
    const closedCode = await new Promise<number>((resolve) =>
      client.once("close", (code) => resolve(code))
    );
    // ws library pre-empts with 1009 (message too big); our guard uses 4409.
    expect([1009, 4409]).toContain(closedCode);
    host.close();
  });
});
