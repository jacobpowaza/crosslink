/**
 * Capability-based authorization. The host is the enforcement point: every RPC
 * request is checked against the requesting device's granted set, every time.
 */
import { CrosslinkError, ErrorCodes } from "@crosslink/protocol";

export type CapabilityRisk = "low" | "medium" | "high";

export interface CapabilityDef {
  /** stable id, e.g. "notes.write" */
  id: string;
  title: string;
  description?: string;
  risk: CapabilityRisk;
  /** granted by default at pairing when the client requests it */
  defaultGranted?: boolean;
  /** require explicit user confirmation on host for each use (future) */
  confirmEachUse?: boolean;
}

const CAP_ID_RE = /^[a-z0-9][a-z0-9_.:@/-]{0,127}$/;

export class CapabilityRegistry {
  private defs = new Map<string, CapabilityDef>();

  register(def: CapabilityDef): this {
    if (!CAP_ID_RE.test(def.id)) {
      throw new TypeError(`invalid capability id: ${def.id}`);
    }
    if (!["low", "medium", "high"].includes(def.risk)) {
      throw new TypeError(`invalid risk for ${def.id}`);
    }
    this.defs.set(def.id, def);
    return this;
  }

  registerAll(defs: CapabilityDef[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get(id: string): CapabilityDef | undefined {
    return this.defs.get(id);
  }

  all(): CapabilityDef[] {
    return [...this.defs.values()];
  }

  defaultGrantedIds(): string[] {
    return this.all().filter((d) => d.defaultGranted).map((d) => d.id);
  }
}

export interface GrantOptions {
  /**
   * Epoch ms after which the grant no longer authorizes anything. Expired
   * grants are reported separately from missing ones so the client can tell
   * "you never had this" from "ask the user again".
   */
  expiresAt?: number;
}

/**
 * Per-device grant sets owned by the host.
 *
 * Grants may carry an expiry. Expiry is evaluated on every check rather than
 * swept on a timer, so a stalled event loop can never widen a device's
 * authority past the moment it was supposed to lapse.
 */
export class DeviceGrants {
  private grants = new Map<string, Map<string, GrantOptions>>();

  grant(deviceId: string, caps: string | string[], options: GrantOptions = {}): void {
    const list = Array.isArray(caps) ? caps : [caps];
    let map = this.grants.get(deviceId);
    if (!map) {
      map = new Map();
      this.grants.set(deviceId, map);
    }
    for (const c of list) map.set(c, { ...options });
  }

  revoke(deviceId: string, cap?: string): void {
    if (cap === undefined) {
      this.grants.delete(deviceId);
      return;
    }
    this.grants.get(deviceId)?.delete(cap);
  }

  drop(deviceId: string): void {
    this.grants.delete(deviceId);
  }

  /** Currently valid (non-expired) capability ids held by the device. */
  grantedTo(deviceId: string, now: number = Date.now()): string[] {
    const map = this.grants.get(deviceId);
    if (!map) return [];
    return [...map].filter(([, opts]) => !isExpired(opts, now)).map(([id]) => id);
  }

  /** Capability ids the device held but whose grant has lapsed. */
  expiredFor(deviceId: string, now: number = Date.now()): string[] {
    const map = this.grants.get(deviceId);
    if (!map) return [];
    return [...map].filter(([, opts]) => isExpired(opts, now)).map(([id]) => id);
  }

  expiresAt(deviceId: string, cap: string): number | undefined {
    return this.grants.get(deviceId)?.get(cap)?.expiresAt;
  }

  hasAll(deviceId: string, required: readonly string[], now: number = Date.now()): boolean {
    const map = this.grants.get(deviceId);
    if (!map) return required.length === 0;
    return required.every((c) => {
      const opts = map.get(c);
      return opts !== undefined && !isExpired(opts, now);
    });
  }

  /** True when the device is known at all (even with zero capabilities). */
  knows(deviceId: string): boolean {
    return this.grants.has(deviceId);
  }
}

function isExpired(options: GrantOptions, now: number): boolean {
  return options.expiresAt !== undefined && options.expiresAt <= now;
}

/**
 * Throws CAPABILITY_DENIED listing missing capabilities when unauthorized, or
 * GRANT_EXPIRED when the device once held them and the grant simply lapsed.
 */
export function authorizeOrThrow(
  grants: DeviceGrants,
  deviceId: string,
  method: string,
  required: readonly string[]
): void {
  if (required.length === 0) return;
  const missing = required.filter((c) => !grants.hasAll(deviceId, [c]));
  if (missing.length === 0) return;

  const expired = grants.expiredFor(deviceId).filter((c) => missing.includes(c));
  if (expired.length === missing.length) {
    throw new CrosslinkError(
      ErrorCodes.GRANT_EXPIRED,
      `method "${method}" requires capabilities whose grant has expired; re-pair or renew`,
      { method, expired, required: [...required] }
    );
  }
  throw new CrosslinkError(
    ErrorCodes.CAPABILITY_DENIED,
    `method "${method}" requires capabilities not granted to this device`,
    { method, missing, ...(expired.length > 0 ? { expired } : {}), required: [...required] }
  );
}
