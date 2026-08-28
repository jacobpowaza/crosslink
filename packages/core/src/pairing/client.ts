/**
 * Client-side pairing flow: build a claim, verify the host challenge against
 * the QR-pinned fingerprint, confirm via SAS, and produce a PairedAppRecord.
 */
import {
  CrosslinkError,
  ErrorCodes,
  base64ToBytes,
  bytesToBase64,
} from "@crosslink/protocol";
import { randomBytes, sha256Bytes, verifySignature } from "../crypto/primitives.js";
import type { DeviceIdentity } from "../identity.js";
import { shortAuthString } from "../sas.js";
import {
  pairingTranscriptBytes,
  type PairedAppRecord,
} from "./types.js";
import { fingerprintFromPublicKey } from "./device-id.js";
import type { ParsedPairingUri } from "./uri.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export interface ClientPairingState {
  claimNonce: string;
}

export interface ClientPairingConfirmRequest {
  sas: string;
  hostName: string;
  hostFp16: string;
  grantedCaps: string[];
  /** True only when the host signed that the resolved live session is a link handoff. */
  link: boolean;
}

/** Builds the signed pair_claim frame for a fresh pairing attempt. */
export function createClaim(
  identity: DeviceIdentity,
  qr: ParsedPairingUri,
  deviceName: string,
  requestedCaps?: string[]
): { claim: Record<string, unknown>; state: ClientPairingState } {
  const claimNonce = bytesToBase64(randomBytes(32));
  const psidPlaceholder = ""; // filled by signaling layer that knows the resolved psid

  const claim = {
    kind: "pair_claim",
    ps: psidPlaceholder,
    dev: identity.deviceId,
    name: deviceName.slice(0, 64),
    pub_ed: bytesToBase64(identity.edPublicKey),
    pub_x: bytesToBase64(identity.xPublicKey),
    nonce: claimNonce,
    ...(requestedCaps && requestedCaps.length > 0 ? { caps_req: requestedCaps } : {})
  };

  return { claim, state: { claimNonce } };
}

/** Signs a claim (psid known only after code resolution). */
export function signClaim(identity: DeviceIdentity, claim: Record<string, unknown>, psid: string): void {
  const transcript = pairingTranscriptBytes("claim", [
    psid,
    String(claim.dev),
    String(claim.name),
    String(claim.pub_ed),
    String(claim.pub_x),
    String(claim.nonce),
    Array.isArray(claim.caps_req) ? claim.caps_req : null
  ]);
  (claim as Record<string, unknown>).ps = psid;
  (claim as Record<string, unknown>).sig = bytesToBase64(identity.sign(transcript));
}

/**
 * Verifies pair_challenge:
 *  1. challenge sig under the host key whose fingerprint matches the QR pin
 *  2. challenge_nonce echoes our claim nonce (session binding / anti-replay)
 * Then asks the user to confirm the SAS and returns the completion frame +
 * paired-app record.
 */
export async function processChallenge(
  identity: DeviceIdentity,
  qr: ParsedPairingUri,
  state: ClientPairingState,
  challenge: Record<string, unknown>,
  confirm: (req: ClientPairingConfirmRequest) => boolean | Promise<boolean>
): Promise<{ complete: Record<string, unknown>; record: PairedAppRecord }> {
  if (challenge.kind !== "pair_challenge") {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "expected pair_challenge frame");
  }
  const hostPubEdB64 = String(challenge.host_pub_ed ?? "");
  const hostPubXB64 = String(challenge.host_pub_x ?? "");
  const challengeNonce = String(challenge.nonce ?? "");
  const grantedCaps = Array.isArray(challenge.granted_caps) ? challenge.granted_caps.map(String) : [];
  const hostConfirmedLink = challenge.link === true;

  if (hostConfirmedLink !== (qr.link === true)) {
    throw new CrosslinkError(
      ErrorCodes.PAIRING_INVALID,
      "pairing URI mode does not match the host session"
    );
  }

  const fp = fingerprintFromPublicKey(base64ToBytes(hostPubEdB64));
  if (!fp.startsWith(qr.fp16)) {
    throw new CrosslinkError(
      ErrorCodes.UNAUTHORIZED,
      "host identity does not match the scanned QR fingerprint"
    );
  }

  const transcriptFields: unknown[] = [
    String(challenge.ps ?? ""),
    state.claimNonce,
    hostPubEdB64,
    hostPubXB64,
    challengeNonce,
    grantedCaps
  ];
  // Normal v1/v2 pairing keeps its established transcript for compatibility.
  // Link mode appends a signed discriminator so `l=1` in an untrusted URL is
  // never sufficient on its own to suppress SAS confirmation.
  if (hostConfirmedLink) transcriptFields.push(true);
  const transcript = pairingTranscriptBytes("challenge", transcriptFields);
  const sigOk = verifySignature(
    base64ToBytes(String(challenge.sig ?? "")),
    transcript,
    base64ToBytes(hostPubEdB64)
  );
  if (!sigOk) {
    throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "host challenge signature invalid");
  }
  if (String(challenge.claim_nonce ?? "") !== state.claimNonce) {
    throw new CrosslinkError(ErrorCodes.PAIRING_INVALID, "challenge does not match our claim");
  }

  // SAS from the now-verified pubs; both devices must display identical codes.
  const sas = shortAuthString(
    qr.appId,
    identity.edPublicKey,
    base64ToBytes(hostPubEdB64)
  );
  const approved = await confirm({
    sas,
    hostName: qr.appName,
    hostFp16: qr.fp16,
    grantedCaps,
    link: hostConfirmedLink
  });
  if (!approved) {
    throw new CrosslinkError(ErrorCodes.PAIRING_INVALID, "pairing cancelled by client user");
  }

  const completeSig = bytesToBase64(
    identity.sign(pairingTranscriptBytes("complete", [String(challenge.ps), state.claimNonce, challengeNonce]))
  );

  const record: PairedAppRecord = {
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

function fpFull(pubEdB64: string): string {
  return bytesToHex(sha256Bytes(utf8("fingerprint"), base64ToBytes(pubEdB64)));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  }
  return out;
}
