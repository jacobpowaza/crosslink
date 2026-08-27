/**
 * Short-lived session tokens and challenge/response for trusted pairing.
 *
 * After pairing, the host issues a signed session token containing:
 *   - host fingerprint (to bind to the specific host/app)
 *   - deviceId
 *   - appId
 *   - expiration time
 *
 * On future connections, the mobile sends this token. The server verifies
 * the signature (using the host identity key) and checks expiration.
 */
import { ed25519, sha256Bytes, randomBytes } from "../crypto/primitives.js";
import { utf8ToBytes, bytesToBase64, base64ToBytes } from "@crosslink/protocol";

export interface SessionTokenPayload {
  hostFp: string; // full hex fingerprint of host ed25519 pub
  appId: string;
  deviceId: string;
  exp: number; // epoch ms
  nonce: string; // anti-replay nonce (optional extra check)
}

/** Creates a signed session token. `hostPrivateKey` is the host ed25519 seed. */
export function createSessionToken(
  payload: SessionTokenPayload,
  hostPrivateKey: Uint8Array
): string {
  const payloadStr = JSON.stringify(payload);
  const payloadBytes = utf8ToBytes(payloadStr);
  const sig = ed25519.sign(payloadBytes, hostPrivateKey);
  const tokenObj = {
    payload: payloadStr,
    sig: bytesToBase64(sig),
  };
  return bytesToBase64(utf8ToBytes(JSON.stringify(tokenObj)));
}

/** Verifies a session token signature and returns parsed payload, or null if invalid/expired. */
export function verifySessionToken(
  tokenB64: string,
  hostPublicKey: Uint8Array
): SessionTokenPayload | null {
  try {
    const tokenStr = new TextDecoder().decode(base64ToBytes(tokenB64));
    const tokenObj = JSON.parse(tokenStr);
    const payloadStr: string = tokenObj.payload;
    const sigB64: string = tokenObj.sig;
    if (!payloadStr || !sigB64) return null;
    const payload = JSON.parse(payloadStr) as SessionTokenPayload;
    const payloadBytes = utf8ToBytes(payloadStr);
    const sigBytes = base64ToBytes(sigB64);
    const ok = ed25519.verify(sigBytes, payloadBytes, hostPublicKey);
    if (!ok) return null;
    if (payload.exp < Date.now()) return null; // expired
    return payload;
  } catch {
    return null;
  }
}

/** Generates a random challenge nonce (base64). */
export function generateChallengeNonce(): string {
  return bytesToBase64(randomBytes(32));
}
