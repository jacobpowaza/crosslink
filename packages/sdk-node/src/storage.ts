import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { HostDeviceStore, TrustedDeviceRecord } from "@crosslink/core";
import { DeviceIdentity, cascadeRevokeLinked, noopLogger } from "@crosslink/core";
import { openSecretStore, type SecretStore, type SecretStoreOptions } from "./keychain.js";

/** Key under which the host identity seed lives in a SecretStore. */
export const IDENTITY_SEED_KEY = "host.identity.seed";

/** Tiny atomic JSON file store (tmp write + rename, mode 600). */
export class JsonStore<T> {
  constructor(readonly filePath: string) {}

  load(defaults: T): T {
    try {
      if (!existsSync(this.filePath)) {
        this.save(defaults);
        return defaults;
      }
      return JSON.parse(readFileSync(this.filePath, "utf8")) as T;
    } catch {
      return defaults;
    }
  }

  save(data: T): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

/**
 * Loads (or creates) the host identity from a plaintext `identity.json`.
 *
 * @deprecated Prefer {@link loadOrCreateIdentitySecurely}, which keeps the seed
 * in the OS keychain. This remains for embedders that manage their own
 * at-rest encryption, and as the migration source for existing installs.
 */
export function loadOrCreateIdentity(storageDir: string): DeviceIdentity {
  const store = new JsonStore<{ v: 1; seed_b64: string }>(path.join(storageDir, "identity.json"));
  const data = store.load({ v: 1, seed_b64: "" });
  if (data.seed_b64) {
    return DeviceIdentity.fromSeed(Buffer.from(data.seed_b64, "base64"));
  }
  const identity = DeviceIdentity.create();
  store.save({
    v: 1,
    seed_b64: Buffer.from(identity.seed).toString("base64")
  });
  return identity;
}

export interface SecureIdentityResult {
  identity: DeviceIdentity;
  /** Which backend the seed is stored in, for status output. */
  store: SecretStore;
  /** True when this call moved a seed out of a legacy plaintext identity.json. */
  migrated: boolean;
}

/**
 * Loads (or creates) the host identity with the seed held in the OS keychain,
 * falling back through the backends {@link openSecretStore} selects.
 *
 * An existing plaintext `identity.json` is migrated in on first run: the seed
 * is copied into the secret store and the plaintext file is deleted, so an
 * upgrade keeps the host's identity (and therefore every existing pairing)
 * rather than silently minting a new one and orphaning paired devices.
 */
export async function loadOrCreateIdentitySecurely(
  options: SecretStoreOptions & { secretStore?: SecretStore }
): Promise<SecureIdentityResult> {
  const log = options.logger ?? noopLogger;
  const store = options.secretStore ?? (await openSecretStore(options));

  const stored = await store.get(IDENTITY_SEED_KEY);
  if (stored) {
    return { identity: DeviceIdentity.fromSeed(Buffer.from(stored, "base64")), store, migrated: false };
  }

  const legacyPath = path.join(options.storageDir, "identity.json");
  if (existsSync(legacyPath)) {
    const seedB64 = readLegacySeed(legacyPath);
    if (seedB64) {
      await store.set(IDENTITY_SEED_KEY, seedB64);
      // Only remove the plaintext copy once the secret store has it, and only
      // if we can read it back: a failed migration must not destroy the key.
      const verify = await store.get(IDENTITY_SEED_KEY);
      if (verify === seedB64) {
        try {
          unlinkSync(legacyPath);
        } catch {
          /* the seed is safe either way; a stale file is a warning, not a fault */
        }
        log.info("identity.migrated", { from: "identity.json", to: store.kind });
        return {
          identity: DeviceIdentity.fromSeed(Buffer.from(seedB64, "base64")),
          store,
          migrated: true
        };
      }
      log.warn("identity.migration-unverified", { to: store.kind });
      return {
        identity: DeviceIdentity.fromSeed(Buffer.from(seedB64, "base64")),
        store,
        migrated: false
      };
    }
  }

  const identity = DeviceIdentity.create();
  await store.set(IDENTITY_SEED_KEY, Buffer.from(identity.seed).toString("base64"));
  log.info("identity.created", { store: store.kind, deviceId: identity.deviceId });
  return { identity, store, migrated: false };
}

function readLegacySeed(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { seed_b64?: string };
    return parsed.seed_b64 || null;
  } catch {
    return null;
  }
}

interface DevicesFile {
  v: 1;
  devices: TrustedDeviceRecord[];
}

/** HostDeviceStore persisted to devices.json inside the storage dir. */
export class FileHostDeviceStore implements HostDeviceStore {
  private file: JsonStore<DevicesFile>;
  private devices = new Map<string, TrustedDeviceRecord>();

  constructor(storageDir: string) {
    this.file = new JsonStore(path.join(storageDir, "devices.json"));
    const data = this.file.load({ v: 1, devices: [] });
    for (const d of data.devices) this.devices.set(d.deviceId, d);
  }

  private persist(): void {
    this.file.save({ v: 1, devices: [...this.devices.values()] });
  }

  list(): TrustedDeviceRecord[] {
    return [...this.devices.values()];
  }

  get(deviceId: string): TrustedDeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  upsert(record: TrustedDeviceRecord): void {
    this.devices.set(record.deviceId, { ...record });
    this.persist();
  }

  revoke(deviceId: string, atMs: number): boolean {
    const rec = this.devices.get(deviceId);
    if (!rec || rec.revokedAt !== undefined) return false;
    rec.revokedAt = atMs;
    cascadeRevokeLinked(this.devices.values(), deviceId, atMs);
    this.persist();
    return true;
  }

  setCaps(deviceId: string, caps: string[]): void {
    const rec = this.devices.get(deviceId);
    if (!rec) return;
    rec.caps = [...caps];
    this.persist();
  }

  setLastSeen(deviceId: string, atMs: number): void {
    const rec = this.devices.get(deviceId);
    if (!rec) return;
    rec.lastSeen = atMs;
    this.persist();
  }
}
