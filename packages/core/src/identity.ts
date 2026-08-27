/**
 * Device / application-installation identity.
 *
 * One identity per *application installation*: two Crosslink apps on the same
 * computer never share keys. The 32-byte seed is the only secret; everything
 * else derives deterministically:
 *
 *   ed25519 signing key   <- seed directly
 *   x25519 agreement key  <- HKDF-SHA256(seed, info="crosslink-x25519-v1")
 */
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
} from "@crosslink/protocol";
import {
  deriveOkm,
  ed25519,
  randomBytes,
  sha256Bytes,
  signBytes,
  verifySignature,
  x25519Public,
} from "./crypto/primitives.js";

export const DEVICE_ID_PREFIX = "cd1_";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export class DeviceIdentity {
  private _xPriv?: Uint8Array;
  private _edPub?: Uint8Array;
  private _xPub?: Uint8Array;

  private constructor(readonly seed: Uint8Array) {
    if (seed.length !== 32) throw new TypeError("identity seed must be 32 bytes");
  }

  static create(): DeviceIdentity {
    return new DeviceIdentity(randomBytes(32));
  }

  static fromSeed(seed: Uint8Array): DeviceIdentity {
    return new DeviceIdentity(seed);
  }

  get edPrivateKey(): Uint8Array {
    return this.seed;
  }

  get edPublicKey(): Uint8Array {
    if (!this._edPub) this._edPub = ed25519.getPublicKey(this.seed);
    return this._edPub;
  }

  get xPrivateKey(): Uint8Array {
    if (!this._xPriv) {
      this._xPriv = deriveOkm(this.seed, new Uint8Array(0), "crosslink-x25519-v1", 32);
    }
    return this._xPriv;
  }

  get xPublicKey(): Uint8Array {
    if (!this._xPub) this._xPub = x25519Public(this.xPrivateKey);
    return this._xPub;
  }

  /** Stable device identifier derived from the signing public key. */
  get deviceId(): string {
    const digest = sha256Bytes(utf8("deviceId"), this.edPublicKey);
    return DEVICE_ID_PREFIX + bytesToHex(digest).slice(0, 32);
  }

  /** Full hex fingerprint of the identity public key (compared by users/UIs). */
  get fingerprint(): string {
    return bytesToHex(sha256Bytes(utf8("fingerprint"), this.edPublicKey));
  }

  sign(message: Uint8Array): Uint8Array {
    return signBytes(message, this.edPrivateKey);
  }

  verifyOwn(signature: Uint8Array, message: Uint8Array): boolean {
    return verifySignature(signature, message, this.edPublicKey);
  }

  toJson(): { v: 1; seed_b64: string } {
    return { v: 1, seed_b64: bytesToBase64(this.seed) };
  }

  static fromJson(json: { v?: number; seed_b64?: string }): DeviceIdentity {
    if (!json || json.v !== 1 || typeof json.seed_b64 !== "string") {
      throw new TypeError("invalid identity json");
    }
    return DeviceIdentity.fromSeed(base64ToBytes(json.seed_b64));
  }

  static import(seedHex: string): DeviceIdentity {
    return DeviceIdentity.fromSeed(hexToBytes(seedHex));
  }
}
