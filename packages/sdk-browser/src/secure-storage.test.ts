/**
 * Tests for the encrypted-at-rest client storage.
 *
 * IndexedDB and WebCrypto are not present under Node's test environment, so
 * the IndexedDB-backed path is covered through the `AsyncSecureStorage`
 * contract with an in-memory backend, plus explicit coverage of the
 * hydrate/write-through facade and the fallback selection logic that decides
 * whether a client is encrypted at rest at all.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AsyncStorageAdapter,
  HydratedSecureStorage,
  createSecureStorage,
  type AsyncSecureStorage
} from "./secure-storage.js";
import { MemorySecureStorage } from "./storage.js";

/** An async backend that can be made to fail or stall on demand. */
class FakeBackend implements AsyncSecureStorage {
  readonly kind = "fake";
  readonly encrypted = true;
  readonly map = new Map<string, string>();
  failNextWrite = false;
  writeDelayMs = 0;
  readonly writeOrder: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("quota exceeded");
    }
    if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
    this.map.set(key, value);
    this.writeOrder.push(`set:${key}`);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
    this.writeOrder.push(`delete:${key}`);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

describe("HydratedSecureStorage", () => {
  it("serves reads from the hydrated cache", async () => {
    const backend = new FakeBackend();
    backend.map.set("crosslink.identity.seed", "seed-value");

    const storage = await HydratedSecureStorage.hydrate(backend);
    expect(storage.get("crosslink.identity.seed")).toBe("seed-value");
    expect(storage.get("missing")).toBeNull();
  });

  it("makes a write visible synchronously and persists it asynchronously", async () => {
    const backend = new FakeBackend();
    const storage = await HydratedSecureStorage.hydrate(backend);

    storage.set("k", "v");
    // The SDK reads back its own writes synchronously, so the cache must be
    // authoritative the instant set() returns.
    expect(storage.get("k")).toBe("v");
    expect(backend.map.get("k")).toBeUndefined();

    await storage.flushed();
    expect(backend.map.get("k")).toBe("v");
  });

  it("deletes through to the backend", async () => {
    const backend = new FakeBackend();
    backend.map.set("k", "v");
    const storage = await HydratedSecureStorage.hydrate(backend);

    storage.delete("k");
    expect(storage.get("k")).toBeNull();
    await storage.flushed();
    expect(backend.map.has("k")).toBe(false);
  });

  it("keeps writes in order even when an early one is slow", async () => {
    const backend = new FakeBackend();
    const storage = await HydratedSecureStorage.hydrate(backend);

    backend.writeDelayMs = 30;
    storage.set("a", "1");
    backend.writeDelayMs = 0;
    storage.set("b", "2");
    storage.delete("a");

    await storage.flushed();
    expect(backend.writeOrder).toEqual(["set:a", "set:b", "delete:a"]);
  });

  it("surfaces a failed write instead of silently losing it", async () => {
    // A silently-unpersisted identity seed means every pairing is lost on the
    // next page load, so this must be loud.
    const backend = new FakeBackend();
    const onWriteError = vi.fn();
    const storage = await HydratedSecureStorage.hydrate(backend, { onWriteError });

    backend.failNextWrite = true;
    storage.set("k", "v");
    await storage.flushed();

    expect(onWriteError).toHaveBeenCalledWith(expect.any(Error), "k");
  });

  it("keeps accepting writes after one fails", async () => {
    const backend = new FakeBackend();
    const storage = await HydratedSecureStorage.hydrate(backend, { onWriteError: () => {} });

    backend.failNextWrite = true;
    storage.set("a", "1");
    storage.set("b", "2");
    await storage.flushed();

    expect(backend.map.get("b")).toBe("2");
    expect(storage.pending).toBe(0);
  });

  it("reports the backend kind and encryption status", async () => {
    const storage = await HydratedSecureStorage.hydrate(new FakeBackend());
    expect(storage.kind).toBe("fake");
    expect(storage.encrypted).toBe(true);
  });
});

describe("AsyncStorageAdapter", () => {
  it("wraps a synchronous store and tracks the keys it wrote", async () => {
    const inner = new MemorySecureStorage();
    const adapter = new AsyncStorageAdapter(inner, "memory");

    await adapter.set("k", "v");
    expect(await adapter.get("k")).toBe("v");
    expect(await adapter.keys()).toEqual(["k"]);

    await adapter.delete("k");
    expect(await adapter.get("k")).toBeNull();
    expect(await adapter.keys()).toEqual([]);
  });

  it("reports itself as unencrypted", () => {
    expect(new AsyncStorageAdapter(new MemorySecureStorage()).encrypted).toBe(false);
  });
});

describe("createSecureStorage", () => {
  it("falls back and reports honestly when IndexedDB is unavailable", async () => {
    // Node has neither IndexedDB nor a secure-origin WebCrypto subtle, which
    // is exactly the private-mode / insecure-origin situation in a browser.
    const result = await createSecureStorage();
    expect(result.encrypted).toBe(false);
    expect(["localstorage", "memory"]).toContain(result.kind);

    result.storage.set("k", "v");
    expect(result.storage.get("k")).toBe("v");
  });

  it("refuses to downgrade silently when the fallback is disallowed", async () => {
    await expect(createSecureStorage({ allowPlaintextFallback: false })).rejects.toThrow();
  });
});
