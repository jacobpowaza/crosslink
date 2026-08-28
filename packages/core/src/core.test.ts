import { describe, expect, it } from "vitest";
import {
  CrosslinkError,
  MessageTypes,
  PROTOCOL_VERSION,
  base64ToBytes,
  bytesToBase64,
} from "@crosslink/protocol";
import {
  CapabilityRegistry,
  DeviceGrants,
  DeviceIdentity,
  SessionCipher,
  authorizeOrThrow,
  clientBeginSession,
  clientCompleteSession,
  deviceIdFromPublicKey,
  hostCompleteSession,
  miniValidator,
  shortAuthString,
} from "../src/index.js";

describe("identity", () => {
  it("derives deterministically from seed", () => {
    const a = DeviceIdentity.fromSeed(new Uint8Array(32).fill(7));
    const b = DeviceIdentity.fromSeed(new Uint8Array(32).fill(7));
    expect(bytesToBase64(a.edPublicKey)).toBe(bytesToBase64(b.edPublicKey));
    expect(a.deviceId).toMatch(/^cd1_[0-9a-f]{32}$/);
    expect(a.fingerprint).toHaveLength(64);
    expect(a.deviceId).toBe(deviceIdFromPublicKey(a.edPublicKey));
  });

  it("signs and verifies; json roundtrip keeps identity", () => {
    const id = DeviceIdentity.create();
    const msg = new TextEncoder().encode("hi");
    const sig = id.sign(msg);
    expect(id.verifyOwn(sig, msg)).toBe(true);
    expect(id.verifyOwn(sig, new TextEncoder().encode("ho"))).toBe(false);

    const restored = DeviceIdentity.fromJson(JSON.parse(JSON.stringify(id.toJson())));
    expect(restored.deviceId).toBe(id.deviceId);
    expect(bytesToBase64(restored.xPublicKey)).toBe(bytesToBase64(id.xPublicKey));
  });
});

describe("shortAuthString", () => {
  it("is order-independent and app-bound", () => {
    const a = DeviceIdentity.fromSeed(new Uint8Array(32).fill(1));
    const b = DeviceIdentity.fromSeed(new Uint8Array(32).fill(2));
    const s1 = shortAuthString("com.example.notes", a.edPublicKey, b.edPublicKey);
    const s2 = shortAuthString("com.example.notes", b.edPublicKey, a.edPublicKey);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^\d{3} \d{3} \d{3}$/);
    expect(shortAuthString("com.other.app", a.edPublicKey, b.edPublicKey)).not.toBe(s1);
  });
});

describe("session cipher", () => {
  const keys = { c2h: new Uint8Array(32).fill(3), h2c: new Uint8Array(32).fill(4) };

  it("seals per-direction and rejects replay/out-of-order", () => {
    const sender = new SessionCipher(keys, "client", 1 << 20);
    const receiver = new SessionCipher(keys, "host", 1 << 20);

    const f1 = sender.seal({ v: PROTOCOL_VERSION, t: MessageTypes.PING, ts: 1 });
    const f2 = sender.seal({ v: PROTOCOL_VERSION, t: MessageTypes.PING, ts: 2 });

    expect(receiver.open(f1)).toMatchObject({ ts: 1 });
    expect(() => receiver.open(f1)).toThrow(/replay/);
    expect(() =>
      receiver.open(sender.seal({ v: PROTOCOL_VERSION, t: MessageTypes.PING, ts: 9 }))
    ).toThrow(/replay/);
    expect(receiver.open(f2)).toMatchObject({ ts: 2 });
  });

  it("fails authentication on modified ciphertext", () => {
    const sender = new SessionCipher(keys, "client", 1 << 20);
    const receiver = new SessionCipher(keys, "host", 1 << 20);
    const frame = sender.seal({ v: PROTOCOL_VERSION, t: MessageTypes.PING, ts: 1 });
    const raw = base64ToBytes(frame.ct);
    raw[0] ^= 0xff;
    frame.ct = bytesToBase64(raw);
    expect(() => receiver.open(frame)).toThrow(/authentication/);
  });

  it("rejects reflection across directions", () => {
    // An attacker bouncing a c2h frame back at the client must fail: the
    // client's receive path authenticates under direction label "h2c".
    const sender = new SessionCipher(keys, "client", 1 << 20);
    const clientReceiver = new SessionCipher(keys, "client", 1 << 20);
    const frame = sender.seal({ v: PROTOCOL_VERSION, t: MessageTypes.PING, ts: 1 });
    expect(() => clientReceiver.open(frame)).toThrow();
  });
});

describe("handshake (CLX1)", () => {
  const makePeers = () => ({
    client: DeviceIdentity.create(),
    host: DeviceIdentity.create()
  });

  const target = (appId: string, host: DeviceIdentity) => ({
    appId,
    pubEdB64: bytesToBase64(host.edPublicKey),
    pubXB64: bytesToBase64(host.xPublicKey)
  });

  it("establishes matching traffic keys", () => {
    const { client, host } = makePeers();
    const { init, state } = clientBeginSession(client, target("com.example.notes", host), {
      nowMs: Date.now()
    });
    const hostResult = hostCompleteSession(host, "com.example.notes", client.edPublicKey, init);
    const clientKeys = clientCompleteSession(
      client,
      state,
      init,
      hostResult.accept,
      { pubEd: host.edPublicKey, pubX: host.xPublicKey }
    );
    const same = (a: Uint8Array, b: Uint8Array) => a.every((v, i) => v === b[i]);
    expect(same(clientKeys.c2h, hostResult.keys.c2h)).toBe(true);
    expect(same(clientKeys.h2c, hostResult.keys.h2c)).toBe(true);
  });

  it("establishes transcript-bound hybrid X25519 + ML-KEM-768 keys", () => {
    const { client, host } = makePeers();
    const { init, state } = clientBeginSession(client, target("com.example.pq", host), {
      hybridPq: "required"
    });
    const hostResult = hostCompleteSession(host, "com.example.pq", client.edPublicKey, init, {
      hybridPq: "required"
    });
    const clientKeys = clientCompleteSession(
      client,
      state,
      init,
      hostResult.accept,
      { pubEd: host.edPublicKey, pubX: host.xPublicKey }
    );
    expect(init.pq?.suite).toBe("ML-KEM-768");
    expect(hostResult.accept.pq?.suite).toBe("ML-KEM-768");
    expect(clientKeys.c2h).toEqual(hostResult.keys.c2h);
    expect(clientKeys.h2c).toEqual(hostResult.keys.h2c);
    expect(state.pqSecretKey?.every((byte) => byte === 0)).toBe(true);
  });

  it("fails closed when either peer requires hybrid PQ", () => {
    const { client, host } = makePeers();
    const classical = clientBeginSession(client, target("app", host));
    expect(() => hostCompleteSession(host, "app", client.edPublicKey, classical.init, {
      hybridPq: "required"
    })).toThrow(/hybrid PQ exchange is required/);

    const hybrid = clientBeginSession(client, target("app", host), { hybridPq: "required" });
    const accepted = hostCompleteSession(host, "app", client.edPublicKey, hybrid.init, {
      hybridPq: "preferred"
    }).accept;
    delete accepted.pq;
    expect(() => clientCompleteSession(
      client,
      hybrid.state,
      hybrid.init,
      accepted,
      { pubEd: host.edPublicKey, pubX: host.xPublicKey }
    )).toThrow(/required hybrid PQ/);
  });

  it("detects tampering with PQ offer and ciphertext through handshake signatures", () => {
    const { client, host } = makePeers();
    const offered = clientBeginSession(client, target("app", host), { hybridPq: "required" });
    offered.init.pq!.ek = bytesToBase64(base64ToBytes(offered.init.pq!.ek).map((byte, index) =>
      index === 0 ? byte ^ 1 : byte
    ));
    expect(() => hostCompleteSession(host, "app", client.edPublicKey, offered.init, {
      hybridPq: "required"
    })).toThrow(/signature invalid/);

    const clean = clientBeginSession(client, target("app", host), { hybridPq: "required" });
    const hostResult = hostCompleteSession(host, "app", client.edPublicKey, clean.init, {
      hybridPq: "required"
    });
    hostResult.accept.pq!.ct = bytesToBase64(
      base64ToBytes(hostResult.accept.pq!.ct).map((byte, index) => index === 0 ? byte ^ 1 : byte)
    );
    expect(() => clientCompleteSession(
      client,
      clean.state,
      clean.init,
      hostResult.accept,
      { pubEd: host.edPublicKey, pubX: host.xPublicKey }
    )).toThrow(/signature invalid/);
  });

  it("binds the handshake to the application id", () => {
    const { client, host } = makePeers();
    const { init } = clientBeginSession(client, target("com.example.notes", host), {
      nowMs: Date.now()
    });
    expect(() =>
      hostCompleteSession(host, "com.other.app", client.edPublicKey, init)
    ).toThrow(/different application/);
  });

  it("rejects stale timestamps and impostor signatures", () => {
    const { client, host } = makePeers();
    const impostor = DeviceIdentity.create();

    const stale = clientBeginSession(client, target("app", host), {
      nowMs: Date.now() - 10 * 60_000
    }).init;
    expect(() =>
      hostCompleteSession(host, "app", client.edPublicKey, stale, { nowMs: Date.now() })
    ).toThrow(CrosslinkError);

    const forged = clientBeginSession(impostor, target("app", host), { nowMs: Date.now() }).init;
    // device record says the paired key is `client`, but init was signed by impostor
    expect(() =>
      hostCompleteSession(host, "app", client.edPublicKey, forged, { nowMs: Date.now() })
    ).toThrow(/signature invalid/);
  });
});

describe("capabilities + validation", () => {
  const registry = new CapabilityRegistry().registerAll([
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
    { id: "notes.write", title: "Write notes", risk: "medium" },
    { id: "terminal.execute", title: "Run commands", risk: "high" }
  ]);

  it("grant matrix", () => {
    const grants = new DeviceGrants();
    grants.grant("dev1", ["notes.read"]);
    expect(grants.hasAll("dev1", ["notes.read"])).toBe(true);
    expect(grants.hasAll("dev1", ["notes.read", "notes.write"])).toBe(false);

    expect(() => authorizeOrThrow(grants, "dev1", "m.notes", [])).not.toThrow();
    expect(() => authorizeOrThrow(grants, "dev1", "m.notes", ["notes.write"])).toThrow(
      /requires capabilities/
    );

    grants.revoke("dev1");
    expect(grants.hasAll("dev1", ["notes.read"])).toBe(false);
    grants.grant("dev1", ["terminal.execute"]);
    expect(() => authorizeOrThrow(grants, "dev1", "m.exec", ["terminal.execute"])).not.toThrow();
    void registry;
  });

  it("miniValidator enforces object shapes", () => {
    const validate = miniValidator({
      type: "object",
      properties: { title: { type: "string", minLen: 1 }, n: { type: "number", int: true } },
      required: ["title"]
    });
    expect(validate({ title: "ok", n: 3 })).toBeNull();
    expect(validate({ n: 3 })?.code).toBe("validation_failed");
    expect(validate({ title: "" })?.message).toContain("shorter");
    expect(validate({ title: "ok", extra: true })?.message).toContain("unexpected property");
  });

  it("refuses a schema whose constraint key it does not implement", () => {
    // `maxLength` is the JSON Schema spelling; this validator's field is
    // `maxLen`. Accepting the misspelling would validate nothing at all, and
    // the input it was meant to bound would cross the trust boundary unchecked.
    expect(() =>
      miniValidator({ type: "string", maxLength: 200 } as never)
    ).toThrow(/unknown key "maxLength"/);
  });

  it("checks nested schemas for the same mistake", () => {
    expect(() =>
      miniValidator({
        type: "object",
        properties: { title: { type: "string", minLength: 1 } }
      } as never)
    ).toThrow(/unknown key "minLength" in string schema at \$\.title/);

    expect(() =>
      miniValidator({ type: "array", items: { type: "number", minimum: 0 } } as never)
    ).toThrow(/unknown key "minimum".*\$\[\]/);
  });
});
