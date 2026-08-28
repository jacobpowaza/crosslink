/**
 * Thin wrappers over audited noble libraries so the rest of the codebase never
 * touches raw crypto APIs. No custom cryptography lives here — composition of
 * standard primitives only (see docs/security/overview.mdx).
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import { utf8ToBytes } from "@crosslink/protocol";

export { ed25519, x25519, hkdf, sha256 };

export function randomBytes(n: number): Uint8Array {
  return nobleRandomBytes(n);
}

export function sha256Bytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  return sha256(merged);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function deriveOkm(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8ToBytes(info), length);
}

/* ----------------------------- signatures ----------------------------- */

export function signBytes(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verifySignature(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/* --------------------------- key agreement ---------------------------- */

export function x25519Public(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/** Raw Diffie-Hellman shared secret; throws on all-zero output (low-order point). */
export function diffieHellman(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const secret = x25519.getSharedSecret(privateKey, publicKey);
  const zero = new Uint8Array(32);
  let acc = 0;
  for (let i = 0; i < 32; i++) acc |= secret[i] ^ zero[i];
  if (acc === 0) throw new Error("x25519: all-zero shared secret rejected");
  return secret;
}

/* ------------------------------- AEAD ---------------------------------- */

export function aeadSeal(
  key: Uint8Array,
  nonce24: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Uint8Array {
  return xchacha20poly1305(key, nonce24, aad).encrypt(plaintext);
}

/** Throws when authentication fails. */
export function aeadOpen(
  key: Uint8Array,
  nonce24: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Uint8Array {
  return xchacha20poly1305(key, nonce24, aad).decrypt(ciphertext);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}
