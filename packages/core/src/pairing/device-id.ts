import { sha256 } from "../crypto/primitives.js";
import { DEVICE_ID_PREFIX } from "../identity.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Derives the stable device id from an Ed25519 public key. MUST stay in sync
 * with DeviceIdentity.deviceId.
 */
export function deviceIdFromPublicKey(pubEd: Uint8Array): string {
  const digest = sha256(concatBytes(utf8("deviceId"), pubEd));
  return DEVICE_ID_PREFIX + toHex(digest).slice(0, 32);
}

export function fingerprintFromPublicKey(pubEd: Uint8Array): string {
  return toHex(sha256(concatBytes(utf8("fingerprint"), pubEd)));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  }
  return out;
}
