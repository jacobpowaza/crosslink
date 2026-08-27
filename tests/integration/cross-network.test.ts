/**
 * Cross-network integration: real signaling service, real relay service, real
 * Node host, real browser clients — with LAN disabled throughout, so nothing
 * here can accidentally succeed because the two ends happen to share a
 * network. This is the "paired device, different network" path.
 *
 * Covers: two devices relayed at once, a token-protected relay, a device
 * paired on one run reconnecting on a later one, host restart, and the
 * permission policy applying across the whole stack.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSignalingServer, type SignalingServer } from "@crosslink/signaling";
import { createRelayServer, type RelayServer } from "@crosslink/relay";
import {
  createCrosslinkServer,
  MemorySecretStore,
  type CrosslinkServer
} from "@crosslink/sdk-node";
import { CrosslinkClient, MemorySecureStorage } from "@crosslink/sdk-browser";

if (typeof globalThis.WebSocket !== "function") {
  (globalThis as { WebSocket: unknown }).WebSocket = WebSocket;
}

const RELAY_TOKEN = "relay-shared-secret";
const SIGNALING_TOKEN = "signaling-shared-secret";
const APP_ID = "com.demo.crossnet";

const CAPABILITIES = [
  { id: "notes.read", title: "Read notes", risk: "low" as const, defaultGranted: true },
  { id: "notes.write", title: "Write notes", risk: "medium" as const },
  { id: "notes.purge", title: "Delete everything", risk: "high" as const }
];

describe("cross-network connectivity", () => {
  let signaling: SignalingServer;
  let relay: RelayServer;
  let host: CrosslinkServer;
  let storageDir: string;
  const secretStore = new MemorySecretStore();
  const notes: string[] = ["welcome"];

  const signalingUrl = (): string => `http://127.0.0.1:${signaling.port}`;
  const relayUrl = (): string => `http://127.0.0.1:${relay.port}`;

  async function startHost(): Promise<CrosslinkServer> {
    const server = createCrosslinkServer({
      application: { id: APP_ID, name: "Cross Network Notes", version: "1.0.0" },
      capabilities: CAPABILITIES,
      storageDir,
      signalingUrl: signalingUrl(),
      relayUrl: relayUrl(),
      relayToken: RELAY_TOKEN,
      signalingToken: SIGNALING_TOKEN,
      // The whole point: no shared network between host and clients.
      lan: { enabled: false },
      secretStore,
      permissions: { maxAutoGrantRisk: "medium" },
      pairing: { autoApprove: true }
    });
    server
      .expose("notes.list", () => [...notes], { capability: "notes.read" })
      .expose(
        "notes.add",
        (input) => {
          notes.push(String((input as { text?: string })?.text ?? ""));
          return { count: notes.length };
        },
        { capability: "notes.write" }
      )
      .expose("notes.purge", () => ({ purged: true }), { capability: "notes.purge" })
      .expose("whoami", (_input, ctx) => ({ deviceId: ctx.deviceId }));
    await server.start();
    return server;
  }

  /** Pairs a fresh browser client through signaling, exactly as a phone would. */
  async function pairNewClient(
    requestedCaps: string[]
  ): Promise<{ client: CrosslinkClient; storage: MemorySecureStorage }> {
    const storage = new MemorySecureStorage();
    const client = new CrosslinkClient({
      storage,
      deviceName: `Device ${randomUUID().slice(0, 4)}`,
      onConfirmPairing: () => true,
      requestTimeoutMs: 10_000
    });
    const info = await host.getPairingCode();
    expect(info.uri).toBeTruthy();
    await client.pairFromQr(info.uri!, requestedCaps);
    return { client, storage };
  }

  beforeAll(async () => {
    signaling = await createSignalingServer({ port: 0, authToken: SIGNALING_TOKEN });
    relay = await createRelayServer({ port: 0, authToken: RELAY_TOKEN });
    storageDir = path.join(tmpdir(), `crosslink-xnet-${randomUUID().slice(0, 8)}`);
    host = await startHost();
    // Give the signaling registration a moment to land before pairing.
    await new Promise((r) => setTimeout(r, 200));
  }, 30_000);

  afterAll(async () => {
    await host?.stop();
    await relay?.close();
    await signaling?.close();
  });

  it("brings the host online over relay and signaling with no LAN listener", () => {
    const status = host.status() as {
      transports: { lan: unknown; relay: unknown; signaling: { online: boolean } };
    };
    expect(status.transports.lan).toBeNull();
    expect(status.transports.relay).toBeTruthy();
    expect(status.transports.signaling.online).toBe(true);
  });

  it("pairs and calls a host on another network", async () => {
    const { client } = await pairNewClient(["notes.read", "notes.write"]);
    const rpc = await client.connect();

    expect(await rpc.call("notes.list")).toContain("welcome");
    expect(await rpc.call("notes.add", { text: "from afar" })).toMatchObject({ count: 2 });
    expect(client.state).toBe("crosslink-relayed");

    client.close();
  }, 30_000);

  it("serves two paired devices over the same relay channel at once", async () => {
    // A single-client relay channel would refuse the second device outright,
    // which is exactly the failure this multiplexing exists to prevent.
    const first = await pairNewClient(["notes.read"]);
    const second = await pairNewClient(["notes.read"]);

    const rpcA = await first.client.connect();
    const rpcB = await second.client.connect();

    const [whoA, whoB] = await Promise.all([
      rpcA.call<{ deviceId: string }>("whoami"),
      rpcB.call<{ deviceId: string }>("whoami")
    ]);

    expect(whoA.deviceId).toBe(first.client.deviceId);
    expect(whoB.deviceId).toBe(second.client.deviceId);
    expect(whoA.deviceId).not.toBe(whoB.deviceId);

    // Both remain usable; neither displaced the other.
    expect(await rpcA.call("notes.list")).toBeInstanceOf(Array);
    expect(await rpcB.call("notes.list")).toBeInstanceOf(Array);

    first.client.close();
    second.client.close();
  }, 40_000);

  it("keeps one device working when another disconnects", async () => {
    const stayer = await pairNewClient(["notes.read"]);
    const leaver = await pairNewClient(["notes.read"]);

    const rpcStay = await stayer.client.connect();
    await leaver.client.connect();

    leaver.client.close();
    await new Promise((r) => setTimeout(r, 300));

    expect(await rpcStay.call("notes.list")).toBeInstanceOf(Array);
    stayer.client.close();
  }, 40_000);

  it("applies the permission policy to a device on another network", async () => {
    const { client } = await pairNewClient(["notes.read", "notes.purge"]);
    const rpc = await client.connect();

    // notes.purge is high risk: auto-approval must never hand it over.
    expect(client.listApps()[0].grantedCaps).toEqual(["notes.read"]);
    await expect(rpc.call("notes.purge")).rejects.toMatchObject({
      code: "capability_denied"
    });

    client.close();
  }, 30_000);

  it("lets a previously paired device reconnect in a fresh client instance", async () => {
    // The device restarting (a browser reload) must not require re-pairing.
    const { storage } = await pairNewClient(["notes.read"]);
    const revived = new CrosslinkClient({ storage, requestTimeoutMs: 10_000 });

    const rpc = await revived.connect();
    expect(await rpc.call("notes.list")).toBeInstanceOf(Array);

    revived.close();
  }, 30_000);

  it("keeps devices paired across a host restart", async () => {
    const { storage } = await pairNewClient(["notes.read"]);
    const pairedCount = host.listDevices().length;

    await host.stop();
    host = await startHost();
    await new Promise((r) => setTimeout(r, 500));

    expect(host.listDevices()).toHaveLength(pairedCount);

    // The relay channel is re-allocated on restart, so the client must pick up
    // the new one from presence rather than dialling the dead channel.
    const revived = new CrosslinkClient({ storage, requestTimeoutMs: 10_000 });
    const rpc = await revived.connect();
    expect(await rpc.call("notes.list")).toBeInstanceOf(Array);
    revived.close();
  }, 60_000);

  it("cuts off a device revoked while it is connected from another network", async () => {
    const { client } = await pairNewClient(["notes.read"]);
    const rpc = await client.connect();
    expect(await rpc.call("notes.list")).toBeInstanceOf(Array);

    host.revokeDevice(client.deviceId);

    await new Promise((r) => setTimeout(r, 500));
    expect(host.grantedCapabilities(client.deviceId)).toEqual([]);
    client.close();
  }, 30_000);
});

describe("relay and signaling refuse an unauthenticated host", () => {
  let signaling: SignalingServer;
  let relay: RelayServer;

  beforeAll(async () => {
    signaling = await createSignalingServer({ port: 0, authToken: SIGNALING_TOKEN });
    relay = await createRelayServer({ port: 0, authToken: RELAY_TOKEN });
  });

  afterAll(async () => {
    await relay?.close();
    await signaling?.close();
  });

  it("refuses to start a host with no relay token", async () => {
    // A private relay must not be usable by anyone who learns its URL.
    const server = createCrosslinkServer({
      application: { id: "com.demo.unauthorized", name: "No Token" },
      storageDir: path.join(tmpdir(), `crosslink-noauth-${randomUUID().slice(0, 8)}`),
      relayUrl: `http://127.0.0.1:${relay.port}`,
      lan: { enabled: false },
      secretStore: new MemorySecretStore()
    });

    await expect(server.start()).rejects.toThrow(/auth token/i);
  }, 20_000);
});
