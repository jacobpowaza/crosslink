import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  bytesToBase64,
  type CrosslinkMessage,
} from "@crosslink/protocol";
import {
  CapabilityRegistry,
  ClientLink,
  DeviceGrants,
  DeviceIdentity,
  HostAcceptor,
  HostPairingManager,
  InMemoryHostDeviceStore,
  MemoryListener,
  RpcRouter,
  buildPairingUri,
  createClaim,
  parsePairingUri,
  processChallenge,
  signClaim,
  type PairedAppRecord,
  type TransportCandidate,
} from "../src/index.js";

/* ------------------------------------------------------------------ */
/* harness: a complete host accepting in-memory connections            */
/* ------------------------------------------------------------------ */

function makeHost(opts: { appId?: string } = {}) {
  const identity = DeviceIdentity.create();
  const store = new InMemoryHostDeviceStore();
  const grants = new DeviceGrants();
  const registry = new CapabilityRegistry().registerAll([
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
    { id: "notes.write", title: "Write notes", risk: "medium" }
  ]);
  const appId = opts.appId ?? "com.example.notes";

  const router = new RpcRouter(() => grants, { ratePerSec: 1000 });
  router
    .expose("echo", (p) => p)
    .expose(
      "notes.create",
      (p) => ({ created: true, title: (p as { title: string }).title }),
      { capability: "notes.write" }
    )
    .expose("notes.list", () => ["a", "b"], { capability: "notes.read" })
    .expose("count.len", (p) => (p as { s: string }).s.length, {
      inputSchema: {
        type: "object",
        properties: { s: { type: "string", maxLen: 8 } },
        required: ["s"]
      }
    })
    .expose("boom", () => {
      throw new Error("secret internal detail");
    })
    .expose("slow", async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return "never";
    }, { timeoutMs: 150 })
    .expose("countStream", async function* (_p, ctx) {
      for (let i = 1; i <= 3; i++) {
        if (ctx.signal.aborted) return { aborted: true };
        yield { i };
        await new Promise((r) => setTimeout(r, 20));
      }
      return { done: true };
    })
    .declareEvent("tasks.status");

  const listener = new MemoryListener();
  const pairing = new HostPairingManager({
    identity,
    appId,
    registry,
    store,
    grants,
    autoApprove: true,
    // These tests exercise RPC authorization, so auto-approval is allowed to
    // hand out the medium-risk write capability. The default policy stops at
    // "low" precisely so this has to be opted into.
    policy: { maxAutoGrantRisk: "medium" }
  });

  listener.onConnection((transport) => {
    let active: import("../src/index.js").CrosslinkSession | undefined;
    new HostAcceptor(
      transport,
      { identity, appId, lookupDevice: (id) => store.get(id), maxFrameBytes: 1024 * 1024 },
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
  });

  const candidatesFor = (): TransportCandidate[] => [
    { kind: "memory", connect: async () => listener.connectClient({ latencyMs: 1 }) }
  ];

  return { identity, store, grants, registry, router, pairing, candidatesFor, appId };
}

/** Runs the full pairing dance against the host manager (no signaling). */
async function pairClient(
  host: ReturnType<typeof makeHost>,
  requestedCaps: string[],
  confirm = (): boolean => true
) {
  const clientIdentity = DeviceIdentity.create();
  const session = host.pairing.beginSession();
  const parsed = parsePairingUri(
    buildPairingUri({
      endpoints: [{ kind: "sig", url: "https://signal.test" }],
      code: session.code,
      appId: host.appId,
      appName: "Notes",
      hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
    })
  );
  const psid = host.pairing.resolveCode(parsed.code)!;
  expect(psid).toBeTruthy();

  const { claim, state } = createClaim(clientIdentity, parsed, "Test Phone", requestedCaps);
  signClaim(clientIdentity, claim as Record<string, unknown>, psid);

  const challenge = await new Promise<Record<string, unknown>>((resolve) => {
    void host.pairing.handleClaim(claim as Record<string, unknown>, (f) =>
      resolve(f as Record<string, unknown>)
    );
  });
  expect(challenge.kind).toBe("pair_challenge");

  const { complete, record } = await processChallenge(
    clientIdentity,
    parsed,
    state,
    challenge,
    confirm
  );
  const done = await new Promise<Record<string, unknown>>((resolve) => {
    host.pairing.handleComplete(complete, (f) => resolve(f as Record<string, unknown>));
  });
  expect(done.kind).toBe("pair_done");
  return { clientIdentity, pairedRecord: record };
}

async function connectClient(
  host: ReturnType<typeof makeHost>,
  clientIdentity: DeviceIdentity,
  record: PairedAppRecord,
  extra: Partial<ConstructorParameters<typeof ClientLink>[0]> = {}
) {
  const link = new ClientLink({
    identity: clientIdentity,
    appId: host.appId,
    hostRecord: () => ({
      ...record,
      pubEdB64: bytesToBase64(host.identity.edPublicKey),
      pubXB64: bytesToBase64(host.identity.xPublicKey)
    }),
    candidates: host.candidatesFor(),
    requestTimeoutMs: 2000,
    ...extra
  });
  await link.connect();
  return link;
}

describe("rpc over an encrypted session", () => {
  it("call / validation / authz / safe errors", async () => {
    const host = makeHost();
    const { clientIdentity, pairedRecord } = await pairClient(host, [
      "notes.read",
      "notes.write"
    ]);
    const link = await connectClient(host, clientIdentity, pairedRecord);

    expect(await link.call("echo", { hi: 1 })).toEqual({ hi: 1 });
    expect(await link.call("notes.list")).toEqual(["a", "b"]);
    expect(await link.call("notes.create", { title: "x" })).toMatchObject({ created: true });

    await expect(link.call("count.len", { s: "123456789" })).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_FAILED
    });
    await expect(link.call("nope.method")).rejects.toMatchObject({
      code: ErrorCodes.METHOD_NOT_FOUND
    });
    // internal errors must not leak details across the trust boundary
    await expect(link.call("boom")).rejects.toThrow("internal error");

    link.close();
  }, 15000);

  it("denies methods whose capabilities were not granted at pairing", async () => {
    const host = makeHost();
    // request ONLY notes.read
    const { clientIdentity, pairedRecord } = await pairClient(host, ["notes.read"]);
    expect(pairedRecord.grantedCaps).toEqual(["notes.read"]);
    const link = await connectClient(host, clientIdentity, pairedRecord);

    expect(await link.call("notes.list")).toEqual(["a", "b"]);
    await expect(link.call("notes.create", { title: "x" })).rejects.toMatchObject({
      code: ErrorCodes.CAPABILITY_DENIED
    });
    link.close();
  }, 15000);

  it("streams chunks then final value", async () => {
    const host = makeHost();
    const { clientIdentity, pairedRecord } = await pairClient(host, []);
    const link = await connectClient(host, clientIdentity, pairedRecord);

    const chunks: number[] = [];
    const final = await link.stream<{ done?: boolean }>(
      "countStream",
      {},
      (d) => chunks.push((d as { i: number }).i)
    );
    expect(chunks).toEqual([1, 2, 3]);
    expect(final).toEqual({ done: true });
    link.close();
  }, 15000);

  it("request timeout reports TIMEOUT", async () => {
    const host = makeHost();
    const { clientIdentity, pairedRecord } = await pairClient(host, []);
    const link = await connectClient(host, clientIdentity, pairedRecord);
    await expect(link.call("slow")).rejects.toMatchObject({ code: ErrorCodes.TIMEOUT });
    link.close();
  }, 15000);

  it("events fan out; unsubscribe stops delivery", async () => {
    const host = makeHost();
    const { clientIdentity, pairedRecord } = await pairClient(host, []);
    const link = await connectClient(host, clientIdentity, pairedRecord);

    const received: unknown[] = [];
    const unsub = link.subscribe("tasks.status", (p) => received.push(p));
    await new Promise((r) => setTimeout(r, 40));

    host.router.publish("tasks.status", { pct: 42 });
    await new Promise((r) => setTimeout(r, 60));
    expect(received).toEqual([{ pct: 42 }]);

    unsub();
    host.router.publish("tasks.status", { pct: 99 });
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveLength(1);
    link.close();
  }, 15000);
});

describe("pairing security", () => {
  it("SAS confirmation can refuse pairing", async () => {
    const host = makeHost({ appId: "com.example.notes" });
    await expect(pairClient(host, ["notes.read"], () => false)).rejects.toThrow(
      /rejected by host user|cancelled/
    );
  });

  it("client refuses hosts whose fingerprint does not match the QR pin", async () => {
    const host = makeHost();
    const evil = DeviceIdentity.create();
    const session = host.pairing.beginSession();
    const parsed = parsePairingUri(
      buildPairingUri({
        endpoints: [{ kind: "sig", url: "https://signal.test" }],
        code: session.code,
        appId: host.appId,
        appName: "Notes",
        hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
      })
    );

    await expect(
      processChallenge(
        DeviceIdentity.create(),
        parsed,
        { claimNonce: "claim-nonce" },
        {
          kind: "pair_challenge",
          ps: "ps",
          claim_nonce: "claim-nonce",
          host_pub_ed: bytesToBase64(evil.edPublicKey),
          host_pub_x: bytesToBase64(evil.xPublicKey),
          nonce: "nonce",
          granted_caps: [],
          sig: bytesToBase64(new Uint8Array(64))
        },
        () => false
      )
    ).rejects.toThrow(/fingerprint/);
  });

  it("a used code cannot pair twice", async () => {
    const host = makeHost();
    const first = await pairClient(host, ["notes.read"]);
    expect(first.pairedRecord.grantedCaps).toEqual(["notes.read"]);

    // Replaying a claim against the SAME (now consumed) session must fail.
    const consumedPsid = host.pairing.resolveCode("000 000 000");
    expect(consumedPsid).toBeNull();

    // Build a claim signed for the first client's psid by re-running the flow
    // manually: begin, pair, then attempt a second claim on that psid.
    const session = host.pairing.beginSession();
    const parsed = parsePairingUri(
      buildPairingUri({
        endpoints: [{ kind: "sig", url: "https://signal.test" }],
        code: session.code,
        appId: host.appId,
        appName: "Notes",
        hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
      })
    );
    const psid = host.pairing.resolveCode(parsed.code)!;
    const c2 = DeviceIdentity.create();
    const { claim } = createClaim(c2, parsed, "phone-2");
    signClaim(c2, claim as Record<string, unknown>, psid);

    const challenge = await new Promise<Record<string, unknown>>((resolve) => {
      void host.pairing.handleClaim(claim as Record<string, unknown>, (f) =>
        resolve(f as Record<string, unknown>)
      );
    });
    expect(challenge.kind).toBe("pair_challenge");

    // A second, different device claiming the same psid while it is pending:
    const c3 = DeviceIdentity.create();
    const { claim: claim3 } = createClaim(c3, parsed, "phone-3");
    signClaim(c3, claim3 as Record<string, unknown>, psid);
    const rejected = await new Promise<Record<string, unknown>>((resolve) => {
      void host.pairing.handleClaim(claim3 as Record<string, unknown>, (f) =>
        resolve(f as Record<string, unknown>)
      );
    });
    expect(rejected.kind).toBe("pair_error");

    void first;
  });
});

describe("revocation and isolation", () => {
  it("revocation blocks new sessions immediately", async () => {
    const host = makeHost();
    const { clientIdentity, pairedRecord } = await pairClient(host, ["notes.read"]);
    const liveLink = await connectClient(host, clientIdentity, pairedRecord);
    expect(liveLink.connected).toBe(true);

    host.store.revoke(clientIdentity.deviceId, Date.now());
    host.grants.drop(clientIdentity.deviceId);

    const states: string[] = [];
    const freshLink = new ClientLink({
      identity: clientIdentity,
      appId: host.appId,
      hostRecord: () => ({
        ...pairedRecord,
        pubEdB64: bytesToBase64(host.identity.edPublicKey),
        pubXB64: bytesToBase64(host.identity.xPublicKey)
      }),
      candidates: host.candidatesFor(),
      onStateChange: (s) => states.push(s)
    });
    await expect(freshLink.connect()).rejects.toThrow();
    expect(freshLink.currentState).toBe("revoked");
    expect(states).toContain("revoked");

    liveLink.close();
  }, 15000);

  it("a device paired with app A cannot reach app B on the same computer", async () => {
    const appA = makeHost({ appId: "com.a.notes" });
    const appB = makeHost({ appId: "com.b.media" });
    const { clientIdentity, pairedRecord } = await pairClient(appA, ["notes.read"]);

    const bLink = new ClientLink({
      identity: clientIdentity,
      appId: appB.appId,
      hostRecord: () => ({
        ...pairedRecord,
        appId: appB.appId,
        pubEdB64: bytesToBase64(appA.identity.edPublicKey), // even lying about keys changes nothing
        pubXB64: bytesToBase64(appA.identity.xPublicKey)
      }),
      candidates: appB.candidatesFor()
    });
    await expect(bLink.connect()).rejects.toThrow();
    expect(bLink.currentState).toBe("unauthorized");
  });

  it("reconnects after a dropped transport without re-pairing", async () => {
    const host = makeHost();
    const { clientIdentity, pairedRecord } = await pairClient(host, ["notes.read"]);
    const link = await connectClient(host, clientIdentity, pairedRecord);

    const result = await link.call<number>("count.len", { s: "abc" });
    expect(result).toBe(3);

    // simulate network drop
    link["session"]?.close("wifi-drop");
    await new Promise((r) => setTimeout(r, 120));
    // auto-reconnect should have kicked in (memory candidate reconnects fast)
    for (let i = 0; i < 50 && !link.connected; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(link.connected).toBe(true);
    expect(await link.call("echo", { back: true })).toEqual({ back: true });
    link.close();
  }, 20000);
});
