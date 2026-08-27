/**
 * Permission policy and per-use consent.
 *
 * Capabilities answer "what may this device ask for". Permissions answer the
 * two questions capabilities alone leave open:
 *
 *  1. At pairing time, which of the capabilities a client *requests* is the
 *     host willing to hand out at all? A client asks for whatever it likes;
 *     without a policy the only thing between a request and a grant is a
 *     human pressing "y" on a list they did not write. `PermissionPolicy` is
 *     the host-authored allowlist that request is filtered through, before
 *     any human ever sees it.
 *
 *  2. At call time, are there capabilities whose grant is not a standing
 *     permission but a licence to *ask*? `confirmEachUse` capabilities route
 *     every invocation through `ConsentBroker`, which prompts the host user
 *     and remembers the answer only as far as the user said it should.
 *
 * Both are default-deny: an empty policy grants nothing beyond what the
 * capability registry marks `defaultGranted`, and an unanswered consent
 * prompt denies.
 */
import { CrosslinkError, ErrorCodes } from "@crosslink/protocol";
import type { CapabilityDef, CapabilityRegistry, CapabilityRisk } from "./capabilities.js";
import { noopLogger, type Logger } from "./logger.js";

const RISK_ORDER: Record<CapabilityRisk, number> = { low: 1, medium: 2, high: 3 };

/* ------------------------------------------------------------------ */
/* policy                                                              */
/* ------------------------------------------------------------------ */

export interface PermissionPolicy {
  /**
   * Capabilities a device may ever hold. `"*"` (the default) means "anything
   * in the registry"; an explicit array is a hard allowlist and anything
   * outside it is denied even if the user approves.
   */
  allow?: string[] | "*";
  /** Hard deny list; wins over `allow` and over any human approval. */
  deny?: string[];
  /**
   * Highest risk tier that may be granted without an explicit human decision
   * (i.e. under `autoApprove`). Defaults to "low": auto-approval is a
   * development convenience and must not silently hand out write access.
   * `"none"` disables auto-approval entirely.
   */
  maxAutoGrantRisk?: CapabilityRisk | "none";
  /**
   * Capabilities that always require a human decision even when the approve
   * hook would accept in bulk. `"high"` (default) means every high-risk
   * capability; `"all"` means every capability.
   */
  requireApproval?: string[] | "high" | "all" | "none";
  /** Grants lapse this long after being issued; the device must re-request. */
  grantTtlMs?: number;
  /** Refuses to grant more than this many capabilities to one device. */
  maxCapabilitiesPerDevice?: number;
  /** Refuses to pair beyond this many non-revoked devices. */
  maxDevices?: number;
}

export interface PolicyContext {
  deviceId: string;
  deviceName?: string;
  /** count of currently paired, non-revoked devices (excluding this one) */
  pairedDeviceCount?: number;
  /** true when the grant is being decided without a human in the loop */
  autoApprove?: boolean;
}

export interface PolicyDecision {
  /** capabilities that may be granted with no further questions */
  granted: string[];
  /** capabilities that may be granted only if a human explicitly approves */
  needsApproval: string[];
  /** capabilities refused outright, with the reason */
  denied: Array<{ id: string; reason: DenyReason }>;
}

export type DenyReason =
  | "unknown-capability"
  | "deny-list"
  | "not-in-allow-list"
  | "risk-above-auto-grant"
  | "too-many-capabilities"
  | "too-many-devices";

export const DEFAULT_PERMISSION_POLICY: Required<
  Pick<PermissionPolicy, "allow" | "deny" | "maxAutoGrantRisk" | "requireApproval">
> = {
  allow: "*",
  deny: [],
  maxAutoGrantRisk: "low",
  requireApproval: "high"
};

export class PermissionEngine {
  private readonly policy: PermissionPolicy;

  constructor(
    private readonly registry: CapabilityRegistry,
    policy: PermissionPolicy = {},
    private readonly logger: Logger = noopLogger
  ) {
    this.policy = { ...DEFAULT_PERMISSION_POLICY, ...policy };
  }

  get grantTtlMs(): number | undefined {
    return this.policy.grantTtlMs;
  }

  /**
   * Filters a device's requested capabilities into grant / ask / deny buckets.
   * Never throws for ordinary denials - `denied` carries the reasons so the
   * host can show the user exactly what was trimmed and why.
   */
  evaluate(requested: readonly string[], ctx: PolicyContext): PolicyDecision {
    const decision: PolicyDecision = { granted: [], needsApproval: [], denied: [] };

    if (
      this.policy.maxDevices !== undefined &&
      (ctx.pairedDeviceCount ?? 0) >= this.policy.maxDevices
    ) {
      for (const id of requested) decision.denied.push({ id, reason: "too-many-devices" });
      this.logger.warn("permission.policy.device-limit", {
        deviceId: ctx.deviceId,
        limit: this.policy.maxDevices,
        paired: ctx.pairedDeviceCount
      });
      return decision;
    }

    const seen = new Set<string>();
    for (const id of requested) {
      if (seen.has(id)) continue;
      seen.add(id);

      const def = this.registry.get(id);
      if (!def) {
        decision.denied.push({ id, reason: "unknown-capability" });
        continue;
      }
      if (this.policy.deny?.includes(id)) {
        decision.denied.push({ id, reason: "deny-list" });
        continue;
      }
      if (Array.isArray(this.policy.allow) && !this.policy.allow.includes(id)) {
        decision.denied.push({ id, reason: "not-in-allow-list" });
        continue;
      }
      if (
        decision.granted.length + decision.needsApproval.length >=
        (this.policy.maxCapabilitiesPerDevice ?? Number.POSITIVE_INFINITY)
      ) {
        decision.denied.push({ id, reason: "too-many-capabilities" });
        continue;
      }

      if (this.requiresApproval(def)) {
        if (ctx.autoApprove) {
          // Auto-approval is never allowed to satisfy an explicit-approval
          // capability: that is the whole point of marking it.
          decision.denied.push({ id, reason: "risk-above-auto-grant" });
          continue;
        }
        decision.needsApproval.push(id);
        continue;
      }

      if (ctx.autoApprove && !this.withinAutoGrantRisk(def)) {
        decision.denied.push({ id, reason: "risk-above-auto-grant" });
        continue;
      }

      decision.granted.push(id);
    }

    this.logger.debug("permission.policy.evaluated", {
      deviceId: ctx.deviceId,
      requested: [...seen],
      granted: decision.granted,
      needsApproval: decision.needsApproval,
      denied: decision.denied
    });
    return decision;
  }

  /** True when `def` may never be granted without a human saying so. */
  requiresApproval(def: CapabilityDef): boolean {
    const rule = this.policy.requireApproval ?? "high";
    if (rule === "none") return false;
    if (rule === "all") return true;
    if (rule === "high") return def.risk === "high";
    return rule.includes(def.id);
  }

  private withinAutoGrantRisk(def: CapabilityDef): boolean {
    const max = this.policy.maxAutoGrantRisk ?? "low";
    if (max === "none") return false;
    return RISK_ORDER[def.risk] <= RISK_ORDER[max];
  }

  /** Expiry timestamp for a freshly issued grant, or undefined for no expiry. */
  grantExpiryFrom(now: number = Date.now()): number | undefined {
    return this.policy.grantTtlMs === undefined ? undefined : now + this.policy.grantTtlMs;
  }
}

/* ------------------------------------------------------------------ */
/* per-use consent                                                     */
/* ------------------------------------------------------------------ */

export interface ConsentRequest {
  deviceId: string;
  deviceName?: string;
  method: string;
  capability: string;
  risk: CapabilityRisk;
  title: string;
  description?: string;
  /** the request payload, so the prompt can say *what* is being asked for */
  input?: unknown;
}

/**
 * `true` / `"once"`  - allow this call only.
 * `"session"`        - allow until the device disconnects or is revoked.
 * `"always"`         - allow until the grant is revoked or expires.
 * `false` / `"deny"` - refuse this call.
 */
export type ConsentDecision = boolean | "once" | "session" | "always" | "deny";

export type ConsentPrompt = (
  request: ConsentRequest
) => ConsentDecision | Promise<ConsentDecision>;

export interface ConsentBrokerOptions {
  registry: CapabilityRegistry;
  /** Asked whenever a `confirmEachUse` capability is invoked with no cached answer. */
  prompt?: ConsentPrompt;
  /** How long a "session" decision survives. Default: until explicitly cleared. */
  sessionTtlMs?: number;
  /** How long an "always" decision survives. Default: 24 hours. */
  alwaysTtlMs?: number;
  /** Refuses the call if the prompt has not answered within this long. */
  promptTimeoutMs?: number;
  logger?: Logger;
}

interface CachedConsent {
  scope: "session" | "always";
  expiresAt?: number;
}

/**
 * Enforces `confirmEachUse` capabilities. A grant for such a capability is a
 * licence to ask, not a standing permission: every invocation is checked
 * against a cache of decisions the user actually made.
 */
export class ConsentBroker {
  private readonly cache = new Map<string, CachedConsent>();
  /** de-duplicates concurrent prompts for the same device+capability */
  private readonly inflight = new Map<string, Promise<ConsentDecision>>();
  private readonly logger: Logger;

  constructor(private readonly options: ConsentBrokerOptions) {
    this.logger = options.logger ?? noopLogger;
  }

  /** True when this capability requires per-use confirmation. */
  requiresConsent(capabilityId: string): boolean {
    return this.options.registry.get(capabilityId)?.confirmEachUse === true;
  }

  /**
   * Resolves when the call may proceed; throws CONSENT_DENIED /
   * CONSENT_TIMEOUT otherwise. Capabilities without `confirmEachUse` resolve
   * immediately.
   */
  async require(
    request: Omit<ConsentRequest, "risk" | "title" | "description">
  ): Promise<void> {
    const def = this.options.registry.get(request.capability);
    if (!def?.confirmEachUse) return;

    const key = cacheKey(request.deviceId, request.capability);
    const cached = this.cache.get(key);
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
      this.logger.trace("consent.cached", {
        deviceId: request.deviceId,
        capability: request.capability,
        scope: cached.scope
      });
      return;
    }
    if (cached) this.cache.delete(key);

    const full: ConsentRequest = {
      ...request,
      risk: def.risk,
      title: def.title,
      description: def.description
    };

    // A host with no prompt configured cannot obtain consent, and silence is
    // a refusal - otherwise `confirmEachUse` would weaken to a no-op.
    if (!this.options.prompt) {
      this.logger.warn("consent.no-prompt", {
        deviceId: request.deviceId,
        capability: request.capability,
        method: request.method
      });
      throw new CrosslinkError(
        ErrorCodes.CONSENT_DENIED,
        `capability "${request.capability}" requires per-use confirmation but the host has no consent prompt configured`,
        { capability: request.capability, method: request.method }
      );
    }

    let decision: ConsentDecision;
    const pending = this.inflight.get(key);
    if (pending) {
      decision = await pending;
    } else {
      const run = this.ask(full);
      this.inflight.set(key, run);
      try {
        decision = await run;
      } finally {
        this.inflight.delete(key);
      }
    }

    if (decision === false || decision === "deny") {
      this.logger.info("consent.denied", {
        deviceId: request.deviceId,
        capability: request.capability,
        method: request.method
      });
      throw new CrosslinkError(
        ErrorCodes.CONSENT_DENIED,
        `the host user declined "${def.title}"`,
        { capability: request.capability, method: request.method }
      );
    }

    if (decision === "session" || decision === "always") {
      this.cache.set(key, {
        scope: decision,
        expiresAt:
          decision === "session"
            ? this.options.sessionTtlMs === undefined
              ? undefined
              : Date.now() + this.options.sessionTtlMs
            : Date.now() + (this.options.alwaysTtlMs ?? 24 * 3600_000)
      });
    }
    this.logger.info("consent.granted", {
      deviceId: request.deviceId,
      capability: request.capability,
      method: request.method,
      scope: decision === true || decision === "once" ? "once" : decision
    });
  }

  private async ask(request: ConsentRequest): Promise<ConsentDecision> {
    const timeoutMs = this.options.promptTimeoutMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve(this.options.prompt!(request)),
        new Promise<ConsentDecision>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new CrosslinkError(
                  ErrorCodes.CONSENT_TIMEOUT,
                  `no answer to the confirmation for "${request.title}"`,
                  { capability: request.capability, method: request.method }
                )
              ),
            timeoutMs
          );
        })
      ]);
    } catch (err) {
      if (err instanceof CrosslinkError) throw err;
      this.logger.warn("consent.prompt-failed", {
        deviceId: request.deviceId,
        capability: request.capability,
        error: err
      });
      throw new CrosslinkError(ErrorCodes.CONSENT_DENIED, "the consent prompt failed", {
        capability: request.capability
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Drops "session"-scoped decisions for a device (called on disconnect). */
  endSession(deviceId: string): void {
    for (const [key, value] of [...this.cache]) {
      if (value.scope === "session" && key.startsWith(`${deviceId} `)) {
        this.cache.delete(key);
      }
    }
  }

  /** Drops every decision for a device (called on revocation). */
  forget(deviceId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${deviceId} `)) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
  }

  /** Diagnostics: current cached decisions. */
  snapshot(): Array<{ deviceId: string; capability: string; scope: string; expiresAt?: number }> {
    return [...this.cache].map(([key, value]) => {
      const [deviceId, capability] = key.split(" ");
      return { deviceId, capability, scope: value.scope, expiresAt: value.expiresAt };
    });
  }
}

function cacheKey(deviceId: string, capability: string): string {
  return `${deviceId} ${capability}`;
}
