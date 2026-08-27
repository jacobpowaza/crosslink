/**
 * Persistent device cryptographic identity stored in secure browser storage.
 * Uses the existing IndexedDB secure storage backend (non-exportable master key)
 * so the device private key never leaves encrypted storage in plaintext.
 */
import { createSecureStorage } from "./secure-storage.js";
import type { SecureStorage } from "./storage.js";

export interface DeviceCryptoStorage {
  load(): Promise<{ deviceId: string; edPrivateSeedB64: string } | null>;
  save(record: { deviceId: string; edPrivateSeedB64: string }): Promise<void>;
  clear(): Promise<void>;
}

export class SecureDeviceCryptoStorage implements DeviceCryptoStorage {
  private readonly storage: SecureStorage;

  private constructor(storage: SecureStorage) {
    this.storage = storage;
  }

  static async open(): Promise<SecureDeviceCryptoStorage> {
    const { storage } = await createSecureStorage({ allowPlaintextFallback: false });
    return new SecureDeviceCryptoStorage(storage);
  }

  private storageKey(appId: string): string {
    return `crosslink.device-crypto.${appId}`;
  }

  async load(appId?: string): Promise<{ deviceId: string; edPrivateSeedB64: string } | null> {
    const key = this.storageKey(appId ?? "default");
    const value = this.storage.get(key);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.deviceId === "string" && typeof parsed.edPrivateSeedB64 === "string") {
        return { deviceId: parsed.deviceId, edPrivateSeedB64: parsed.edPrivateSeedB64 };
      }
    } catch {}
    return null;
  }

  async save(record: { deviceId: string; edPrivateSeedB64: string }, appId?: string): Promise<void> {
    const key = this.storageKey(appId ?? "default");
    this.storage.set(key, JSON.stringify(record));
  }

  async clear(appId?: string): Promise<void> {
    const key = this.storageKey(appId ?? "default");
    this.storage.delete(key);
  }
}
