import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@crosslink/protocol";
import { CapabilityRegistry, DeviceGrants, authorizeOrThrow } from "./capabilities.js";
import { MemoryLogSink } from "./logger.js";
import { ConsentBroker, PermissionEngine, type ConsentPrompt } from "./permissions.js";

const DEVICE = "dev_test";

function registry(): CapabilityRegistry {
  return new CapabilityRegistry().registerAll([
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
    { id: "notes.write", title: "Write notes", risk: "medium" },
    { id: "files.delete", title: "Delete files", risk: "high" },
    { id: "shell.exec", title: "Run a command", risk: "high", confirmEachUse: true }
  ]);
}

describe("PermissionEngine", () => {
  it("defaults to auto-granting only low risk", () => {
    const engine = new PermissionEngine(registry());
    const decision = engine.evaluate(["notes.read", "notes.write"], {
      deviceId: DEVICE,
      autoApprove: true
    });

    expect(decision.granted).toEqual(["notes.read"]);
    expect(decision.denied).toEqual([{ id: "notes.write", reason: "risk-above-auto-grant" }]);
  });

  it("routes high-risk capabilities to a human even when the policy is permissive", () => {
    const engine = new PermissionEngine(registry(), { maxAutoGrantRisk: "high" });
    const decision = engine.evaluate(["notes.write", "files.delete"], { deviceId: DEVICE });

    expect(decision.granted).toEqual(["notes.write"]);
    expect(decision.needsApproval).toEqual(["files.delete"]);
  });

  it("refuses explicit-approval capabilities outright under autoApprove", () => {
    // A client must not be able to obtain a high-risk capability by pairing
    // against a host left in auto-approve mode.
    const engine = new PermissionEngine(registry(), { maxAutoGrantRisk: "high" });
    const decision = engine.evaluate(["files.delete"], {
      deviceId: DEVICE,
      autoApprove: true
    });

    expect(decision.granted).toEqual([]);
    expect(decision.needsApproval).toEqual([]);
    expect(decision.denied).toEqual([{ id: "files.delete", reason: "risk-above-auto-grant" }]);
  });

  it("treats the deny list as absolute", () => {
    const engine = new PermissionEngine(registry(), {
      deny: ["files.delete"],
      maxAutoGrantRisk: "high",
      requireApproval: "none"
    });
    const decision = engine.evaluate(["files.delete", "notes.read"], { deviceId: DEVICE });

    expect(decision.granted).toEqual(["notes.read"]);
    expect(decision.denied).toEqual([{ id: "files.delete", reason: "deny-list" }]);
  });

  it("treats an explicit allow list as an allowlist", () => {
    const engine = new PermissionEngine(registry(), {
      allow: ["notes.read"],
      requireApproval: "none"
    });
    const decision = engine.evaluate(["notes.read", "notes.write"], { deviceId: DEVICE });

    expect(decision.granted).toEqual(["notes.read"]);
    expect(decision.denied).toEqual([{ id: "notes.write", reason: "not-in-allow-list" }]);
  });

  it("rejects capabilities the registry has never heard of", () => {
    const decision = new PermissionEngine(registry()).evaluate(["made.up"], {
      deviceId: DEVICE
    });
    expect(decision.denied).toEqual([{ id: "made.up", reason: "unknown-capability" }]);
  });

  it("caps how many capabilities one device may hold", () => {
    const engine = new PermissionEngine(registry(), {
      maxCapabilitiesPerDevice: 1,
      requireApproval: "none",
      maxAutoGrantRisk: "high"
    });
    const decision = engine.evaluate(["notes.read", "notes.write"], { deviceId: DEVICE });

    expect(decision.granted).toEqual(["notes.read"]);
    expect(decision.denied).toEqual([{ id: "notes.write", reason: "too-many-capabilities" }]);
  });

  it("refuses everything once the device limit is reached", () => {
    const engine = new PermissionEngine(registry(), { maxDevices: 2 });
    const decision = engine.evaluate(["notes.read"], {
      deviceId: DEVICE,
      pairedDeviceCount: 2
    });

    expect(decision.granted).toEqual([]);
    expect(decision.denied).toEqual([{ id: "notes.read", reason: "too-many-devices" }]);
  });

  it("deduplicates a repeated request", () => {
    const engine = new PermissionEngine(registry());
    const decision = engine.evaluate(["notes.read", "notes.read"], {
      deviceId: DEVICE,
      autoApprove: true
    });
    expect(decision.granted).toEqual(["notes.read"]);
  });

  it("computes grant expiry only when a TTL is configured", () => {
    expect(new PermissionEngine(registry()).grantExpiryFrom(1000)).toBeUndefined();
    expect(
      new PermissionEngine(registry(), { grantTtlMs: 5000 }).grantExpiryFrom(1000)
    ).toBe(6000);
  });

  it("logs the decision for the audit trail", () => {
    const sink = new MemoryLogSink();
    new PermissionEngine(registry(), {}, sink.logger()).evaluate(["notes.write"], {
      deviceId: DEVICE,
      autoApprove: true
    });
    const record = sink.matching("permission.policy")[0];
    expect(record.event).toBe("permission.policy.evaluated");
    expect(record.fields.deviceId).toBe(DEVICE);
  });
});

describe("DeviceGrants expiry", () => {
  it("stops honouring a grant the moment it lapses", () => {
    const grants = new DeviceGrants();
    grants.grant(DEVICE, ["notes.read"], { expiresAt: 1000 });

    expect(grants.hasAll(DEVICE, ["notes.read"], 999)).toBe(true);
    expect(grants.hasAll(DEVICE, ["notes.read"], 1000)).toBe(false);
    expect(grants.grantedTo(DEVICE, 1001)).toEqual([]);
    expect(grants.expiredFor(DEVICE, 1001)).toEqual(["notes.read"]);
  });

  it("keeps non-expiring grants indefinitely", () => {
    const grants = new DeviceGrants();
    grants.grant(DEVICE, ["notes.read"]);
    expect(grants.hasAll(DEVICE, ["notes.read"], Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("distinguishes an unknown device from one with zero capabilities", () => {
    const grants = new DeviceGrants();
    expect(grants.knows(DEVICE)).toBe(false);
    grants.grant(DEVICE, []);
    expect(grants.knows(DEVICE)).toBe(true);
    expect(grants.grantedTo(DEVICE)).toEqual([]);
  });

  it("reports GRANT_EXPIRED rather than CAPABILITY_DENIED for a lapsed grant", () => {
    const grants = new DeviceGrants();
    grants.grant(DEVICE, ["notes.write"], { expiresAt: Date.now() - 1 });

    expect(() => authorizeOrThrow(grants, DEVICE, "notes.create", ["notes.write"])).toThrow(
      expect.objectContaining({ code: ErrorCodes.GRANT_EXPIRED })
    );
  });

  it("reports CAPABILITY_DENIED when the device never held the capability", () => {
    const grants = new DeviceGrants();
    grants.grant(DEVICE, ["notes.read"]);

    expect(() => authorizeOrThrow(grants, DEVICE, "notes.create", ["notes.write"])).toThrow(
      expect.objectContaining({ code: ErrorCodes.CAPABILITY_DENIED })
    );
  });

  it("allows methods that require nothing", () => {
    const grants = new DeviceGrants();
    expect(() => authorizeOrThrow(grants, DEVICE, "ping", [])).not.toThrow();
  });
});

describe("ConsentBroker", () => {
  const base = { deviceId: DEVICE, method: "shell.run", capability: "shell.exec" };

  it("passes through capabilities that do not require per-use confirmation", async () => {
    const prompt = vi.fn();
    const broker = new ConsentBroker({ registry: registry(), prompt });
    await broker.require({ ...base, capability: "notes.read" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts for confirmEachUse capabilities and passes the request detail through", async () => {
    const prompt = vi.fn<ConsentPrompt>(() => "once");
    const broker = new ConsentBroker({ registry: registry(), prompt });

    await broker.require({ ...base, input: { cmd: "ls" } });

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "shell.exec",
        method: "shell.run",
        risk: "high",
        title: "Run a command",
        input: { cmd: "ls" }
      })
    );
  });

  it("asks again on every call when the answer was 'once'", async () => {
    const prompt = vi.fn<ConsentPrompt>(() => "once");
    const broker = new ConsentBroker({ registry: registry(), prompt });

    await broker.require(base);
    await broker.require(base);

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("remembers a 'session' answer until the session ends", async () => {
    const prompt = vi.fn<ConsentPrompt>(() => "session");
    const broker = new ConsentBroker({ registry: registry(), prompt });

    await broker.require(base);
    await broker.require(base);
    expect(prompt).toHaveBeenCalledTimes(1);

    broker.endSession(DEVICE);
    await broker.require(base);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("remembers an 'always' answer across sessions but not across revocation", async () => {
    const prompt = vi.fn<ConsentPrompt>(() => "always");
    const broker = new ConsentBroker({ registry: registry(), prompt });

    await broker.require(base);
    broker.endSession(DEVICE);
    await broker.require(base);
    expect(prompt).toHaveBeenCalledTimes(1);

    broker.forget(DEVICE);
    await broker.require(base);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("expires an 'always' answer after its TTL", async () => {
    vi.useFakeTimers();
    try {
      const prompt = vi.fn<ConsentPrompt>(() => "always");
      const broker = new ConsentBroker({ registry: registry(), prompt, alwaysTtlMs: 1000 });

      await broker.require(base);
      vi.setSystemTime(Date.now() + 2000);
      await broker.require(base);

      expect(prompt).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws CONSENT_DENIED when the user refuses", async () => {
    const broker = new ConsentBroker({ registry: registry(), prompt: () => false });
    await expect(broker.require(base)).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
  });

  it("does not cache a refusal - the user may say yes next time", async () => {
    let answer: boolean | "always" = false;
    const prompt = vi.fn<ConsentPrompt>(() => answer);
    const broker = new ConsentBroker({ registry: registry(), prompt });

    await expect(broker.require(base)).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
    answer = "always";
    await expect(broker.require(base)).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("denies when the host configured no prompt at all", async () => {
    // Silence must not weaken confirmEachUse into a no-op.
    const broker = new ConsentBroker({ registry: registry() });
    await expect(broker.require(base)).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
  });

  it("times out an unanswered prompt rather than hanging the request", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ConsentBroker({
        registry: registry(),
        prompt: () => new Promise<never>(() => {}),
        promptTimeoutMs: 50
      });
      const pending = broker.require(base);
      const assertion = expect(pending).rejects.toMatchObject({
        code: ErrorCodes.CONSENT_TIMEOUT
      });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a throwing prompt as a refusal", async () => {
    const broker = new ConsentBroker({
      registry: registry(),
      prompt: () => {
        throw new Error("UI crashed");
      }
    });
    await expect(broker.require(base)).rejects.toMatchObject({
      code: ErrorCodes.CONSENT_DENIED
    });
  });

  it("collapses concurrent prompts for the same device and capability", async () => {
    let resolvePrompt: (d: "always") => void = () => {};
    const prompt = vi.fn<ConsentPrompt>(
      () => new Promise<"always">((resolve) => (resolvePrompt = resolve))
    );
    const broker = new ConsentBroker({ registry: registry(), prompt });

    const a = broker.require(base);
    const b = broker.require(base);
    resolvePrompt("always");
    await Promise.all([a, b]);

    // Two simultaneous calls must not put two dialogs in front of the user.
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps decisions separate per device", async () => {
    const prompt = vi.fn<ConsentPrompt>(() => "always");
    const broker = new ConsentBroker({ registry: registry(), prompt });

    await broker.require(base);
    await broker.require({ ...base, deviceId: "dev_other" });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(broker.snapshot()).toHaveLength(2);
  });
});
