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
}

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
