/**
 * Secret storage for Node hosts.
 *
 * A Crosslink host's identity seed is the thing that makes it *that* host: any
 * process that reads it can impersonate the application to every paired
 * device. Writing it to a mode-600 JSON file next to the code is fine for a
 * demo and wrong for a product - a mode-600 file is readable by every process
 * running as that user, survives in backups, and syncs to cloud drives.
 *
 * This module stores it in the operating system's own credential store when
 * one is reachable, and falls back to an authenticated-encryption file whose
 * key is itself kept in the OS store or derived from an operator passphrase.
 *
 * Backends are tried in order:
 *
 *  1. `keytar`         - libsecret / macOS Keychain / Windows Credential Vault.
 *  2. Electron `safeStorage` - the same vaults, via Electron's own binding.
 *  3. `EncryptedFileSecretStore` - AES-256-GCM, key from `CROSSLINK_SECRET_KEY`
 *     or a passphrase, scrypt-stretched.
 *  4. `PlaintextFileSecretStore` - mode-600 JSON. Refuses to be selected
 *     automatically unless explicitly allowed, so a silent downgrade to
 *     plaintext cannot happen by accident.
 *
 * `keytar` and `electron` are optional: they are imported dynamically and
 * their absence is a normal, quiet outcome rather than an error.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { noopLogger, type Logger } from "@crosslink/core";

export type SecretStoreKind =
  | "keytar"
  | "electron-safe-storage"
  | "encrypted-file"
  | "plaintext-file"
  | "memory";

/**
 * A named secret store. Keys are opaque identifiers scoped by `service`;
 * values are UTF-8 strings (Crosslink stores base64).
 */
export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** Human-readable description for status output and logs. */
  readonly description: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SecretStoreOptions {
  /** Service/account namespace in the OS store. Defaults to "crosslink". */
  service?: string;
  /** Directory for file-backed fallbacks. */
  storageDir: string;
  /**
   * Passphrase for the encrypted-file fallback. Defaults to
   * `CROSSLINK_SECRET_KEY` from the environment. Without either, the fallback
   * derives a machine-bound key, which protects against casual file copying
   * but not against a local attacker.
   */
  passphrase?: string;
  /**
   * Allows the plaintext fallback to be selected automatically. Off by
   * default: a host that silently degrades to plaintext is worse than one
   * that says it cannot protect the key.
   */
  allowPlaintextFallback?: boolean;
  /** Skip OS keychain probing (tests, headless CI). */
  preferFile?: boolean;
  logger?: Logger;
}

/* ------------------------------------------------------------------ */
/* backends                                                            */
/* ------------------------------------------------------------------ */

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

class KeytarSecretStore implements SecretStore {
  readonly kind = "keytar" as const;
  readonly description: string;

  constructor(
    private readonly keytar: KeytarModule,
    private readonly service: string
  ) {
    this.description = `OS keychain via keytar (service "${service}")`;
  }

  get(key: string): Promise<string | null> {
    return this.keytar.getPassword(this.service, key);
  }
  set(key: string, value: string): Promise<void> {
    return this.keytar.setPassword(this.service, key, value);
  }
  async delete(key: string): Promise<void> {
    await this.keytar.deletePassword(this.service, key);
  }
}

interface SafeStorageModule {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

/**
 * Electron's safeStorage encrypts with an OS-vault-held key but does not
 * itself persist anything, so the ciphertext lives in a file alongside it.
 */
class ElectronSafeStorageStore implements SecretStore {
  readonly kind = "electron-safe-storage" as const;
  readonly description = "Electron safeStorage (OS-backed encryption key)";
  private readonly file: string;

  constructor(
    private readonly safeStorage: SafeStorageModule,
    storageDir: string
  ) {
    this.file = path.join(storageDir, "secrets.safe.json");
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>): void {
    atomicWrite(this.file, JSON.stringify(data, null, 2));
  }

  async get(key: string): Promise<string | null> {
    const raw = this.read()[key];
    if (!raw) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(raw, "base64"));
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const data = this.read();
    data[key] = this.safeStorage.encryptString(value).toString("base64");
    this.write(data);
  }

  async delete(key: string): Promise<void> {
    const data = this.read();
    delete data[key];
    this.write(data);
  }
}

interface EncryptedEntry {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/**
 * AES-256-GCM file store. The key is scrypt-stretched from a passphrase; with
 * no passphrase it is derived from stable machine properties, which stops a
 * copied file from being readable elsewhere but is not a defence against a
 * local attacker who can read the same machine's properties.
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly kind = "encrypted-file" as const;
  readonly description: string;
  private readonly file: string;
  private readonly passphrase: string;
  private readonly machineBound: boolean;

  constructor(storageDir: string, passphrase?: string) {
    this.file = path.join(storageDir, "secrets.enc.json");
    this.machineBound = !passphrase;
    this.passphrase = passphrase ?? machineKeyMaterial();
    this.description = this.machineBound
      ? "AES-256-GCM file with a machine-derived key"
      : "AES-256-GCM file with an operator passphrase";
  }

  private read(): Record<string, EncryptedEntry> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, EncryptedEntry>;
    } catch {
      return {};
    }
  }

  private write(data: Record<string, EncryptedEntry>): void {
    atomicWrite(this.file, JSON.stringify(data, null, 2));
  }

  async get(key: string): Promise<string | null> {
    const entry = this.read()[key];
    if (!entry || entry.v !== 1) return null;
    try {
      const derived = scryptSync(this.passphrase, Buffer.from(entry.salt, "base64"), 32);
      const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(entry.iv, "base64"));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(entry.data, "base64")),
        decipher.final()
      ]).toString("utf8");
    } catch {
      // Wrong passphrase or tampered ciphertext are indistinguishable here,
      // and both mean "this secret is not available to us".
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const derived = scryptSync(this.passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const all = this.read();
    all[key] = {
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64")
    };
    this.write(all);
  }

  async delete(key: string): Promise<void> {
    const all = this.read();
    delete all[key];
    this.write(all);
  }
}

/** Last-resort mode-600 JSON. Never selected automatically unless allowed. */
export class PlaintextFileSecretStore implements SecretStore {
  readonly kind = "plaintext-file" as const;
  readonly description = "mode-600 JSON file (NOT encrypted at rest)";
  private readonly file: string;

  constructor(storageDir: string, fileName = "secrets.json") {
    this.file = path.join(storageDir, fileName);
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<string | null> {
    return this.read()[key] ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    const data = this.read();
    data[key] = value;
    atomicWrite(this.file, JSON.stringify(data, null, 2));
  }
  async delete(key: string): Promise<void> {
    const data = this.read();
    delete data[key];
    atomicWrite(this.file, JSON.stringify(data, null, 2));
  }
}

/** In-process store for tests. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory" as const;
  readonly description = "in-memory (not persisted)";
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* selection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Picks the strongest available backend. Probes the OS keychain with a real
 * round-trip rather than trusting that the module loaded: keytar imports fine
 * on a headless Linux box with no secret service running and then fails on
 * every call.
 */
export async function openSecretStore(options: SecretStoreOptions): Promise<SecretStore> {
  const log = options.logger ?? noopLogger;
  const service = options.service ?? "crosslink";
  mkdirSync(options.storageDir, { recursive: true });

  if (!options.preferFile) {
    const keytar = await loadKeytar();
    if (keytar) {
      const store = new KeytarSecretStore(keytar, service);
      if (await probe(store)) {
        log.info("secrets.backend", { kind: store.kind });
        return store;
      }
      log.debug("secrets.keytar-unusable");
    }

    const safeStorage = await loadElectronSafeStorage();
    if (safeStorage) {
      const store = new ElectronSafeStorageStore(safeStorage, options.storageDir);
      if (await probe(store)) {
        log.info("secrets.backend", { kind: store.kind });
        return store;
      }
      log.debug("secrets.safe-storage-unusable");
    }
  }

  const passphrase = options.passphrase ?? process.env.CROSSLINK_SECRET_KEY;
  const encrypted = new EncryptedFileSecretStore(options.storageDir, passphrase);
  if (await probe(encrypted)) {
    if (!passphrase) {
      log.warn("secrets.machine-bound-key", {
        detail:
          "no OS keychain and no CROSSLINK_SECRET_KEY; the identity key is encrypted with a machine-derived key"
      });
    }
    log.info("secrets.backend", { kind: encrypted.kind });
    return encrypted;
  }

  if (!options.allowPlaintextFallback) {
    throw new Error(
      "no usable secret store: install `keytar`, set CROSSLINK_SECRET_KEY, or pass allowPlaintextFallback:true to accept plaintext storage"
    );
  }
  const plain = new PlaintextFileSecretStore(options.storageDir);
  log.warn("secrets.backend", { kind: plain.kind, detail: "secrets are NOT encrypted at rest" });
  return plain;
}

/** Round-trips a throwaway value to prove the backend actually works. */
async function probe(store: SecretStore): Promise<boolean> {
  const key = "__crosslink_probe";
  const value = randomBytes(16).toString("base64");
  try {
    await store.set(key, value);
    const got = await store.get(key);
    await store.delete(key);
    return (
      got !== null &&
      got.length === value.length &&
      timingSafeEqual(Buffer.from(got), Buffer.from(value))
    );
  } catch {
    try {
      await store.delete(key);
    } catch {
      /* best effort */
    }
    return false;
  }
}

/**
 * Imports an optional dependency by a non-literal specifier, so neither
 * TypeScript nor a bundler treats `keytar` / `electron` as required.
 */
function optionalImport(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
}

async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    const mod = (await optionalImport("keytar")) as { default?: KeytarModule } & KeytarModule;
    const resolved = mod.default ?? mod;
    return typeof resolved?.getPassword === "function" ? resolved : null;
  } catch {
    // keytar is an optional native dependency; not having it is normal.
    return null;
  }
}

async function loadElectronSafeStorage(): Promise<SafeStorageModule | null> {
  try {
    const mod = (await optionalImport("electron")) as { safeStorage?: SafeStorageModule };
    const safeStorage = mod.safeStorage;
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") return null;
    return safeStorage.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null;
  }
}

/**
 * Stable-per-machine key material. Deliberately excludes anything that changes
 * across reboots (uptime, network interfaces on DHCP) so the key survives a
 * restart, and includes the user so two accounts on one host do not share it.
 */
function machineKeyMaterial(): string {
  return [
    "crosslink-machine-key-v1",
    os.hostname(),
    os.platform(),
    os.arch(),
    os.userInfo().username,
    os.homedir()
  ].join(" ");
}

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
