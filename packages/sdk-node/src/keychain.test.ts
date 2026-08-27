import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLogSink } from "@crosslink/core";
import {
  EncryptedFileSecretStore,
  MemorySecretStore,
  PlaintextFileSecretStore,
  openSecretStore
} from "./keychain.js";
import { IDENTITY_SEED_KEY, loadOrCreateIdentitySecurely } from "./storage.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "crosslink-keychain-"));
}

const savedEnv = process.env.CROSSLINK_SECRET_KEY;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CROSSLINK_SECRET_KEY;
  else process.env.CROSSLINK_SECRET_KEY = savedEnv;
});

describe("EncryptedFileSecretStore", () => {
  it("round-trips a value", async () => {
    const store = new EncryptedFileSecretStore(tempDir(), "correct horse");
    await store.set("k", "the-secret");
    expect(await store.get("k")).toBe("the-secret");
  });

  it("never writes the plaintext to disk", async () => {
    const dir = tempDir();
    const store = new EncryptedFileSecretStore(dir, "pass");
    await store.set(IDENTITY_SEED_KEY, "SEED-MATERIAL-1234");

    const onDisk = readFileSync(path.join(dir, "secrets.enc.json"), "utf8");
    expect(onDisk).not.toContain("SEED-MATERIAL-1234");
    expect(onDisk).toContain("\"v\": 1");
  });

  it("uses a fresh salt and IV per write, so equal values differ on disk", async () => {
    const dir = tempDir();
    const store = new EncryptedFileSecretStore(dir, "pass");
    await store.set("a", "same");
    const first = readFileSync(path.join(dir, "secrets.enc.json"), "utf8");
    await store.set("b", "same");
    const parsed = JSON.parse(readFileSync(path.join(dir, "secrets.enc.json"), "utf8")) as Record<
      string,
      { data: string; iv: string }
    >;

    expect(parsed.a.data).not.toBe(parsed.b.data);
    expect(parsed.a.iv).not.toBe(parsed.b.iv);
    expect(first).toBeTruthy();
  });

  it("returns null under the wrong passphrase rather than garbage", async () => {
    const dir = tempDir();
    await new EncryptedFileSecretStore(dir, "right").set("k", "v");
    expect(await new EncryptedFileSecretStore(dir, "wrong").get("k")).toBeNull();
  });

  it("detects tampering through the GCM tag", async () => {
    const dir = tempDir();
    const file = path.join(dir, "secrets.enc.json");
    await new EncryptedFileSecretStore(dir, "pass").set("k", "v");

    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, { data: string }>;
    const bytes = Buffer.from(parsed.k.data, "base64");
    bytes[0] ^= 0xff;
    parsed.k.data = bytes.toString("base64");
    writeFileSync(file, JSON.stringify(parsed));

    expect(await new EncryptedFileSecretStore(dir, "pass").get("k")).toBeNull();
  });

  it("persists across instances and supports deletion", async () => {
    const dir = tempDir();
    await new EncryptedFileSecretStore(dir, "pass").set("k", "v");
    expect(await new EncryptedFileSecretStore(dir, "pass").get("k")).toBe("v");

    await new EncryptedFileSecretStore(dir, "pass").delete("k");
    expect(await new EncryptedFileSecretStore(dir, "pass").get("k")).toBeNull();
  });

  it("derives a machine-bound key when given no passphrase", async () => {
    const dir = tempDir();
    const store = new EncryptedFileSecretStore(dir);
    await store.set("k", "v");

    expect(store.description).toContain("machine-derived");
    expect(await new EncryptedFileSecretStore(dir).get("k")).toBe("v");
  });

  it("returns null for a missing or corrupt file rather than throwing", async () => {
    const dir = tempDir();
    expect(await new EncryptedFileSecretStore(dir, "pass").get("nope")).toBeNull();

    writeFileSync(path.join(dir, "secrets.enc.json"), "not json at all");
    expect(await new EncryptedFileSecretStore(dir, "pass").get("k")).toBeNull();
  });
});

describe("openSecretStore", () => {
  it("selects the encrypted file backend when no OS keychain is available", async () => {
    const store = await openSecretStore({ storageDir: tempDir(), preferFile: true });
    expect(store.kind).toBe("encrypted-file");
  });

  it("uses CROSSLINK_SECRET_KEY as the passphrase when set", async () => {
    process.env.CROSSLINK_SECRET_KEY = "from-the-environment";
    const dir = tempDir();
    const store = await openSecretStore({ storageDir: dir, preferFile: true });

    expect(store.description).toContain("operator passphrase");
    await store.set("k", "v");
    expect(await new EncryptedFileSecretStore(dir, "from-the-environment").get("k")).toBe("v");
  });

  it("warns when it falls back to a machine-derived key", async () => {
    delete process.env.CROSSLINK_SECRET_KEY;
    const sink = new MemoryLogSink();
    await openSecretStore({ storageDir: tempDir(), preferFile: true, logger: sink.logger() });

    expect(sink.records.map((r) => r.event)).toContain("secrets.machine-bound-key");
  });

  it("creates the storage directory if it does not exist", async () => {
    const dir = path.join(tempDir(), "nested", "deeper");
    await openSecretStore({ storageDir: dir, preferFile: true });
    expect(existsSync(dir)).toBe(true);
  });
});

describe("PlaintextFileSecretStore", () => {
  it("round-trips and is explicit about not being encrypted", async () => {
    const dir = tempDir();
    const store = new PlaintextFileSecretStore(dir);
    await store.set("k", "v");

    expect(await store.get("k")).toBe("v");
    expect(store.description).toContain("NOT encrypted");
    expect(readFileSync(path.join(dir, "secrets.json"), "utf8")).toContain("v");
  });
});

describe("loadOrCreateIdentitySecurely", () => {
  it("creates an identity and stores the seed in the secret store", async () => {
    const secretStore = new MemorySecretStore();
    const { identity, migrated } = await loadOrCreateIdentitySecurely({
      storageDir: tempDir(),
      secretStore
    });

    expect(migrated).toBe(false);
    expect(await secretStore.get(IDENTITY_SEED_KEY)).toBe(
      Buffer.from(identity.seed).toString("base64")
    );
  });

  it("returns the same identity on the next start", async () => {
    const secretStore = new MemorySecretStore();
    const dir = tempDir();

    const first = await loadOrCreateIdentitySecurely({ storageDir: dir, secretStore });
    const second = await loadOrCreateIdentitySecurely({ storageDir: dir, secretStore });

    expect(second.identity.deviceId).toBe(first.identity.deviceId);
  });

  it("migrates a legacy plaintext identity.json and removes it", async () => {
    // An upgrade must keep the host's identity: minting a new one would
    // silently orphan every device already paired with it.
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const seed = Buffer.alloc(32, 7).toString("base64");
    writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ v: 1, seed_b64: seed }));

    const sink = new MemoryLogSink();
    const secretStore = new MemorySecretStore();
    const result = await loadOrCreateIdentitySecurely({
      storageDir: dir,
      secretStore,
      logger: sink.logger()
    });

    expect(result.migrated).toBe(true);
    expect(await secretStore.get(IDENTITY_SEED_KEY)).toBe(seed);
    expect(existsSync(path.join(dir, "identity.json"))).toBe(false);
    expect(sink.records.map((r) => r.event)).toContain("identity.migrated");
  });

  it("keeps the plaintext file when the secret store cannot read the seed back", async () => {
    // A failed migration must never destroy the only copy of the key.
    const dir = tempDir();
    const seed = Buffer.alloc(32, 3).toString("base64");
    writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ v: 1, seed_b64: seed }));

    const amnesiac = new MemorySecretStore();
    amnesiac.get = async () => null;

    const result = await loadOrCreateIdentitySecurely({ storageDir: dir, secretStore: amnesiac });

    expect(result.migrated).toBe(false);
    expect(existsSync(path.join(dir, "identity.json"))).toBe(true);
    expect(Buffer.from(result.identity.seed).toString("base64")).toBe(seed);
  });

  it("ignores an unreadable legacy file and mints a fresh identity", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "identity.json"), "{ broken");

    const result = await loadOrCreateIdentitySecurely({
      storageDir: dir,
      secretStore: new MemorySecretStore()
    });
    expect(result.identity.deviceId).toMatch(/\S/);
  });
});
