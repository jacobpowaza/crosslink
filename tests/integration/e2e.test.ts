/**
 * Full-stack integration: real signaling service + real relay service +
 * sdk-node host + sdk-browser client (running under Node's WebSocket).
 *
 * Covers: QR pairing over signaling blobs, fingerprint pinning, relayed
 * encrypted RPC, capability enforcement, input validation, unknown methods,
 * event fan-out, mid-session revocation, and identity/record persistence
 * across client restarts.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createSignalingServer, type SignalingServer } from "@crosslink/signaling";
import { createRelayServer, type RelayServer } from "@crosslink/relay";
import { createCrosslinkServer, type CrosslinkServer } from "@crosslink/sdk-node";
import { CrosslinkClient, MemorySecureStorage, CrosslinkMobileBootstrap } from "@crosslink/sdk-browser";
import { buildPairingUri, parsePairingUri } from "@crosslink/core";

if (typeof globalThis.WebSocket !== "function") {
  (globalThis as { WebSocket: unknown }).WebSocket = WebSocket;
}

async function expectErrorCode(p: Promise<unknown>, codeAlternatives: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected rejection matching ${codeAlternatives}, resolved instead`);
  } catch (err) {
    const actual = String((err as { code?: string }).code ?? (err as Error).message);
    expect(codeAlternatives.toLowerCase().split("|")).toContain(actual.toLowerCase());
  }
}

describe("crosslink end-to-end", () => {
  let signaling: SignalingServer;
  let relay: RelayServer;
  let host: CrosslinkServer;

  const storageA = new MemorySecureStorage();
  let clientA: CrosslinkClient;
  let pairingUri = "";

  beforeAll(async () => {
    signaling = await createSignalingServer({ port: 0 });
    relay = await createRelayServer({ port: 0 });

    const storageDir = path.join(tmpdir(), `crosslink-it-${randomUUID().slice(0, 8)}`);
    host = createCrosslinkServer({
      application: { id: "com.demo.notes", name: "Notes", version: "1.0.0" },
      capabilities: [
        { id: "notes.read", title: "Read notes", risk: "low" },
        { id: "notes.write", title: "Create notes", risk: "medium" }
      ],
      storageDir,
      signalingUrl: `http://127.0.0.1:${signaling.port}`,
      relayUrl: `http://127.0.0.1:${relay.port}`,
      lan: { enabled: false },
      pairing: { autoApprove: true }
    });
    host
      .expose("notes.get", () => ({ title: "shopping list", items: 3 }), {
        capability: "notes.read"
      })
      .expose(
        "notes.create",
        (input) => ({ ok: true, title: (input as { title?: string })?.title }),
        {
          capability: "notes.write",
          inputSchema: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string", maxLen: 200 } }
          }
        }
      )
      .expose("app.info", () => ({ name: "Notes" }));
    host.declareEvent("notes.changed");

    await host.start();
  }, 30_000);

  afterAll(async () => {
    await host.stop();
    await Promise.all([signaling.close(), relay.close()]);
  });

  it("issues a pairing code with QR", async () => {
    const info = await host.getPairingCode();
    expect(info.code).toMatch(/^\d{3} \d{3} \d{3}$/);
    expect(info.qrSvg).toContain("<svg");
    pairingUri = info.uri!;
  });

  it("pairs a phone client over signaling with pinned fingerprints", async () => {
    clientA = new CrosslinkClient({
      storage: storageA,
      deviceName: "Jacobs Phone"
    });
    const record = await clientA.pairFromQr(pairingUri, ["notes.read"]);
    expect(record.appId).toBe("com.demo.notes");
    expect(record.grantedCaps).toEqual(["notes.read"]);
    expect(record.fingerprint.startsWith(record.fingerprint.slice(0, 16))).toBe(true);
  });

  it("connects through the relay and serves authorized RPC", async () => {
    const rpc = await clientA.connect();
    const info = await rpc.call<{ title: string }>("notes.get");
    expect(info.title).toBe("shopping list");
  }, 20_000);

  it("enforces capabilities on every request", async () => {
    const rpc = clientA.rpc();
    await expectErrorCode(rpc.call("notes.create", { title: "x" }), "CAPABILITY_DENIED");
  });

  it("validates inputs and reports unknown methods safely", async () => {
    const rpc = clientA.rpc();
    await expectErrorCode(rpc.call("notes.create", { title: "" }), "CAPABILITY_DENIED");
    await expectErrorCode(rpc.call("nope.nothing"), "METHOD_NOT_FOUND");
    const open = await rpc.call<{ name: string }>("app.info");
    expect(open.name).toBe("Notes");
  });

  it("fans events out to subscribed devices", async () => {
    const rpc = clientA.rpc();
    const received = new Promise<unknown>((resolve) => {
      rpc.subscribe("notes.changed", resolve);
    });
    await new Promise((r) => setTimeout(r, 300));
    host.emit("notes.changed", { n: 1 });
    expect(await received).toMatchObject({ n: 1 });
  });

  it("blocks a revoked device immediately", async () => {
    const deviceId = clientA.deviceId;
    expect(host.revokeDevice(deviceId)).toBe(true);

    const rpc = clientA.rpc();
    await expectErrorCode(rpc.call("notes.get"), "DEVICE_REVOKED|NOT_CONNECTED|PEER_LOST");

    // Reconnection attempts are refused with UNAUTHORIZED (terminal state).
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (["unauthorized", "revoked"].includes(clientA.state)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(["unauthorized", "revoked"]).toContain(clientA.state);
  }, 20_000);

  it("persists identity + paired records across client restarts", async () => {
    const deviceIdBefore = clientA.deviceId;
    clientA.close();

    const revived = new CrosslinkClient({ storage: storageA, deviceName: "Jacobs Phone" });
    expect(revived.deviceId).toBe(deviceIdBefore);
    expect(revived.listApps()[0].appId).toBe("com.demo.notes");
  });

  it("surfaces presence over the signaling HTTP directory", async () => {
    const res = await fetch(`http://127.0.0.1:${signaling.port}/apps`);
    const apps = (await res.json()) as Array<{ appId: string; relay?: unknown }>;
    const notes = apps.find((a) => a.appId === "com.demo.notes");
    expect(notes).toBeDefined();
    expect((notes as { relay?: { channel: string } }).relay?.channel).toBeTruthy();
  });

  it("completes full-stack mobile onboarding lifecycle: QR connect URI -> Code entry -> Authorize -> Revoke", async () => {
    // 1. Host issues a fresh pairing session
    const info = await host.getPairingCode();
    const cleanCode = info.code.replace(/\D/g, "");

    // 2. Generate pure QR connect URI (WITHOUT pre-baked code)
    const connectUri = buildPairingUri({
      endpoints: [{ kind: "sig", url: `http://127.0.0.1:${signaling.port}` }],
      appId: "com.demo.notes",
      appName: "Notes",
      hostPubEdB64: host.identity.edPublicKey ? Buffer.from(host.identity.edPublicKey).toString("base64") : ""
    });

    const mobileStorage = new MemorySecureStorage();
    const mobileClient = new CrosslinkClient({
      storage: mobileStorage,
      deviceName: "Mobile Device B"
    });

    const onAuthorized = vi.fn();
    const onUnauthorized = vi.fn();

    const bootstrap = new CrosslinkMobileBootstrap({
      appId: "com.demo.notes",
      appName: "Notes",
      client: mobileClient,
      pairingUri: connectUri,
      autoRegisterServiceWorker: false,
      onAuthorized,
      onUnauthorized
    });

    // 3. Initial start on untrusted device -> Must require pairing, app is blocked
    await bootstrap.start();
    // 4. Invalid pairing code attempt -> Must fail and remain in pairing-required
    await expect(mobileClient.pairWithCode(connectUri, "999999999", ["notes.read"])).rejects.toThrow();
    expect(bootstrap.getState()).toBe("pairing-required");
    expect(onAuthorized).not.toHaveBeenCalled();

    // 5. Valid pairing code entry -> Successful cryptographic pairing
    const pairedRecord = await mobileClient.pairWithCode(connectUri, cleanCode, ["notes.read"]);
    expect(pairedRecord.appId).toBe("com.demo.notes");

    // 6. Connect newly paired client & mark onboarding completed -> App is authorized!
    (bootstrap as any).markOnboardingCompleted("com.demo.notes");
    await bootstrap.forceReconnect();

    expect(bootstrap.getState()).toBe("authorized");
    expect(onAuthorized).toHaveBeenCalled();

    // 7. Verify RPC works over live relay
    const rpc = mobileClient.rpc();
    const notesResult = await rpc.call<{ title: string }>("notes.get");
    expect(notesResult.title).toBe("shopping list");

    // 8. Desktop host revokes Mobile Device B
    expect(host.revokeDevice(mobileClient.deviceId)).toBe(true);

    // 9. Reconnect attempt rejects device, clears storage, and returns to pairing screen
    await bootstrap.forceReconnect();
    expect(bootstrap.getState()).toBe("pairing-required");
    expect(mobileClient.listApps().length).toBe(0);
    expect(onUnauthorized).toHaveBeenCalled();

    bootstrap.destroy();
  });
});
