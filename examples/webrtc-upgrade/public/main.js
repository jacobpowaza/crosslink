var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// ../../packages/sdk-browser/dist/chunk-FKNR6EFT.js
var MemorySecureStorage, LocalStorageSecureStorage, JsonStore;
var init_chunk_FKNR6EFT = __esm({
  "../../packages/sdk-browser/dist/chunk-FKNR6EFT.js"() {
    "use strict";
    MemorySecureStorage = class {
      map = /* @__PURE__ */ new Map();
      get(key) {
        return this.map.get(key) ?? null;
      }
      set(key, value) {
        this.map.set(key, value);
      }
      delete(key) {
        this.map.delete(key);
      }
    };
    LocalStorageSecureStorage = class {
      constructor(ls) {
        this.ls = ls;
      }
      ls;
      get(key) {
        return this.ls.getItem(key);
      }
      set(key, value) {
        this.ls.setItem(key, value);
      }
      delete(key) {
        this.ls.removeItem(key);
      }
    };
    JsonStore = class {
      constructor(storage, key) {
        this.storage = storage;
        this.key = key;
      }
      storage;
      key;
      load(defaults) {
        const raw = this.storage.get(this.key);
        if (!raw) return defaults;
        try {
          return { ...defaults, ...JSON.parse(raw) };
        } catch {
          return defaults;
        }
      }
      save(value) {
        this.storage.set(this.key, JSON.stringify(value));
      }
    };
  }
});

// ../../packages/sdk-browser/dist/storage-FHFZA2HW.js
var storage_FHFZA2HW_exports = {};
__export(storage_FHFZA2HW_exports, {
  JsonStore: () => JsonStore,
  LocalStorageSecureStorage: () => LocalStorageSecureStorage,
  MemorySecureStorage: () => MemorySecureStorage
});
var init_storage_FHFZA2HW = __esm({
  "../../packages/sdk-browser/dist/storage-FHFZA2HW.js"() {
    "use strict";
    init_chunk_FKNR6EFT();
  }
});

// ../../packages/sdk-browser/dist/chunk-RCHT4DYR.js
function openDb() {
  return new Promise((resolve, reject) => {
    const request2 = indexedDB.open(DB_NAME, DB_VERSION);
    request2.onupgradeneeded = () => {
      const db = request2.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
      if (!db.objectStoreNames.contains(VALUE_STORE)) db.createObjectStore(VALUE_STORE);
    };
    request2.onsuccess = () => resolve(request2.result);
    request2.onerror = () => reject(request2.error ?? new Error("indexedDB open failed"));
    request2.onblocked = () => reject(new Error("indexedDB open blocked by another tab"));
  });
}
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
  });
}
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}
async function createSecureStorage(options = {}) {
  try {
    const backend = await IndexedDbSecureStorage.open();
    const storage = await HydratedSecureStorage.hydrate(backend, {
      ...options.onWriteError ? { onWriteError: options.onWriteError } : {}
    });
    return { storage, kind: backend.kind, encrypted: true };
  } catch (err) {
    if (options.allowPlaintextFallback === false) throw err;
  }
  const { LocalStorageSecureStorage: LocalStorageSecureStorage2, MemorySecureStorage: MemorySecureStorage2 } = await Promise.resolve().then(() => (init_storage_FHFZA2HW(), storage_FHFZA2HW_exports));
  if (typeof localStorage !== "undefined") {
    return {
      storage: new LocalStorageSecureStorage2(localStorage),
      kind: "localstorage",
      encrypted: false
    };
  }
  return { storage: new MemorySecureStorage2(), kind: "memory", encrypted: false };
}
var DB_NAME, DB_VERSION, KEY_STORE, VALUE_STORE, MASTER_KEY_ID, IV_BYTES, IndexedDbSecureStorage, HydratedSecureStorage;
var init_chunk_RCHT4DYR = __esm({
  "../../packages/sdk-browser/dist/chunk-RCHT4DYR.js"() {
    "use strict";
    DB_NAME = "crosslink-secure";
    DB_VERSION = 1;
    KEY_STORE = "keys";
    VALUE_STORE = "values";
    MASTER_KEY_ID = "master";
    IV_BYTES = 12;
    IndexedDbSecureStorage = class _IndexedDbSecureStorage {
      constructor(db, key) {
        this.db = db;
        this.key = key;
      }
      db;
      key;
      kind = "indexeddb-aes-gcm";
      encrypted = true;
      /**
       * Opens the store, generating the non-extractable master key on first use.
       * Rejects when IndexedDB or WebCrypto is unavailable (private-mode Safari,
       * insecure origins) so the caller can choose its own fallback rather than
       * being silently downgraded to plaintext.
       */
      static async open() {
        if (typeof indexedDB === "undefined") {
          throw new Error("IndexedDB is not available in this environment");
        }
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) {
          throw new Error("WebCrypto subtle is not available (requires a secure origin)");
        }
        const db = await openDb();
        let key = await request(
          db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(MASTER_KEY_ID)
        );
        if (!key) {
          key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt"
          ]);
          const tx = db.transaction(KEY_STORE, "readwrite");
          tx.objectStore(KEY_STORE).put(key, MASTER_KEY_ID);
          await txDone(tx);
        }
        return new _IndexedDbSecureStorage(db, key);
      }
      async get(name) {
        const stored = await request(
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
          return null;
        }
      }
      async set(name, value) {
        const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const data = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          this.key,
          new TextEncoder().encode(value)
        );
        const tx = this.db.transaction(VALUE_STORE, "readwrite");
        tx.objectStore(VALUE_STORE).put({ iv: iv.buffer, data }, name);
        await txDone(tx);
      }
      async delete(name) {
        const tx = this.db.transaction(VALUE_STORE, "readwrite");
        tx.objectStore(VALUE_STORE).delete(name);
        await txDone(tx);
      }
      async keys() {
        const all = await request(
          this.db.transaction(VALUE_STORE, "readonly").objectStore(VALUE_STORE).getAllKeys()
        );
        return all.map(String);
      }
      /** Destroys every stored value and the master key. */
      async wipe() {
        const tx = this.db.transaction([VALUE_STORE, KEY_STORE], "readwrite");
        tx.objectStore(VALUE_STORE).clear();
        tx.objectStore(KEY_STORE).clear();
        await txDone(tx);
      }
    };
    HydratedSecureStorage = class _HydratedSecureStorage {
      constructor(backend, onWriteError) {
        this.backend = backend;
        this.onWriteError = onWriteError;
      }
      backend;
      onWriteError;
      cache = /* @__PURE__ */ new Map();
      /** serializes writes so a rapid set/delete pair cannot land out of order */
      flushChain = Promise.resolve();
      pendingWrites = 0;
      static async hydrate(backend, options = {}) {
        const storage = new _HydratedSecureStorage(backend, options.onWriteError);
        for (const key of await backend.keys()) {
          const value = await backend.get(key);
          if (value !== null) storage.cache.set(key, value);
        }
        return storage;
      }
      get kind() {
        return this.backend.kind;
      }
      get encrypted() {
        return this.backend.encrypted;
      }
      get(key) {
        return this.cache.get(key) ?? null;
      }
      set(key, value) {
        this.cache.set(key, value);
        this.enqueue(key, () => this.backend.set(key, value));
      }
      delete(key) {
        this.cache.delete(key);
        this.enqueue(key, () => this.backend.delete(key));
      }
      /** Resolves once every queued write has reached the backend. */
      flushed() {
        return this.flushChain;
      }
      get pending() {
        return this.pendingWrites;
      }
      enqueue(key, op) {
        this.pendingWrites += 1;
        this.flushChain = this.flushChain.then(op).catch((err) => {
          this.onWriteError?.(err, key);
        }).finally(() => {
          this.pendingWrites -= 1;
        });
      }
    };
  }
});

// ../../packages/sdk-browser/dist/device-crypto-storage-NEJ3IT2Z.js
var device_crypto_storage_NEJ3IT2Z_exports = {};
__export(device_crypto_storage_NEJ3IT2Z_exports, {
  SecureDeviceCryptoStorage: () => SecureDeviceCryptoStorage
});
var SecureDeviceCryptoStorage;
var init_device_crypto_storage_NEJ3IT2Z = __esm({
  "../../packages/sdk-browser/dist/device-crypto-storage-NEJ3IT2Z.js"() {
    "use strict";
    init_chunk_RCHT4DYR();
    SecureDeviceCryptoStorage = class _SecureDeviceCryptoStorage {
      storage;
      constructor(storage) {
        this.storage = storage;
      }
      static async open() {
        const { storage } = await createSecureStorage({ allowPlaintextFallback: false });
        return new _SecureDeviceCryptoStorage(storage);
      }
      storageKey(appId) {
        return `crosslink.device-crypto.${appId}`;
      }
      async load(appId) {
        const key = this.storageKey(appId ?? "default");
        const value = this.storage.get(key);
        if (!value) return null;
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed.deviceId === "string" && typeof parsed.edPrivateSeedB64 === "string") {
            return { deviceId: parsed.deviceId, edPrivateSeedB64: parsed.edPrivateSeedB64 };
          }
        } catch {
        }
        return null;
      }
      async save(record, appId) {
        const key = this.storageKey(appId ?? "default");
        this.storage.set(key, JSON.stringify(record));
      }
      async clear(appId) {
        const key = this.storageKey(appId ?? "default");
        this.storage.delete(key);
      }
    };
  }
});

// ../../packages/sdk-browser/dist/index.js
init_chunk_FKNR6EFT();
init_chunk_RCHT4DYR();

// ../../node_modules/@noble/ciphers/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abool(b) {
  if (typeof b !== "boolean")
    throw new Error(`boolean expected, not ${b}`);
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  else if (isBytes(data))
    data = copyBytes(data);
  else
    throw new Error("Uint8Array expected, got " + typeof data);
  return data;
}
function checkOpts(defaults, opts) {
  if (opts == null || typeof opts !== "object")
    throw new Error("options must be defined");
  const merged = Object.assign(defaults, opts);
  return merged;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes(key);
    if (!isLE)
      throw new Error("Non little-endian hardware is not yet supported");
    if (params.nonceLength !== void 0) {
      const nonce = args[0];
      if (!nonce)
        throw new Error("nonce / iv required");
      if (params.varSizeNonce)
        abytes(nonce);
      else
        abytes(nonce, params.nonceLength);
    }
    const tagl = params.tagLength;
    if (tagl && args[1] !== void 0) {
      abytes(args[1]);
    }
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== void 0) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes(output);
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        called = true;
        abytes(data);
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes(data);
        if (tagl && data.length < tagl)
          throw new Error("invalid ciphertext length: smaller than tagLength=" + tagl);
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === void 0)
    return new Uint8Array(expectedLength);
  if (out.length !== expectedLength)
    throw new Error("invalid output length, expected " + expectedLength + ", got: " + out.length);
  if (onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function setBigUint64(view, byteOffset, value, isLE2) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE2);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE2);
  view.setUint32(byteOffset + l, wl, isLE2);
}
function u64Lengths(dataLength, aadLength, isLE2) {
  abool(isLE2);
  const num = new Uint8Array(16);
  const view = createView(num);
  setBigUint64(view, 0, BigInt(aadLength), isLE2);
  setBigUint64(view, 8, BigInt(dataLength), isLE2);
  return num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}

// ../../node_modules/@noble/ciphers/esm/_arx.js
var _utf8ToBytes = (str) => Uint8Array.from(str.split("").map((c) => c.charCodeAt(0)));
var sigma16 = _utf8ToBytes("expand 16-byte k");
var sigma32 = _utf8ToBytes("expand 32-byte k");
var sigma16_32 = u32(sigma16);
var sigma32_32 = u32(sigma32);
function rotl(a, b) {
  return a << b | a >>> 32 - b;
}
function isAligned322(b) {
  return b.byteOffset % 4 === 0;
}
var BLOCK_LEN = 64;
var BLOCK_LEN32 = 16;
var MAX_COUNTER = 2 ** 32 - 1;
var U32_EMPTY = new Uint32Array();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
  const len = data.length;
  const block = new Uint8Array(BLOCK_LEN);
  const b32 = u32(block);
  const isAligned = isAligned322(data) && isAligned322(output);
  const d32 = isAligned ? u32(data) : U32_EMPTY;
  const o32 = isAligned ? u32(output) : U32_EMPTY;
  for (let pos = 0; pos < len; counter++) {
    core(sigma, key, nonce, b32, counter, rounds);
    if (counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    const take = Math.min(BLOCK_LEN, len - pos);
    if (isAligned && take === BLOCK_LEN) {
      const pos32 = pos / 4;
      if (pos % 4 !== 0)
        throw new Error("arx: invalid block position");
      for (let j = 0, posj; j < BLOCK_LEN32; j++) {
        posj = pos32 + j;
        o32[posj] = d32[posj] ^ b32[j];
      }
      pos += BLOCK_LEN;
      continue;
    }
    for (let j = 0, posj; j < take; j++) {
      posj = pos + j;
      output[posj] = data[posj] ^ block[j];
    }
    pos += take;
  }
}
function createCipher(core, opts) {
  const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({ allowShortKeys: false, counterLength: 8, counterRight: false, rounds: 20 }, opts);
  if (typeof core !== "function")
    throw new Error("core must be a function");
  anumber(counterLength);
  anumber(rounds);
  abool(counterRight);
  abool(allowShortKeys);
  return (key, nonce, data, output, counter = 0) => {
    abytes(key);
    abytes(nonce);
    abytes(data);
    const len = data.length;
    if (output === void 0)
      output = new Uint8Array(len);
    abytes(output);
    anumber(counter);
    if (counter < 0 || counter >= MAX_COUNTER)
      throw new Error("arx: counter overflow");
    if (output.length < len)
      throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
    const toClean = [];
    let l = key.length;
    let k;
    let sigma;
    if (l === 32) {
      toClean.push(k = copyBytes(key));
      sigma = sigma32_32;
    } else if (l === 16 && allowShortKeys) {
      k = new Uint8Array(32);
      k.set(key);
      k.set(key, 16);
      sigma = sigma16_32;
      toClean.push(k);
    } else {
      throw new Error(`arx: invalid 32-byte key, got length=${l}`);
    }
    if (!isAligned322(nonce))
      toClean.push(nonce = copyBytes(nonce));
    const k32 = u32(k);
    if (extendNonceFn) {
      if (nonce.length !== 24)
        throw new Error(`arx: extended nonce must be 24 bytes`);
      extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
      nonce = nonce.subarray(16);
    }
    const nonceNcLen = 16 - counterLength;
    if (nonceNcLen !== nonce.length)
      throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
    if (nonceNcLen !== 12) {
      const nc = new Uint8Array(12);
      nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
      nonce = nc;
      toClean.push(nonce);
    }
    const n32 = u32(nonce);
    runCipher(core, sigma, k32, n32, data, output, counter, rounds);
    clean(...toClean);
    return output;
  };
}

// ../../node_modules/@noble/ciphers/esm/_poly1305.js
var u8to16 = (a, i) => a[i++] & 255 | (a[i++] & 255) << 8;
var Poly1305 = class {
  constructor(key) {
    this.blockLen = 16;
    this.outputLen = 16;
    this.buffer = new Uint8Array(16);
    this.r = new Uint16Array(10);
    this.h = new Uint16Array(10);
    this.pad = new Uint16Array(8);
    this.pos = 0;
    this.finished = false;
    key = toBytes(key);
    abytes(key, 32);
    const t0 = u8to16(key, 0);
    const t1 = u8to16(key, 2);
    const t2 = u8to16(key, 4);
    const t3 = u8to16(key, 6);
    const t4 = u8to16(key, 8);
    const t5 = u8to16(key, 10);
    const t6 = u8to16(key, 12);
    const t7 = u8to16(key, 14);
    this.r[0] = t0 & 8191;
    this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
    this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
    this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
    this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
    this.r[5] = t4 >>> 1 & 8190;
    this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
    this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
    this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
    this.r[9] = t7 >>> 5 & 127;
    for (let i = 0; i < 8; i++)
      this.pad[i] = u8to16(key, 16 + 2 * i);
  }
  process(data, offset, isLast = false) {
    const hibit = isLast ? 0 : 1 << 11;
    const { h, r } = this;
    const r0 = r[0];
    const r1 = r[1];
    const r2 = r[2];
    const r3 = r[3];
    const r4 = r[4];
    const r5 = r[5];
    const r6 = r[6];
    const r7 = r[7];
    const r8 = r[8];
    const r9 = r[9];
    const t0 = u8to16(data, offset + 0);
    const t1 = u8to16(data, offset + 2);
    const t2 = u8to16(data, offset + 4);
    const t3 = u8to16(data, offset + 6);
    const t4 = u8to16(data, offset + 8);
    const t5 = u8to16(data, offset + 10);
    const t6 = u8to16(data, offset + 12);
    const t7 = u8to16(data, offset + 14);
    let h0 = h[0] + (t0 & 8191);
    let h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
    let h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
    let h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
    let h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
    let h5 = h[5] + (t4 >>> 1 & 8191);
    let h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
    let h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
    let h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
    let h9 = h[9] + (t7 >>> 5 | hibit);
    let c = 0;
    let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
    c = d0 >>> 13;
    d0 &= 8191;
    d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
    c += d0 >>> 13;
    d0 &= 8191;
    let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
    c = d1 >>> 13;
    d1 &= 8191;
    d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
    c += d1 >>> 13;
    d1 &= 8191;
    let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
    c = d2 >>> 13;
    d2 &= 8191;
    d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
    c += d2 >>> 13;
    d2 &= 8191;
    let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
    c = d3 >>> 13;
    d3 &= 8191;
    d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
    c += d3 >>> 13;
    d3 &= 8191;
    let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
    c = d4 >>> 13;
    d4 &= 8191;
    d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
    c += d4 >>> 13;
    d4 &= 8191;
    let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
    c = d5 >>> 13;
    d5 &= 8191;
    d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
    c += d5 >>> 13;
    d5 &= 8191;
    let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
    c = d6 >>> 13;
    d6 &= 8191;
    d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
    c += d6 >>> 13;
    d6 &= 8191;
    let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
    c = d7 >>> 13;
    d7 &= 8191;
    d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
    c += d7 >>> 13;
    d7 &= 8191;
    let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
    c = d8 >>> 13;
    d8 &= 8191;
    d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
    c += d8 >>> 13;
    d8 &= 8191;
    let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
    c = d9 >>> 13;
    d9 &= 8191;
    d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
    c += d9 >>> 13;
    d9 &= 8191;
    c = (c << 2) + c | 0;
    c = c + d0 | 0;
    d0 = c & 8191;
    c = c >>> 13;
    d1 += c;
    h[0] = d0;
    h[1] = d1;
    h[2] = d2;
    h[3] = d3;
    h[4] = d4;
    h[5] = d5;
    h[6] = d6;
    h[7] = d7;
    h[8] = d8;
    h[9] = d9;
  }
  finalize() {
    const { h, pad } = this;
    const g = new Uint16Array(10);
    let c = h[1] >>> 13;
    h[1] &= 8191;
    for (let i = 2; i < 10; i++) {
      h[i] += c;
      c = h[i] >>> 13;
      h[i] &= 8191;
    }
    h[0] += c * 5;
    c = h[0] >>> 13;
    h[0] &= 8191;
    h[1] += c;
    c = h[1] >>> 13;
    h[1] &= 8191;
    h[2] += c;
    g[0] = h[0] + 5;
    c = g[0] >>> 13;
    g[0] &= 8191;
    for (let i = 1; i < 10; i++) {
      g[i] = h[i] + c;
      c = g[i] >>> 13;
      g[i] &= 8191;
    }
    g[9] -= 1 << 13;
    let mask = (c ^ 1) - 1;
    for (let i = 0; i < 10; i++)
      g[i] &= mask;
    mask = ~mask;
    for (let i = 0; i < 10; i++)
      h[i] = h[i] & mask | g[i];
    h[0] = (h[0] | h[1] << 13) & 65535;
    h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
    h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
    h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
    h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
    h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
    h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
    h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
    let f = h[0] + pad[0];
    h[0] = f & 65535;
    for (let i = 1; i < 8; i++) {
      f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
      h[i] = f & 65535;
    }
    clean(g);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(data, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(buffer, 0, false);
        this.pos = 0;
      }
    }
    return this;
  }
  destroy() {
    clean(this.h, this.r, this.buffer, this.pad);
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, h } = this;
    let { pos } = this;
    if (pos) {
      buffer[pos++] = 1;
      for (; pos < 16; pos++)
        buffer[pos] = 0;
      this.process(buffer, 0, true);
    }
    this.finalize();
    let opos = 0;
    for (let i = 0; i < 8; i++) {
      out[opos++] = h[i] >>> 0;
      out[opos++] = h[i] >>> 8;
    }
    return out;
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
};
function wrapConstructorWithKey(hashCons) {
  const hashC = (msg, key) => hashCons(key).update(toBytes(msg)).digest();
  const tmp = hashCons(new Uint8Array(32));
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = (key) => hashCons(key);
  return hashC;
}
var poly1305 = wrapConstructorWithKey((key) => new Poly1305(key));

// ../../node_modules/@noble/ciphers/esm/chacha.js
function chachaCore(s, k, n, out, cnt, rounds = 20) {
  let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
  let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
  for (let r = 0; r < rounds; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  out[oi++] = y00 + x00 | 0;
  out[oi++] = y01 + x01 | 0;
  out[oi++] = y02 + x02 | 0;
  out[oi++] = y03 + x03 | 0;
  out[oi++] = y04 + x04 | 0;
  out[oi++] = y05 + x05 | 0;
  out[oi++] = y06 + x06 | 0;
  out[oi++] = y07 + x07 | 0;
  out[oi++] = y08 + x08 | 0;
  out[oi++] = y09 + x09 | 0;
  out[oi++] = y10 + x10 | 0;
  out[oi++] = y11 + x11 | 0;
  out[oi++] = y12 + x12 | 0;
  out[oi++] = y13 + x13 | 0;
  out[oi++] = y14 + x14 | 0;
  out[oi++] = y15 + x15 | 0;
}
function hchacha(s, k, i, o32) {
  let x00 = s[0], x01 = s[1], x02 = s[2], x03 = s[3], x04 = k[0], x05 = k[1], x06 = k[2], x07 = k[3], x08 = k[4], x09 = k[5], x10 = k[6], x11 = k[7], x12 = i[0], x13 = i[1], x14 = i[2], x15 = i[3];
  for (let r = 0; r < 20; r += 2) {
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 16);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 12);
    x00 = x00 + x04 | 0;
    x12 = rotl(x12 ^ x00, 8);
    x08 = x08 + x12 | 0;
    x04 = rotl(x04 ^ x08, 7);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 16);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 12);
    x01 = x01 + x05 | 0;
    x13 = rotl(x13 ^ x01, 8);
    x09 = x09 + x13 | 0;
    x05 = rotl(x05 ^ x09, 7);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 16);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 12);
    x02 = x02 + x06 | 0;
    x14 = rotl(x14 ^ x02, 8);
    x10 = x10 + x14 | 0;
    x06 = rotl(x06 ^ x10, 7);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 16);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 12);
    x03 = x03 + x07 | 0;
    x15 = rotl(x15 ^ x03, 8);
    x11 = x11 + x15 | 0;
    x07 = rotl(x07 ^ x11, 7);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 16);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 12);
    x00 = x00 + x05 | 0;
    x15 = rotl(x15 ^ x00, 8);
    x10 = x10 + x15 | 0;
    x05 = rotl(x05 ^ x10, 7);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 16);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 12);
    x01 = x01 + x06 | 0;
    x12 = rotl(x12 ^ x01, 8);
    x11 = x11 + x12 | 0;
    x06 = rotl(x06 ^ x11, 7);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 16);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 12);
    x02 = x02 + x07 | 0;
    x13 = rotl(x13 ^ x02, 8);
    x08 = x08 + x13 | 0;
    x07 = rotl(x07 ^ x08, 7);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 16);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 12);
    x03 = x03 + x04 | 0;
    x14 = rotl(x14 ^ x03, 8);
    x09 = x09 + x14 | 0;
    x04 = rotl(x04 ^ x09, 7);
  }
  let oi = 0;
  o32[oi++] = x00;
  o32[oi++] = x01;
  o32[oi++] = x02;
  o32[oi++] = x03;
  o32[oi++] = x12;
  o32[oi++] = x13;
  o32[oi++] = x14;
  o32[oi++] = x15;
}
var chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 4,
  allowShortKeys: false
});
var xchacha20 = /* @__PURE__ */ createCipher(chachaCore, {
  counterRight: false,
  counterLength: 8,
  extendNonceFn: hchacha,
  allowShortKeys: false
});
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var updatePadded = (h, msg) => {
  h.update(msg);
  const left = msg.length % 16;
  if (left)
    h.update(ZEROS16.subarray(left));
};
var ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, data, AAD) {
  const authKey = fn(key, nonce, ZEROS32);
  const h = poly1305.create(authKey);
  if (AAD)
    updatePadded(h, AAD);
  updatePadded(h, data);
  const num = u64Lengths(data.length, AAD ? AAD.length : 0, true);
  h.update(num);
  const res = h.digest();
  clean(authKey, num);
  return res;
}
var _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
  const tagLength = 16;
  return {
    encrypt(plaintext, output) {
      const plength = plaintext.length;
      output = getOutput(plength + tagLength, output, false);
      output.set(plaintext);
      const oPlain = output.subarray(0, -tagLength);
      xorStream(key, nonce, oPlain, oPlain, 1);
      const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
      output.set(tag, plength);
      clean(tag);
      return output;
    },
    decrypt(ciphertext, output) {
      output = getOutput(ciphertext.length - tagLength, output, false);
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = computeTag(xorStream, key, nonce, data, AAD);
      if (!equalBytes(passedTag, tag))
        throw new Error("invalid tag");
      output.set(ciphertext.subarray(0, -tagLength));
      xorStream(key, nonce, output, output, 1);
      clean(tag);
      return output;
    }
  };
};
var chacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 12, tagLength: 16 }, _poly1305_aead(chacha20));
var xchacha20poly1305 = /* @__PURE__ */ wrapCipher({ blockSize: 64, nonceLength: 24, tagLength: 16 }, _poly1305_aead(xchacha20));

// ../../node_modules/@noble/hashes/esm/crypto.js
var crypto2 = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

// ../../node_modules/@noble/hashes/esm/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber2(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes2(b, ...lengths) {
  if (!isBytes2(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.createHasher");
  anumber2(h.outputLen);
  anumber2(h.blockLen);
}
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput2(out, instance) {
  abytes2(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes2(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function utf8ToBytes2(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes2(data) {
  if (typeof data === "string")
    data = utf8ToBytes2(data);
  abytes2(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
var Hash2 = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes2(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto2 && typeof crypto2.getRandomValues === "function") {
    return crypto2.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto2 && typeof crypto2.randomBytes === "function") {
    return Uint8Array.from(crypto2.randomBytes(bytesLength));
  }
  throw new Error("crypto.getRandomValues must be defined");
}

// ../../node_modules/@noble/hashes/esm/_md.js
function setBigUint642(view, byteOffset, value, isLE2) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE2);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE2);
  view.setUint32(byteOffset + l, wl, isLE2);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash2 {
  constructor(blockLen, outputLen, padOffset, isLE2) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView2(this.buffer);
  }
  update(data) {
    aexists2(this);
    data = toBytes2(data);
    abytes2(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView2(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean2(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint642(view, blockLen - 8, BigInt(this.length * 8), isLE2);
    this.process(view, 0);
    const oview = createView2(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA512_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  4089235720,
  3144134277,
  2227873595,
  1013904242,
  4271175723,
  2773480762,
  1595750129,
  1359893119,
  2917565137,
  2600822924,
  725511199,
  528734635,
  4215389547,
  1541459225,
  327033209
]);

// ../../node_modules/@noble/hashes/esm/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var shrSH = (h, _l, s) => h >>> s;
var shrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
function add(Ah, Al, Bh, Bl) {
  const l = (Al >>> 0) + (Bl >>> 0);
  return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
}
var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;

// ../../node_modules/@noble/hashes/esm/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean2(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean2(this.buffer);
  }
};
var K512 = /* @__PURE__ */ (() => split([
  "0x428a2f98d728ae22",
  "0x7137449123ef65cd",
  "0xb5c0fbcfec4d3b2f",
  "0xe9b5dba58189dbbc",
  "0x3956c25bf348b538",
  "0x59f111f1b605d019",
  "0x923f82a4af194f9b",
  "0xab1c5ed5da6d8118",
  "0xd807aa98a3030242",
  "0x12835b0145706fbe",
  "0x243185be4ee4b28c",
  "0x550c7dc3d5ffb4e2",
  "0x72be5d74f27b896f",
  "0x80deb1fe3b1696b1",
  "0x9bdc06a725c71235",
  "0xc19bf174cf692694",
  "0xe49b69c19ef14ad2",
  "0xefbe4786384f25e3",
  "0x0fc19dc68b8cd5b5",
  "0x240ca1cc77ac9c65",
  "0x2de92c6f592b0275",
  "0x4a7484aa6ea6e483",
  "0x5cb0a9dcbd41fbd4",
  "0x76f988da831153b5",
  "0x983e5152ee66dfab",
  "0xa831c66d2db43210",
  "0xb00327c898fb213f",
  "0xbf597fc7beef0ee4",
  "0xc6e00bf33da88fc2",
  "0xd5a79147930aa725",
  "0x06ca6351e003826f",
  "0x142929670a0e6e70",
  "0x27b70a8546d22ffc",
  "0x2e1b21385c26c926",
  "0x4d2c6dfc5ac42aed",
  "0x53380d139d95b3df",
  "0x650a73548baf63de",
  "0x766a0abb3c77b2a8",
  "0x81c2c92e47edaee6",
  "0x92722c851482353b",
  "0xa2bfe8a14cf10364",
  "0xa81a664bbc423001",
  "0xc24b8b70d0f89791",
  "0xc76c51a30654be30",
  "0xd192e819d6ef5218",
  "0xd69906245565a910",
  "0xf40e35855771202a",
  "0x106aa07032bbd1b8",
  "0x19a4c116b8d2d0c8",
  "0x1e376c085141ab53",
  "0x2748774cdf8eeb99",
  "0x34b0bcb5e19b48a8",
  "0x391c0cb3c5c95a63",
  "0x4ed8aa4ae3418acb",
  "0x5b9cca4f7763e373",
  "0x682e6ff3d6b2b8a3",
  "0x748f82ee5defb2fc",
  "0x78a5636f43172f60",
  "0x84c87814a1f0ab72",
  "0x8cc702081a6439ec",
  "0x90befffa23631e28",
  "0xa4506cebde82bde9",
  "0xbef9a3f7b2c67915",
  "0xc67178f2e372532b",
  "0xca273eceea26619c",
  "0xd186b8c721c0c207",
  "0xeada7dd6cde0eb1e",
  "0xf57d4f7fee6ed178",
  "0x06f067aa72176fba",
  "0x0a637dc5a2c898a6",
  "0x113f9804bef90dae",
  "0x1b710b35131c471b",
  "0x28db77f523047d84",
  "0x32caab7b40c72493",
  "0x3c9ebe0a15c9bebc",
  "0x431d67c49c100d4c",
  "0x4cc5d4becb3e42b6",
  "0x597f299cfc657e2a",
  "0x5fcb6fab3ad6faec",
  "0x6c44198c4a475817"
].map((n) => BigInt(n))))();
var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
var SHA512 = class extends HashMD {
  constructor(outputLen = 64) {
    super(128, outputLen, 16, false);
    this.Ah = SHA512_IV[0] | 0;
    this.Al = SHA512_IV[1] | 0;
    this.Bh = SHA512_IV[2] | 0;
    this.Bl = SHA512_IV[3] | 0;
    this.Ch = SHA512_IV[4] | 0;
    this.Cl = SHA512_IV[5] | 0;
    this.Dh = SHA512_IV[6] | 0;
    this.Dl = SHA512_IV[7] | 0;
    this.Eh = SHA512_IV[8] | 0;
    this.El = SHA512_IV[9] | 0;
    this.Fh = SHA512_IV[10] | 0;
    this.Fl = SHA512_IV[11] | 0;
    this.Gh = SHA512_IV[12] | 0;
    this.Gl = SHA512_IV[13] | 0;
    this.Hh = SHA512_IV[14] | 0;
    this.Hl = SHA512_IV[15] | 0;
  }
  // prettier-ignore
  get() {
    const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
  }
  // prettier-ignore
  set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
    this.Ah = Ah | 0;
    this.Al = Al | 0;
    this.Bh = Bh | 0;
    this.Bl = Bl | 0;
    this.Ch = Ch | 0;
    this.Cl = Cl | 0;
    this.Dh = Dh | 0;
    this.Dl = Dl | 0;
    this.Eh = Eh | 0;
    this.El = El | 0;
    this.Fh = Fh | 0;
    this.Fl = Fl | 0;
    this.Gh = Gh | 0;
    this.Gl = Gl | 0;
    this.Hh = Hh | 0;
    this.Hl = Hl | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4) {
      SHA512_W_H[i] = view.getUint32(offset);
      SHA512_W_L[i] = view.getUint32(offset += 4);
    }
    for (let i = 16; i < 80; i++) {
      const W15h = SHA512_W_H[i - 15] | 0;
      const W15l = SHA512_W_L[i - 15] | 0;
      const s0h = rotrSH(W15h, W15l, 1) ^ rotrSH(W15h, W15l, 8) ^ shrSH(W15h, W15l, 7);
      const s0l = rotrSL(W15h, W15l, 1) ^ rotrSL(W15h, W15l, 8) ^ shrSL(W15h, W15l, 7);
      const W2h = SHA512_W_H[i - 2] | 0;
      const W2l = SHA512_W_L[i - 2] | 0;
      const s1h = rotrSH(W2h, W2l, 19) ^ rotrBH(W2h, W2l, 61) ^ shrSH(W2h, W2l, 6);
      const s1l = rotrSL(W2h, W2l, 19) ^ rotrBL(W2h, W2l, 61) ^ shrSL(W2h, W2l, 6);
      const SUMl = add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
      const SUMh = add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
      SHA512_W_H[i] = SUMh | 0;
      SHA512_W_L[i] = SUMl | 0;
    }
    let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
    for (let i = 0; i < 80; i++) {
      const sigma1h = rotrSH(Eh, El, 14) ^ rotrSH(Eh, El, 18) ^ rotrBH(Eh, El, 41);
      const sigma1l = rotrSL(Eh, El, 14) ^ rotrSL(Eh, El, 18) ^ rotrBL(Eh, El, 41);
      const CHIh = Eh & Fh ^ ~Eh & Gh;
      const CHIl = El & Fl ^ ~El & Gl;
      const T1ll = add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
      const T1h = add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
      const T1l = T1ll | 0;
      const sigma0h = rotrSH(Ah, Al, 28) ^ rotrBH(Ah, Al, 34) ^ rotrBH(Ah, Al, 39);
      const sigma0l = rotrSL(Ah, Al, 28) ^ rotrBL(Ah, Al, 34) ^ rotrBL(Ah, Al, 39);
      const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
      const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
      Hh = Gh | 0;
      Hl = Gl | 0;
      Gh = Fh | 0;
      Gl = Fl | 0;
      Fh = Eh | 0;
      Fl = El | 0;
      ({ h: Eh, l: El } = add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
      Dh = Ch | 0;
      Dl = Cl | 0;
      Ch = Bh | 0;
      Cl = Bl | 0;
      Bh = Ah | 0;
      Bl = Al | 0;
      const All = add3L(T1l, sigma0l, MAJl);
      Ah = add3H(All, T1h, sigma0h, MAJh);
      Al = All | 0;
    }
    ({ h: Ah, l: Al } = add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
    ({ h: Bh, l: Bl } = add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
    ({ h: Ch, l: Cl } = add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
    ({ h: Dh, l: Dl } = add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
    ({ h: Eh, l: El } = add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
    ({ h: Fh, l: Fl } = add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
    ({ h: Gh, l: Gl } = add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
    ({ h: Hh, l: Hl } = add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
    this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
  }
  roundClean() {
    clean2(SHA512_W_H, SHA512_W_L);
  }
  destroy() {
    clean2(this.buffer);
    this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  }
};
var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());
var sha512 = /* @__PURE__ */ createHasher(() => new SHA512());

// ../../node_modules/@noble/curves/esm/utils.js
var _0n = /* @__PURE__ */ BigInt(0);
var _1n = /* @__PURE__ */ BigInt(1);
function _abool2(value, title = "") {
  if (typeof value !== "boolean") {
    const prefix = title && `"${title}"`;
    throw new Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function _abytes2(value, length, title = "") {
  const bytes = isBytes2(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  abytes2(bytes);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes2(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function equalBytes2(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function copyBytes2(bytes) {
  return Uint8Array.from(bytes);
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function _validateObject(object, fields, optFields = {}) {
  if (!object || typeof object !== "object")
    throw new Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    const val = object[fieldName];
    if (isOpt && val === void 0)
      return;
    const current = typeof val;
    if (current !== expectedType || val === null)
      throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  Object.entries(fields).forEach(([k, v]) => checkField(k, v, false));
  Object.entries(optFields).forEach(([k, v]) => checkField(k, v, true));
}
var notImplemented = () => {
  throw new Error("not implemented");
};
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// ../../node_modules/@noble/curves/esm/abstract/modular.js
var _0n2 = BigInt(0);
var _1n2 = BigInt(1);
var _2n = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _7n = /* @__PURE__ */ BigInt(7);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n2)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp2, root, n) {
  if (!Fp2.eql(Fp2.sqr(root), n))
    throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp2, n) {
  const p1div4 = (Fp2.ORDER + _1n2) / _4n;
  const root = Fp2.pow(n, p1div4);
  assertIsSquare(Fp2, root, n);
  return root;
}
function sqrt5mod8(Fp2, n) {
  const p5div8 = (Fp2.ORDER - _5n) / _8n;
  const n2 = Fp2.mul(n, _2n);
  const v = Fp2.pow(n2, p5div8);
  const nv = Fp2.mul(n, v);
  const i = Fp2.mul(Fp2.mul(nv, _2n), v);
  const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
  assertIsSquare(Fp2, root, n);
  return root;
}
function sqrt9mod16(P) {
  const Fp_ = Field(P);
  const tn = tonelliShanks(P);
  const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
  const c2 = tn(Fp_, c1);
  const c3 = tn(Fp_, Fp_.neg(c1));
  const c4 = (P + _7n) / _16n;
  return (Fp2, n) => {
    let tv1 = Fp2.pow(n, c4);
    let tv2 = Fp2.mul(tv1, c1);
    const tv3 = Fp2.mul(tv1, c2);
    const tv4 = Fp2.mul(tv1, c3);
    const e1 = Fp2.eql(Fp2.sqr(tv2), n);
    const e2 = Fp2.eql(Fp2.sqr(tv3), n);
    tv1 = Fp2.cmov(tv1, tv2, e1);
    tv2 = Fp2.cmov(tv4, tv3, e2);
    const e3 = Fp2.eql(Fp2.sqr(tv2), n);
    const root = Fp2.cmov(tv1, tv2, e3);
    assertIsSquare(Fp2, root, n);
    return root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw new Error("sqrt is not defined for small field");
  let Q = P - _1n2;
  let S = 0;
  while (Q % _2n === _0n2) {
    Q /= _2n;
    S++;
  }
  let Z = _2n;
  const _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1) {
    if (Z++ > 1e3)
      throw new Error("Cannot find square root: probably non-prime P");
  }
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q);
  const Q1div2 = (Q + _1n2) / _2n;
  return function tonelliSlow(Fp2, n) {
    if (Fp2.is0(n))
      return n;
    if (FpLegendre(Fp2, n) !== 1)
      throw new Error("Cannot find square root");
    let M = S;
    let c = Fp2.mul(Fp2.ONE, cc);
    let t = Fp2.pow(n, Q);
    let R = Fp2.pow(n, Q1div2);
    while (!Fp2.eql(t, Fp2.ONE)) {
      if (Fp2.is0(t))
        return Fp2.ZERO;
      let i = 1;
      let t_tmp = Fp2.sqr(t);
      while (!Fp2.eql(t_tmp, Fp2.ONE)) {
        i++;
        t_tmp = Fp2.sqr(t_tmp);
        if (i === M)
          throw new Error("Cannot find square root");
      }
      const exponent = _1n2 << BigInt(M - i - 1);
      const b = Fp2.pow(c, exponent);
      M = i;
      c = Fp2.sqr(b);
      t = Fp2.mul(t, c);
      R = Fp2.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var isNegativeLE = (num, modulo) => (mod(num, modulo) & _1n2) === _1n2;
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "number",
    BITS: "number"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  _validateObject(field, opts);
  return field;
}
function FpPow(Fp2, num, power) {
  if (power < _0n2)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp2.ONE;
  if (power === _1n2)
    return num;
  let p = Fp2.ONE;
  let d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp2.mul(p, d);
    d = Fp2.sqr(d);
    power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp2, nums, passZero = false) {
  const inverted = new Array(nums.length).fill(passZero ? Fp2.ZERO : void 0);
  const multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp2.is0(num))
      return acc;
    inverted[i] = acc;
    return Fp2.mul(acc, num);
  }, Fp2.ONE);
  const invertedAcc = Fp2.inv(multipliedAcc);
  nums.reduceRight((acc, num, i) => {
    if (Fp2.is0(num))
      return acc;
    inverted[i] = Fp2.mul(acc, inverted[i]);
    return Fp2.mul(acc, num);
  }, invertedAcc);
  return inverted;
}
function FpLegendre(Fp2, n) {
  const p1mod2 = (Fp2.ORDER - _1n2) / _2n;
  const powered = Fp2.pow(n, p1mod2);
  const yes = Fp2.eql(powered, Fp2.ONE);
  const zero = Fp2.eql(powered, Fp2.ZERO);
  const no = Fp2.eql(powered, Fp2.neg(Fp2.ONE));
  if (!yes && !zero && !no)
    throw new Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber2(nBitLength);
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLenOrOpts, isLE2 = false, opts = {}) {
  if (ORDER <= _0n2)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  let _nbitLength = void 0;
  let _sqrt = void 0;
  let modFromBytes = false;
  let allowedLengths = void 0;
  if (typeof bitLenOrOpts === "object" && bitLenOrOpts != null) {
    if (opts.sqrt || isLE2)
      throw new Error("cannot specify opts in two arguments");
    const _opts = bitLenOrOpts;
    if (_opts.BITS)
      _nbitLength = _opts.BITS;
    if (_opts.sqrt)
      _sqrt = _opts.sqrt;
    if (typeof _opts.isLE === "boolean")
      isLE2 = _opts.isLE;
    if (typeof _opts.modFromBytes === "boolean")
      modFromBytes = _opts.modFromBytes;
    allowedLengths = _opts.allowedLengths;
  } else {
    if (typeof bitLenOrOpts === "number")
      _nbitLength = bitLenOrOpts;
    if (opts.sqrt)
      _sqrt = opts.sqrt;
  }
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, _nbitLength);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE: isLE2,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n2,
    ONE: _1n2,
    allowedLengths,
    create: (num) => mod(num, ORDER),
    isValid: (num) => {
      if (typeof num !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num);
      return _0n2 <= num && num < ORDER;
    },
    is0: (num) => num === _0n2,
    // is valid and invertible
    isValidNot0: (num) => !f.is0(num) && f.isValid(num),
    isOdd: (num) => (num & _1n2) === _1n2,
    neg: (num) => mod(-num, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num) => mod(num * num, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num, power) => FpPow(f, num, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num) => num * num,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num) => invert(num, ORDER),
    sqrt: _sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    toBytes: (num) => isLE2 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
    fromBytes: (bytes, skipValidation = true) => {
      if (allowedLengths) {
        if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) {
          throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
        }
        const padded = new Uint8Array(BYTES);
        padded.set(bytes, isLE2 ? 0 : padded.length - bytes.length);
        bytes = padded;
      }
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      let scalar = isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
      if (modFromBytes)
        scalar = mod(scalar, ORDER);
      if (!skipValidation) {
        if (!f.isValid(scalar))
          throw new Error("invalid field element: outside of range 0..ORDER");
      }
      return scalar;
    },
    // TODO: we don't need it here, move out to separate fn
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // We can't move this out because Fp6, Fp12 implement it
    // and it's unclear what to return in there.
    cmov: (a, b, c) => c ? b : a
  });
  return Object.freeze(f);
}

// ../../node_modules/@noble/curves/esm/abstract/curve.js
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
function negateCt(condition, item) {
  const neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  const windows = Math.ceil(scalarBits / W) + 1;
  const windowSize = 2 ** (W - 1);
  const maxNumber = 2 ** W;
  const mask = bitMask(W);
  const shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window2, wOpts) {
  const { windowSize, mask, maxNumber, shiftBy } = wOpts;
  let wbits = Number(n & mask);
  let nextN = n >> shiftBy;
  if (wbits > windowSize) {
    wbits -= maxNumber;
    nextN += _1n3;
  }
  const offsetStart = window2 * windowSize;
  const offset = offsetStart + Math.abs(wbits) - 1;
  const isZero = wbits === 0;
  const isNeg = wbits < 0;
  const isNegF = window2 % 2 !== 0;
  const offsetF = offsetStart;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw new Error("invalid wNAF");
}
var wNAF = class {
  // Parametrized with a given Point class (not individual point)
  constructor(Point, bits) {
    this.BASE = Point.BASE;
    this.ZERO = Point.ZERO;
    this.Fn = Point.Fn;
    this.bits = bits;
  }
  // non-const time multiplication ladder
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double();
      n >>= _1n3;
    }
    return p;
  }
  /**
   * Creates a wNAF precomputation window. Used for caching.
   * Default window size is set by `utils.precompute()` and is equal to 8.
   * Number of precomputed points depends on the curve size:
   * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
   * - 𝑊 is the window size
   * - 𝑛 is the bitlength of the curve order.
   * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
   * @param point Point instance
   * @param W window size
   * @returns precomputed point tables flattened to a single array
   */
  precomputeWindow(point, W) {
    const { windows, windowSize } = calcWOpts(W, this.bits);
    const points = [];
    let p = point;
    let base = p;
    for (let window2 = 0; window2 < windows; window2++) {
      base = p;
      points.push(base);
      for (let i = 1; i < windowSize; i++) {
        base = base.add(p);
        points.push(base);
      }
      p = base.double();
    }
    return points;
  }
  /**
   * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
   * More compact implementation:
   * https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
   * @returns real and fake (for const-time) points
   */
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw new Error("invalid scalar");
    let p = this.ZERO;
    let f = this.BASE;
    const wo = calcWOpts(W, this.bits);
    for (let window2 = 0; window2 < wo.windows; window2++) {
      const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window2, wo);
      n = nextN;
      if (isZero) {
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      } else {
        p = p.add(negateCt(isNeg, precomputes[offset]));
      }
    }
    assert0(n);
    return { p, f };
  }
  /**
   * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
   * @param acc accumulator point to add result of multiplication
   * @returns point
   */
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    const wo = calcWOpts(W, this.bits);
    for (let window2 = 0; window2 < wo.windows; window2++) {
      if (n === _0n3)
        break;
      const { nextN, offset, isZero, isNeg } = calcOffsets(n, window2, wo);
      n = nextN;
      if (isZero) {
        continue;
      } else {
        const item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    assert0(n);
    return acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      comp = this.precomputeWindow(point, W);
      if (W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    const W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    const W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  createCache(P, W) {
    validateW(W, this.bits);
    pointWindowSizes.set(P, W);
    pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
};
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  const plength = points.length;
  const slength = scalars.length;
  if (plength !== slength)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(plength));
  let windowSize = 1;
  if (wbits > 12)
    windowSize = wbits - 3;
  else if (wbits > 4)
    windowSize = wbits - 2;
  else if (wbits > 0)
    windowSize = 2;
  const MASK = bitMask(windowSize);
  const buckets = new Array(Number(MASK) + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < slength; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & MASK);
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function createField(order, field, isLE2) {
  if (field) {
    if (field.ORDER !== order)
      throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
    validateField(field);
    return field;
  } else {
    return Field(order, { isLE: isLE2 });
  }
}
function _createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw new Error(`expected valid ${type} CURVE object`);
  for (const p of ["p", "n", "h"]) {
    const val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw new Error(`CURVE.${p} must be positive bigint`);
  }
  const Fp2 = createField(CURVE.p, curveOpts.Fp, FpFnLE);
  const Fn2 = createField(CURVE.n, curveOpts.Fn, FpFnLE);
  const _b = type === "weierstrass" ? "b" : "d";
  const params = ["Gx", "Gy", "a", _b];
  for (const p of params) {
    if (!Fp2.isValid(CURVE[p]))
      throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  }
  CURVE = Object.freeze(Object.assign({}, CURVE));
  return { CURVE, Fp: Fp2, Fn: Fn2 };
}

// ../../node_modules/@noble/curves/esm/abstract/edwards.js
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
var _2n2 = BigInt(2);
var _8n2 = BigInt(8);
function isEdValidXY(Fp2, CURVE, x, y) {
  const x2 = Fp2.sqr(x);
  const y2 = Fp2.sqr(y);
  const left = Fp2.add(Fp2.mul(CURVE.a, x2), y2);
  const right = Fp2.add(Fp2.ONE, Fp2.mul(CURVE.d, Fp2.mul(x2, y2)));
  return Fp2.eql(left, right);
}
function edwards(params, extraOpts = {}) {
  const validated = _createCurveFields("edwards", params, extraOpts, extraOpts.FpFnLE);
  const { Fp: Fp2, Fn: Fn2 } = validated;
  let CURVE = validated.CURVE;
  const { h: cofactor } = CURVE;
  _validateObject(extraOpts, {}, { uvRatio: "function" });
  const MASK = _2n2 << BigInt(Fn2.BYTES * 8) - _1n4;
  const modP = (n) => Fp2.create(n);
  const uvRatio2 = extraOpts.uvRatio || ((u, v) => {
    try {
      return { isValid: true, value: Fp2.sqrt(Fp2.div(u, v)) };
    } catch (e) {
      return { isValid: false, value: _0n4 };
    }
  });
  if (!isEdValidXY(Fp2, CURVE, CURVE.Gx, CURVE.Gy))
    throw new Error("bad curve params: generator point");
  function acoord(title, n, banZero = false) {
    const min = banZero ? _1n4 : _0n4;
    aInRange("coordinate " + title, n, min, MASK);
    return n;
  }
  function aextpoint(other) {
    if (!(other instanceof Point))
      throw new Error("ExtendedPoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { X, Y, Z } = p;
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? _8n2 : Fp2.inv(Z);
    const x = modP(X * iz);
    const y = modP(Y * iz);
    const zz = Fp2.mul(Z, iz);
    if (is0)
      return { x: _0n4, y: _1n4 };
    if (zz !== _1n4)
      throw new Error("invZ was invalid");
    return { x, y };
  });
  const assertValidMemo = memoized((p) => {
    const { a, d } = CURVE;
    if (p.is0())
      throw new Error("bad point: ZERO");
    const { X, Y, Z, T } = p;
    const X2 = modP(X * X);
    const Y2 = modP(Y * Y);
    const Z2 = modP(Z * Z);
    const Z4 = modP(Z2 * Z2);
    const aX2 = modP(X2 * a);
    const left = modP(Z2 * modP(aX2 + Y2));
    const right = modP(Z4 + modP(d * modP(X2 * Y2)));
    if (left !== right)
      throw new Error("bad point: equation left != right (1)");
    const XY = modP(X * Y);
    const ZT = modP(Z * T);
    if (XY !== ZT)
      throw new Error("bad point: equation left != right (2)");
    return true;
  });
  class Point {
    constructor(X, Y, Z, T) {
      this.X = acoord("x", X);
      this.Y = acoord("y", Y);
      this.Z = acoord("z", Z, true);
      this.T = acoord("t", T);
      Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      if (p instanceof Point)
        throw new Error("extended point not allowed");
      const { x, y } = p || {};
      acoord("x", x);
      acoord("y", y);
      return new Point(x, y, _1n4, modP(x * y));
    }
    // Uses algo from RFC8032 5.1.3.
    static fromBytes(bytes, zip215 = false) {
      const len = Fp2.BYTES;
      const { a, d } = CURVE;
      bytes = copyBytes2(_abytes2(bytes, len, "point"));
      _abool2(zip215, "zip215");
      const normed = copyBytes2(bytes);
      const lastByte = bytes[len - 1];
      normed[len - 1] = lastByte & ~128;
      const y = bytesToNumberLE(normed);
      const max = zip215 ? MASK : Fp2.ORDER;
      aInRange("point.y", y, _0n4, max);
      const y2 = modP(y * y);
      const u = modP(y2 - _1n4);
      const v = modP(d * y2 - a);
      let { isValid, value: x } = uvRatio2(u, v);
      if (!isValid)
        throw new Error("bad point: invalid y coordinate");
      const isXOdd = (x & _1n4) === _1n4;
      const isLastByteOdd = (lastByte & 128) !== 0;
      if (!zip215 && x === _0n4 && isLastByteOdd)
        throw new Error("bad point: x=0 and x_0=1");
      if (isLastByteOdd !== isXOdd)
        x = modP(-x);
      return Point.fromAffine({ x, y });
    }
    static fromHex(bytes, zip215 = false) {
      return Point.fromBytes(ensureBytes("point", bytes), zip215);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = true) {
      wnaf.createCache(this, windowSize);
      if (!isLazy)
        this.multiply(_2n2);
      return this;
    }
    // Useful in fromAffine() - not for fromBytes(), which always created valid points.
    assertValidity() {
      assertValidMemo(this);
    }
    // Compare one point to another.
    equals(other) {
      aextpoint(other);
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const { X: X2, Y: Y2, Z: Z2 } = other;
      const X1Z2 = modP(X1 * Z2);
      const X2Z1 = modP(X2 * Z1);
      const Y1Z2 = modP(Y1 * Z2);
      const Y2Z1 = modP(Y2 * Z1);
      return X1Z2 === X2Z1 && Y1Z2 === Y2Z1;
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    negate() {
      return new Point(modP(-this.X), this.Y, this.Z, modP(-this.T));
    }
    // Fast algo for doubling Extended Point.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#doubling-dbl-2008-hwcd
    // Cost: 4M + 4S + 1*a + 6add + 1*2.
    double() {
      const { a } = CURVE;
      const { X: X1, Y: Y1, Z: Z1 } = this;
      const A = modP(X1 * X1);
      const B = modP(Y1 * Y1);
      const C = modP(_2n2 * modP(Z1 * Z1));
      const D = modP(a * A);
      const x1y1 = X1 + Y1;
      const E = modP(modP(x1y1 * x1y1) - A - B);
      const G = D + B;
      const F = G - C;
      const H = D - B;
      const X3 = modP(E * F);
      const Y3 = modP(G * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G);
      return new Point(X3, Y3, Z3, T3);
    }
    // Fast algo for adding 2 Extended Points.
    // https://hyperelliptic.org/EFD/g1p/auto-twisted-extended.html#addition-add-2008-hwcd
    // Cost: 9M + 1*a + 1*d + 7add.
    add(other) {
      aextpoint(other);
      const { a, d } = CURVE;
      const { X: X1, Y: Y1, Z: Z1, T: T1 } = this;
      const { X: X2, Y: Y2, Z: Z2, T: T2 } = other;
      const A = modP(X1 * X2);
      const B = modP(Y1 * Y2);
      const C = modP(T1 * d * T2);
      const D = modP(Z1 * Z2);
      const E = modP((X1 + Y1) * (X2 + Y2) - A - B);
      const F = D - C;
      const G = D + C;
      const H = modP(B - a * A);
      const X3 = modP(E * F);
      const Y3 = modP(G * H);
      const T3 = modP(E * H);
      const Z3 = modP(F * G);
      return new Point(X3, Y3, Z3, T3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    // Constant-time multiplication.
    multiply(scalar) {
      if (!Fn2.isValidNot0(scalar))
        throw new Error("invalid scalar: expected 1 <= sc < curve.n");
      const { p, f } = wnaf.cached(this, scalar, (p2) => normalizeZ(Point, p2));
      return normalizeZ(Point, [p, f])[0];
    }
    // Non-constant-time multiplication. Uses double-and-add algorithm.
    // It's faster, but should only be used when you don't care about
    // an exposed private key e.g. sig verification.
    // Does NOT allow scalars higher than CURVE.n.
    // Accepts optional accumulator to merge with multiply (important for sparse scalars)
    multiplyUnsafe(scalar, acc = Point.ZERO) {
      if (!Fn2.isValid(scalar))
        throw new Error("invalid scalar: expected 0 <= sc < curve.n");
      if (scalar === _0n4)
        return Point.ZERO;
      if (this.is0() || scalar === _1n4)
        return this;
      return wnaf.unsafe(this, scalar, (p) => normalizeZ(Point, p), acc);
    }
    // Checks if point is of small order.
    // If you add something to small order point, you will have "dirty"
    // point with torsion component.
    // Multiplies point by cofactor and checks if the result is 0.
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    // Multiplies point by curve order and checks if the result is 0.
    // Returns `false` is the point is dirty.
    isTorsionFree() {
      return wnaf.unsafe(this, CURVE.n).is0();
    }
    // Converts Extended point to default (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    clearCofactor() {
      if (cofactor === _1n4)
        return this;
      return this.multiplyUnsafe(cofactor);
    }
    toBytes() {
      const { x, y } = this.toAffine();
      const bytes = Fp2.toBytes(y);
      bytes[bytes.length - 1] |= x & _1n4 ? 128 : 0;
      return bytes;
    }
    toHex() {
      return bytesToHex(this.toBytes());
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
    // TODO: remove
    get ex() {
      return this.X;
    }
    get ey() {
      return this.Y;
    }
    get ez() {
      return this.Z;
    }
    get et() {
      return this.T;
    }
    static normalizeZ(points) {
      return normalizeZ(Point, points);
    }
    static msm(points, scalars) {
      return pippenger(Point, Fn2, points, scalars);
    }
    _setWindowSize(windowSize) {
      this.precompute(windowSize);
    }
    toRawBytes() {
      return this.toBytes();
    }
  }
  Point.BASE = new Point(CURVE.Gx, CURVE.Gy, _1n4, modP(CURVE.Gx * CURVE.Gy));
  Point.ZERO = new Point(_0n4, _1n4, _1n4, _0n4);
  Point.Fp = Fp2;
  Point.Fn = Fn2;
  const wnaf = new wNAF(Point, Fn2.BITS);
  Point.BASE.precompute(8);
  return Point;
}
var PrimeEdwardsPoint = class {
  constructor(ep) {
    this.ep = ep;
  }
  // Static methods that must be implemented by subclasses
  static fromBytes(_bytes) {
    notImplemented();
  }
  static fromHex(_hex) {
    notImplemented();
  }
  get x() {
    return this.toAffine().x;
  }
  get y() {
    return this.toAffine().y;
  }
  // Common implementations
  clearCofactor() {
    return this;
  }
  assertValidity() {
    this.ep.assertValidity();
  }
  toAffine(invertedZ) {
    return this.ep.toAffine(invertedZ);
  }
  toHex() {
    return bytesToHex(this.toBytes());
  }
  toString() {
    return this.toHex();
  }
  isTorsionFree() {
    return true;
  }
  isSmallOrder() {
    return false;
  }
  add(other) {
    this.assertSame(other);
    return this.init(this.ep.add(other.ep));
  }
  subtract(other) {
    this.assertSame(other);
    return this.init(this.ep.subtract(other.ep));
  }
  multiply(scalar) {
    return this.init(this.ep.multiply(scalar));
  }
  multiplyUnsafe(scalar) {
    return this.init(this.ep.multiplyUnsafe(scalar));
  }
  double() {
    return this.init(this.ep.double());
  }
  negate() {
    return this.init(this.ep.negate());
  }
  precompute(windowSize, isLazy) {
    return this.init(this.ep.precompute(windowSize, isLazy));
  }
  /** @deprecated use `toBytes` */
  toRawBytes() {
    return this.toBytes();
  }
};
function eddsa(Point, cHash, eddsaOpts = {}) {
  if (typeof cHash !== "function")
    throw new Error('"hash" function param is required');
  _validateObject(eddsaOpts, {}, {
    adjustScalarBytes: "function",
    randomBytes: "function",
    domain: "function",
    prehash: "function",
    mapToCurve: "function"
  });
  const { prehash } = eddsaOpts;
  const { BASE, Fp: Fp2, Fn: Fn2 } = Point;
  const randomBytes3 = eddsaOpts.randomBytes || randomBytes;
  const adjustScalarBytes2 = eddsaOpts.adjustScalarBytes || ((bytes) => bytes);
  const domain = eddsaOpts.domain || ((data, ctx, phflag) => {
    _abool2(phflag, "phflag");
    if (ctx.length || phflag)
      throw new Error("Contexts/pre-hash are not supported");
    return data;
  });
  function modN_LE(hash) {
    return Fn2.create(bytesToNumberLE(hash));
  }
  function getPrivateScalar(key) {
    const len = lengths.secretKey;
    key = ensureBytes("private key", key, len);
    const hashed = ensureBytes("hashed private key", cHash(key), 2 * len);
    const head = adjustScalarBytes2(hashed.slice(0, len));
    const prefix = hashed.slice(len, 2 * len);
    const scalar = modN_LE(head);
    return { head, prefix, scalar };
  }
  function getExtendedPublicKey(secretKey) {
    const { head, prefix, scalar } = getPrivateScalar(secretKey);
    const point = BASE.multiply(scalar);
    const pointBytes = point.toBytes();
    return { head, prefix, scalar, point, pointBytes };
  }
  function getPublicKey(secretKey) {
    return getExtendedPublicKey(secretKey).pointBytes;
  }
  function hashDomainToScalar(context = Uint8Array.of(), ...msgs) {
    const msg = concatBytes(...msgs);
    return modN_LE(cHash(domain(msg, ensureBytes("context", context), !!prehash)));
  }
  function sign(msg, secretKey, options = {}) {
    msg = ensureBytes("message", msg);
    if (prehash)
      msg = prehash(msg);
    const { prefix, scalar, pointBytes } = getExtendedPublicKey(secretKey);
    const r = hashDomainToScalar(options.context, prefix, msg);
    const R = BASE.multiply(r).toBytes();
    const k = hashDomainToScalar(options.context, R, pointBytes, msg);
    const s = Fn2.create(r + k * scalar);
    if (!Fn2.isValid(s))
      throw new Error("sign failed: invalid s");
    const rs = concatBytes(R, Fn2.toBytes(s));
    return _abytes2(rs, lengths.signature, "result");
  }
  const verifyOpts = { zip215: true };
  function verify(sig, msg, publicKey, options = verifyOpts) {
    const { context, zip215 } = options;
    const len = lengths.signature;
    sig = ensureBytes("signature", sig, len);
    msg = ensureBytes("message", msg);
    publicKey = ensureBytes("publicKey", publicKey, lengths.publicKey);
    if (zip215 !== void 0)
      _abool2(zip215, "zip215");
    if (prehash)
      msg = prehash(msg);
    const mid = len / 2;
    const r = sig.subarray(0, mid);
    const s = bytesToNumberLE(sig.subarray(mid, len));
    let A, R, SB;
    try {
      A = Point.fromBytes(publicKey, zip215);
      R = Point.fromBytes(r, zip215);
      SB = BASE.multiplyUnsafe(s);
    } catch (error) {
      return false;
    }
    if (!zip215 && A.isSmallOrder())
      return false;
    const k = hashDomainToScalar(context, R.toBytes(), A.toBytes(), msg);
    const RkA = R.add(A.multiplyUnsafe(k));
    return RkA.subtract(SB).clearCofactor().is0();
  }
  const _size = Fp2.BYTES;
  const lengths = {
    secretKey: _size,
    publicKey: _size,
    signature: 2 * _size,
    seed: _size
  };
  function randomSecretKey(seed = randomBytes3(lengths.seed)) {
    return _abytes2(seed, lengths.seed, "seed");
  }
  function keygen(seed) {
    const secretKey = utils.randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  }
  function isValidSecretKey(key) {
    return isBytes2(key) && key.length === Fn2.BYTES;
  }
  function isValidPublicKey(key, zip215) {
    try {
      return !!Point.fromBytes(key, zip215);
    } catch (error) {
      return false;
    }
  }
  const utils = {
    getExtendedPublicKey,
    randomSecretKey,
    isValidSecretKey,
    isValidPublicKey,
    /**
     * Converts ed public key to x public key. Uses formula:
     * - ed25519:
     *   - `(u, v) = ((1+y)/(1-y), sqrt(-486664)*u/x)`
     *   - `(x, y) = (sqrt(-486664)*u/v, (u-1)/(u+1))`
     * - ed448:
     *   - `(u, v) = ((y-1)/(y+1), sqrt(156324)*u/x)`
     *   - `(x, y) = (sqrt(156324)*u/v, (1+u)/(1-u))`
     */
    toMontgomery(publicKey) {
      const { y } = Point.fromBytes(publicKey);
      const size = lengths.publicKey;
      const is25519 = size === 32;
      if (!is25519 && size !== 57)
        throw new Error("only defined for 25519 and 448");
      const u = is25519 ? Fp2.div(_1n4 + y, _1n4 - y) : Fp2.div(y - _1n4, y + _1n4);
      return Fp2.toBytes(u);
    },
    toMontgomerySecret(secretKey) {
      const size = lengths.secretKey;
      _abytes2(secretKey, size);
      const hashed = cHash(secretKey.subarray(0, size));
      return adjustScalarBytes2(hashed).subarray(0, size);
    },
    /** @deprecated */
    randomPrivateKey: randomSecretKey,
    /** @deprecated */
    precompute(windowSize = 8, point = Point.BASE) {
      return point.precompute(windowSize, false);
    }
  };
  return Object.freeze({
    keygen,
    getPublicKey,
    sign,
    verify,
    utils,
    Point,
    lengths
  });
}
function _eddsa_legacy_opts_to_new(c) {
  const CURVE = {
    a: c.a,
    d: c.d,
    p: c.Fp.ORDER,
    n: c.n,
    h: c.h,
    Gx: c.Gx,
    Gy: c.Gy
  };
  const Fp2 = c.Fp;
  const Fn2 = Field(CURVE.n, c.nBitLength, true);
  const curveOpts = { Fp: Fp2, Fn: Fn2, uvRatio: c.uvRatio };
  const eddsaOpts = {
    randomBytes: c.randomBytes,
    adjustScalarBytes: c.adjustScalarBytes,
    domain: c.domain,
    prehash: c.prehash,
    mapToCurve: c.mapToCurve
  };
  return { CURVE, curveOpts, hash: c.hash, eddsaOpts };
}
function _eddsa_new_output_to_legacy(c, eddsa2) {
  const Point = eddsa2.Point;
  const legacy = Object.assign({}, eddsa2, {
    ExtendedPoint: Point,
    CURVE: c,
    nBitLength: Point.Fn.BITS,
    nByteLength: Point.Fn.BYTES
  });
  return legacy;
}
function twistedEdwards(c) {
  const { CURVE, curveOpts, hash, eddsaOpts } = _eddsa_legacy_opts_to_new(c);
  const Point = edwards(CURVE, curveOpts);
  const EDDSA = eddsa(Point, hash, eddsaOpts);
  return _eddsa_new_output_to_legacy(c, EDDSA);
}

// ../../node_modules/@noble/curves/esm/abstract/montgomery.js
var _0n5 = BigInt(0);
var _1n5 = BigInt(1);
var _2n3 = BigInt(2);
function validateOpts(curve) {
  _validateObject(curve, {
    adjustScalarBytes: "function",
    powPminus2: "function"
  });
  return Object.freeze({ ...curve });
}
function montgomery(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { P, type, adjustScalarBytes: adjustScalarBytes2, powPminus2, randomBytes: rand } = CURVE;
  const is25519 = type === "x25519";
  if (!is25519 && type !== "x448")
    throw new Error("invalid type");
  const randomBytes_ = rand || randomBytes;
  const montgomeryBits = is25519 ? 255 : 448;
  const fieldLen = is25519 ? 32 : 56;
  const Gu = is25519 ? BigInt(9) : BigInt(5);
  const a24 = is25519 ? BigInt(121665) : BigInt(39081);
  const minScalar = is25519 ? _2n3 ** BigInt(254) : _2n3 ** BigInt(447);
  const maxAdded = is25519 ? BigInt(8) * _2n3 ** BigInt(251) - _1n5 : BigInt(4) * _2n3 ** BigInt(445) - _1n5;
  const maxScalar = minScalar + maxAdded + _1n5;
  const modP = (n) => mod(n, P);
  const GuBytes = encodeU(Gu);
  function encodeU(u) {
    return numberToBytesLE(modP(u), fieldLen);
  }
  function decodeU(u) {
    const _u = ensureBytes("u coordinate", u, fieldLen);
    if (is25519)
      _u[31] &= 127;
    return modP(bytesToNumberLE(_u));
  }
  function decodeScalar(scalar) {
    return bytesToNumberLE(adjustScalarBytes2(ensureBytes("scalar", scalar, fieldLen)));
  }
  function scalarMult(scalar, u) {
    const pu = montgomeryLadder(decodeU(u), decodeScalar(scalar));
    if (pu === _0n5)
      throw new Error("invalid private or public key received");
    return encodeU(pu);
  }
  function scalarMultBase(scalar) {
    return scalarMult(scalar, GuBytes);
  }
  function cswap(swap, x_2, x_3) {
    const dummy = modP(swap * (x_2 - x_3));
    x_2 = modP(x_2 - dummy);
    x_3 = modP(x_3 + dummy);
    return { x_2, x_3 };
  }
  function montgomeryLadder(u, scalar) {
    aInRange("u", u, _0n5, P);
    aInRange("scalar", scalar, minScalar, maxScalar);
    const k = scalar;
    const x_1 = u;
    let x_2 = _1n5;
    let z_2 = _0n5;
    let x_3 = u;
    let z_3 = _1n5;
    let swap = _0n5;
    for (let t = BigInt(montgomeryBits - 1); t >= _0n5; t--) {
      const k_t = k >> t & _1n5;
      swap ^= k_t;
      ({ x_2, x_3 } = cswap(swap, x_2, x_3));
      ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
      swap = k_t;
      const A = x_2 + z_2;
      const AA = modP(A * A);
      const B = x_2 - z_2;
      const BB = modP(B * B);
      const E = AA - BB;
      const C = x_3 + z_3;
      const D = x_3 - z_3;
      const DA = modP(D * A);
      const CB = modP(C * B);
      const dacb = DA + CB;
      const da_cb = DA - CB;
      x_3 = modP(dacb * dacb);
      z_3 = modP(x_1 * modP(da_cb * da_cb));
      x_2 = modP(AA * BB);
      z_2 = modP(E * (AA + modP(a24 * E)));
    }
    ({ x_2, x_3 } = cswap(swap, x_2, x_3));
    ({ x_2: z_2, x_3: z_3 } = cswap(swap, z_2, z_3));
    const z2 = powPminus2(z_2);
    return modP(x_2 * z2);
  }
  const lengths = {
    secretKey: fieldLen,
    publicKey: fieldLen,
    seed: fieldLen
  };
  const randomSecretKey = (seed = randomBytes_(fieldLen)) => {
    abytes2(seed, lengths.seed);
    return seed;
  };
  function keygen(seed) {
    const secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: scalarMultBase(secretKey) };
  }
  const utils = {
    randomSecretKey,
    randomPrivateKey: randomSecretKey
  };
  return {
    keygen,
    getSharedSecret: (secretKey, publicKey) => scalarMult(secretKey, publicKey),
    getPublicKey: (secretKey) => scalarMultBase(secretKey),
    scalarMult,
    scalarMultBase,
    utils,
    GuBytes: GuBytes.slice(),
    lengths
  };
}

// ../../node_modules/@noble/curves/esm/ed25519.js
var _0n6 = /* @__PURE__ */ BigInt(0);
var _1n6 = BigInt(1);
var _2n4 = BigInt(2);
var _3n2 = BigInt(3);
var _5n2 = BigInt(5);
var _8n3 = BigInt(8);
var ed25519_CURVE_p = BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffed");
var ed25519_CURVE = /* @__PURE__ */ (() => ({
  p: ed25519_CURVE_p,
  n: BigInt("0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed"),
  h: _8n3,
  a: BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec"),
  d: BigInt("0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3"),
  Gx: BigInt("0x216936d3cd6e53fec0a4e231fdd6dc5c692cc7609525a7b2c9562d608f25d51a"),
  Gy: BigInt("0x6666666666666666666666666666666666666666666666666666666666666658")
}))();
function ed25519_pow_2_252_3(x) {
  const _10n = BigInt(10), _20n = BigInt(20), _40n = BigInt(40), _80n = BigInt(80);
  const P = ed25519_CURVE_p;
  const x2 = x * x % P;
  const b2 = x2 * x % P;
  const b4 = pow2(b2, _2n4, P) * b2 % P;
  const b5 = pow2(b4, _1n6, P) * x % P;
  const b10 = pow2(b5, _5n2, P) * b5 % P;
  const b20 = pow2(b10, _10n, P) * b10 % P;
  const b40 = pow2(b20, _20n, P) * b20 % P;
  const b80 = pow2(b40, _40n, P) * b40 % P;
  const b160 = pow2(b80, _80n, P) * b80 % P;
  const b240 = pow2(b160, _80n, P) * b80 % P;
  const b250 = pow2(b240, _10n, P) * b10 % P;
  const pow_p_5_8 = pow2(b250, _2n4, P) * x % P;
  return { pow_p_5_8, b2 };
}
function adjustScalarBytes(bytes) {
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytes;
}
var ED25519_SQRT_M1 = /* @__PURE__ */ BigInt("19681161376707505956807079304988542015446066515923890162744021073123829784752");
function uvRatio(u, v) {
  const P = ed25519_CURVE_p;
  const v3 = mod(v * v * v, P);
  const v7 = mod(v3 * v3 * v, P);
  const pow = ed25519_pow_2_252_3(u * v7).pow_p_5_8;
  let x = mod(u * v3 * pow, P);
  const vx2 = mod(v * x * x, P);
  const root1 = x;
  const root2 = mod(x * ED25519_SQRT_M1, P);
  const useRoot1 = vx2 === u;
  const useRoot2 = vx2 === mod(-u, P);
  const noRoot = vx2 === mod(-u * ED25519_SQRT_M1, P);
  if (useRoot1)
    x = root1;
  if (useRoot2 || noRoot)
    x = root2;
  if (isNegativeLE(x, P))
    x = mod(-x, P);
  return { isValid: useRoot1 || useRoot2, value: x };
}
var Fp = /* @__PURE__ */ (() => Field(ed25519_CURVE.p, { isLE: true }))();
var Fn = /* @__PURE__ */ (() => Field(ed25519_CURVE.n, { isLE: true }))();
var ed25519Defaults = /* @__PURE__ */ (() => ({
  ...ed25519_CURVE,
  Fp,
  hash: sha512,
  adjustScalarBytes,
  // dom2
  // Ratio of u to v. Allows us to combine inversion and square root. Uses algo from RFC8032 5.1.3.
  // Constant-time, u/√v
  uvRatio
}))();
var ed25519 = /* @__PURE__ */ (() => twistedEdwards(ed25519Defaults))();
var x25519 = /* @__PURE__ */ (() => {
  const P = Fp.ORDER;
  return montgomery({
    P,
    type: "x25519",
    powPminus2: (x) => {
      const { pow_p_5_8, b2 } = ed25519_pow_2_252_3(x);
      return mod(pow2(pow_p_5_8, _3n2, P) * b2, P);
    },
    adjustScalarBytes
  });
})();
var SQRT_M1 = ED25519_SQRT_M1;
var SQRT_AD_MINUS_ONE = /* @__PURE__ */ BigInt("25063068953384623474111414158702152701244531502492656460079210482610430750235");
var INVSQRT_A_MINUS_D = /* @__PURE__ */ BigInt("54469307008909316920995813868745141605393597292927456921205312896311721017578");
var ONE_MINUS_D_SQ = /* @__PURE__ */ BigInt("1159843021668779879193775521855586647937357759715417654439879720876111806838");
var D_MINUS_ONE_SQ = /* @__PURE__ */ BigInt("40440834346308536858101042469323190826248399146238708352240133220865137265952");
var invertSqrt = (number) => uvRatio(_1n6, number);
var MAX_255B = /* @__PURE__ */ BigInt("0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
var bytes255ToNumberLE = (bytes) => ed25519.Point.Fp.create(bytesToNumberLE(bytes) & MAX_255B);
function calcElligatorRistrettoMap(r0) {
  const { d } = ed25519_CURVE;
  const P = ed25519_CURVE_p;
  const mod2 = (n) => Fp.create(n);
  const r = mod2(SQRT_M1 * r0 * r0);
  const Ns = mod2((r + _1n6) * ONE_MINUS_D_SQ);
  let c = BigInt(-1);
  const D = mod2((c - d * r) * mod2(r + d));
  let { isValid: Ns_D_is_sq, value: s } = uvRatio(Ns, D);
  let s_ = mod2(s * r0);
  if (!isNegativeLE(s_, P))
    s_ = mod2(-s_);
  if (!Ns_D_is_sq)
    s = s_;
  if (!Ns_D_is_sq)
    c = r;
  const Nt = mod2(c * (r - _1n6) * D_MINUS_ONE_SQ - D);
  const s2 = s * s;
  const W0 = mod2((s + s) * D);
  const W1 = mod2(Nt * SQRT_AD_MINUS_ONE);
  const W2 = mod2(_1n6 - s2);
  const W3 = mod2(_1n6 + s2);
  return new ed25519.Point(mod2(W0 * W3), mod2(W2 * W1), mod2(W1 * W3), mod2(W0 * W2));
}
function ristretto255_map(bytes) {
  abytes2(bytes, 64);
  const r1 = bytes255ToNumberLE(bytes.subarray(0, 32));
  const R1 = calcElligatorRistrettoMap(r1);
  const r2 = bytes255ToNumberLE(bytes.subarray(32, 64));
  const R2 = calcElligatorRistrettoMap(r2);
  return new _RistrettoPoint(R1.add(R2));
}
var _RistrettoPoint = class __RistrettoPoint extends PrimeEdwardsPoint {
  constructor(ep) {
    super(ep);
  }
  static fromAffine(ap) {
    return new __RistrettoPoint(ed25519.Point.fromAffine(ap));
  }
  assertSame(other) {
    if (!(other instanceof __RistrettoPoint))
      throw new Error("RistrettoPoint expected");
  }
  init(ep) {
    return new __RistrettoPoint(ep);
  }
  /** @deprecated use `import { ristretto255_hasher } from '@noble/curves/ed25519.js';` */
  static hashToCurve(hex) {
    return ristretto255_map(ensureBytes("ristrettoHash", hex, 64));
  }
  static fromBytes(bytes) {
    abytes2(bytes, 32);
    const { a, d } = ed25519_CURVE;
    const P = ed25519_CURVE_p;
    const mod2 = (n) => Fp.create(n);
    const s = bytes255ToNumberLE(bytes);
    if (!equalBytes2(Fp.toBytes(s), bytes) || isNegativeLE(s, P))
      throw new Error("invalid ristretto255 encoding 1");
    const s2 = mod2(s * s);
    const u1 = mod2(_1n6 + a * s2);
    const u2 = mod2(_1n6 - a * s2);
    const u1_2 = mod2(u1 * u1);
    const u2_2 = mod2(u2 * u2);
    const v = mod2(a * d * u1_2 - u2_2);
    const { isValid, value: I } = invertSqrt(mod2(v * u2_2));
    const Dx = mod2(I * u2);
    const Dy = mod2(I * Dx * v);
    let x = mod2((s + s) * Dx);
    if (isNegativeLE(x, P))
      x = mod2(-x);
    const y = mod2(u1 * Dy);
    const t = mod2(x * y);
    if (!isValid || isNegativeLE(t, P) || y === _0n6)
      throw new Error("invalid ristretto255 encoding 2");
    return new __RistrettoPoint(new ed25519.Point(x, y, _1n6, t));
  }
  /**
   * Converts ristretto-encoded string to ristretto point.
   * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-decode).
   * @param hex Ristretto-encoded 32 bytes. Not every 32-byte string is valid ristretto encoding
   */
  static fromHex(hex) {
    return __RistrettoPoint.fromBytes(ensureBytes("ristrettoHex", hex, 32));
  }
  static msm(points, scalars) {
    return pippenger(__RistrettoPoint, ed25519.Point.Fn, points, scalars);
  }
  /**
   * Encodes ristretto point to Uint8Array.
   * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-encode).
   */
  toBytes() {
    let { X, Y, Z, T } = this.ep;
    const P = ed25519_CURVE_p;
    const mod2 = (n) => Fp.create(n);
    const u1 = mod2(mod2(Z + Y) * mod2(Z - Y));
    const u2 = mod2(X * Y);
    const u2sq = mod2(u2 * u2);
    const { value: invsqrt } = invertSqrt(mod2(u1 * u2sq));
    const D1 = mod2(invsqrt * u1);
    const D2 = mod2(invsqrt * u2);
    const zInv = mod2(D1 * D2 * T);
    let D;
    if (isNegativeLE(T * zInv, P)) {
      let _x = mod2(Y * SQRT_M1);
      let _y = mod2(X * SQRT_M1);
      X = _x;
      Y = _y;
      D = mod2(D1 * INVSQRT_A_MINUS_D);
    } else {
      D = D2;
    }
    if (isNegativeLE(X * zInv, P))
      Y = mod2(-Y);
    let s = mod2((Z - Y) * D);
    if (isNegativeLE(s, P))
      s = mod2(-s);
    return Fp.toBytes(s);
  }
  /**
   * Compares two Ristretto points.
   * Described in [RFC9496](https://www.rfc-editor.org/rfc/rfc9496#name-equals).
   */
  equals(other) {
    this.assertSame(other);
    const { X: X1, Y: Y1 } = this.ep;
    const { X: X2, Y: Y2 } = other.ep;
    const mod2 = (n) => Fp.create(n);
    const one = mod2(X1 * Y2) === mod2(Y1 * X2);
    const two = mod2(Y1 * Y2) === mod2(X1 * X2);
    return one || two;
  }
  is0() {
    return this.equals(__RistrettoPoint.ZERO);
  }
};
_RistrettoPoint.BASE = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.BASE))();
_RistrettoPoint.ZERO = /* @__PURE__ */ (() => new _RistrettoPoint(ed25519.Point.ZERO))();
_RistrettoPoint.Fp = /* @__PURE__ */ (() => Fp)();
_RistrettoPoint.Fn = /* @__PURE__ */ (() => Fn)();

// ../../node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash2 {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key = toBytes2(_key);
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean2(pad);
  }
  update(buf) {
    aexists2(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists2(this);
    abytes2(out, this.outputLen);
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new HMAC(hash, key);

// ../../node_modules/@noble/hashes/esm/hkdf.js
function extract(hash, ikm, salt) {
  ahash(hash);
  if (salt === void 0)
    salt = new Uint8Array(hash.outputLen);
  return hmac(hash, toBytes2(salt), toBytes2(ikm));
}
var HKDF_COUNTER = /* @__PURE__ */ Uint8Array.from([0]);
var EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
function expand(hash, prk, info, length = 32) {
  ahash(hash);
  anumber2(length);
  const olen = hash.outputLen;
  if (length > 255 * olen)
    throw new Error("Length should be <= 255*HashLen");
  const blocks = Math.ceil(length / olen);
  if (info === void 0)
    info = EMPTY_BUFFER;
  const okm = new Uint8Array(blocks * olen);
  const HMAC2 = hmac.create(hash, prk);
  const HMACTmp = HMAC2._cloneInto();
  const T = new Uint8Array(HMAC2.outputLen);
  for (let counter = 0; counter < blocks; counter++) {
    HKDF_COUNTER[0] = counter + 1;
    HMACTmp.update(counter === 0 ? EMPTY_BUFFER : T).update(info).update(HKDF_COUNTER).digestInto(T);
    okm.set(T, olen * counter);
    HMAC2._cloneInto(HMACTmp);
  }
  HMAC2.destroy();
  HMACTmp.destroy();
  clean2(T, HKDF_COUNTER);
  return okm.slice(0, length);
}
var hkdf = (hash, ikm, salt, info, length) => expand(hash, extract(hash, ikm, salt), info, length);

// ../../node_modules/@noble/hashes/esm/sha256.js
var sha2562 = sha256;

// ../../packages/protocol/dist/index.js
var ErrorCodes = {
  PARSE_ERROR: "parse_error",
  INVALID_MESSAGE: "invalid_message",
  VERSION_UNSUPPORTED: "version_unsupported",
  UNAUTHORIZED: "unauthorized",
  CAPABILITY_DENIED: "capability_denied",
  METHOD_NOT_FOUND: "method_not_found",
  VALIDATION_FAILED: "validation_failed",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  RATE_LIMITED: "rate_limited",
  DEVICE_REVOKED: "device_revoked",
  SESSION_EXPIRED: "session_expired",
  PAIRING_EXPIRED: "pairing_expired",
  PAIRING_INVALID: "pairing_invalid",
  HOST_OFFLINE: "host_offline",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  INTERNAL: "internal",
  NOT_CONNECTED: "not_connected",
  PEER_LOST: "peer_lost",
  /** the capability is granted but the grant has lapsed and must be renewed */
  GRANT_EXPIRED: "grant_expired",
  /** the host user declined a per-use confirmation prompt */
  CONSENT_DENIED: "consent_denied",
  /** the host could not obtain a per-use confirmation in time */
  CONSENT_TIMEOUT: "consent_timeout",
  /** host permission policy forbids this, independent of what was granted */
  POLICY_DENIED: "policy_denied"
};
var ALL_ERROR_CODES = Object.values(ErrorCodes);
var CrosslinkError = class _CrosslinkError extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.name = "CrosslinkError";
    this.code = code;
    this.data = data;
  }
  toWire() {
    return { code: this.code, message: this.message, data: this.data };
  }
  static from(err) {
    if (err instanceof _CrosslinkError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new _CrosslinkError(ErrorCodes.INTERNAL, message);
  }
  /** True for codes that must never leak internal detail across the wire. */
  static isInternal(code) {
    return code === ErrorCodes.INTERNAL || code === ErrorCodes.PARSE_ERROR || code === ErrorCodes.INVALID_MESSAGE;
  }
};
function canonicalJson(value) {
  return serialize(value);
}
function serialize(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    return String(value);
  }
  if (t === "bigint") {
    throw new TypeError("canonicalJson: bigint not allowed");
  }
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ",";
      out += serialize(value[i]);
    }
    return out + "]";
  }
  if (t === "object") {
    const obj = value;
    const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
    let out = "{";
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) out += ",";
      out += `${JSON.stringify(keys[i])}:${serialize(obj[keys[i]])}`;
    }
    return out + "}";
  }
  throw new TypeError(`canonicalJson: unsupported type ${t}`);
}
var HAS_BUFFER = typeof Buffer !== "undefined";
function bytesToBase64(bytes) {
  if (HAS_BUFFER) return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  if (HAS_BUFFER) {
    const buf = Buffer.from(b64, "base64");
    return new Uint8Array(buf);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var HEX = "0123456789abcdef";
function bytesToHex2(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}
function hexToBytes2(hex) {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new TypeError("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
var te = new TextEncoder();
var td = new TextDecoder();
var utf8ToBytes3 = (s) => te.encode(s);
var bytesToUtf82 = (b) => td.decode(b);
var MessageTypes = {
  HELLO: "hello",
  HELLO_OK: "hello_ok",
  REQ: "req",
  RES: "res",
  ERR: "err",
  CHUNK: "chunk",
  END: "end",
  EVT: "evt",
  SUB: "sub",
  UNSUB: "unsub",
  CANCEL: "cancel",
  PING: "ping",
  PONG: "pong",
  BYE: "bye"
};
var REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var METHOD_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
var EVENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
var DEVICE_ID_RE = /^cd1_[0-9a-f]{32}$/;
var VERSION_RE2 = /^\d+\.\d+$/;
function makeRequestId(rand) {
  return toUrlSafeBase64ish(rand(12));
}
function toUrlSafeBase64ish(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  const b64 = globalThis.btoa !== void 0 ? btoa(out) : BufferFrom(out);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function BufferFrom(s) {
  return Buffer.from(s).toString("base64");
}
function validateMessage(msg) {
  if (typeof msg !== "object" || msg === null) return "not-an-object";
  const m = msg;
  if (typeof m.v !== "string" || !VERSION_RE2.test(m.v)) return "bad-version";
  if (!isMessageType(m.t)) return "bad-type";
  switch (m.t) {
    case MessageTypes.HELLO: {
      if (!Array.isArray(m.versions) || m.versions.length === 0) return "hello-versions";
      if (!m.versions.every((x) => typeof x === "string" && VERSION_RE2.test(x))) {
        return "hello-version-format";
      }
      if (typeof m.deviceId !== "string" || !DEVICE_ID_RE.test(m.deviceId)) return "hello-device-id";
      if (typeof m.appId !== "string" || m.appId.length === 0 || m.appId.length > 256) {
        return "hello-app-id";
      }
      break;
    }
    case MessageTypes.HELLO_OK:
      if (typeof m.version !== "string" || !VERSION_RE2.test(m.version)) return "hello-ok-version";
      break;
    case MessageTypes.REQ:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return "req-id";
      if (typeof m.m !== "string" || !METHOD_RE.test(m.m)) return "req-method";
      if (m.idem !== void 0 && m.idem !== true) return "req-idem-flag";
      break;
    case MessageTypes.RES:
    case MessageTypes.END:
    case MessageTypes.CANCEL:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return `${m.t}-id`;
      break;
    case MessageTypes.ERR:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return "err-id";
      if (typeof m.e !== "object" || m.e === null || typeof m.e.code !== "string" || !ALL_ERROR_CODES.includes(m.e.code) || typeof m.e.message !== "string") {
        return "err-body";
      }
      break;
    case MessageTypes.CHUNK:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return "chunk-id";
      if (typeof m.n !== "number" || !Number.isInteger(m.n) || m.n < 0) return "chunk-n";
      if (m.d === void 0) return "chunk-data-missing";
      break;
    case MessageTypes.EVT:
      if (typeof m.s !== "string" || !REQUEST_ID_RE.test(m.s)) return "evt-sub";
      if (typeof m.e !== "string" || !EVENT_RE.test(m.e)) return "evt-name";
      break;
    case MessageTypes.SUB:
    case MessageTypes.UNSUB:
      if (typeof m.s !== "string" || !REQUEST_ID_RE.test(m.s)) return `${m.t}-sub`;
      if (m.t === MessageTypes.SUB && (typeof m.e !== "string" || !EVENT_RE.test(m.e))) {
        return "sub-event";
      }
      break;
    case MessageTypes.PING:
    case MessageTypes.PONG:
      if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return "ts";
      break;
    case MessageTypes.BYE:
      break;
  }
  return null;
}
function isMessageType(value) {
  return typeof value === "string" && Object.values(MessageTypes).includes(value);
}
var Limits = {
  DEFAULT_MAX_FRAME_BYTES: 4 * 1024 * 1024,
  MAX_FRAME_BYTES_HARD: 16 * 1024 * 1024,
  DEFAULT_CHUNK_BYTES: 256 * 1024,
  DEFAULT_REQUEST_TIMEOUT_MS: 3e4,
  DEFAULT_MAX_INFLIGHT: 32,
  DEFAULT_RATE_PER_SEC: 50,
  PAIRING_CODE_TTL_MS: 12e4,
  HEARTBEAT_INTERVAL_MS: 15e3,
  HEARTBEAT_TIMEOUT_MS: 45e3,
  CLOCK_SKEW_MS: 12e4
};
function encodeMessage(msg) {
  return utf8ToBytes3(canonicalJson(msg));
}
function decodeMessage(data) {
  let text;
  try {
    text = typeof data === "string" ? data : bytesToUtf82(data);
  } catch {
    throw new CrosslinkError(ErrorCodes.PARSE_ERROR, "payload is not valid UTF-8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CrosslinkError(ErrorCodes.PARSE_ERROR, "payload is not valid JSON");
  }
  rejectProto(parsed, 0);
  const problem = validateMessage(parsed);
  if (problem) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, `invalid message: ${problem}`);
  }
  return parsed;
}
function rejectProto(value, depth) {
  if (depth > 64) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "payload nesting exceeds 64");
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectProto(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) rejectProto(item, depth + 1);
  }
}
function isOuterKind(value) {
  return value === "sinit" || value === "sack" || value === "srej" || value === "enc" || value === "oping" || value === "opong" || value === "bye";
}

// ../../packages/core/dist/index.js
function randomBytes2(n) {
  return randomBytes(n);
}
function sha256Bytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  return sha2562(merged);
}
function deriveOkm(ikm, salt, info, length) {
  return hkdf(sha2562, ikm, salt, utf8ToBytes3(info), length);
}
function signBytes(message, privateKey) {
  return ed25519.sign(message, privateKey);
}
function verifySignature(signature, message, publicKey) {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
function x25519Public(privateKey) {
  return x25519.getPublicKey(privateKey);
}
function diffieHellman(privateKey, publicKey) {
  const secret = x25519.getSharedSecret(privateKey, publicKey);
  const zero = new Uint8Array(32);
  let acc = 0;
  for (let i = 0; i < 32; i++) acc |= secret[i] ^ zero[i];
  if (acc === 0) throw new Error("x25519: all-zero shared secret rejected");
  return secret;
}
function aeadSeal(key, nonce24, plaintext, aad) {
  return xchacha20poly1305(key, nonce24, aad).encrypt(plaintext);
}
function aeadOpen(key, nonce24, ciphertext, aad) {
  return xchacha20poly1305(key, nonce24, aad).decrypt(ciphertext);
}
var DEVICE_ID_PREFIX = "cd1_";
var utf8 = (s) => new TextEncoder().encode(s);
var DeviceIdentity = class _DeviceIdentity {
  constructor(seed) {
    this.seed = seed;
    if (seed.length !== 32) throw new TypeError("identity seed must be 32 bytes");
  }
  seed;
  _xPriv;
  _edPub;
  _xPub;
  static create() {
    return new _DeviceIdentity(randomBytes2(32));
  }
  static fromSeed(seed) {
    return new _DeviceIdentity(seed);
  }
  get edPrivateKey() {
    return this.seed;
  }
  get edPublicKey() {
    if (!this._edPub) this._edPub = ed25519.getPublicKey(this.seed);
    return this._edPub;
  }
  get xPrivateKey() {
    if (!this._xPriv) {
      this._xPriv = deriveOkm(this.seed, new Uint8Array(0), "crosslink-x25519-v1", 32);
    }
    return this._xPriv;
  }
  get xPublicKey() {
    if (!this._xPub) this._xPub = x25519Public(this.xPrivateKey);
    return this._xPub;
  }
  /** Stable device identifier derived from the signing public key. */
  get deviceId() {
    const digest = sha256Bytes(utf8("deviceId"), this.edPublicKey);
    return DEVICE_ID_PREFIX + bytesToHex2(digest).slice(0, 32);
  }
  /** Full hex fingerprint of the identity public key (compared by users/UIs). */
  get fingerprint() {
    return bytesToHex2(sha256Bytes(utf8("fingerprint"), this.edPublicKey));
  }
  sign(message) {
    return signBytes(message, this.edPrivateKey);
  }
  verifyOwn(signature, message) {
    return verifySignature(signature, message, this.edPublicKey);
  }
  toJson() {
    return { v: 1, seed_b64: bytesToBase64(this.seed) };
  }
  static fromJson(json) {
    if (!json || json.v !== 1 || typeof json.seed_b64 !== "string") {
      throw new TypeError("invalid identity json");
    }
    return _DeviceIdentity.fromSeed(base64ToBytes(json.seed_b64));
  }
  static import(seedHex) {
    return _DeviceIdentity.fromSeed(hexToBytes2(seedHex));
  }
};
function shortAuthString(appId, pubA, pubB) {
  const [first, second] = compareBytes(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];
  const okm = deriveOkm(
    concat(first, second),
    utf8ToBytes3("crosslink-sas-v1"),
    appId,
    6
  );
  const groups = [];
  for (let g = 0; g < 3; g++) {
    const n = (okm[g * 2] << 8 | okm[g * 2 + 1]) % 1e3;
    groups.push(String(n).padStart(3, "0"));
  }
  return groups.join(" ");
}
function compareBytes(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
var LABEL = { client: "c2h", host: "h2c" };
var PEER_LABEL = { client: "h2c", host: "c2h" };
var SessionCipher = class {
  constructor(keys, role, maxFrameBytes) {
    this.keys = keys;
    this.role = role;
    this.maxFrameBytes = maxFrameBytes;
  }
  keys;
  role;
  maxFrameBytes;
  sendCounter = 0;
  recvExpected = 1;
  get role_() {
    return this.role;
  }
  seal(msg) {
    this.sendCounter += 1;
    const n = this.sendCounter;
    const iv = randomBytes2(24);
    const aad = utf8ToBytes3(`${LABEL[this.role]}:${n}`);
    const plaintext = encodeMessage(msg);
    if (plaintext.length > this.maxFrameBytes) {
      throw new CrosslinkError(
        ErrorCodes.PAYLOAD_TOO_LARGE,
        `message ${plaintext.length}B exceeds session limit ${this.maxFrameBytes}B`
      );
    }
    const key = this.keys[LABEL[this.role]];
    const ct = aeadSeal(key, iv, plaintext, aad);
    return { kind: "enc", n, iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
  }
  open(frame) {
    if (typeof frame.n !== "number" || !Number.isInteger(frame.n) || frame.n !== this.recvExpected) {
      throw new CrosslinkError(
        ErrorCodes.INVALID_MESSAGE,
        `replay/out-of-order frame: expected n=${this.recvExpected}, got ${String(frame.n)}`
      );
    }
    const n = frame.n;
    this.recvExpected += 1;
    const iv = base64ToBytes(frame.iv);
    if (iv.length !== 24) {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad nonce length");
    }
    const aad = utf8ToBytes3(`${PEER_LABEL[this.role]}:${n}`);
    let plaintext;
    try {
      plaintext = aeadOpen(this.keys[PEER_LABEL[this.role]], iv, base64ToBytes(frame.ct), aad);
    } catch {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "frame failed authentication");
    }
    return decodeMessage(plaintext);
  }
};
var HANDSHAKE_VERSION = "CLX1";
var KEY_INFO = "crosslink-session-keys-v1";
function transcript(appId, dev, sxC, epkC, ncC, hostEdB64, hostXB64, epkH, nh) {
  const parts = [
    HANDSHAKE_VERSION,
    appId,
    dev,
    sxC,
    epkC,
    ncC,
    hostEdB64,
    hostXB64
  ];
  if (epkH !== void 0 && nh !== void 0) parts.push(epkH, nh);
  return sha256Bytes(new TextEncoder().encode(canonicalJson(parts)));
}
function concat2(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function clientBeginSession(identity, host, ctx = {}) {
  const ephPrivate = randomBytes2(32);
  const ephPublic = x25519Public(ephPrivate);
  const nonceClient = randomBytes2(32);
  const sig = signBytes(
    transcript(
      host.appId,
      identity.deviceId,
      bytesToBase64(identity.xPublicKey),
      bytesToBase64(ephPublic),
      bytesToBase64(nonceClient),
      host.pubEdB64,
      host.pubXB64
    ),
    identity.edPrivateKey
  );
  const init = {
    kind: "sinit",
    v: "1.0",
    app: host.appId,
    dev: identity.deviceId,
    sx: bytesToBase64(identity.xPublicKey),
    epk: bytesToBase64(ephPublic),
    nc: bytesToBase64(nonceClient),
    ts: ctx.nowMs ?? Date.now(),
    sig: bytesToBase64(sig)
  };
  return { init, state: { ephPrivate, nonceClient } };
}
function clientCompleteSession(identity, state, sentInit, accept, trustedHost) {
  const epkH = base64ToBytes(accept.epk);
  const nh = base64ToBytes(accept.nh);
  if (epkH.length !== 32 || nh.length !== 32) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad accept key material lengths");
  }
  const transcriptHash = transcript(
    sentInit.app,
    sentInit.dev,
    sentInit.sx,
    sentInit.epk,
    sentInit.nc,
    bytesToBase64(trustedHost.pubEd),
    bytesToBase64(trustedHost.pubX),
    accept.epk,
    accept.nh
  );
  if (!verifySignature(base64ToBytes(accept.sig), transcriptHash, trustedHost.pubEd)) {
    throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "host handshake signature invalid");
  }
  const sharedE = diffieHellman(state.ephPrivate, epkH);
  const sharedS = diffieHellman(identity.xPrivateKey, trustedHost.pubX);
  const okm = deriveOkm(concat2(sharedE, sharedS), concat2(state.nonceClient, nh), KEY_INFO, 64);
  return { c2h: okm.slice(0, 32), h2c: okm.slice(32, 64) };
}
var LOG_LEVEL_ORDER = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};
var SECRET_KEY_RE = /(^|[._-])(secret|token|password|passphrase|seed|privkey|private_?key|auth|authorization|cookie|api_?key|credential)s?([._-]|$)/i;
var MAX_STRING_FIELD = 512;
var MAX_DEPTH = 4;
function redactFields(fields) {
  return redactObject(fields, 0);
}
function redactObject(value, depth) {
  if (depth > MAX_DEPTH) return "[depth]";
  if (value === null || value === void 0) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_FIELD ? `${value.slice(0, MAX_STRING_FIELD)}\u2026[+${value.length - MAX_STRING_FIELD}]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code };
  }
  if (value instanceof Uint8Array) return `[bytes ${value.length}]`;
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => redactObject(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? redactSecret(v) : redactObject(v, depth + 1);
    }
    return out;
  }
  return String(value);
}
function redactSecret(value) {
  if (typeof value === "string") return `[redacted ${value.length}]`;
  if (value instanceof Uint8Array) return `[redacted ${value.length}]`;
  return "[redacted]";
}
var BaseLogger = class _BaseLogger {
  constructor(sink, minLevel, bindings) {
    this.sink = sink;
    this.minLevel = minLevel;
    this.bindings = bindings;
  }
  sink;
  minLevel;
  bindings;
  isEnabled(level) {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.minLevel];
  }
  child(bindings) {
    return new _BaseLogger(this.sink, this.minLevel, { ...this.bindings, ...bindings });
  }
  trace(event, fields) {
    this.emit("trace", event, fields);
  }
  debug(event, fields) {
    this.emit("debug", event, fields);
  }
  info(event, fields) {
    this.emit("info", event, fields);
  }
  warn(event, fields) {
    this.emit("warn", event, fields);
  }
  error(event, fields) {
    this.emit("error", event, fields);
  }
  emit(level, event, fields) {
    if (!this.isEnabled(level)) return;
    let record;
    try {
      record = {
        level,
        time: Date.now(),
        event,
        fields: redactFields({ ...this.bindings, ...fields ?? {} })
      };
    } catch {
      record = { level, time: Date.now(), event, fields: { _logError: "field-serialization-failed" } };
    }
    try {
      this.sink(record);
    } catch {
    }
  }
};
var NOOP_CHILD = {
  trace() {
  },
  debug() {
  },
  info() {
  },
  warn() {
  },
  error() {
  },
  isEnabled: () => false,
  child: () => NOOP_CHILD
};
var noopLogger = NOOP_CHILD;
function createLogger(sink, options = {}) {
  return new BaseLogger(sink, options.level ?? "info", options.bindings ?? {});
}
function consoleLogger(options = {}) {
  const target = options.console ?? console;
  const sink = (record) => {
    const method = record.level === "error" ? target.error : record.level === "warn" ? target.warn : record.level === "info" ? target.info : target.debug;
    if (options.json) {
      method.call(target, JSON.stringify(record));
      return;
    }
    const stamp = new Date(record.time).toISOString().slice(11, 23);
    const rest = Object.entries(record.fields).map(([k, v]) => `${k}=${formatValue(v)}`).join(" ");
    method.call(
      target,
      `${stamp} ${record.level.toUpperCase().padEnd(5)} ${record.event}${rest ? ` ${rest}` : ""}`
    );
  };
  return createLogger(sink, options);
}
function formatValue(value) {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value === null || value === void 0) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
var CrosslinkSession = class {
  constructor(transport, keys, meta, handlers, opts = {}) {
    this.transport = transport;
    this.meta = meta;
    this.handlers = handlers;
    this.maxFrameBytes = opts.maxFrameBytes ?? Limits.DEFAULT_MAX_FRAME_BYTES;
    this.cipher = new SessionCipher(keys, meta.role, this.maxFrameBytes);
    this.log = (opts.logger ?? noopLogger).child({
      role: meta.role,
      appId: meta.appId,
      peer: meta.peerDeviceId,
      transport: meta.transportKind
    });
    this.log.info("session.opened");
    transport.onData((data) => this.handleData(data));
    transport.onClose((reason) => this.handleClosed(reason));
    if (opts.heartbeat !== false) {
      const interval = opts.heartbeatIntervalMs ?? Limits.HEARTBEAT_INTERVAL_MS;
      const timeout = opts.heartbeatTimeoutMs ?? Limits.HEARTBEAT_TIMEOUT_MS;
      this.hbTimer = setInterval(() => {
        const silentFor = Date.now() - this.lastRecvAt;
        if (silentFor > timeout) {
          this.log.warn("session.heartbeat-timeout", { silentForMs: silentFor, timeoutMs: timeout });
          this.close("heartbeat-timeout");
          return;
        }
        try {
          this.sendOuter({ kind: "oping", ts: Date.now() });
        } catch {
        }
      }, interval);
    }
  }
  transport;
  meta;
  handlers;
  cipher;
  log;
  closed = false;
  lastRecvAt = Date.now();
  hbTimer;
  maxFrameBytes;
  get isOpen() {
    return !this.closed;
  }
  /** Sends an application-layer message, encrypted. */
  send(msg) {
    this.sendOuter(this.cipher.seal(msg));
  }
  sendOuter(frame) {
    if (this.closed) throw Object.assign(new Error("session closed"), { code: "not_connected" });
    this.transport.send(encodeMessage(frame));
  }
  handleData(data) {
    this.lastRecvAt = Date.now();
    let frame;
    try {
      const text = new TextDecoder().decode(data);
      frame = JSON.parse(text);
    } catch {
      this.log.warn("session.malformed-frame", { bytes: data.length });
      this.close("malformed-outer-frame");
      return;
    }
    if (!isOuterKind(frame.kind)) {
      this.log.warn("session.unknown-frame-kind", { kind: String(frame.kind).slice(0, 32) });
      this.close("unknown-outer-kind");
      return;
    }
    switch (frame.kind) {
      case "enc":
        try {
          const msg = this.cipher.open(frame);
          this.handlers.onMessage(msg, this);
        } catch (err) {
          this.log.error("session.decrypt-failed", { error: err });
          this.close(err);
        }
        break;
      case "oping":
        try {
          this.sendOuter({ kind: "opong", ts: frame.ts });
        } catch {
        }
        break;
      case "opong":
        break;
      case "bye":
      case "srej":
        this.handleClosed(frame.reason ?? frame.code ?? "bye");
        break;
      default:
        break;
    }
  }
  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.log.info("session.closed", { reason: describe(reason), initiator: "local" });
    if (this.hbTimer) clearInterval(this.hbTimer);
    try {
      const bye = {
        kind: "bye",
        reason: typeof reason === "string" ? reason.slice(0, 128) : void 0
      };
      this.transport.send(encodeMessage(bye));
    } catch {
    }
    try {
      this.transport.close(reason);
    } catch {
    }
    this.handlers.onClose(reason);
  }
  handleClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.log.info("session.closed", { reason: describe(reason), initiator: "peer" });
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.handlers.onClose(reason);
  }
};
function describe(reason) {
  if (reason === void 0) return "unspecified";
  if (typeof reason === "string") return reason.slice(0, 128);
  if (reason instanceof Error) return `${reason.name}: ${reason.message.slice(0, 96)}`;
  return String(reason).slice(0, 128);
}
var RpcClient = class {
  constructor(session, defaultTimeoutMs = Limits.DEFAULT_REQUEST_TIMEOUT_MS) {
    this.session = session;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }
  session;
  defaultTimeoutMs;
  pending = /* @__PURE__ */ new Map();
  nextSeq = 0;
  /** event name -> subscription state */
  subs = /* @__PURE__ */ new Map();
  get activeRequests() {
    return this.pending.size;
  }
  async call(method, input, options = {}) {
    return await this.execute(method, input, void 0, options);
  }
  async stream(method, input, onChunk, options = {}) {
    return await this.execute(method, input, onChunk, options);
  }
  subscribe(event, cb) {
    let state = this.subs.get(event);
    if (!state) {
      const subId = `sub_${this.nextSeq++}_${bytesToUrlSafe(randomBytes2(6))}`;
      state = { subId, cbs: /* @__PURE__ */ new Set() };
      this.subs.set(event, state);
      this.session.send({ v: "1.0", t: MessageTypes.SUB, s: subId, e: event });
    }
    state.cbs.add(cb);
    return () => {
      const current = this.subs.get(event);
      if (!current) return;
      current.cbs.delete(cb);
      if (current.cbs.size === 0) {
        this.subs.delete(event);
        try {
          this.session.send({ v: "1.0", t: MessageTypes.UNSUB, s: current.subId });
        } catch {
        }
      }
    };
  }
  /** Subscription ids to replay after reconnecting (re-SUB on fresh session). */
  subscribedEvents() {
    return [...this.subs.keys()];
  }
  cancel(requestId) {
    try {
      this.session.send({ v: "1.0", t: MessageTypes.CANCEL, i: requestId });
    } catch {
    }
  }
  handleMessage(msg) {
    switch (msg.t) {
      case MessageTypes.RES: {
        const entry = this.pending.get(msg.i);
        if (entry) {
          this.clearPending(msg.i, entry);
          entry.resolve(msg.p);
        }
        break;
      }
      case MessageTypes.END: {
        const entry = this.pending.get(msg.i);
        if (entry) {
          this.clearPending(msg.i, entry);
          entry.resolve(msg.p);
        }
        break;
      }
      case MessageTypes.ERR: {
        const entry = this.pending.get(msg.i);
        if (entry) {
          this.clearPending(msg.i, entry);
          entry.reject(new CrosslinkError(msg.e.code, msg.e.message, msg.e.data));
        }
        break;
      }
      case MessageTypes.CHUNK: {
        const entry = this.pending.get(msg.i);
        entry?.onChunk?.(msg.d, msg.n);
        break;
      }
      case MessageTypes.EVT: {
        const state = this.subs.get(msg.e);
        if (state && msg.s === state.subId) {
          for (const cb of [...state.cbs]) {
            try {
              cb(msg.p);
            } catch {
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  /** Rejects all in-flight requests; called when the transport dies. */
  failAll(reasonCode = ErrorCodes.PEER_LOST, message = "connection lost") {
    for (const [id, entry] of [...this.pending]) {
      this.clearPending(id, entry);
      entry.reject(new CrosslinkError(reasonCode, message));
    }
  }
  execute(method, input, onChunk, options) {
    const id = makeRequestId(() => randomBytes2(12));
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        onChunk
      };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        entry.reject(
          new CrosslinkError(ErrorCodes.TIMEOUT, `${method} timed out after ${timeoutMs}ms`)
        );
        this.cancel(id);
      }, timeoutMs);
      this.pending.set(id, entry);
      try {
        this.session.send({
          v: "1.0",
          t: MessageTypes.REQ,
          i: id,
          m: method,
          ...input !== void 0 ? { p: input } : {},
          ts: Date.now()
        });
      } catch {
        this.clearPending(id, entry);
        entry.reject(new CrosslinkError(ErrorCodes.NOT_CONNECTED, "session closed"));
      }
    });
  }
  clearPending(id, entry) {
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
  }
};
function bytesToUrlSafe(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
var KIND_STATE = {
  "memory": "direct",
  "lan": "direct",
  "webrtc-direct": "direct",
  "turn-relayed": "turn-relayed",
  "crosslink-relayed": "crosslink-relayed"
};
var ClientLink = class {
  constructor(options) {
    this.options = options;
    this.log = (options.logger ?? noopLogger).child({
      component: "client-link",
      appId: options.appId,
      device: options.identity.deviceId
    });
  }
  options;
  session;
  rpcClient;
  state = "offline";
  attempts = 0;
  reconnectTimer;
  stopped = false;
  queue = [];
  desiredSubscriptions = /* @__PURE__ */ new Map();
  /** per-callback detach handle for the *current* session, if any */
  activeSubscriptions = /* @__PURE__ */ new Map();
  log;
  get currentState() {
    return this.state;
  }
  get connected() {
    return this.session?.isOpen ?? false;
  }
  /** Active RPC surface; throws when not connected (calls may be queued). */
  get rpc() {
    if (!this.rpcClient || !this.connected) {
      throw new CrosslinkError(ErrorCodes.NOT_CONNECTED, "not connected");
    }
    return this.rpcClient;
  }
  /* ------------------------------ lifecycle --------------------------- */
  async connect() {
    if (this.stopped && (this.state === "revoked" || this.state === "unauthorized" || this.state === "protocol-incompatible")) {
      throw new CrosslinkError(
        this.state === "revoked" ? ErrorCodes.DEVICE_REVOKED : this.state === "unauthorized" ? ErrorCodes.UNAUTHORIZED : ErrorCodes.VERSION_UNSUPPORTED,
        `cannot connect: ${this.state}`
      );
    }
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.setState("connecting");
    const errors = [];
    for (const candidate of this.options.candidates) {
      let transport;
      this.log.debug("link.candidate-dial", { candidate: candidate.kind });
      try {
        transport = await candidate.connect();
      } catch (err) {
        this.log.debug("link.candidate-failed", { candidate: candidate.kind, error: err });
        errors.push(err);
        continue;
      }
      const opened = await this.handshakeOver(transport);
      if (opened) {
        this.attempts = 0;
        this.log.info("link.connected", { candidate: candidate.kind, queued: this.queue.length });
        this.setState(KIND_STATE[candidate.kind], { transport: candidate.kind });
        void this.flushQueue();
        return;
      }
      if (this.stopped) break;
    }
    if (this.stopped) {
      const code = this.state === "revoked" ? ErrorCodes.DEVICE_REVOKED : this.state === "unauthorized" ? ErrorCodes.UNAUTHORIZED : this.state === "protocol-incompatible" ? ErrorCodes.VERSION_UNSUPPORTED : ErrorCodes.HOST_OFFLINE;
      throw new CrosslinkError(code, `cannot connect: ${this.state}`);
    }
    this.log.warn("link.all-candidates-failed", {
      candidates: this.options.candidates.map((c) => c.kind),
      failures: errors.length
    });
    throw new CrosslinkError(ErrorCodes.HOST_OFFLINE, "no transport candidate succeeded");
  }
  close() {
    this.log.info("link.close-requested", { state: this.state });
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.rpcClient?.failAll(ErrorCodes.NOT_CONNECTED, "client closed");
    this.session?.close("client-close");
    this.session = void 0;
    this.rpcClient = void 0;
    this.setState("offline");
  }
  /**
   * Moves an established connection onto a better transport without
   * re-pairing: dials `candidate`, runs a fresh CLX1 handshake over it, and
   * swaps it in only once that succeeds. A failed upgrade is a no-op - the
   * current connection is left exactly as it was.
   *
   * This is how a relayed session becomes a direct one: the SDP exchange that
   * sets up the WebRTC candidate travels over the session being replaced. See
   * `@crosslink/webrtc-adapter`.
   *
   * In-flight requests on the old session are failed with NOT_CONNECTED and
   * must be retried; subscriptions are restored automatically.
   */
  async upgrade(candidate) {
    if (!this.connected) {
      this.log.debug("link.upgrade-skipped", { reason: "not-connected" });
      return false;
    }
    const previousKind = this.session?.meta.transportKind;
    this.log.info("link.upgrade-attempt", { from: previousKind, to: candidate.kind });
    let transport;
    try {
      transport = await candidate.connect();
    } catch (err) {
      this.log.warn("link.upgrade-dial-failed", { to: candidate.kind, error: err });
      return false;
    }
    const oldSession = this.session;
    const oldRpc = this.rpcClient;
    const ok = await this.handshakeOver(transport);
    if (!ok) {
      this.log.warn("link.upgrade-handshake-failed", { to: candidate.kind });
      return false;
    }
    oldRpc?.failAll(ErrorCodes.NOT_CONNECTED, "connection upgraded; retry this request");
    try {
      oldSession?.close("upgraded");
    } catch {
    }
    this.attempts = 0;
    this.log.info("link.upgraded", { from: previousKind, to: candidate.kind });
    this.setState(KIND_STATE[candidate.kind], { transport: candidate.kind, upgraded: true });
    return true;
  }
  /** The transport the live session is running over, if any. */
  get transportKind() {
    return this.session?.meta.transportKind;
  }
  /* ------------------------------- security --------------------------- */
  /** Called by SDK layers when the host revokes this device. */
  markRevoked() {
    this.log.warn("link.revoked");
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.rpcClient?.failAll(ErrorCodes.DEVICE_REVOKED, "device revoked");
    this.session?.close("revoked");
    this.session = void 0;
    this.rpcClient = void 0;
    this.setState("revoked");
  }
  /* --------------------------------- rpc ------------------------------ */
  async call(method, input, opts = {}) {
    if (!this.rpcClient || !this.connected) {
      throw new CrosslinkError(ErrorCodes.NOT_CONNECTED, "not connected");
    }
    return this.rpcClient.call(method, input, opts);
  }
  stream(method, input, onChunk, opts = {}) {
    if (!this.rpcClient || !this.connected) {
      return Promise.reject(new CrosslinkError(ErrorCodes.NOT_CONNECTED, "not connected"));
    }
    return this.rpcClient.stream(method, input, onChunk, opts);
  }
  /**
   * Subscribes to a host event. The subscription is remembered across
   * reconnects: the desired set is the source of truth, and every fresh
   * session re-issues SUB for it with the caller's real callbacks attached.
   */
  subscribe(event, cb) {
    let cbs = this.desiredSubscriptions.get(event);
    if (!cbs) {
      cbs = /* @__PURE__ */ new Set();
      this.desiredSubscriptions.set(event, cbs);
    }
    cbs.add(cb);
    let detach = this.rpcClient && this.connected ? this.rpcClient.subscribe(event, cb) : void 0;
    this.activeSubscriptions.set(cb, () => detach?.());
    return () => {
      const set = this.desiredSubscriptions.get(event);
      set?.delete(cb);
      if (set && set.size === 0) this.desiredSubscriptions.delete(event);
      this.activeSubscriptions.get(cb)?.();
      this.activeSubscriptions.delete(cb);
      detach = void 0;
    };
  }
  /** Queues an idempotent call while offline; flushed after reconnection. */
  queueIdempotent(method, input) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        method,
        input,
        resolve,
        reject
      });
    });
  }
  get queuedCount() {
    return this.queue.length;
  }
  /* ------------------------------ internals --------------------------- */
  async handshakeOver(transport) {
    const record = this.options.hostRecord();
    const { init, state } = clientBeginSession(this.options.identity, {
      appId: this.options.appId,
      pubEdB64: record.pubEdB64,
      pubXB64: record.pubXB64
    });
    let reply;
    try {
      reply = await this.requestFrame(
        transport,
        encodeMessage(init),
        this.options.handshakeTimeoutMs ?? 1e4
      );
    } catch (err) {
      this.log.warn("link.handshake-failed", { transport: transport.kind, error: err });
      try {
        transport.close("handshake-error");
      } catch {
      }
      return false;
    }
    if (reply.kind === "sack") {
      const keys = clientCompleteSession(
        this.options.identity,
        state,
        init,
        reply,
        { pubEd: base64ToBytes(record.pubEdB64), pubX: base64ToBytes(record.pubXB64) }
      );
      this.attachSession(transport, keys);
      return true;
    }
    if (reply.kind === "srej") {
      const code = String(reply.code ?? "");
      this.log.warn("link.handshake-rejected", {
        code,
        message: String(reply.message ?? "").slice(0, 200)
      });
      transport.close(code);
      if (code === ErrorCodes.DEVICE_REVOKED) {
        this.markRevoked();
        return false;
      }
      if (code === ErrorCodes.VERSION_UNSUPPORTED) {
        this.setState("protocol-incompatible", { version: init.v });
        this.stopped = true;
        return false;
      }
      if (code === ErrorCodes.UNAUTHORIZED) {
        this.setState("unauthorized");
        this.stopped = true;
        return false;
      }
      return false;
    }
    this.log.warn("link.unexpected-handshake-frame", {
      kind: String(reply.kind).slice(0, 32)
    });
    transport.close("unexpected-handshake-frame");
    return false;
  }
  attachSession(transport, keys) {
    const session = new CrosslinkSession(
      transport,
      keys,
      {
        role: "client",
        appId: this.options.appId,
        peerDeviceId: "host",
        transportKind: transport.kind
      },
      {
        onMessage: (msg) => {
          if (this.rpcClient) this.rpcClient.handleMessage(msg);
          this.options.onMessage?.(msg);
        },
        onClose: (reason) => {
          try {
            transport.close("session-ended");
          } catch {
          }
          if (this.session !== session) {
            this.log.debug("link.stale-session-closed", { reason: String(reason ?? "") });
            return;
          }
          if (reason === "device-revoked") {
            this.markRevoked();
            return;
          }
          this.handleDisconnect();
        }
      },
      {
        maxFrameBytes: this.options.maxFrameBytes ?? Limits.DEFAULT_MAX_FRAME_BYTES,
        logger: this.options.logger
      }
    );
    this.session = session;
    this.rpcClient = new RpcClient(session, this.options.requestTimeoutMs);
    for (const [event, cbs] of this.desiredSubscriptions) {
      for (const cb of cbs) {
        const detach = this.rpcClient.subscribe(event, cb);
        this.activeSubscriptions.set(cb, detach);
      }
    }
    if (this.desiredSubscriptions.size > 0) {
      this.log.debug("link.subscriptions-restored", {
        events: [...this.desiredSubscriptions.keys()]
      });
    }
  }
  handleDisconnect() {
    this.log.info("link.disconnected", { state: this.state, stopped: this.stopped });
    this.activeSubscriptions.clear();
    this.rpcClient?.failAll();
    this.session = void 0;
    this.rpcClient = void 0;
    if (this.stopped) {
      if (this.state !== "revoked" && this.state !== "unauthorized" && this.state !== "protocol-incompatible") {
        this.setState("offline");
      }
      return;
    }
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (this.stopped) return;
    const attempt = ++this.attempts;
    const backoff = Math.min(3e4, 500 * 2 ** Math.min(attempt, 6));
    const jitter = backoff * (0.7 + Math.random() * 0.6);
    this.log.info("link.reconnect-scheduled", { attempt, delayMs: Math.round(jitter) });
    this.setState("reconnecting", { attempt, delayMs: Math.round(jitter) });
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch(() => {
        if (!this.stopped) this.scheduleReconnect();
      });
    }, jitter);
  }
  async flushQueue() {
    while (this.queue.length > 0 && this.connected) {
      const item = this.queue.shift();
      try {
        const result = await this.rpcClient.call(item.method, item.input);
        item.resolve(result);
      } catch (err) {
        this.log.warn("link.queued-call-failed", { method: item.method, error: err });
        item.reject(CrosslinkError.from(err));
      }
    }
  }
  setState(state, detail) {
    if (this.state !== state || detail) {
      this.log.debug("link.state", { from: this.state, to: state, ...detail ?? {} });
      this.state = state;
      this.options.onStateChange?.(state, detail);
    }
  }
  isFatal(errors) {
    return errors.some(
      (e) => e instanceof CrosslinkError && [ErrorCodes.DEVICE_REVOKED, ErrorCodes.UNAUTHORIZED, ErrorCodes.VERSION_UNSUPPORTED].includes(
        e.code
      )
    );
  }
  requestFrame(transport, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(reject, new Error("handshake timed out")), timeoutMs);
      function finish(fail2, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (fail2 === resolve && value !== void 0) resolve(value);
        else reject(value instanceof Error ? value : new Error(String(value ?? "handshake failed")));
      }
      transport.onData((data) => {
        try {
          const frame = JSON.parse(new TextDecoder().decode(data));
          finish(resolve, frame);
        } catch (err) {
          finish(reject, err instanceof Error ? err : new Error("bad handshake frame"));
        }
      });
      transport.onClose(() => finish(reject, new Error("transport closed during handshake")));
      Promise.resolve().then(() => transport.send(payload)).catch((err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
    });
  }
};
var PAIRING_TRANSCRIPT = {
  claim: "crosslink-pair-claim-v1",
  challenge: "crosslink-pair-challenge-v1",
  complete: "crosslink-pair-complete-v1"
};
function pairingTranscriptBytes(kind, fields) {
  return utf8ToBytes3(canonicalJson([PAIRING_TRANSCRIPT[kind], ...fields]));
}
var utf82 = (s) => new TextEncoder().encode(s);
function fingerprintFromPublicKey(pubEd) {
  return toHex(sha2562(concatBytes2(utf82("fingerprint"), pubEd)));
}
function concatBytes2(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  }
  return out;
}
var utf83 = (s) => new TextEncoder().encode(s);
function createClaim(identity, qr, deviceName, requestedCaps) {
  const claimNonce = bytesToBase64(randomBytes2(32));
  const psidPlaceholder = "";
  const claim = {
    kind: "pair_claim",
    ps: psidPlaceholder,
    dev: identity.deviceId,
    name: deviceName.slice(0, 64),
    pub_ed: bytesToBase64(identity.edPublicKey),
    pub_x: bytesToBase64(identity.xPublicKey),
    nonce: claimNonce,
    ...requestedCaps && requestedCaps.length > 0 ? { caps_req: requestedCaps } : {}
  };
  return { claim, state: { claimNonce } };
}
function signClaim(identity, claim, psid) {
  const transcript2 = pairingTranscriptBytes("claim", [
    psid,
    String(claim.dev),
    String(claim.name),
    String(claim.pub_ed),
    String(claim.pub_x),
    String(claim.nonce),
    Array.isArray(claim.caps_req) ? claim.caps_req : null
  ]);
  claim.ps = psid;
  claim.sig = bytesToBase64(identity.sign(transcript2));
}
async function processChallenge(identity, qr, state, challenge, confirm) {
  if (challenge.kind !== "pair_challenge") {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "expected pair_challenge frame");
  }
  const hostPubEdB64 = String(challenge.host_pub_ed ?? "");
  const hostPubXB64 = String(challenge.host_pub_x ?? "");
  const challengeNonce = String(challenge.nonce ?? "");
  const grantedCaps = Array.isArray(challenge.granted_caps) ? challenge.granted_caps.map(String) : [];
  const fp = fingerprintFromPublicKey(base64ToBytes(hostPubEdB64));
  if (!fp.startsWith(qr.fp16)) {
    throw new CrosslinkError(
      ErrorCodes.UNAUTHORIZED,
      "host identity does not match the scanned QR fingerprint"
    );
  }
  const transcript2 = pairingTranscriptBytes("challenge", [
    String(challenge.ps ?? ""),
    state.claimNonce,
    hostPubEdB64,
    hostPubXB64,
    challengeNonce,
    grantedCaps
  ]);
  const sigOk = verifySignature(
    base64ToBytes(String(challenge.sig ?? "")),
    transcript2,
    base64ToBytes(hostPubEdB64)
  );
  if (!sigOk) {
    throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "host challenge signature invalid");
  }
  if (String(challenge.claim_nonce ?? "") !== state.claimNonce) {
    throw new CrosslinkError(ErrorCodes.PAIRING_INVALID, "challenge does not match our claim");
  }
  const sas = shortAuthString(
    qr.appId,
    identity.edPublicKey,
    base64ToBytes(hostPubEdB64)
  );
  const approved = await confirm({
    sas,
    hostName: qr.appName,
    hostFp16: qr.fp16,
    grantedCaps
  });
  if (!approved) {
    throw new CrosslinkError(ErrorCodes.PAIRING_INVALID, "pairing cancelled by client user");
  }
  const completeSig = bytesToBase64(
    identity.sign(pairingTranscriptBytes("complete", [String(challenge.ps), state.claimNonce, challengeNonce]))
  );
  const record = {
    appId: qr.appId,
    appName: qr.appName,
    fingerprint: fpFull(hostPubEdB64),
    pubEdB64: hostPubEdB64,
    pubXB64: hostPubXB64,
    grantedCaps,
    pairedAt: Date.now()
  };
  return {
    complete: {
      kind: "pair_complete",
      ps: String(challenge.ps),
      claim_nonce: state.claimNonce,
      challenge_nonce: challengeNonce,
      sig: completeSig
    },
    record
  };
}
function fpFull(pubEdB64) {
  return bytesToHex22(sha256Bytes(utf83("fingerprint"), base64ToBytes(pubEdB64)));
}
function bytesToHex22(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  }
  return out;
}
var PAIRING_URI_SCHEME = "crosslink://pair";
function parsePairingUri(text) {
  const trimmed = text.trim();
  let params;
  if (trimmed.startsWith(PAIRING_URI_SCHEME)) {
    params = new URLSearchParams(trimmed.slice(PAIRING_URI_SCHEME.length));
  } else if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    params = url.searchParams.get("c") !== null || url.searchParams.get("s") !== null || url.searchParams.get("a") !== null ? url.searchParams : new URLSearchParams(url.hash.replace(/^#/, ""));
  } else {
    throw new Error("not a crosslink pairing URI");
  }
  const version = params.get("v");
  const signalingUrl = params.get("s");
  const rawCode = params.get("c");
  const code = rawCode ? normalizeCode(rawCode) : "";
  const appId = params.get("a");
  const appName = params.get("n") ?? appId ?? "";
  const fp16 = (params.get("f") ?? "").toLowerCase();
  const transport = params.get("t") ?? void 0;
  if (version !== "1") throw new Error(`unsupported pairing uri version: ${String(version)}`);
  if (!signalingUrl || !/^(https?|wss?):\/\//i.test(signalingUrl)) {
    throw new Error("pairing uri missing valid signaling url");
  }
  if (!appId || appId.length > 256 || !/^[\w.@:/-]+$/.test(appId)) {
    throw new Error("pairing uri missing valid app id");
  }
  if (!/^[0-9a-f]{16}$/.test(fp16)) throw new Error("pairing uri missing fingerprint");
  return { signalingUrl, code, appId, appName, fp16, transport };
}
function normalizeCode(input) {
  const digits = input.replace(/\D/g, "");
  return digits.length === 9 ? digits : input.trim();
}
var BOOTSTRAP_FRAGMENT_KEY = "pair";
function unwrapBootstrapUri(text) {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    let params = new URLSearchParams(url.hash.replace(/^#/, ""));
    let embedded = params.get(BOOTSTRAP_FRAGMENT_KEY);
    if (!embedded) {
      params = url.searchParams;
      embedded = params.get(BOOTSTRAP_FRAGMENT_KEY);
    }
    if (embedded) return decodeEmojiSafe(embedded);
  } catch {
  }
  return trimmed;
}
function decodeEmojiSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ../../adapters/webrtc/dist/index.js
var WEBRTC_OFFER_METHOD = "crosslink.webrtc.offer";
var MAX_SDP_BYTES = 64 * 1024;
var DEFAULT_TIMEOUT_MS = 15e3;
var CHANNEL_LABEL = "crosslink";
function webrtcUpgradeCandidate(link, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    kind: "webrtc-direct",
    connect: async () => {
      const pc = options.createPeer();
      try {
        const channel = pc.createDataChannel(options.label ?? CHANNEL_LABEL, { ordered: true });
        const opened = waitOpen(channel, timeoutMs);
        await pc.setLocalDescription(await pc.createOffer());
        await gatherSettled(pc, timeoutMs);
        const offerSdp = pc.localDescription?.sdp;
        if (!offerSdp) throw new Error("no local description after createOffer");
        const answer = await link.call(
          options.method ?? WEBRTC_OFFER_METHOD,
          { type: "offer", sdp: offerSdp },
          { timeoutMs }
        );
        await pc.setRemoteDescription(readSdp(answer, "answer"));
        await opened;
        return dataChannelTransport(channel);
      } catch (err) {
        pc.close();
        throw err;
      }
    }
  };
}
async function tryUpgradeToWebrtc(link, options) {
  if (link.transportKind === "webrtc-direct") return true;
  try {
    return await link.upgrade(webrtcUpgradeCandidate(link, options));
  } catch {
    return false;
  }
}
function readSdp(input, expected) {
  const value = input;
  if (!value || typeof value.sdp !== "string" || value.type !== expected) {
    throw Object.assign(new Error(`expected an SDP ${expected}`), {
      code: "validation_failed"
    });
  }
  if (value.sdp.length > MAX_SDP_BYTES) {
    throw Object.assign(new Error("SDP too large"), { code: "payload_too_large" });
  }
  return { type: expected, sdp: value.sdp };
}
function waitOpen(dc, timeoutMs) {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("datachannel open timeout")), timeoutMs);
    dc.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    dc.onerror = () => {
      clearTimeout(timer);
      reject(new Error("datachannel error"));
    };
  });
}
function gatherSettled(pc, timeoutMs) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.onicegatheringstatechange = null;
      resolve();
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    setTimeout(done, Math.min(2e3, timeoutMs));
  });
}
function dataChannelTransport(dc, kind = "webrtc-direct") {
  let dataHandler;
  let closeHandler;
  let closed = false;
  dc.binaryType = "arraybuffer";
  dc.onmessage = async (ev) => {
    if (closed) return;
    const data = ev.data;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    dataHandler?.(bytes);
  };
  const die = () => {
    if (closed) return;
    closed = true;
    closeHandler?.("dc-closed");
  };
  dc.onclose = die;
  dc.onerror = die;
  return {
    kind,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    async send(bytes) {
      if (closed || dc.readyState !== "open") throw new Error("datachannel closed");
      dc.send(bytes);
    },
    close(reason) {
      if (closed) return;
      try {
        dc.close();
      } catch {
      }
      closed = true;
      closeHandler?.(typeof reason === "string" ? reason : "closed");
    }
  };
}

// ../../packages/sdk-browser/dist/index.js
function toBytes3(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof data === "string") throw new Error("unexpected text frame");
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  throw new Error("unsupported websocket message type");
}
function openWithTimeout(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
      }
      reject(new Error(`connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onOpen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener?.("error", onError);
      resolve();
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("connection failed"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}
function wsTransport(ws, kind) {
  try {
    ws.binaryType = "arraybuffer";
  } catch {
  }
  let dataHandler;
  let closeHandler;
  let closed = false;
  ws.addEventListener("message", (ev) => {
    if (closed) return;
    let bytes;
    try {
      bytes = toBytes3(ev.data);
    } catch {
      return;
    }
    if (bytes instanceof Uint8Array) {
      dataHandler?.(bytes);
      return;
    }
    void bytes.then((resolved) => {
      if (!closed) dataHandler?.(resolved);
    });
  });
  const onCloseOnce = () => {
    if (closed) return;
    closed = true;
    closeHandler?.("ws-closed");
  };
  ws.addEventListener("close", onCloseOnce);
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
    }
    onCloseOnce();
  });
  return {
    kind,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    async send(bytes) {
      if (closed || ws.readyState !== 1) throw new Error("transport closed");
      ws.send(bytes);
    },
    close(reason) {
      if (closed) return;
      try {
        ws.close(1e3, typeof reason === "string" ? reason.slice(0, 100) : void 0);
      } catch {
      }
    }
  };
}
var SignalingPeer = class _SignalingPeer {
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.op === "pair_deliver" && typeof msg.blob === "string") {
        const entry = { from: String(msg.from), blob: msg.blob };
        const r = this.resolvers.shift();
        if (r) r(entry);
        else this.queue.push(entry);
        return;
      }
      if (msg.op === "error") {
        this.fail(new Error(`signaling error: ${JSON.stringify(msg.error ?? {})}`));
      }
      if (msg.op === "pair_not_found") {
        this.fail(new Error("PAIRING_EXPIRED: code not found or expired"));
      }
    });
    ws.addEventListener(
      "close",
      () => this.fail(new Error("signaling connection closed"))
    );
    ws.addEventListener("error", () => this.fail(new Error("signaling connection failed")));
  }
  ws;
  queue = [];
  resolvers = [];
  failure;
  failureWaiters = [];
  static async open(wsFactory, timeoutMs = 1e4) {
    const ws = wsFactory();
    const peer = new _SignalingPeer(ws);
    try {
      await openWithTimeout(ws, timeoutMs);
    } catch {
      throw new Error("cannot reach signaling");
    }
    return peer;
  }
  /** Resolves a pairing code; returns psid, host connection id, and presence. */
  async resolve(code) {
    this.send({ op: "pair_resolve", code });
    return new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.op === "pair_found") {
          this.ws.removeEventListener?.("message", onMsg);
          resolve({
            psid: String(msg.psid),
            hostConn: String(msg.host_conn),
            app: msg.app
          });
        } else if (msg.op === "pair_not_found") {
          this.ws.removeEventListener?.("message", onMsg);
          reject(new Error("PAIRING_EXPIRED"));
        } else if (msg.op === "error") {
          this.ws.removeEventListener?.("message", onMsg);
          reject(new Error(String(msg.error?.code ?? "error")));
        }
      };
      this.ws.addEventListener("message", onMsg);
    });
  }
  /** Sends an opaque blob to a connected peer (host or waiter). */
  sendTo(connId, blob) {
    this.send({ op: "pair_payload", to: connId, blob });
  }
  /** Awaits the next blob delivered from `fromConnId`. */
  nextBlob(fromConnId, timeoutMs = 15e3) {
    const idx = this.queue.findIndex((q) => q.from === fromConnId);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0].blob);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failureWaiters = this.failureWaiters.filter((w) => w !== wake);
        reject(new Error("timeout awaiting pairing reply"));
      }, timeoutMs);
      const wake = (err) => {
        clearTimeout(timer);
        err ? reject(err) : reject(new Error("peer closed"));
      };
      this.resolvers.push((entry) => {
        clearTimeout(timer);
        this.failureWaiters = this.failureWaiters.filter((w) => w !== wake);
        if (entry.from === fromConnId) resolve(entry.blob);
        else {
          this.queue.push(entry);
          this.resolvers.push((e2) => resolve(e2.blob));
          reject(new Error("blob from unexpected sender"));
        }
      });
      this.failureWaiters.push(wake);
      if (this.failure) wake(this.failure);
    });
  }
  close() {
    try {
      this.ws.close(1e3, "done");
    } catch {
    }
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  fail(err) {
    this.failure = err;
    const waiters = this.failureWaiters.splice(0);
    for (const w of waiters) w(err);
  }
};
var StorageBackedAppStore = class {
  file;
  constructor(storage) {
    this.file = new JsonStore(storage, "crosslink.apps");
  }
  all() {
    return this.file.load({ apps: {} }).apps;
  }
  list() {
    return Object.values(this.all());
  }
  get(appId) {
    return this.all()[appId];
  }
  upsert(record) {
    const data = this.file.load({ apps: {} });
    data.apps[record.appId] = record;
    this.file.save(data);
  }
  remove(appId) {
    const data = this.file.load({ apps: {} });
    delete data.apps[appId];
    this.file.save(data);
  }
};
var CrosslinkClient = class _CrosslinkClient {
  constructor(options = {}) {
    this.options = options;
    const storage = options.storage ?? new MemorySecureStorage();
    this.storage = storage;
    this.appStore = new StorageBackedAppStore(storage);
    this.hints = new JsonStore(storage, "crosslink.hints");
    this.log = (options.logger ?? noopLogger).child({ component: "crosslink-client" });
    const seedKey = "crosslink.identity.seed";
    const existing = storage.get(seedKey);
    if (existing) {
      this.identity = DeviceIdentity.fromSeed(base64ToBytesLocal(existing));
    } else {
      this.identity = DeviceIdentity.create();
      storage.set(seedKey, bytesToBase64(this.identity.seed));
      this.log.info("client.identity-created", { deviceId: this.identity.deviceId });
    }
  }
  options;
  log;
  identity;
  appStore;
  hints;
  link;
  storage;
  deviceCryptoStorage;
  /**
   * Builds a client whose identity and paired-app records are encrypted at
   * rest with a non-extractable WebCrypto key, rather than sitting in
   * `localStorage` in the clear. Prefer this over `new CrosslinkClient()` in
   * browsers; the constructor stays synchronous for embedders that supply
   * their own storage.
   */
  static async create(options = {}) {
    if (options.storage) return new _CrosslinkClient(options);
    const log2 = options.logger ?? noopLogger;
    const { storage, kind, encrypted } = await createSecureStorage({
      ...options.allowPlaintextFallback !== void 0 ? { allowPlaintextFallback: options.allowPlaintextFallback } : {},
      onWriteError: (err, key) => log2.error("client.storage-write-failed", { key, error: err })
    });
    if (!encrypted) {
      log2.warn("client.storage-not-encrypted", {
        kind,
        detail: "identity seed is stored in the clear; WebCrypto/IndexedDB unavailable"
      });
    } else {
      log2.info("client.storage", { kind });
    }
    return new _CrosslinkClient({ ...options, storage });
  }
  get deviceId() {
    return this.identity.deviceId;
  }
  listApps() {
    return this.appStore.list();
  }
  forget(appId) {
    this.appStore.remove(appId);
    this.link?.close();
    this.link = void 0;
  }
  /**
   * Runs the full pairing flow against a scanned QR / URI: resolve code via
   * signaling, verify pinned fingerprint, verify challenge signature, confirm
   * SAS, persist the paired-app record.
   *
   * Accepts either a raw `crosslink://pair?…` manifest URI or a hosted
   * bootstrap URL (`https://…/…&pair=<manifest>`), because iOS Safari has no
   * handler for the custom scheme — the phone's camera produces the hosted
   * link and this call transparently unwraps it.
   */
  async pairFromQr(text, requestedCaps, codeOverride) {
    if (!this.deviceCryptoStorage) {
      try {
        const storageModule = await Promise.resolve().then(() => (init_device_crypto_storage_NEJ3IT2Z(), device_crypto_storage_NEJ3IT2Z_exports));
        this.deviceCryptoStorage = await storageModule.SecureDeviceCryptoStorage.open();
      } catch (e) {
        this.log.warn("client.device-crypto-init-failed", { error: String(e) });
      }
    }
    const manifest = unwrapBootstrapUri(text);
    const uri = parsePairingUri(manifest);
    const code = (codeOverride ?? uri.code).replace(/\D/g, "");
    if (code.length !== 9) {
      throw new Error("A valid 9-digit pairing code is required");
    }
    if (!uri.signalingUrl) throw new Error("pairing URI has no signaling URL (LAN-only pairing not supported by browser client)");
    const wsUrl = `${uri.signalingUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    const peer = await SignalingPeer.open(() => this.ws(wsUrl), this.options.dialTimeoutMs ?? 1e4);
    try {
      const found = await peer.resolve(code);
      if (!found.app.fingerprint.startsWith(uri.fp16)) {
        this.log.error("client.fingerprint-mismatch", {
          expected: uri.fp16,
          got: found.app.fingerprint.slice(0, 16)
        });
        throw new Error("SECURITY: host fingerprint does not match the scanned code");
      }
      const { claim, state } = createClaim(this.identity, uri, this.options.deviceName ?? "browser", requestedCaps);
      signClaim(this.identity, claim, found.psid);
      peer.sendTo(found.hostConn, JSON.stringify(claim));
      const challengeBlob = await peer.nextBlob(found.hostConn);
      const challenge = JSON.parse(challengeBlob);
      if (challenge.kind === "pair_error") {
        throw new Error(`PAIRING_FAILED: ${JSON.stringify(challenge.error ?? {})}`);
      }
      const defaultConfirm = (req) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          return window.confirm(
            `Confirm pairing with "${req.hostName}"?

SAS: ${req.sas}
Capabilities: ${req.grantedCaps.join(", ") || "(none)"}`
          );
        }
        return true;
      };
      const confirm = this.options.onConfirmPairing ?? defaultConfirm;
      const { complete, record } = await processChallenge(
        this.identity,
        uri,
        state,
        challenge,
        confirm
      );
      peer.sendTo(found.hostConn, JSON.stringify(complete));
      const doneBlob = await peer.nextBlob(found.hostConn);
      const done = JSON.parse(doneBlob);
      if (done.kind === "pair_error") {
        throw new Error(`PAIRING_FAILED: ${JSON.stringify(done.error ?? {})}`);
      }
      record.lastConnected = Date.now();
      this.appStore.upsert(record);
      this.log.info("client.paired", {
        appId: record.appId,
        appName: record.appName,
        grantedCaps: record.grantedCaps,
        requestedCaps: requestedCaps ?? null
      });
      const hintsAll = this.hints.load({});
      hintsAll[record.appId] = {
        relay: found.app.relay,
        lan: found.app.lan,
        signalingUrl: uri.signalingUrl
      };
      this.hints.save(hintsAll);
      if (done && typeof done.sessionToken === "string") {
        try {
          await this.deviceCryptoStorage?.save({ sessionToken: done.sessionToken }, record.appId);
        } catch (e) {
          this.log.debug("client.session-token-store-failed", { error: String(e) });
        }
      }
      return record;
    } finally {
      peer.close();
    }
  }
  /** Connects to a previously paired app; returns the RPC client when online. */
  async connect(appId) {
    const record = appId ? this.appStore.get(appId) : this.appStore.list()[0];
    if (!record) throw new Error("no paired app" + (appId ? ` for ${appId}` : ""));
    if (this.link && this.link.currentState !== "offline" && this.link.currentState !== "connecting" && this.link.currentState !== "reconnecting") return this.rpc();
    const hintsAll = this.hints.load({});
    const hints = hintsAll[record.appId] ?? {};
    let presence = null;
    if (hints.signalingUrl) {
      const doFetch = this.options.fetch ?? globalThis.fetch;
      try {
        const res = await doFetch(
          `${hints.signalingUrl.replace(/\/$/, "")}/apps/${encodeURIComponent(record.appId)}`
        );
        if (res.ok) {
          presence = await res.json();
          hintsAll[record.appId] = { ...hints, ...presence };
          this.hints.save(hintsAll);
        }
      } catch (err) {
        this.log.debug("client.presence-lookup-failed", { appId: record.appId, error: err });
      }
    }
    const relay = presence?.relay ?? hints.relay;
    const lan = presence?.lan ?? hints.lan;
    const candidates = [];
    if (lan && lan.host) {
      candidates.push({
        kind: "lan",
        connect: async () => {
          const { ws: opened, ready } = openWs(`ws://${lan.host}:${lan.port}`, (u) => this.ws(u), this.options.dialTimeoutMs ?? 1e4);
          await ready;
          return wsTransport(opened, "lan");
        }
      });
    }
    if (relay && this.options.networkMode !== "local-only") {
      candidates.push({
        kind: "crosslink-relayed",
        connect: async () => {
          const base = `${relay.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
          const url = `${base}?channel=${encodeURIComponent(relay.channel)}&role=c` + (this.options.relayToken ? `&auth=${encodeURIComponent(this.options.relayToken)}` : "");
          const { ws: opened, ready } = openWs(url, (u) => this.ws(u), this.options.dialTimeoutMs ?? 1e4);
          await ready;
          return wsTransport(opened, "crosslink-relayed");
        }
      });
    }
    if (candidates.length === 0) {
      this.log.warn("client.no-candidates", { appId: record.appId });
      throw new Error("no known transport for this app; re-pair or check host is online");
    }
    this.log.debug("client.connecting", {
      appId: record.appId,
      candidates: candidates.map((c) => c.kind)
    });
    this.link?.close();
    const link = new ClientLink({
      identity: this.identity,
      appId: record.appId,
      hostRecord: () => {
        const rec = this.appStore.get(record.appId);
        rec.lastConnected = Date.now();
        return rec;
      },
      candidates,
      autoReconnect: true,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onStateChange: this.options.onStateChange,
      logger: this.options.logger
    });
    this.link = link;
    await link.connect();
    if (this.options.webrtc) {
      this.tryWebrtcUpgrade(link);
    }
    return link.rpc;
  }
  /**
   * Attempts to upgrade a relayed session to a direct WebRTC DataChannel.
   * Runs asynchronously — the relayed session stays active regardless.
   */
  async tryWebrtcUpgrade(_link) {
    if (!this.options.webrtc?.createPeer) return;
    try {
      const target = _link;
      const ok = await tryUpgradeToWebrtc(target, {
        createPeer: this.options.webrtc.createPeer,
        timeoutMs: this.options.webrtc.timeoutMs
      });
      if (ok) {
        this.log.info("client.webrtc-upgraded");
      }
    } catch (err) {
      this.log.debug("client.webrtc-upgrade-failed", { error: err });
    }
  }
  rpc() {
    if (!this.link || !this.link.connected) throw new Error("not connected");
    return this.link.rpc;
  }
  /** The live connection, exposed for adapters that upgrade the transport. */
  get connection() {
    return this.link;
  }
  /**
   * Convenience for the iOS / Add-to-Home-Screen flow: accepts the long
   * `https://…#pair=<uri>` link a phone camera produces, unwraps it, and
   * delegates to `pairFromQr`.
   */
  async pairFromBootstrap(bootstrapUrl, requestedCaps, codeOverride) {
    return this.pairFromQr(bootstrapUrl, requestedCaps, codeOverride);
  }
  /**
   * Explicit pairing method taking a target host URI/manifest and entered 9-digit code.
   */
  async pairWithCode(targetUri, code, requestedCaps) {
    return this.pairFromQr(targetUri, requestedCaps, code);
  }
  /** True when the identity seed is encrypted at rest. */
  get storageEncrypted() {
    return this.storage.encrypted === true;
  }
  ws(url) {
    return (this.options.webSocket ?? defaultWebSocket)(url);
  }
  get state() {
    return this.link?.currentState ?? "offline";
  }
  close() {
    this.link?.close();
    this.link = void 0;
  }
};
function defaultWebSocket(url) {
  const ctor = globalThis.WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket not available in this environment");
  }
  return new ctor(url);
}
function openWs(url, factory, timeoutMs) {
  const ws = factory(url);
  return { ws, ready: openWithTimeout(ws, timeoutMs) };
}
function base64ToBytesLocal(b64) {
  const bin = atobSafe(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function atobSafe(b64) {
  if (typeof atob === "function") return atob(b64);
  return Buffer.from(b64, "base64").toString("binary");
}
var DEFAULT_CROSSLINK_SVG = `
<svg viewBox="105 363 1060 222" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z" fill="currentColor" fill-rule="evenodd"/>
</svg>
`.trim();
var PAIRING_CARD_STYLES = `
.cl-pair-card {
  --cl-bg: #000000;
  --cl-fg: #ffffff;
  --cl-muted: #9a9a9a;
  --cl-divider: #2a2a2a;
  --cl-pill: #e7e7ea;
  --cl-pill-text: #0a0a0a;
  --cl-radius: 28px;
  --cl-accent: #38bdf8;
  position: relative;
  background: var(--cl-bg);
  color: var(--cl-fg);
  border-radius: var(--cl-radius);
  padding: 28px 32px;
  margin: 20px 0;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1.1fr auto 1fr auto 1fr;
  align-items: center;
  gap: 28px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  text-align: left;
}
.cl-pair-card * {
  box-sizing: border-box;
}

/* \u2500\u2500 Cog Button \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-cog-btn {
  position: absolute;
  top: 14px;
  right: 16px;
  background: transparent;
  border: none;
  color: var(--cl-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
  z-index: 20;
}
.cl-cog-btn:hover {
  color: var(--cl-fg);
  background: rgba(255, 255, 255, 0.1);
}
.cl-cog-btn svg {
  width: 17px;
  height: 17px;
  display: block;
}

/* \u2500\u2500 Small Dropdown Menu \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-settings-dropdown {
  position: absolute;
  top: 44px;
  right: 14px;
  width: 300px;
  background: var(--cl-bg);
  border: 1px solid var(--cl-divider);
  border-radius: 12px;
  padding: 8px;
  z-index: 30;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08);
  animation: clDropdownFade 0.12s ease-out;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cl-settings-dropdown[hidden] {
  display: none;
}
@keyframes clDropdownFade {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.cl-dropdown-header {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cl-muted);
  padding: 6px 8px 4px 8px;
}
.cl-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--cl-fg);
  transition: background 0.12s;
  position: relative;
  user-select: none;
}
.cl-dropdown-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.cl-dropdown-label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.cl-dropdown-label input[type="radio"] {
  accent-color: var(--cl-accent);
  cursor: pointer;
  margin: 0;
}
.cl-info-knob-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cl-info-knob {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: var(--cl-muted);
  font-size: 11px;
  font-weight: 700;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.cl-info-knob:hover,
.cl-info-knob:focus {
  background: var(--cl-accent);
  color: #082f49;
}
/* Tooltip on hover / focus */
.cl-dropdown-tooltip {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 250px;
  background: #020617;
  border: 1px solid var(--cl-divider);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.45;
  color: #cbd5e1;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-2px);
  transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
  z-index: 50;
}
.cl-info-knob-wrap:hover .cl-dropdown-tooltip,
.cl-info-knob-wrap:focus-within .cl-dropdown-tooltip {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
}
.cl-dropdown-tooltip a {
  color: var(--cl-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  display: inline-block;
  margin-top: 6px;
}

/* \u2500\u2500 Columns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-pair-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.cl-pair-logo {
  height: 24px;
  width: auto;
  max-width: 140px;
  display: block;
  margin-bottom: 14px;
  color: var(--cl-fg);
}
.cl-pair-blurb {
  font-size: 13px;
  line-height: 1.55;
  color: var(--cl-muted);
  max-width: 32ch;
  margin: 0;
}
.cl-pair-blurb strong {
  color: var(--cl-fg);
  font-weight: 600;
}
.cl-pair-refresh {
  appearance: none;
  background: none;
  border: none;
  color: var(--cl-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  padding: 0;
  margin-top: 14px;
  transition: color 0.15s;
}
.cl-pair-refresh:hover {
  color: var(--cl-fg);
}
.cl-pair-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.cl-pair-divider {
  width: 1px;
  align-self: stretch;
  background: var(--cl-divider);
}
.cl-pair-label {
  font-size: 12px;
  font-weight: 700;
  text-transform: none;
  color: var(--cl-fg);
  margin: 0 0 14px 0;
  text-align: center;
}
.cl-pair-center,
.cl-pair-right {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.cl-qr-wrap {
  background: #ffffff;
  border-radius: 16px;
  padding: 12px;
  min-width: 176px;
  min-height: 176px;
  width: 176px;
  height: 176px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.cl-qr-wrap svg {
  width: 152px;
  height: 152px;
  display: block;
}
.cl-qr-wrap img {
  width: 152px;
  height: 152px;
  display: block;
  border-radius: 8px;
}
.cl-qr-placeholder {
  color: #6b6b6b;
  font-size: 12px;
  text-align: center;
  max-width: 140px;
  line-height: 1.4;
}
.cl-qr-placeholder.cl-error {
  color: #f87171;
}
.cl-pair-code-pills {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  max-width: 200px;
  justify-content: center;
  min-height: 44px;
  align-items: center;
}
.cl-pair-code-pills .cl-pill {
  background: var(--cl-pill);
  color: var(--cl-pill-text);
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  border-radius: 12px;
  padding: 14px 8px;
  min-width: 44px;
  text-align: center;
  display: block;
}
.cl-pair-hint {
  font-size: 11px;
  color: var(--cl-muted);
  margin: 12px 0 0 0;
  text-align: center;
}
@media (max-width: 860px) {
  .cl-pair-card {
    grid-template-columns: 1fr;
    text-align: center;
    padding: 20px 24px;
    gap: 20px;
  }
  .cl-pair-left {
    align-items: center;
  }
  .cl-pair-card .cl-pair-divider {
    width: 100%;
    height: 1px;
  }
  .cl-pair-logo {
    margin-left: auto;
    margin-right: auto;
  }
  .cl-pair-blurb {
    max-width: none;
  }
}

/* \u2500\u2500 Connected Devices Modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-connected-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.75);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clDropdownFade 0.15s ease-out;
}
.cl-connected-modal {
  background: #0a0a0a;
  border: 1px solid var(--cl-divider);
  border-radius: 20px;
  width: 92vw;
  max-width: 640px;
  max-height: 85vh;
  padding: 24px 28px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.06);
  overflow-y: auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--cl-fg);
}
.cl-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 16px;
}
.cl-modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.cl-modal-header button {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--cl-divider);
  border-radius: 10px;
  color: var(--cl-fg);
  font-size: 20px;
  line-height: 1;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.cl-modal-header button:hover {
  background: rgba(255, 255, 255, 0.15);
}
.cl-modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cl-modal-error {
  color: #f87171;
  font-size: 12px;
  padding: 8px 0;
}
.cl-device-card {
  background: #121212;
  border: 1px solid var(--cl-divider);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.cl-device-info {
  flex: 1;
  min-width: 0;
}
.cl-device-name {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 4px;
  letter-spacing: -0.01em;
}
.cl-device-meta {
  font-size: 11px;
  color: var(--cl-muted);
  margin-bottom: 8px;
  text-transform: capitalize;
}
.cl-device-detail {
  font-size: 11px;
  line-height: 1.5;
  color: #c4c4c4;
}
.cl-device-detail strong {
  color: var(--cl-muted);
  font-weight: 600;
}
.cl-device-actions {
  flex-shrink: 0;
}
.cl-revoke-btn {
  background: #1a1a2e;
  border: 1px solid #2a2a3a;
  color: #e7e7ea;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.cl-revoke-btn:hover {
  background: #7f1d1d;
  border-color: #f87171;
  color: #f87171;
}
`.trim();
var BOOTSTRAP_STYLES = `
/* \u2500\u2500 Crosslink Mobile Framework Styles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-screen-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: #000000;
  color: #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-align: center;
  overflow-y: auto;
  -webkit-tap-highlight-color: transparent;
}
.cl-screen-overlay * {
  box-sizing: border-box;
}

/* \u2500\u2500 Crosslink Logo \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-crosslink-logo {
  width: 150px;
  height: auto;
  margin-bottom: 20px;
  display: block;
  opacity: 0.95;
}

/* \u2500\u2500 Screen A: Pairing Screen \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-pair-screen {
  background: #000000;
  gap: 20px;
}
.cl-pair-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: #ffffff;
}
.cl-pair-desc {
  font-size: 14px;
  color: #a1a1aa;
  max-width: 290px;
  line-height: 1.5;
  margin: 0;
}
.cl-pair-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  max-width: 260px;
  margin: 8px 0;
}
.cl-pair-digit {
  width: 72px;
  height: 64px;
  font-size: 26px;
  text-align: center;
  border-radius: 14px;
  border: 1px solid #27272a;
  background: #111111;
  color: #ffffff;
  font-weight: 700;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cl-pair-digit:focus {
  border-color: #ffffff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
}
.cl-pair-err {
  font-size: 13px;
  color: #f87171;
  min-height: 20px;
  margin: 0;
  line-height: 1.4;
  max-width: 280px;
}
.cl-pair-reset {
  margin-top: 12px;
  background: transparent;
  border: none;
  color: #71717a;
  font-size: 12px;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 6px;
  text-decoration: underline;
  transition: color 0.15s;
}
.cl-pair-reset:hover {
  color: #a1a1aa;
}

/* \u2500\u2500 Screen B: Add to Home Screen (Screen B) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-bootstrap-screen {
  background: #000000;
  justify-content: center;
  position: fixed;
  inset: 0;
  z-index: 100000;
  height: 100dvh;
}
.cl-bootstrap-appname {
  font-size: 21px;
  font-weight: 600;
  color: #ffffff;
  margin-top: 12px;
  letter-spacing: -0.01em;
}
.cl-continue-btn {
  margin-top: 20px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #ffffff;
  padding: 11px 24px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.cl-continue-btn:hover {
  background: rgba(255, 255, 255, 0.25);
}
.cl-bootstrap-nudge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(18px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  pointer-events: none;
}
.cl-bootstrap-nudge span {
  font-family: "Caveat", "Segoe Script", "Bradley Hand", cursive, sans-serif;
  font-size: 21px;
  color: #ffffff;
  opacity: 0.92;
  text-align: center;
  max-width: 280px;
  line-height: 1.2;
}
.cl-bootstrap-nudge svg {
  width: 46px;
  height: 46px;
  color: #ffffff;
  opacity: 0.92;
}

/* \u2500\u2500 SAS Modal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.cl-sas-modal {
  position: fixed;
  inset: 0;
  z-index: 100001;
  background: #000000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  gap: 14px;
  text-align: center;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, sans-serif;
}
.cl-sas-modal h2 { font-size: 18px; color: #fff; margin: 0; }
.cl-sas-modal p { color: #a1a1aa; font-size: 13px; margin: 0; }
.cl-sas-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: 100%;
  max-width: 240px;
  margin: 10px 0;
}
.cl-sas-grid span {
  display: grid;
  place-items: center;
  aspect-ratio: 1.5;
  background: #111111;
  border: 1px solid #27272a;
  border-radius: 10px;
  font-size: 24px;
  font-weight: 700;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
}
.cl-sas-caps { color: #a1a1aa; font-size: 12px; }
.cl-sas-actions { display: flex; gap: 12px; margin-top: 10px; }
.cl-sas-actions button {
  padding: 10px 22px;
  border-radius: 999px;
  border: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.cl-sas-ok { background: #ffffff; color: #000000; }
.cl-sas-no { background: #111111; color: #ffffff; border: 1px solid #27272a !important; }
`.trim();
var DEFAULT_SERVICE_WORKER_CONFIG = {
  version: "1.0.0",
  precacheAssets: [
    "./mobile.html",
    "./bundle.js",
    "./manifest.webmanifest",
    "./crosslink-mark.svg",
    "./icon-192.png",
    "./icon-512.png"
  ]
};
function generateServiceWorker(config = {}) {
  const version = config.version || DEFAULT_SERVICE_WORKER_CONFIG.version;
  const precacheAssets = config.precacheAssets || DEFAULT_SERVICE_WORKER_CONFIG.precacheAssets;
  const cacheName = `crosslink-shell-v${version}`;
  const assetsJson = JSON.stringify(precacheAssets, null, 2);
  return `/* Crosslink PWA Service Worker \u2014 Generated by Crosslink Framework */
const CACHE_NAME = "${cacheName}";
const PRECACHE_ASSETS = ${assetsJson};

// Endpoints and patterns that must NEVER be cached (security, credentials, active RPC/presence)
const NEVER_CACHE_PATTERNS = [
  "/api/",
  "/rpc/",
  "/ws",
  "/pair",
  "/verify-pair",
  "/challenge",
  "/session",
  "/revoke",
  "/events"
];

function isSecuritySensitive(url) {
  const path = url.pathname;
  return NEVER_CACHE_PATTERNS.some((pattern) => path.includes(pattern));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Robust asset caching: fetch individually so one missing asset doesn't abort entire install
      for (const asset of PRECACHE_ASSETS) {
        try {
          const res = await fetch(asset, { cache: "no-cache" });
          if (res.ok) {
            await cache.put(asset, res);
          }
        } catch (err) {
          console.warn("[Crosslink SW] Precache missed:", asset);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("crosslink-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Ignore cross-origin requests
  if (url.origin !== self.location.origin) return;

  // Never cache auth or API calls
  if (isSecuritySensitive(url)) {
    return;
  }

  // 1. Navigation requests: network-first with offline fallback to cached shell
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          // Host is offline: return cached shell
          const cached =
            (await caches.match(request, { ignoreSearch: true })) ||
            (await caches.match("./mobile.html", { ignoreSearch: true })) ||
            (await caches.match("/mobile.html", { ignoreSearch: true })) ||
            (await caches.match("/", { ignoreSearch: true }));
          if (cached) return cached;
          return new Response("Application is offline", {
            status: 503,
            statusText: "Offline",
            headers: { "Content-Type": "text/plain" }
          });
        })
    );
    return;
  }

  // 2. Static shell assets: cache-first with network fallback
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});
`;
}
var DEFAULT_SERVICE_WORKER = generateServiceWorker();

// src/main.ts
var REQUESTED_CAPS = ["files.read", "shell.exec"];
var ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
var $ = (id) => document.getElementById(id);
var ui = {
  uri: $("uri"),
  cmd: $("cmd"),
  pair: $("pair"),
  connect: $("connect"),
  upgrade: $("upgrade"),
  disconnect: $("disconnect"),
  list: $("list"),
  info: $("info"),
  run: $("run"),
  log: $("log"),
  state: $("badge-state"),
  transport: $("badge-transport"),
  storage: $("badge-storage")
};
function log(message, detail) {
  const line = detail === void 0 ? message : `${message} ${JSON.stringify(detail)}`;
  ui.log.textContent = `${(/* @__PURE__ */ new Date()).toLocaleTimeString()}  ${line}
${ui.log.textContent}`.slice(
    0,
    2e4
  );
}
var client = await CrosslinkClient.create({
  deviceName: navigator.userAgent.includes("Mobile") ? "Phone" : "Laptop",
  logger: consoleLogger({ level: "debug" }),
  requestTimeoutMs: 2e4,
  onStateChange: (state, detail) => {
    ui.state.textContent = state;
    ui.state.className = `badge ${state === "offline" || state === "revoked" ? "warn" : "on"}`;
    ui.transport.textContent = String(detail?.transport ?? client.connection?.transportKind ?? "\u2014");
    refreshButtons();
    log(`state: ${state}`, detail);
  },
  onConfirmPairing: (request2) => window.confirm(
    [
      `Pair with "${request2.hostName}"?`,
      "",
      `Confirm this code matches the host screen: ${request2.sas}`,
      `Capabilities granted: ${request2.grantedCaps.join(", ") || "(none)"}`
    ].join("\n")
  )
});
ui.storage.textContent = `storage: ${client.storageEncrypted ? "encrypted" : "plaintext"}`;
ui.storage.className = `badge ${client.storageEncrypted ? "on" : "warn"}`;
var paired = client.listApps();
if (paired.length > 0) {
  log(`already paired with ${paired[0].appName}`, { caps: paired[0].grantedCaps });
}
function refreshButtons() {
  const hasApp = client.listApps().length > 0;
  const online = client.state !== "offline" && client.state !== "revoked";
  const direct = client.connection?.transportKind === "webrtc-direct";
  ui.connect.disabled = !hasApp || online;
  ui.disconnect.disabled = !online;
  ui.upgrade.disabled = !online || direct;
  for (const button of [ui.list, ui.info, ui.run]) button.disabled = !online;
}
ui.pair.addEventListener("click", async () => {
  const uri = ui.uri.value.trim();
  if (!uri) return log("paste the pairing URI from the host terminal first");
  ui.pair.disabled = true;
  try {
    const record = await client.pairFromQr(uri, REQUESTED_CAPS);
    log(`paired with ${record.appName}`, { granted: record.grantedCaps });
    const trimmed = REQUESTED_CAPS.filter((c) => !record.grantedCaps.includes(c));
    if (trimmed.length > 0) log("host declined some capabilities", { trimmed });
  } catch (err) {
    log(`pairing failed: ${err.message}`);
  } finally {
    ui.pair.disabled = false;
    refreshButtons();
  }
});
ui.connect.addEventListener("click", async () => {
  try {
    await client.connect();
    log(`connected over ${client.connection?.transportKind}`);
  } catch (err) {
    log(`connect failed: ${err.message}`);
  }
  refreshButtons();
});
ui.upgrade.addEventListener("click", async () => {
  const link = client.connection;
  if (!link) return;
  ui.upgrade.disabled = true;
  log("negotiating a direct connection over the current session\u2026");
  const upgraded = await tryUpgradeToWebrtc(link, {
    createPeer: () => new RTCPeerConnection({ iceServers: ICE_SERVERS }),
    timeoutMs: 15e3
  });
  log(
    upgraded ? "upgraded \u2014 traffic is now peer-to-peer, the relay is idle" : "no direct path available; still connected through the relay"
  );
  refreshButtons();
});
ui.disconnect.addEventListener("click", () => {
  client.close();
  log("disconnected");
  refreshButtons();
});
ui.list.addEventListener("click", () => call("files.list"));
ui.info.addEventListener("click", () => call("link.info"));
ui.run.addEventListener("click", () => call("shell.run", { cmd: ui.cmd.value }));
async function call(method, input) {
  try {
    log(`\u2192 ${method}`, input);
    const result = await client.rpc().call(method, input);
    log(`\u2190 ${method}`, result);
  } catch (err) {
    const error = err;
    log(`\u2717 ${method}: ${error.code ?? "error"} \u2014 ${error.message}`);
  }
}
refreshButtons();
log("ready \u2014 paste a pairing URI to begin");
/*! Bundled license information:

@noble/ciphers/esm/utils.js:
  (*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) *)

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/utils.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/modular.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/curve.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/edwards.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/montgomery.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/ed25519.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
