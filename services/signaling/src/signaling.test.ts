import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSignalingServer, type SignalingServer } from "./index.js";
import { createHash } from "node:crypto";
import WebSocket from "ws";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

function until(ws: WebSocket, op: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${op}`)), 5000);
    const onMsg = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.op === op) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(msg);
      }
    };
    ws.on("message", onMsg);
    ws.on("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`closed ${code} waiting for ${op}`));
    });
  });
}

describe("signaling service", () => {
  let signaling: SignalingServer;
  let base: string;

  beforeAll(async () => {
    signaling = await createSignalingServer({ port: 0 });
    base = `ws://127.0.0.1:${signaling.port}`;
  });

  afterAll(async () => {
    await signaling.close();
  });

  it("routes pairing blobs between host and client via hashed codes", async () => {
    const hostWs = new WebSocket(base);
    await new Promise((r) => hostWs.once("open", r));

    void hostWs.send(
      JSON.stringify({
        op: "host_hello",
        app: {
          appId: "com.test.app",
          name: "Test App",
          fingerprint: "f".repeat(64),
          pubEdB64: "aGVsbG8",
          pubXB64: "aGVsbG8y",
          versions: ["1.0"]
        }
      })
    );
    await until(hostWs, "host_ok");

    const psid = "psid-1";
    const code = "483 921 004";
    // Production hosts hash the digit-only form (server.ts strips spaces).
    hostWs.send(JSON.stringify({ op: "pair_open", psid, code_hash: sha256Hex(code.replace(/\D/g, "")), ttl_ms: 5000 }));

    // presence visible over HTTP
    const res = await fetch(`http://127.0.0.1:${signaling.port}/apps/com.test.app`);
    expect(res.status).toBe(200);
    const app = (await res.json()) as { appId: string };
    expect(app.appId).toBe("com.test.app");

    const clientWs = new WebSocket(base);
    await new Promise((r) => clientWs.once("open", r));
    clientWs.send(JSON.stringify({ op: "pair_resolve", code }));
    const found = await until(clientWs, "pair_found");
    expect(found.psid).toBe(psid);

    // host receives the client's claim blob addressed to it
    const deliverPromise = until(hostWs, "pair_deliver");
    clientWs.send(
      JSON.stringify({
        op: "pair_payload",
        to: found.host_conn,
        blob: JSON.stringify({ kind: "pair_claim", hello: "host" })
      })
    );
    const delivered = await deliverPromise;
    expect(JSON.parse(delivered.blob as string)).toMatchObject({ kind: "pair_claim" });
    const waiterConn = delivered.from as string;

    // ...and the host's reply reaches the client
    const replyPromise = until(clientWs, "pair_deliver");
    hostWs.send(
      JSON.stringify({
        op: "pair_payload",
        to: waiterConn,
        blob: JSON.stringify({ kind: "pair_challenge" })
      })
    );
    const reply = await replyPromise;
    expect(JSON.parse(reply.blob as string)).toMatchObject({ kind: "pair_challenge" });

    // unknown codes are refused
    clientWs.send(JSON.stringify({ op: "pair_resolve", code: "000 000 000" }));
    await until(clientWs, "pair_not_found");

    hostWs.close();
    clientWs.close();
  });

  it("rejects oversized blobs", async () => {
    const hostWs = new WebSocket(base);
    await new Promise((r) => hostWs.once("open", r));
    hostWs.send(
      JSON.stringify({
        op: "pair_payload",
        to: "nobody",
        blob: "x".repeat(17 * 1024)
      })
    );
    const err = await until(hostWs, "error");
    expect(err.error).toMatchObject({ code: "payload_too_large" });
    hostWs.close();
  });
});

describe("signaling service limits", () => {
  let signaling: SignalingServer;
  let base: string;

  afterEach(async () => {
    await signaling.close();
  });

  it("rejects connections past the per-IP concurrent-connection cap", async () => {
    signaling = await createSignalingServer({ port: 0, maxConnectionsPerIp: 2 });
    base = `ws://127.0.0.1:${signaling.port}`;

    const a = new WebSocket(base);
    const b = new WebSocket(base);
    await Promise.all([
      new Promise((r) => a.once("open", r)),
      new Promise((r) => b.once("open", r))
    ]);

    const c = new WebSocket(base);
    const closeCode = await new Promise<number>((resolve) => {
      c.once("close", (code) => resolve(code));
      c.once("open", () => {
        /* if it opens, wait for the close the server should still send */
      });
    });
    expect(closeCode).toBe(4429);

    a.close();
    b.close();
  });

  it("frees a connection's per-IP slot once it closes", async () => {
    signaling = await createSignalingServer({ port: 0, maxConnectionsPerIp: 1 });
    base = `ws://127.0.0.1:${signaling.port}`;

    const a = new WebSocket(base);
    await new Promise((r) => a.once("open", r));
    a.close();
    await new Promise((r) => a.once("close", r));

    // The slot must be released - a second connection from the same IP
    // should now be allowed rather than permanently locked out.
    const b = new WebSocket(base);
    await new Promise((resolve, reject) => {
      b.once("open", resolve);
      b.once("close", (code) => reject(new Error(`unexpectedly rejected with ${code}`)));
    });
    b.close();
  });

  it("disconnects a connection after repeated rate-limit violations", async () => {
    signaling = await createSignalingServer({
      port: 0,
      rateLimitViolationsBeforeClose: 1
    });
    base = `ws://127.0.0.1:${signaling.port}`;

    const ws = new WebSocket(base);
    await new Promise((r) => ws.once("open", r));

    // Each `hb` message is cheap and legal; sending far more than the
    // window allows should still eventually close the connection.
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    for (let i = 0; i < 400; i++) {
      if (ws.readyState !== WebSocket.OPEN) break;
      ws.send(JSON.stringify({ op: "hb" }));
    }
    const code = await closed;
    expect(code).toBe(4429);
  });

  it("rejects pair_open past the per-host pairing-session cap", async () => {
    signaling = await createSignalingServer({ port: 0, maxPairsPerHost: 2 });
    base = `ws://127.0.0.1:${signaling.port}`;

    const hostWs = new WebSocket(base);
    await new Promise((r) => hostWs.once("open", r));
    hostWs.send(
      JSON.stringify({
        op: "host_hello",
        app: {
          appId: "com.test.capped",
          name: "Capped App",
          fingerprint: "f".repeat(64),
          pubEdB64: "aGVsbG8",
          pubXB64: "aGVsbG8y",
          versions: ["1.0"]
        }
      })
    );
    await until(hostWs, "host_ok");

    hostWs.send(JSON.stringify({ op: "pair_open", psid: "p1", code_hash: sha256Hex("111111111"), ttl_ms: 5000 }));
    hostWs.send(JSON.stringify({ op: "pair_open", psid: "p2", code_hash: sha256Hex("222222222"), ttl_ms: 5000 }));
    hostWs.send(JSON.stringify({ op: "pair_open", psid: "p3", code_hash: sha256Hex("333333333"), ttl_ms: 5000 }));

    const err = await until(hostWs, "error");
    expect(err.error).toMatchObject({ code: "capacity_exceeded" });
    hostWs.close();
  });
});
