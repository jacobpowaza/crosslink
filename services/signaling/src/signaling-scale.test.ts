import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHash } from "node:crypto";
import {
  createSignalingServer,
  type BackplaneDelivery,
  type DistributedPair,
  type DistributedPresence,
  type PresenceInfo,
  type SignalingBackplane,
  type SignalingServer
} from "./index.js";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

interface SharedHub {
  presence: Map<string, DistributedPresence<PresenceInfo>>;
  pairs: Map<string, DistributedPair<PresenceInfo>>;
  subscribers: Map<string, (delivery: BackplaneDelivery) => void>;
}

class MemoryBackplane implements SignalingBackplane<PresenceInfo> {
  readonly kind = "test-memory";
  constructor(private readonly hub: SharedHub) {}
  connect(): Promise<void> { return Promise.resolve(); }
  putPresence(appId: string, value: DistributedPresence<PresenceInfo>): Promise<void> {
    this.hub.presence.set(appId, value);
    return Promise.resolve();
  }
  getPresence(appId: string): Promise<DistributedPresence<PresenceInfo> | null> {
    return Promise.resolve(this.hub.presence.get(appId) ?? null);
  }
  listPresence(): Promise<Array<DistributedPresence<PresenceInfo>>> {
    return Promise.resolve([...this.hub.presence.values()]);
  }
  deletePresence(appId: string, route: string): Promise<void> {
    if (this.hub.presence.get(appId)?.route === route) this.hub.presence.delete(appId);
    return Promise.resolve();
  }
  putPair(codeHash: string, value: DistributedPair<PresenceInfo>): Promise<void> {
    this.hub.pairs.set(codeHash, value);
    return Promise.resolve();
  }
  getPair(codeHash: string): Promise<DistributedPair<PresenceInfo> | null> {
    return Promise.resolve(this.hub.pairs.get(codeHash) ?? null);
  }
  publish(nodeId: string, delivery: BackplaneDelivery): Promise<void> {
    this.hub.subscribers.get(nodeId)?.(delivery);
    return Promise.resolve();
  }
  subscribe(nodeId: string, onDelivery: (delivery: BackplaneDelivery) => void): Promise<void> {
    this.hub.subscribers.set(nodeId, onDelivery);
    return Promise.resolve();
  }
  close(): Promise<void> { return Promise.resolve(); }
}

function until(ws: WebSocket, op: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${op}`)), 5000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.op !== op) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

describe("distributed signaling backplane", () => {
  const servers: SignalingServer[] = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it("resolves and routes an opaque pairing exchange across two nodes", async () => {
    const hub: SharedHub = {
      presence: new Map(),
      pairs: new Map(),
      subscribers: new Map()
    };
    const west = await createSignalingServer({
      port: 0,
      nodeId: "west",
      region: "us-west",
      backplane: new MemoryBackplane(hub)
    });
    const east = await createSignalingServer({
      port: 0,
      nodeId: "east",
      region: "us-east",
      backplane: new MemoryBackplane(hub)
    });
    servers.push(west, east);

    const host = new WebSocket(`ws://127.0.0.1:${west.port}`);
    await new Promise((resolve) => host.once("open", resolve));
    host.send(JSON.stringify({
      op: "host_hello",
      app: {
        appId: "com.scale.test",
        name: "Scale Test",
        fingerprint: "f".repeat(64),
        pubEdB64: "ZWQ",
        pubXB64: "eA",
        versions: ["1.0"]
      }
    }));
    expect((await until(host, "host_ok")).conn).toMatch(/^west\//);

    const code = "483921004";
    host.send(JSON.stringify({
      op: "pair_open",
      psid: "distributed-pair",
      code_hash: sha256Hex(code),
      ttl_ms: 5000
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const client = new WebSocket(`ws://127.0.0.1:${east.port}`);
    await new Promise((resolve) => client.once("open", resolve));
    client.send(JSON.stringify({ op: "pair_resolve", code }));
    const found = await until(client, "pair_found");
    expect(found).toMatchObject({ psid: "distributed-pair" });
    expect(found.host_conn).toMatch(/^west\//);

    const hostDelivery = until(host, "pair_deliver");
    client.send(JSON.stringify({ op: "pair_payload", to: found.host_conn, blob: "claim" }));
    const delivered = await hostDelivery;
    expect(delivered.blob).toBe("claim");
    expect(delivered.from).toMatch(/^east\//);

    const clientDelivery = until(client, "pair_deliver");
    host.send(JSON.stringify({ op: "pair_payload", to: delivered.from, blob: "challenge" }));
    expect(await clientDelivery).toMatchObject({ blob: "challenge" });

    const presence = await fetch(`http://127.0.0.1:${east.port}/apps/com.scale.test`);
    expect(presence.status).toBe(200);
    expect(await presence.json()).toMatchObject({ appId: "com.scale.test" });

    host.close();
    client.close();
  });
});
