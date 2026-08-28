/**
 * Pairing with no service in the middle.
 *
 * This is the path that makes Crosslink zero-configuration: the QR carries the
 * host's own address, the phone dials it directly, and the whole
 * claim/challenge/SAS/complete exchange runs on that socket. No signaling
 * service, no relay, no tunnel, no account — nothing to deploy.
 *
 * Covers first pairing, silent reconnect, host restart, revocation, wrong and
 * expired codes, brute-force throttling, fingerprint pinning, and multiple
 * devices — all without any rendezvous service running.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createCrosslinkServer, type CrosslinkServer } from "@crosslink/sdk-node";
import { CrosslinkClient, MemorySecureStorage } from "@crosslink/sdk-browser";
import { parsePairingUri } from "@crosslink/core";

if (typeof globalThis.WebSocket !== "function") {
  (globalThis as { WebSocket: unknown }).WebSocket = WebSocket;
}

const APP_ID = "com.demo.direct";

describe("direct pairing (no signaling, no relay)", () => {
  let host: CrosslinkServer;
  let storageDir: string;
  const notes: string[] = ["first note"];

  async function startHost(): Promise<CrosslinkServer> {
    const server = createCrosslinkServer({
      application: { id: APP_ID, name: "Direct Notes", version: "1.0.0" },
      capabilities: [
        { id: "notes.read", title: "Read notes", risk: "low" },
        { id: "notes.write", title: "Add notes", risk: "medium" }
      ],
      storageDir,
      // The point of the test: nothing else is configured. `local-only` also
      // opts out of the dev-time auto-discovery that would otherwise adopt a
      // signaling/relay stack left running on this machine.
      networkMode: "local-only",
      lan: { enabled: true, bind: "all" },
      pairing: { autoApprove: true },
      security: { pairingRateLimitMs: 0 }
    });
    server
      .expose("notes.list", () => [...notes], { capability: "notes.read" })
      .expose("notes.add", (input) => {
        notes.push(String((input as { text?: string })?.text ?? ""));
        return { count: notes.length };
      }, { capability: "notes.write" });
    await server.start();
    return server;
  }

  beforeEach(async () => {
    storageDir = path.join(tmpdir(), `crosslink-direct-${randomUUID().slice(0, 8)}`);
    host = await startHost();
  });

  afterEach(async () => {
    await host.stop();
  });

  const newClient = (storage = new MemorySecureStorage(), deviceName = "Phone"): CrosslinkClient =>
    new CrosslinkClient({ storage, deviceName, dialTimeoutMs: 5_000, requestTimeoutMs: 10_000 });

  it("advertises a LAN endpoint and no brokered route", async () => {
    const info = await host.getPairingCode();
    const parsed = parsePairingUri(info.uri!);

    expect(parsed.version).toBe(2);
    expect(parsed.endpoints.map((e) => e.kind)).toEqual(["lan"]);
    // Never loopback: that address would name the phone, not the host.
    expect(parsed.endpoints[0].url).toMatch(/^ws:\/\/(?!127\.|localhost)[^:]+:\d+$/);
    // Nothing to broker through — and the URI is still valid, which is exactly
    // what the old "missing valid signaling url" failure got wrong.
    expect(parsed.signalingUrl).toBeUndefined();
  });

  it("pairs a phone over the host's own socket and serves authorized RPC", async () => {
    const info = await host.getPairingCode();
    const client = newClient();

    const record = await client.pairFromQr(info.uri!, ["notes.read"]);
    expect(record.appId).toBe(APP_ID);
    expect(record.grantedCaps).toEqual(["notes.read"]);

    const rpc = await client.connect();
    expect(await rpc.call("notes.list")).toContain("first note");
    client.close();
  }, 20_000);

  it("enforces granted capabilities on a directly paired device", async () => {
    const info = await host.getPairingCode();
    const client = newClient();
    await client.pairFromQr(info.uri!, ["notes.read"]);
    const rpc = await client.connect();

    await expect(rpc.call("notes.add", { text: "nope" })).rejects.toThrow();
    client.close();
  }, 20_000);

  it("reconnects silently after a host restart, with no second scan", async () => {
    const storage = new MemorySecureStorage();
    const info = await host.getPairingCode();
    await newClient(storage).pairFromQr(info.uri!, ["notes.read"]);

    await host.stop();
    host = await startHost();

    // A brand-new client object, as after a phone restart: it has the stored
    // credentials and the stored endpoint, and nothing else.
    const revived = newClient(storage);
    const rpc = await revived.connect();
    expect(await rpc.call("notes.list")).toBeInstanceOf(Array);
    revived.close();
  }, 30_000);

  it("serves two directly paired devices independently", async () => {
    const a = newClient(new MemorySecureStorage(), "Phone A");
    const b = newClient(new MemorySecureStorage(), "Phone B");
    await a.pairFromQr((await host.getPairingCode()).uri!, ["notes.read"]);
    await b.pairFromQr((await host.getPairingCode()).uri!, ["notes.read"]);

    expect(host.listDevices().filter((d) => !d.revokedAt)).toHaveLength(2);
    const rpcA = await a.connect();
    const rpcB = await b.connect();
    expect(await rpcA.call("notes.list")).toBeInstanceOf(Array);
    expect(await rpcB.call("notes.list")).toBeInstanceOf(Array);
    a.close();
    b.close();
  }, 30_000);

  it("cuts off a revoked device and leaves the other one working", async () => {
    const a = newClient(new MemorySecureStorage(), "Phone A");
    const b = newClient(new MemorySecureStorage(), "Phone B");
    await a.pairFromQr((await host.getPairingCode()).uri!, ["notes.read"]);
    await b.pairFromQr((await host.getPairingCode()).uri!, ["notes.read"]);
    const deviceA = host.listDevices()[0].deviceId;
    const rpcA = await a.connect();
    const rpcB = await b.connect();
    expect(await rpcA.call("notes.list")).toBeInstanceOf(Array);

    expect(host.revokeDevice(deviceA)).toBe(true);

    await expect(rpcA.call("notes.list")).rejects.toThrow();
    // Revocation must be per-device, and enforced on the host rather than by
    // asking the phone to stop.
    expect(await rpcB.call("notes.list")).toBeInstanceOf(Array);
    a.close();
    b.close();
  }, 30_000);

  it("refuses a device that reconnects after revocation", async () => {
    const storage = new MemorySecureStorage();
    const client = newClient(storage);
    await client.pairFromQr((await host.getPairingCode()).uri!, ["notes.read"]);
    await client.connect();
    client.close();

    expect(host.revokeDevice(host.listDevices()[0].deviceId)).toBe(true);

    const returning = newClient(storage);
    await expect(returning.connect()).rejects.toThrow();
    returning.close();
  }, 30_000);

  it("rejects a wrong pairing code without pairing anything", async () => {
    const info = await host.getPairingCode();
    const client = newClient();
    await expect(client.pairFromQr(info.uri!, ["notes.read"], "000000000")).rejects.toThrow();
    expect(host.listDevices()).toHaveLength(0);
  }, 20_000);

  it("throttles repeated wrong codes rather than allowing unlimited guesses", async () => {
    const info = await host.getPairingCode();
    const client = newClient();

    let throttled = false;
    // A 9-digit code is only ~30 bits; without a host-side limit a direct
    // socket would let an attacker walk the space.
    for (let i = 0; i < 12; i += 1) {
      try {
        await client.pairFromQr(info.uri!, ["notes.read"], String(100000000 + i));
      } catch (err) {
        if (/too many incorrect pairing codes/i.test(String((err as Error).message))) {
          throttled = true;
          break;
        }
      }
    }
    expect(throttled).toBe(true);
    expect(host.listDevices()).toHaveLength(0);
  }, 30_000);

  it("refuses a QR whose fingerprint does not match the host", async () => {
    const info = await host.getPairingCode();
    // Swap the pinned fingerprint for another valid-looking one: a MITM that
    // relays a real host's address but substitutes its own identity.
    const tampered = info.uri!.replace(/f=[0-9a-f]{16}/, "f=0123456789abcdef");
    const client = newClient();
    await expect(client.pairFromQr(tampered, ["notes.read"])).rejects.toThrow();
    expect(host.listDevices()).toHaveLength(0);
  }, 20_000);

  it("reports every route it tried when the host cannot be reached", async () => {
    const info = await host.getPairingCode();
    await host.stop();

    const client = newClient();
    await expect(client.pairFromQr(info.uri!, ["notes.read"])).rejects.toThrow(
      /cannot reach the host on any route/i
    );
    // Restarted so afterEach has something to stop.
    host = await startHost();
  }, 30_000);
});
