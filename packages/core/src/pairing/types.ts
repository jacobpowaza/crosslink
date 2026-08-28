/**
 * Pairing data types and stores shared by host and client implementations.
 */
import {
  Limits,
  canonicalJson,
  utf8ToBytes,
  bytesToBase64,
  base64ToBytes,
} from "@crosslink/protocol";
import { randomBytes } from "../crypto/primitives.js";

export interface TrustedDeviceRecord {
  deviceId: string;
  name: string;
  /** identity signing public key, base64 */
  pubEd: string;
  /** static agreement public key, base64 */
  pubX: string;
  caps: string[];
  addedAt: number;
  lastSeen?: number;
  revokedAt?: number;
  /**
   * deviceId of the already-trusted device whose session minted the device-link
   * token this device completed with — e.g. a browser tab handing off to the
   * same app installed to the home screen. Revoking the parent cascades to
   * every device linked from it, since to the user it's one continuous trust
   * relationship wearing two keypairs.
   */
  linkedFrom?: string;
}

/**
 * RPC method every host auto-registers so an already-trusted, connected
 * device can mint a single-use continuation token for itself — used to
 * silently re-establish trust from a fresh, storage-isolated context (e.g. an
 * iOS "Add to Home Screen" install, which does not share IndexedDB/localStorage
 * with the Safari tab that originally paired).
 */
export const DEVICE_LINK_RPC_METHOD = "crosslink.system.deviceLink.create";

export interface PairedAppRecord {
  appId: string;
  appName: string;
  /** full hex fingerprint of host identity key */
  fingerprint: string;
  pubEdB64: string;
  pubXB64: string;
  grantedCaps: string[];
  pairedAt: number;
  lastConnected?: number;
}

export interface HostDeviceStore {
  list(): TrustedDeviceRecord[];
  get(deviceId: string): TrustedDeviceRecord | undefined;
  upsert(record: TrustedDeviceRecord): void;
  revoke(deviceId: string, atMs: number): boolean;
  setCaps(deviceId: string, caps: string[]): void;
}

export interface ClientAppStore {
  list(): PairedAppRecord[];
  get(appId: string): PairedAppRecord | undefined;
  upsert(record: PairedAppRecord): void;
  remove(appId: string): void;
}

/**
 * Revokes every device transitively linked from `rootDeviceId` (breadth-first,
 * so a chain of hand-offs is fully covered, not just the direct child).
 * Mutates records in place; callers persist afterward.
 */
export function cascadeRevokeLinked(
  all: Iterable<TrustedDeviceRecord>,
  rootDeviceId: string,
  atMs: number
): void {
  const records = [...all];
  const queue = [rootDeviceId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const rec of records) {
      if (rec.linkedFrom === parent && rec.revokedAt === undefined) {
        rec.revokedAt = atMs;
        queue.push(rec.deviceId);
      }
    }
  }
}

export class InMemoryHostDeviceStore implements HostDeviceStore {
  private records = new Map<string, TrustedDeviceRecord>();
  list(): TrustedDeviceRecord[] {
    return [...this.records.values()];
  }
  get(deviceId: string): TrustedDeviceRecord | undefined {
    return this.records.get(deviceId);
  }
  upsert(record: TrustedDeviceRecord): void {
    this.records.set(record.deviceId, record);
  }
  revoke(deviceId: string, atMs: number): boolean {
    const rec = this.records.get(deviceId);
    if (!rec || rec.revokedAt !== undefined) return false;
    rec.revokedAt = atMs;
    cascadeRevokeLinked(this.records.values(), deviceId, atMs);
    return true;
  }
  setCaps(deviceId: string, caps: string[]): void {
    const rec = this.records.get(deviceId);
    if (rec) rec.caps = [...caps];
  }
}

export class InMemoryClientAppStore implements ClientAppStore {
  private records = new Map<string, PairedAppRecord>();
  list(): PairedAppRecord[] {
    return [...this.records.values()];
  }
  get(appId: string): PairedAppRecord | undefined {
    return this.records.get(appId);
  }
  upsert(record: PairedAppRecord): void {
    this.records.set(record.appId, record);
  }
  remove(appId: string): void {
    this.records.delete(appId);
  }
}

/* ------------------------------------------------------------------ */
/* pairing codes                                                       */
/* ------------------------------------------------------------------ */

/** Generates a human-friendly single-use code: "483 921 004". */
export function generatePairingCode(): string {
  const bytes = randomBytes(5);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  const digits = (value % 1_000_000_000n).toString().padStart(9, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

export function normalizePairingCode(input: string): string {
  const d = input.replace(/\D/g, "");
  return d.length === 9
    ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`
    : input.trim();
}

export interface PairingSessionState {
  psid: string;
  code: string;
  expiresAt: number;
  used: boolean;
}

export function createPairingSession(ttlMs: number = Limits.PAIRING_CODE_TTL_MS): PairingSessionState {
  const bytes = randomBytes(16);
  return {
    psid: bytesToBase64(bytes),
    code: generatePairingCode(),
    expiresAt: Date.now() + ttlMs,
    used: false
  };
}

export const PAIRING_TRANSCRIPT = {
  claim: "crosslink-pair-claim-v1",
  challenge: "crosslink-pair-challenge-v1",
  complete: "crosslink-pair-complete-v1"
} as const;

/** Canonical byte payloads signed during pairing (deterministic across languages). */
export function pairingTranscriptBytes(
  kind: keyof typeof PAIRING_TRANSCRIPT,
  fields: unknown[]
): Uint8Array {
  return utf8ToBytes(canonicalJson([PAIRING_TRANSCRIPT[kind], ...fields]));
}

export { bytesToBase64, base64ToBytes };
