/**
 * Device cryptographic identity for persistent trusted pairing.
 *
 * Each browser/phone generates a persistent Ed25519 + X25519 keypair.
 * The private key stays in secure storage (IndexedDB encrypted or
 * non-exportable WebCrypto where available). The public keys are shared
 * during pairing and stored by the host in a TrustedDeviceRecord.
 *
 * On future connections the host sends a random challenge nonce; the
 * device signs it with edPrivateKey; the host verifies against pubEd.
 */
import { ed25519, x25519, randomBytes, sha256Bytes, deriveOkm } from "../crypto/primitives.js";
import { utf8ToBytes, bytesToBase64, base64ToBytes } from "@crosslink/protocol";
import { sha256 } from "../crypto/primitives.js";

export interface DeviceCryptoKeypair {
  deviceId: string; // derived from edPublicKey (same derivation as DeviceIdentity)
  edPrivateKey: Uint8Array;
  edPublicKey: Uint8Array;
  xPrivateKey: Uint8Array;
  xPublicKey: Uint8Array;
}

/** Creates a new device keypair from a random 32-byte seed. */
export function createDeviceCryptoKeypair(): DeviceCryptoKeypair {
  const seed = randomBytes(32);
  const edPriv = seed;
  const edPub = ed25519.getPublicKey(edPriv);
  const xPriv = deriveOkm(edPriv, new Uint8Array(0), "crosslink-x25519-v1-device", 32);
  const xPub = x25519.getPublicKey(xPriv);

  // Derive deviceId same way as DeviceIdentity: sha256("deviceId" + edPub) truncated
  const digest = sha256Bytes(utf8ToBytes("deviceId"), edPub);
  const hexDigest = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  const deviceId = "cd1_" + hexDigest.slice(0, 32);

  return {
    deviceId,
    edPrivateKey: edPriv,
    edPublicKey: edPub,
    xPrivateKey: xPriv,
    xPublicKey: xPub,
  };
}

/** Restores a keypair from a stored seed (base64). */
export function restoreDeviceCryptoKeypair(seedB64: string): DeviceCryptoKeypair {
  const seed = base64ToBytes(seedB64);
  if (seed.length !== 32) throw new Error("invalid device keypair seed length");
  const edPriv = seed;
  const edPub = ed25519.getPublicKey(edPriv);
  const xPriv = deriveOkm(edPriv, new Uint8Array(0), "crosslink-x25519-v1-device", 32);
  const xPub = x25519.getPublicKey(xPriv);

  const digest = sha256Bytes(utf8ToBytes("deviceId"), edPub);
  const hexDigest = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  const deviceId = "cd1_" + hexDigest.slice(0, 32);

  return {
    deviceId,
    edPrivateKey: edPriv,
    edPublicKey: edPub,
    xPrivateKey: xPriv,
    xPublicKey: xPub,
  };
}

/** Serialize keypair seed for secure storage. */
export function serializeDeviceKeypair(keypair: DeviceCryptoKeypair): string {
  return bytesToBase64(keypair.edPrivateKey);
}

/** Sign a challenge nonce with the device's ed25519 private key. */
export function signDeviceChallenge(
  keypair: DeviceCryptoKeypair,
  nonce: string
): string {
  const msg = utf8ToBytes(nonce);
  const sig = ed25519.sign(msg, keypair.edPrivateKey);
  return bytesToBase64(sig);
}

/** Verify a device challenge signature against a stored public key. */
export function verifyDeviceChallenge(
  pubEd: Uint8Array,
  nonce: string,
  signatureB64: string
): boolean {
  try {
    return ed25519.verify(base64ToBytes(signatureB64), utf8ToBytes(nonce), pubEd);
  } catch {
    return false;
  }
}
