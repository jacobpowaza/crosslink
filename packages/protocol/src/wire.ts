/**
 * Outer wire shapes: the plaintext control vocabulary exchanged *before* an
 * encrypted session exists (handshake, pairing) plus the encrypted-frame
 * envelope itself, and the signaling/relay service protocols.
 *
 * All base64 fields are standard base64 unless suffixed `b64u` (base64url).
 * See docs/reference/protocol.mdx for byte-level details.
 */

/* ------------------------------------------------------------------ */
/* outer transport envelope                                            */
/* ------------------------------------------------------------------ */

export type OuterFrame =
  | SessionInitFrame
  | SessionAcceptFrame
  | SessionRejectFrame
  | EncryptedFrame
  | OuterPingFrame
  | OuterPongFrame
  | ByeFrame;

export interface SessionInitFrame {
  kind: "sinit";
  v: string;
  /** target application id — binds handshake to one app */
  app: string;
  /** client device id */
  dev: string;
  /** client static X25519 public key (base64) */
  sx: string;
  /** client ephemeral X25519 public key (base64) */
  epk: string;
  /** client nonce (base64, 32 bytes) */
  nc: string;
  ts: number;
  sig: string;
  /** Optional ephemeral ML-KEM encapsulation key, transcript-bound by sig. */
  pq?: { suite: "ML-KEM-768"; ek: string };
}

export interface SessionAcceptFrame {
  kind: "sack";
  v: string;
  epk: string;
  nh: string;
  sig: string;
  /** Ciphertext for the client's ephemeral ML-KEM key. */
  pq?: { suite: "ML-KEM-768"; ct: string };
}

export interface SessionRejectFrame {
  kind: "srej";
  code: string;
  message: string;
}

export interface EncryptedFrame {
  kind: "enc";
  /** monotonic per-direction counter starting at 1; strictly increasing */
  n: number;
  /** random 24-byte XChaCha nonce (base64) */
  iv: string;
  /** ciphertext+tag (base64) */
  ct: string;
}

export interface OuterPingFrame {
  kind: "oping";
  ts: number;
}

export interface OuterPongFrame {
  kind: "opong";
  ts: number;
}

export interface ByeFrame {
  kind: "bye";
  code?: string;
  reason?: string;
}

export function isOuterKind(value: unknown): value is OuterFrame["kind"] {
  return (
    value === "sinit" ||
    value === "sack" ||
    value === "srej" ||
    value === "enc" ||
    value === "oping" ||
    value === "opong" ||
    value === "bye"
  );
}

export const OUTER_KINDS = isOuterKind;

/* ------------------------------------------------------------------ */
/* pairing frames (end-to-end signed; routed as opaque blobs)          */
/* ------------------------------------------------------------------ */

export interface PairClaimFrame {
  ps: string;
  dev: string;
  name: string;
  pub_ed: string;
  pub_x: string;
  nonce: string;
  caps_req?: string[];
  sig: string;
}

export interface PairChallengeFrame {
  ps: string;
  claim_nonce: string;
  host_pub_ed: string;
  host_pub_x: string;
  nonce: string;
  granted_caps: string[];
  link?: true;
  sig: string;
}

export interface PairCompleteFrame {
  ps: string;
  claim_nonce: string;
  challenge_nonce: string;
  sig: string;
}

export interface PairDoneFrame {
  ps: string;
  relay?: { url: string; channel: string };
  lan?: { host: string; port: number };
}

export interface PairErrorFrame {
  error: { code: string; message: string };
}
