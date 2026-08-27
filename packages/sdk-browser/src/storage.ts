/**
 * Pluggable secure storage. Browsers use localStorage (origin-scoped);
 * tests/embedders inject memory or native secure storage.
 */
export interface SecureStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export class MemorySecureStorage implements SecureStorage {
  private map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

export class LocalStorageSecureStorage implements SecureStorage {
  constructor(private readonly ls: Storage) {}
  get(key: string): string | null {
    return this.ls.getItem(key);
  }
  set(key: string, value: string): void {
    this.ls.setItem(key, value);
  }
  delete(key: string): void {
    this.ls.removeItem(key);
  }
}

/** Minimal typed wrapper used by the SDK internals. */
export class JsonStore<T> {
  constructor(private readonly storage: SecureStorage, private readonly key: string) {}
  load(defaults: T): T {
    const raw = this.storage.get(this.key);
    if (!raw) return defaults;
    try {
      return { ...defaults, ...(JSON.parse(raw) as object) } as T;
    } catch {
      return defaults;
    }
  }
  save(value: T): void {
    this.storage.set(this.key, JSON.stringify(value));
  }
}
