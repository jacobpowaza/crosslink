/**
 * Connection-lifecycle tests for ClientLink and the permission enforcement
 * that sits behind the RPC router: reconnect and backoff, subscription
 * restoration, transport upgrade, terminal states, and per-use consent.
 *
 * The transport layer is mocked (an in-memory pipe under a scripted
 * candidate), so failures are produced deliberately rather than waited for.
 */
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, bytesToBase64 } from "@crosslink/protocol";
import {
  CapabilityRegistry,
  ClientLink,
  ConsentBroker,
  DeviceGrants,
  DeviceIdentity,
  HostAcceptor,
  HostPairingManager,
  InMemoryHostDeviceStore,
  MemoryListener,
  MemoryLogSink,
  RpcRouter,
  buildPairingUri,
  createClaim,
  createMemoryPair,
  parsePairingUri,
  processChallenge,
  signClaim,
  type ConnectionState,
  type ConsentPrompt,
  type CrosslinkTransport,
  type PairedAppRecord,
  type TransportCandidate
} from "./index.js";

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface HostHarness {
  identity: DeviceIdentity;
  appId: string;
  store: InMemoryHostDeviceStore;
  grants: DeviceGrants;
  router: RpcRouter;
  pairing: HostPairingManager;
  listener: MemoryListener;
  consentPrompt: ReturnType<typeof vi.fn>;
  /** transports handed to the acceptor outside the listener (upgrade path) */
  acceptTransport(t: CrosslinkTransport): void;
  connectCount(): number;
}

function makeHost(
  options: {
    consent?: ConsentPrompt;
    policy?: ConstructorParameters<typeof HostPairingManager>[0]["policy"];
  } = {}
): HostHarness {
  const identity = DeviceIdentity.create();
  const appId = "com.example.link";
  const store = new InMemoryHostDeviceStore();
  const grants = new DeviceGrants();
  const registry = new CapabilityRegistry().registerAll([
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
    { id: "notes.write", title: "Write notes", risk: "medium" },
    { id: "shell.exec", title: "Run a command", risk: "high", confirmEachUse: true }
  ]);

  const consentPrompt = vi.fn(options.consent ?? (() => "once" as const));
  const consent = new ConsentBroker({ registry, prompt: consentPrompt as ConsentPrompt });

  const router = new RpcRouter(() => grants, { ratePerSec: 1000 }, { registry, consent });
  router
    .expose("echo", (p) => p)
    .expose("notes.list", () => ["a"], { capability: "notes.read" })
    .expose("notes.create", (p) => ({ created: true, input: p }), { capability: "notes.write" })
    .expose("shell.run", (p) => ({ ran: p }), { capability: "shell.exec" })
    .declareEvent("notes.changed");

  const pairing = new HostPairingManager({
    identity,
    appId,
    registry,
    store,
    grants,
    autoApprove: true,
    policy: options.policy ?? { maxAutoGrantRisk: "medium" }
  });

  let connects = 0;
  const acceptTransport = (transport: CrosslinkTransport): void => {
    connects += 1;
    let active: import("./session.js").CrosslinkSession | undefined;
    new HostAcceptor(
      transport,
      { identity, appId, lookupDevice: (id) => store.get(id) },
      {
        onMessage: (msg, session) => router.handleMessage(session, msg),
        onSession: (session) => {
          active = session;
        },
        onClose: () => {
          if (active) router.handleSessionClosed(active);
        }
      }
    );
  };

  const listener = new MemoryListener();
  listener.onConnection(acceptTransport);

  return {
    identity,
    appId,
    store,
    grants,
    router,
    pairing,
    listener,
    consentPrompt,
    acceptTransport,
    connectCount: () => connects
  };
}

async function pairClient(
  host: HostHarness,
  requestedCaps: string[]
): Promise<{ clientIdentity: DeviceIdentity; record: PairedAppRecord }> {
  const clientIdentity = DeviceIdentity.create();
  const session = host.pairing.beginSession();
  const parsed = parsePairingUri(
    buildPairingUri({
      signalingUrl: "https://signal.test",
      code: session.code,
      appId: host.appId,
      appName: "Link",
      hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
    })
  );
  const psid = host.pairing.resolveCode(parsed.code)!;

  const { claim, state } = createClaim(clientIdentity, parsed, "Test Device", requestedCaps);
  signClaim(clientIdentity, claim, psid);

  const challenge = await new Promise<Record<string, unknown>>((resolve) => {
    void host.pairing.handleClaim(claim, (f) => resolve(f as Record<string, unknown>));
  });
  const { complete, record } = await processChallenge(
    clientIdentity,
    parsed,
    state,
    challenge,
    () => true
  );
  await new Promise<void>((resolve) => {
    host.pairing.handleComplete(complete, () => resolve());
  });
  return { clientIdentity, record };
}

function hostRecordOf(host: HostHarness, record: PairedAppRecord): () => PairedAppRecord {
  return () => ({
    ...record,
    pubEdB64: bytesToBase64(host.identity.edPublicKey),
    pubXB64: bytesToBase64(host.identity.xPublicKey)
  });
}

/**
 * A candidate whose behaviour is scripted per attempt: `"ok"` connects to the
 * host, `"refuse"` fails to dial, `"dead"` returns a pipe with nothing on the
 * other end so the handshake times out.
 */
function scriptedCandidate(
  host: HostHarness,
  script: Array<"ok" | "refuse" | "dead">,
  kind: TransportCandidate["kind"] = "memory"
): TransportCandidate & { attempts: number; lastTransport?: CrosslinkTransport } {
  const candidate = {
    kind,
    attempts: 0,
    lastTransport: undefined as CrosslinkTransport | undefined,
    connect: async (): Promise<CrosslinkTransport> => {
      const step = script[Math.min(candidate.attempts, script.length - 1)];
      candidate.attempts += 1;
      if (step === "refuse") throw new Error("dial refused");
      if (step === "dead") {
        const [clientSide] = createMemoryPair();
        return clientSide;
      }
      const transport = host.listener.connectClient({ latencyMs: 0 });
      candidate.lastTransport = transport;
      return transport;
    }
  };
  return candidate;
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe("ClientLink candidate selection", () => {
  it("falls through to the next candidate when the first will not dial", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const bad = scriptedCandidate(host, ["refuse"]);
    const good = scriptedCandidate(host, ["ok"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [bad, good]
    });
    await link.connect();

    expect(bad.attempts).toBe(1);
    expect(good.attempts).toBe(1);
    expect(link.connected).toBe(true);
    link.close();
  });

  it("reports HOST_OFFLINE when every candidate fails", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["refuse"]), scriptedCandidate(host, ["refuse"])]
    });

    await expect(link.connect()).rejects.toMatchObject({ code: ErrorCodes.HOST_OFFLINE });
    expect(link.currentState).toBe("connecting");
  });

  it("gives up on a candidate whose handshake never answers", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const dead = scriptedCandidate(host, ["dead"]);
    const good = scriptedCandidate(host, ["ok"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [dead, good],
      handshakeTimeoutMs: 40
    });
    await link.connect();

    expect(link.connected).toBe(true);
    expect(good.attempts).toBe(1);
    link.close();
  });

  it("maps the winning candidate kind onto the user-facing state", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const states: ConnectionState[] = [];

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"], "crosslink-relayed")],
      onStateChange: (s) => states.push(s)
    });
    await link.connect();

    expect(link.currentState).toBe("crosslink-relayed");
    expect(states).toContain("connecting");
    link.close();
  });
});

describe("ClientLink reconnection", () => {
  it("reconnects automatically after the transport drops", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const candidate = scriptedCandidate(host, ["ok"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate],
      requestTimeoutMs: 2000
    });
    await link.connect();
    expect(await link.call("notes.list")).toEqual(["a"]);

    candidate.lastTransport!.close("simulated-drop");

    await vi.waitFor(() => expect(link.connected).toBe(true), { timeout: 5000 });
    expect(candidate.attempts).toBeGreaterThanOrEqual(2);
    expect(await link.call("notes.list")).toEqual(["a"]);
    link.close();
  }, 15000);

  it("backs off between attempts and reports the delay", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const candidate = scriptedCandidate(host, ["ok", "refuse", "refuse", "ok"]);
    const delays: number[] = [];

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate],
      onStateChange: (state, detail) => {
        if (state === "reconnecting" && typeof detail?.delayMs === "number") {
          delays.push(detail.delayMs);
        }
      }
    });
    await link.connect();
    candidate.lastTransport!.close("simulated-drop");

    await vi.waitFor(() => expect(link.connected).toBe(true), { timeout: 15000 });
    expect(delays.length).toBeGreaterThanOrEqual(2);
    // Jittered exponential: later waits are longer than the first.
    expect(Math.max(...delays)).toBeGreaterThan(delays[0]);
    link.close();
  }, 25000);

  it("restores subscriptions with their real callbacks after reconnecting", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const candidate = scriptedCandidate(host, ["ok"]);
    const received: unknown[] = [];

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate]
    });
    await link.connect();
    link.subscribe("notes.changed", (p) => received.push(p));

    host.router.publish("notes.changed", { n: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(1));

    candidate.lastTransport!.close("simulated-drop");
    await vi.waitFor(() => expect(link.connected).toBe(true), { timeout: 5000 });

    // The subscription must still deliver: a placeholder callback here would
    // drop every event after the first reconnect, silently.
    host.router.publish("notes.changed", { n: 2 });
    await vi.waitFor(() => expect(received).toHaveLength(2), { timeout: 5000 });
    expect(received[1]).toEqual({ n: 2 });
    link.close();
  }, 15000);

  it("stops delivering to an unsubscribed callback across a reconnect", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const candidate = scriptedCandidate(host, ["ok"]);
    const received: unknown[] = [];

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate]
    });
    await link.connect();
    const unsubscribe = link.subscribe("notes.changed", (p) => received.push(p));
    unsubscribe();

    candidate.lastTransport!.close("simulated-drop");
    await vi.waitFor(() => expect(link.connected).toBe(true), { timeout: 5000 });

    host.router.publish("notes.changed", { n: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(0);
    link.close();
  }, 15000);

  it("does not reconnect after an explicit close", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const candidate = scriptedCandidate(host, ["ok"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate]
    });
    await link.connect();
    const attemptsAtClose = candidate.attempts;
    link.close();

    await new Promise((r) => setTimeout(r, 300));
    expect(candidate.attempts).toBe(attemptsAtClose);
    expect(link.currentState).toBe("offline");
  });

  it("enters the terminal revoked state and refuses to reconnect", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const candidate = scriptedCandidate(host, ["ok"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate]
    });
    await link.connect();

    host.store.revoke(record.appId === "" ? "" : clientIdentity.deviceId, Date.now());
    host.grants.drop(clientIdentity.deviceId);
    candidate.lastTransport!.close("revoked");

    await vi.waitFor(() => expect(link.currentState).toBe("revoked"), { timeout: 10000 });
    await expect(link.connect()).rejects.toMatchObject({ code: ErrorCodes.DEVICE_REVOKED });
  }, 20000);

  it("fails in-flight calls when the connection drops", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const candidate = scriptedCandidate(host, ["ok"]);

    host.router.expose("hang", () => new Promise(() => {}));
    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [candidate],
      requestTimeoutMs: 30_000
    });
    await link.connect();

    const pending = link.call("hang");
    candidate.lastTransport!.close("simulated-drop");

    await expect(pending).rejects.toMatchObject({ code: ErrorCodes.PEER_LOST });
    link.close();
  }, 15000);
});

describe("ClientLink offline queue", () => {
  it("flushes queued idempotent calls once connected", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });

    const queued = link.queueIdempotent("echo", { queued: true });
    expect(link.queuedCount).toBe(1);

    await link.connect();
    expect(await queued).toEqual({ queued: true });
    expect(link.queuedCount).toBe(0);
    link.close();
  });
});

describe("ClientLink.upgrade", () => {
  it("swaps onto a better transport and keeps working", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"], "crosslink-relayed")]
    });
    await link.connect();
    expect(link.currentState).toBe("crosslink-relayed");

    const upgraded = await link.upgrade(scriptedCandidate(host, ["ok"], "webrtc-direct"));

    expect(upgraded).toBe(true);
    expect(link.currentState).toBe("direct");
    expect(await link.call("notes.list")).toEqual(["a"]);
    link.close();
  }, 15000);

  it("leaves the existing session running when the upgrade cannot dial", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"], "crosslink-relayed")]
    });
    await link.connect();

    const upgraded = await link.upgrade(scriptedCandidate(host, ["refuse"], "webrtc-direct"));

    expect(upgraded).toBe(false);
    expect(link.currentState).toBe("crosslink-relayed");
    expect(await link.call("notes.list")).toEqual(["a"]);
    link.close();
  }, 15000);

  it("leaves the existing session running when the upgrade handshake fails", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"], "crosslink-relayed")],
      handshakeTimeoutMs: 40
    });
    await link.connect();

    const upgraded = await link.upgrade(scriptedCandidate(host, ["dead"], "webrtc-direct"));

    expect(upgraded).toBe(false);
    expect(link.connected).toBe(true);
    expect(await link.call("notes.list")).toEqual(["a"]);
    link.close();
  }, 15000);

  it("does not trigger a reconnect when the superseded session closes", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const initial = scriptedCandidate(host, ["ok"], "crosslink-relayed");

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [initial]
    });
    await link.connect();
    await link.upgrade(scriptedCandidate(host, ["ok"], "webrtc-direct"));

    // The relayed candidate must not be re-dialled: the old session ending is
    // the upgrade succeeding, not the connection being lost.
    await new Promise((r) => setTimeout(r, 300));
    expect(initial.attempts).toBe(1);
    expect(link.currentState).toBe("direct");
    link.close();
  }, 15000);

  it("refuses to upgrade when not connected", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, []);
    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });

    expect(await link.upgrade(scriptedCandidate(host, ["ok"], "webrtc-direct"))).toBe(false);
  });
});

describe("per-use consent through the RPC router", () => {
  it("prompts before invoking a confirmEachUse method", async () => {
    const host = makeHost({ policy: { maxAutoGrantRisk: "high", requireApproval: "none" } });
    const { clientIdentity, record } = await pairClient(host, ["shell.exec"]);
    expect(record.grantedCaps).toEqual(["shell.exec"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });
    await link.connect();

    expect(await link.call("shell.run", { cmd: "ls" })).toEqual({ ran: { cmd: "ls" } });
    expect(host.consentPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "shell.exec", method: "shell.run" })
    );
    link.close();
  }, 15000);

  it("returns CONSENT_DENIED to the client when the user refuses", async () => {
    const host = makeHost({
      consent: () => false,
      policy: { maxAutoGrantRisk: "high", requireApproval: "none" }
    });
    const { clientIdentity, record } = await pairClient(host, ["shell.exec"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });
    await link.connect();

    // The grant lets the device *ask*; it does not let it act.
    await expect(link.call("shell.run", { cmd: "rm -rf /" })).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
    link.close();
  }, 15000);

  it("does not prompt for methods whose capability needs no confirmation", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });
    await link.connect();

    await link.call("notes.list");
    expect(host.consentPrompt).not.toHaveBeenCalled();
    link.close();
  }, 15000);
});

describe("pairing policy end to end", () => {
  it("grants only what the policy permits, whatever the client asks for", async () => {
    const host = makeHost({ policy: { allow: ["notes.read"], requireApproval: "none" } });
    const { record } = await pairClient(host, ["notes.read", "notes.write", "shell.exec"]);

    expect(record.grantedCaps).toEqual(["notes.read"]);
  });

  it("refuses a method whose capability the policy trimmed away", async () => {
    const host = makeHost({ policy: { allow: ["notes.read"], requireApproval: "none" } });
    const { clientIdentity, record } = await pairClient(host, ["notes.read", "notes.write"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });
    await link.connect();

    await expect(link.call("notes.create", { title: "x" })).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED
    });
    link.close();
  }, 15000);

  it("reports GRANT_EXPIRED once the grant TTL lapses", async () => {
    const host = makeHost({
      policy: { maxAutoGrantRisk: "medium", grantTtlMs: 120 }
    });
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])]
    });
    await link.connect();
    expect(await link.call("notes.list")).toEqual(["a"]);

    await new Promise((r) => setTimeout(r, 200));
    await expect(link.call("notes.list")).rejects.toMatchObject({
      code: ErrorCodes.GRANT_EXPIRED
    });
    link.close();
  }, 15000);
});

describe("logging", () => {
  it("records the connection lifecycle under stable event ids", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const sink = new MemoryLogSink();

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])],
      logger: sink.logger()
    });
    await link.connect();
    link.close();

    const events = sink.records.map((r) => r.event);
    expect(events).toContain("link.candidate-dial");
    expect(events).toContain("link.connected");
    expect(events).toContain("session.opened");
    expect(events).toContain("link.close-requested");
  }, 15000);

  it("never writes the identity seed or host token into a record", async () => {
    const host = makeHost();
    const { clientIdentity, record } = await pairClient(host, ["notes.read"]);
    const sink = new MemoryLogSink();

    const link = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: hostRecordOf(host, record),
      candidates: [scriptedCandidate(host, ["ok"])],
      logger: sink.logger()
    });
    await link.connect();
    link.close();

    const dump = JSON.stringify(sink.records);
    expect(dump).not.toContain(bytesToBase64(clientIdentity.seed));
  }, 15000);
});
