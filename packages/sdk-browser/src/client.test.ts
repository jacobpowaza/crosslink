/**
 * Browser SDK tests against a mocked transport layer.
 *
 * Nothing here touches a socket: a `MockSocket` pair stands in for the
 * signaling websocket and for the relay pipe, with a real `HostPairingManager`
 * and a real `HostAcceptor` on the far side. That means the pairing dance, the
 * fingerprint pin, capability enforcement, RPC dispatch and reconnect are
 * exercised end to end while every failure is produced on purpose.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, bytesToBase64 } from "@crosslink/protocol";
import {
  CapabilityRegistry,
  DeviceGrants,
  DeviceIdentity,
  HostAcceptor,
  HostPairingManager,
  InMemoryHostDeviceStore,
  MemoryLogSink,
  RpcRouter,
  buildPairingUri,
  type CrosslinkSession
} from "@crosslink/core";
import { CrosslinkClient, type PairingConfirmRequest } from "./client.js";
import { MockSocket } from "./mock-ws.js";
import { MemorySecureStorage } from "./storage.js";
import { wsTransport, type WsLike } from "./ws.js";

/* ------------------------------------------------------------------ */
/* a host reachable over mock sockets                                  */
/* ------------------------------------------------------------------ */

const SIGNALING_URL = "https://signal.test";
const RELAY_URL = "https://relay.test";
const APP_ID = "com.example.notes";

function makeHost(options: { policy?: ConstructorParameters<typeof HostPairingManager>[0]["policy"] } = {}) {
  const identity = DeviceIdentity.create();
  const store = new InMemoryHostDeviceStore();
  const grants = new DeviceGrants();
  const registry = new CapabilityRegistry().registerAll([
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
    { id: "notes.write", title: "Write notes", risk: "medium" }
  ]);

  const router = new RpcRouter(() => grants, { ratePerSec: 1000 }, { registry });
  router
    .expose("notes.list", () => ["alpha", "beta"], { capability: "notes.read" })
    .expose("notes.create", (p) => ({ created: true, input: p }), { capability: "notes.write" })
    .expose("echo", (p) => p)
    .declareEvent("notes.changed");

  const pairing = new HostPairingManager({
    identity,
    appId: APP_ID,
    registry,
    store,
    grants,
    autoApprove: true,
    policy: options.policy ?? { maxAutoGrantRisk: "medium" }
  });

  const sessions: CrosslinkSession[] = [];
  const accept = (socket: MockSocket): void => {
    let active: CrosslinkSession | undefined;
    new HostAcceptor(
      wsTransport(socket, "crosslink-relayed"),
      { identity, appId: APP_ID, lookupDevice: (id) => store.get(id) },
      {
        onMessage: (msg, session) => router.handleMessage(session, msg),
        onSession: (session) => {
          active = session;
          sessions.push(session);
        },
        onClose: () => {
          if (active) router.handleSessionClosed(active);
        }
      }
    );
  };

  return { identity, store, grants, registry, router, pairing, accept, sessions };
}

/**
 * Stands in for the signaling service on the far end of a socket pair: routes
 * opaque pairing blobs between the client and a real HostPairingManager,
 * exactly as the real service does, without ever seeing key material.
 */
function attachSignaling(
  serviceSocket: MockSocket,
  host: ReturnType<typeof makeHost>,
  overrides: { fingerprint?: string; notFound?: boolean } = {}
): void {
  const hostConn = "host-conn-1";

  serviceSocket.addEventListener("message", (ev) => {
    const msg = JSON.parse(String((ev as { data: unknown }).data)) as Record<string, unknown>;
    const reply = (frame: object): void => {
      if (serviceSocket.readyState === 1) serviceSocket.send(JSON.stringify(frame));
    };

    if (msg.op === "pair_resolve") {
      if (overrides.notFound) {
        reply({ op: "pair_not_found" });
        return;
      }
      const psid = host.pairing.resolveCode(String(msg.code));
      if (!psid) {
        reply({ op: "pair_not_found" });
        return;
      }
      reply({
        op: "pair_found",
        psid,
        host_conn: hostConn,
        app: {
          appId: APP_ID,
          name: "Notes",
          fingerprint: overrides.fingerprint ?? host.identity.fingerprint,
          pubEdB64: bytesToBase64(host.identity.edPublicKey),
          pubXB64: bytesToBase64(host.identity.xPublicKey),
          relay: { url: RELAY_URL, channel: "chan-1" }
        }
      });
      return;
    }

    if (msg.op === "pair_payload") {
      const blob = JSON.parse(String(msg.blob)) as Record<string, unknown>;
      const deliver = (frame: object): void =>
        reply({ op: "pair_deliver", from: hostConn, blob: JSON.stringify(frame) });
      if (blob.kind === "pair_claim") {
        void host.pairing.handleClaim(blob, deliver);
      } else if (blob.kind === "pair_complete") {
        try {
          host.pairing.handleComplete(blob, deliver);
        } catch {
          /* handleComplete already replied pair_error */
        }
      }
    }
  });
}

interface Harness {
  client: CrosslinkClient;
  host: ReturnType<typeof makeHost>;
  pairingUri: string;
  /** relay sockets handed to the host, newest last */
  relaySockets: MockSocket[];
  relayDialCount(): number;
  /** make the next relay dial fail */
  breakRelay(): void;
  fixRelay(): void;
  fetchCalls: string[];
  /** wires another socket to the same mock host/signaling, for a second client */
  webSocket: (url: string) => WsLike;
}

function makeHarness(
  options: {
    hostOptions?: Parameters<typeof makeHost>[0];
    signalingOverrides?: Parameters<typeof attachSignaling>[2];
    clientOptions?: ConstructorParameters<typeof CrosslinkClient>[0];
    presenceFails?: boolean;
  } = {}
): Harness {
  const host = makeHost(options.hostOptions);
  const relaySockets: MockSocket[] = [];
  const fetchCalls: string[] = [];
  let relayBroken = false;
  let relayDials = 0;

  const webSocket = (url: string): WsLike => {
    if (url.startsWith("wss://signal.test") || url.startsWith("ws://signal.test")) {
      const [clientEnd, serviceEnd] = MockSocket.pair(url, `${url}#service`);
      attachSignaling(serviceEnd, host, options.signalingOverrides);
      return clientEnd;
    }
    // relay (or LAN) dial: wire it straight to the host acceptor
    relayDials += 1;
    if (relayBroken) return new MockSocket(url, { failToOpen: true });
    const [clientEnd, hostEnd] = MockSocket.pair(url, `${url}#host`);
    relaySockets.push(hostEnd);
    queueMicrotask(() => host.accept(hostEnd));
    return clientEnd;
  };

  const fakeFetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    if (options.presenceFails) throw new Error("signaling unreachable");
    return {
      ok: true,
      json: async () => ({ relay: { url: RELAY_URL, channel: "chan-1" } })
    } as Response;
  }) as typeof fetch;

  const client = new CrosslinkClient({
    storage: new MemorySecureStorage(),
    deviceName: "Test Browser",
    onConfirmPairing: () => true,
    requestTimeoutMs: 3000,
    webSocket,
    fetch: fakeFetch,
    ...options.clientOptions
  });

  const session = host.pairing.beginSession();
  const pairingUri = buildPairingUri({
    endpoints: [{ kind: "sig", url: SIGNALING_URL }],
    code: session.code,
    appId: APP_ID,
    appName: "Notes",
    hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
  });

  return {
    client,
    host,
    pairingUri,
    relaySockets,
    relayDialCount: () => relayDials,
    breakRelay: () => {
      relayBroken = true;
    },
    fixRelay: () => {
      relayBroken = false;
    },
    fetchCalls,
    webSocket
  };
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe("CrosslinkClient identity", () => {
  it("mints an identity on first construction and persists the seed", () => {
    const storage = new MemorySecureStorage();
    const first = new CrosslinkClient({ storage });
    expect(storage.get("crosslink.identity.seed")).toBeTruthy();

    const second = new CrosslinkClient({ storage });
    expect(second.deviceId).toBe(first.deviceId);
  });

  it("keeps separate identities for separate storages", () => {
    const a = new CrosslinkClient({ storage: new MemorySecureStorage() });
    const b = new CrosslinkClient({ storage: new MemorySecureStorage() });
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});

describe("pairing", () => {
  it("completes the flow and persists the paired-app record", async () => {
    const h = makeHarness();
    const record = await h.client.pairFromQr(h.pairingUri, ["notes.read"]);

    expect(record.appId).toBe(APP_ID);
    expect(record.grantedCaps).toEqual(["notes.read"]);
    expect(record.fingerprint).toBe(h.host.identity.fingerprint);
    expect(h.client.listApps().map((a) => a.appId)).toEqual([APP_ID]);
  });

  it("refuses a host whose fingerprint does not match the scanned code", async () => {
    // The pin is the primary defence against a signaling service that lies
    // about which host is on the other end.
    const h = makeHarness({ signalingOverrides: { fingerprint: "f".repeat(64) } });

    await expect(h.client.pairFromQr(h.pairingUri, ["notes.read"])).rejects.toThrow(/SECURITY/);
  });

  it("unwraps a hosted bootstrap URL and pairs successfully", async () => {
    // The iOS / Add-to-Home-Screen flow produces a long https:// link whose
    // fragment carries the real crosslink:// manifest URI. pairFromQr and
    // pairFromBootstrap must transparently decode it.
    const h = makeHarness();
    const bootstrapUrl = `https://my-pwa.netlify.app/#pair=${encodeURIComponent(h.pairingUri)}`;
    const record = await h.client.pairFromBootstrap(bootstrapUrl, ["notes.read"]);
    expect(record.appId).toBe(APP_ID);
    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("surfaces an expired or unknown code", async () => {
    const h = makeHarness({ signalingOverrides: { notFound: true } });
    await expect(h.client.pairFromQr(h.pairingUri)).rejects.toThrow(/PAIRING_EXPIRED/);
  });

  it("aborts when the user declines the SAS confirmation", async () => {
    const h = makeHarness({ clientOptions: { onConfirmPairing: () => false } });
    await expect(h.client.pairFromQr(h.pairingUri, ["notes.read"])).rejects.toThrow();
    expect(h.client.listApps()).toEqual([]);
  });

  it("passes the SAS and granted capabilities to the confirmation hook", async () => {
    const onConfirmPairing = vi.fn((_request: PairingConfirmRequest) => true);
    const h = makeHarness({ clientOptions: { onConfirmPairing } });
    await h.client.pairFromQr(h.pairingUri, ["notes.read", "notes.write"]);

    expect(onConfirmPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        hostName: "Notes",
        grantedCaps: ["notes.read", "notes.write"]
      })
    );
    expect(onConfirmPairing.mock.calls[0]![0].sas).toMatch(/\S/);
  });

  it("grants only what the host policy allows, whatever was requested", async () => {
    const h = makeHarness({
      hostOptions: { policy: { allow: ["notes.read"], requireApproval: "none" } }
    });
    const record = await h.client.pairFromQr(h.pairingUri, ["notes.read", "notes.write"]);
    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("refuses to build a pairing URI with no usable endpoint", () => {
    const h = makeHarness();
    expect(() =>
      buildPairingUri({
        endpoints: [],
        code: "111 222 333",
        appId: APP_ID,
        appName: "Notes",
        hostPubEdB64: bytesToBase64(h.host.identity.edPublicKey)
      })
    ).toThrow(/no reachable endpoint/);
  });
});

describe("device link", () => {
  // Models the iOS "Add to Home Screen" handoff: a device that's already
  // paired mints a continuation URI for itself, and a second, otherwise
  // unpaired client (standing in for the storage-isolated installed icon)
  // completes it with no SAS prompt and no human-typed code.
  function beginLink(h: Harness, fromDeviceId: string) {
    const session = h.host.pairing.beginLinkSession(fromDeviceId);
    const uri = buildPairingUri({
      endpoints: [{ kind: "sig", url: SIGNALING_URL }],
      code: session.code,
      appId: APP_ID,
      appName: "Notes",
      hostPubEdB64: bytesToBase64(h.host.identity.edPublicKey),
      link: true
    });
    return { session, uri };
  }

  it("completes silently and inherits the linking device's granted caps", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read", "notes.write"]);

    const { uri } = beginLink(h, h.client.deviceId);
    const client2 = new CrosslinkClient({
      storage: new MemorySecureStorage(),
      deviceName: "Installed Icon",
      onConfirmPairing: () => {
        throw new Error("link-mode pairing must not prompt for SAS confirmation");
      },
      webSocket: h.webSocket
    });

    const record = await client2.pairFromQr(uri);
    expect(record.appId).toBe(APP_ID);
    expect(record.grantedCaps).toEqual(["notes.read", "notes.write"]);
    expect(record.fingerprint).toBe(h.host.identity.fingerprint);
    expect(client2.deviceId).not.toBe(h.client.deviceId);
  });

  it("narrows granted caps to what the new device actually requests", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read", "notes.write"]);

    const { uri } = beginLink(h, h.client.deviceId);
    const client2 = new CrosslinkClient({
      storage: new MemorySecureStorage(),
      onConfirmPairing: () => true,
      webSocket: h.webSocket
    });
    const record = await client2.pairFromQr(uri, ["notes.read"]);
    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("is single-use: a second completion attempt fails", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);

    const { uri } = beginLink(h, h.client.deviceId);
    const client2 = new CrosslinkClient({
      storage: new MemorySecureStorage(),
      onConfirmPairing: () => true,
      webSocket: h.webSocket
    });
    await client2.pairFromQr(uri);

    const client3 = new CrosslinkClient({
      storage: new MemorySecureStorage(),
      onConfirmPairing: () => true,
      webSocket: h.webSocket
    });
    await expect(client3.pairFromQr(uri)).rejects.toThrow();
  });

  it("cascades revoke: revoking the linking device also revokes what it linked", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);

    const { uri } = beginLink(h, h.client.deviceId);
    const client2 = new CrosslinkClient({
      storage: new MemorySecureStorage(),
      onConfirmPairing: () => true,
      webSocket: h.webSocket
    });
    await client2.pairFromQr(uri);

    h.host.store.revoke(h.client.deviceId, Date.now());

    expect(h.host.store.get(client2.deviceId)?.revokedAt).toBeDefined();
  });
});

describe("connect and RPC dispatch", () => {
  it("connects over the relay and dispatches calls", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read", "notes.write"]);
    const rpc = await h.client.connect();

    expect(await rpc.call("notes.list")).toEqual(["alpha", "beta"]);
    expect(await rpc.call("notes.create", { title: "x" })).toEqual({
      created: true,
      input: { title: "x" }
    });
    h.client.close();
  });

  it("enforces capabilities the device was not granted", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    const rpc = await h.client.connect();

    await expect(rpc.call("notes.create", { title: "x" })).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED
    });
    h.client.close();
  });

  it("reports METHOD_NOT_FOUND for an unknown method", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    const rpc = await h.client.connect();

    await expect(rpc.call("does.not.exist")).rejects.toMatchObject({
      code: ErrorCodes.METHOD_NOT_FOUND
    });
    h.client.close();
  });

  it("delivers host events to subscribers", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    const rpc = await h.client.connect();

    const received: unknown[] = [];
    rpc.subscribe("notes.changed", (p) => received.push(p));
    await new Promise((r) => setTimeout(r, 20));

    h.host.router.publish("notes.changed", { id: 1 });
    await vi.waitFor(() => expect(received).toEqual([{ id: 1 }]));
    h.client.close();
  });

  it("refuses to connect when nothing has been paired", async () => {
    const h = makeHarness();
    await expect(h.client.connect()).rejects.toThrow(/no paired app/);
  });

  it("prefers live presence over stored hints", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    await h.client.connect();

    // Relay channels are ephemeral, so a stale hint must never win over a
    // fresh presence lookup.
    expect(h.fetchCalls.some((u) => u.includes(`/apps/${encodeURIComponent(APP_ID)}`))).toBe(true);
    h.client.close();
  });

  it("falls back to stored hints when the presence lookup fails", async () => {
    const h = makeHarness({ presenceFails: true });
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    const rpc = await h.client.connect();

    expect(await rpc.call("notes.list")).toEqual(["alpha", "beta"]);
    h.client.close();
  });

  it("reports state transitions to the caller", async () => {
    const states: string[] = [];
    const h = makeHarness({ clientOptions: { onStateChange: (s) => states.push(s) } });
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    await h.client.connect();

    expect(states).toContain("connecting");
    expect(h.client.state).toBe("crosslink-relayed");
    h.client.close();
    expect(h.client.state).toBe("offline");
  });
});

describe("reconnection", () => {
  it("re-dials after the relay socket drops", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    const rpc = await h.client.connect();
    expect(await rpc.call("notes.list")).toEqual(["alpha", "beta"]);

    const dialsBefore = h.relayDialCount();
    h.relaySockets.at(-1)!.fail("network dropped");

    await vi.waitFor(() => expect(h.relayDialCount()).toBeGreaterThan(dialsBefore), {
      timeout: 6000
    });
    await vi.waitFor(() => expect(h.client.state).toBe("crosslink-relayed"), { timeout: 6000 });
    expect(await h.client.rpc().call("notes.list")).toEqual(["alpha", "beta"]);
    h.client.close();
  }, 20000);

  it("keeps retrying while the relay is unreachable, then recovers", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    await h.client.connect();

    h.breakRelay();
    h.relaySockets.at(-1)!.fail("network dropped");
    await vi.waitFor(() => expect(h.client.state).toBe("reconnecting"), { timeout: 6000 });

    h.fixRelay();
    await vi.waitFor(() => expect(h.client.state).toBe("crosslink-relayed"), { timeout: 20000 });
    expect(await h.client.rpc().call("notes.list")).toEqual(["alpha", "beta"]);
    h.client.close();
  }, 30000);

  it("stops reconnecting once the client is closed", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    await h.client.connect();
    h.client.close();

    const dials = h.relayDialCount();
    await new Promise((r) => setTimeout(r, 400));
    expect(h.relayDialCount()).toBe(dials);
  }, 10000);
});

describe("revocation", () => {
  it("refuses to reconnect a revoked device", async () => {
    const h = makeHarness();
    const record = await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    await h.client.connect();

    h.host.store.revoke(h.client.deviceId, Date.now());
    h.host.grants.drop(h.client.deviceId);
    h.relaySockets.at(-1)!.fail("dropped");

    await vi.waitFor(() => expect(h.client.state).toBe("revoked"), { timeout: 20000 });
    expect(record.appId).toBe(APP_ID);
  }, 30000);

  it("forgetting an app removes it from storage", async () => {
    const h = makeHarness();
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    expect(h.client.listApps()).toHaveLength(1);

    h.client.forget(APP_ID);
    expect(h.client.listApps()).toHaveLength(0);
  });
});

describe("logging", () => {
  it("records pairing and connection under stable event ids", async () => {
    const sink = new MemoryLogSink();
    const h = makeHarness({ clientOptions: { logger: sink.logger() } });
    await h.client.pairFromQr(h.pairingUri, ["notes.read"]);
    await h.client.connect();

    const events = sink.records.map((r) => r.event);
    expect(events).toContain("client.paired");
    expect(events).toContain("client.connecting");
    expect(events).toContain("link.connected");
    h.client.close();
  });

  it("logs the mismatch when fingerprint pinning rejects a host", async () => {
    const sink = new MemoryLogSink();
    const h = makeHarness({
      signalingOverrides: { fingerprint: "f".repeat(64) },
      clientOptions: { logger: sink.logger() }
    });

    await expect(h.client.pairFromQr(h.pairingUri)).rejects.toThrow();
    expect(sink.records.map((r) => r.event)).toContain("client.fingerprint-mismatch");
  });
});

describe("MockSocket", () => {
  let a: MockSocket;
  let b: MockSocket;

  beforeEach(() => {
    [a, b] = MockSocket.pair();
  });

  it("delivers messages to its peer once open", async () => {
    const received: unknown[] = [];
    b.addEventListener("message", (ev) => received.push((ev as { data: unknown }).data));
    await vi.waitFor(() => expect(a.readyState).toBe(1));

    a.send("hello");
    await vi.waitFor(() => expect(received).toEqual(["hello"]));
  });

  it("propagates close to both ends", async () => {
    await vi.waitFor(() => expect(a.readyState).toBe(1));
    const closes: number[] = [];
    b.addEventListener("close", () => closes.push(1));

    a.close(1000, "done");
    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(b.readyState).toBe(3);
  });

  it("reports a failure to open", async () => {
    const socket = new MockSocket("ws://nope", { failToOpen: true });
    const errors: unknown[] = [];
    socket.addEventListener("error", () => errors.push(1));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(socket.readyState).toBe(3);
  });

  it("refuses to send before it is open", () => {
    const socket = new MockSocket("ws://later");
    expect(() => socket.send("x")).toThrow(/not open/);
  });
});
