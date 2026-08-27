import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
