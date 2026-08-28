/**
 * Encrypted-at-rest storage for browser clients.
 *
 * A browser client's identity seed grants access to every app it has paired
 * with. In `localStorage` that seed is a plain string: readable by any script
 * that gets a foothold on the origin, visible in devtools, and trivially
 * exfiltrated by an XSS payload in one line.
 *
 * `IndexedDbSecureStorage` encrypts every value with AES-256-GCM under a key
 * that is generated **non-extractable** and stored as a live `CryptoKey` in
 * IndexedDB. The browser will hand that key back to this origin's scripts to
 * *use*, but never to read: `crypto.subtle.exportKey` on it rejects. Stolen
 * ciphertext is therefore useless off-origin, and an attacker who can run
 * script on the origin has to stay resident and use the key in place rather
 * than copying the seed out.
 *
 * This is meaningfully stronger than `localStorage` and it is not a vault: a
 * script running on the origin can still ask the key to decrypt. The honest
 * summary is that it removes the copy-and-leave attack, not the code-execution
 * one - see docs/security/threat-model.mdx.
 *
 * The synchronous `SecureStorage` interface the SDK uses internally is served
 * by `hydrate()`, which decrypts everything once into memory and writes back
 * through asynchronously.
 */
import type { SecureStorage } from "./storage.js";

const DB_NAME = "crosslink-secure";
const DB_VERSION = 1;
const KEY_STORE = "keys";
const VALUE_STORE = "values";
const MASTER_KEY_ID = "master";
const IV_BYTES = 12;

/** Async counterpart of {@link SecureStorage}. */
export interface AsyncSecureStorage {
  readonly kind: string;
  /** True when values are encrypted at rest. */
  readonly encrypted: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

interface StoredValue {
  iv: ArrayBuffer;
  data: ArrayBuffer;
}

/* ------------------------------------------------------------------ */
/* IndexedDB plumbing                                                  */
/* ------------------------------------------------------------------ */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(VALUE_STORE)) db.createObjectStore(VALUE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    request.onblocked = () => reject(new Error("indexedDB open blocked by another tab"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

/* ------------------------------------------------------------------ */
/* implementation                                                      */
/* ------------------------------------------------------------------ */

export class IndexedDbSecureStorage implements AsyncSecureStorage {
  readonly kind = "indexeddb-aes-gcm";
  readonly encrypted = true;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly key: CryptoKey
  ) {}

  /**
   * Opens the store, generating the non-extractable master key on first use.
   * Rejects when IndexedDB or WebCrypto is unavailable (private-mode Safari,
   * insecure origins) so the caller can choose its own fallback rather than
   * being silently downgraded to plaintext.
   */
  static async open(): Promise<IndexedDbSecureStorage> {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is not available in this environment");
    }
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      throw new Error("WebCrypto subtle is not available (requires a secure origin)");
    }

    const db = await openDb();
    let key = await request<CryptoKey | undefined>(
      db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(MASTER_KEY_ID)
    );

    if (!key) {
      // extractable: false is the whole point - the browser will use this key
      // on our behalf but will never serialize it back out to script.
      key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt"
      ]);
      const tx = db.transaction(KEY_STORE, "readwrite");
      tx.objectStore(KEY_STORE).put(key, MASTER_KEY_ID);
      await txDone(tx);
    }

    return new IndexedDbSecureStorage(db, key);
  }

  async get(name: string): Promise<string | null> {
    const stored = await request<StoredValue | undefined>(
      this.db.transaction(VALUE_STORE, "readonly").objectStore(VALUE_STORE).get(name)
    );
    if (!stored) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(stored.iv) },
        this.key,
        stored.data
      );
      return new TextDecoder().decode(plain);
    } catch {
      // A GCM tag failure means the record was written under a different key
      // (the store was cleared and regenerated) or tampered with. Either way
      // it is not recoverable, and treating it as absent is correct.
      return null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.key,
      new TextEncoder().encode(value)
    );
    const tx = this.db.transaction(VALUE_STORE, "readwrite");
    tx.objectStore(VALUE_STORE).put({ iv: iv.buffer, data } satisfies StoredValue, name);
    await txDone(tx);
  }

  async delete(name: string): Promise<void> {
    const tx = this.db.transaction(VALUE_STORE, "readwrite");
    tx.objectStore(VALUE_STORE).delete(name);
    await txDone(tx);
  }

  async keys(): Promise<string[]> {
    const all = await request<IDBValidKey[]>(
      this.db.transaction(VALUE_STORE, "readonly").objectStore(VALUE_STORE).getAllKeys()
    );
    return all.map(String);
  }

  /** Destroys every stored value and the master key. */
  async wipe(): Promise<void> {
    const tx = this.db.transaction([VALUE_STORE, KEY_STORE], "readwrite");
    tx.objectStore(VALUE_STORE).clear();
    tx.objectStore(KEY_STORE).clear();
    await txDone(tx);
  }
}

/** Adapts an existing synchronous {@link SecureStorage} to the async shape. */
export class AsyncStorageAdapter implements AsyncSecureStorage {
  readonly kind: string;
  readonly encrypted = false;

  constructor(
    private readonly inner: SecureStorage,
    kind = "sync-adapter",
    private readonly knownKeys = new Set<string>()
  ) {
    this.kind = kind;
  }

  async get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.knownKeys.add(key);
    this.inner.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.knownKeys.delete(key);
    this.inner.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.knownKeys];
  }
}

/* ------------------------------------------------------------------ */
/* sync facade                                                         */
/* ------------------------------------------------------------------ */

/**
 * A synchronous `SecureStorage` view over an async backend.
 *
 * Reads are served from the in-memory cache filled by `hydrate()`. Writes
 * update the cache immediately and are flushed to the backend in order; a
 * failed flush is surfaced through `onWriteError` rather than swallowed, since
 * a silently-unpersisted identity seed means the device loses every pairing on
 * the next reload.
 */
export class HydratedSecureStorage implements SecureStorage {
  private readonly cache = new Map<string, string>();
  /** serializes writes so a rapid set/delete pair cannot land out of order */
  private flushChain: Promise<void> = Promise.resolve();
  private pendingWrites = 0;

  private constructor(
    private readonly backend: AsyncSecureStorage,
    private readonly onWriteError?: (err: unknown, key: string) => void
  ) {}

  static async hydrate(
    backend: AsyncSecureStorage,
    options: { onWriteError?(err: unknown, key: string): void } = {}
  ): Promise<HydratedSecureStorage> {
    const storage = new HydratedSecureStorage(backend, options.onWriteError);
    for (const key of await backend.keys()) {
      const value = await backend.get(key);
      if (value !== null) storage.cache.set(key, value);
    }
    return storage;
  }

  get kind(): string {
    return this.backend.kind;
  }

  get encrypted(): boolean {
    return this.backend.encrypted;
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    this.enqueue(key, () => this.backend.set(key, value));
  }

  delete(key: string): void {
    this.cache.delete(key);
    this.enqueue(key, () => this.backend.delete(key));
  }

  /** Resolves once every queued write has reached the backend. */
  flushed(): Promise<void> {
    return this.flushChain;
  }

  get pending(): number {
    return this.pendingWrites;
  }

  private enqueue(key: string, op: () => Promise<void>): void {
    this.pendingWrites += 1;
    this.flushChain = this.flushChain
      .then(op)
      .catch((err) => {
        this.onWriteError?.(err, key);
      })
      .finally(() => {
        this.pendingWrites -= 1;
      });
  }
}

export interface CreateSecureStorageOptions {
  /**
   * Fall back to localStorage when IndexedDB/WebCrypto are unavailable.
   * Defaults to true - a client that cannot start at all is worse than one
   * that starts with weaker at-rest protection - but the result reports
   * `encrypted: false` so the application can tell the user.
   */
  allowPlaintextFallback?: boolean;
  onWriteError?(err: unknown, key: string): void;
}

export interface SecureStorageResult {
  storage: SecureStorage;
  /** Which backend was selected. */
  kind: string;
  /** False when the fallback was used and values are stored in the clear. */
  encrypted: boolean;
}

/**
 * Builds the strongest available client storage: IndexedDB + AES-GCM under a
 * non-extractable key, falling back to localStorage, then to memory.
 */
export async function createSecureStorage(
  options: CreateSecureStorageOptions = {}
): Promise<SecureStorageResult> {
  try {
    const backend = await IndexedDbSecureStorage.open();
    const storage = await HydratedSecureStorage.hydrate(backend, {
      ...(options.onWriteError ? { onWriteError: options.onWriteError } : {})
    });
    return { storage, kind: backend.kind, encrypted: true };
  } catch (err) {
    if (options.allowPlaintextFallback === false) throw err;
  }

  const { LocalStorageSecureStorage, MemorySecureStorage } = await import("./storage.js");
  if (typeof localStorage !== "undefined") {
    return {
      storage: new LocalStorageSecureStorage(localStorage),
      kind: "localstorage",
      encrypted: false
    };
  }
  return { storage: new MemorySecureStorage(), kind: "memory", encrypted: false };
}
