/**
 * Authenticated ephemeral key exchange ("CLX1").
 *
 *   client                                          host
 *   ------                                          ----
 *   sinit{app, dev, sx_C, epk_C, ncC, ts,
 *         sigC = Sign_edC(H(T0))            ->
 *                                                   look up device record by dev,
 *                                                   verify sigC under RECORD's ed key
 *                                                   (key continuity - never the wire)
 *                                           <-      sack{epk_H, nh,
 *                                                 sigH = Sign_edH(H(T1))}
 *   verify sigH under TRUSTED host ed key
 *
 *   T0 = ["CLX1", appId, dev, b64(sx_C), b64(epk_C), b64(ncC), b64(ed_H), b64(x_H)]
 *   T1 = [...T0, b64(epk_H), b64(nh)]
 *   ikm  = X25519(eph, eph_peer) || X25519(static_x, static_x_peer)
 *   okm  = HKDF-SHA256(ikm, salt = ncC||nh, info="crosslink-session-keys-v1", 64)
 *   kC   = okm[0..32]    (client -> host traffic key)
 *   kH   = okm[32..64]   (host -> client traffic key)
 *
 * Fresh ephemerals every connect give forward secrecy; the static-static term
 * binds sessions to the paired identities; signatures over canonical
 * transcripts prevent MITM, cross-application relay and replay.
 */
import {
  CrosslinkError,
  ErrorCodes,
  Limits,
  base64ToBytes,
  bytesToBase64,
  canonicalJson,
  type SessionAcceptFrame,
  type SessionInitFrame
} from "@crosslink/protocol";
import {
  deriveOkm,
  diffieHellman,
  randomBytes,
  sha256Bytes,
  signBytes,
  verifySignature,
  x25519Public
} from "./crypto/primitives.js";
import { DEVICE_ID_PREFIX, type DeviceIdentity } from "./identity.js";
import type { TrafficKeys } from "./session-cipher.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

const DEVICE_ID_RE = /^cd1_[0-9a-f]{32}$/;

export const HANDSHAKE_VERSION = "CLX1";
const KEY_INFO = "crosslink-session-keys-v1";
const PQ_KEY_INFO = "crosslink-session-keys-v1+ml-kem-768";
export const HYBRID_PQ_SUITE = "ML-KEM-768" as const;
export type HybridPqMode = "disabled" | "preferred" | "required";

/** Peer's long-term public keys, always sourced from trusted records. */
export interface TrustedPeerPubs {
  pubEd: Uint8Array;
  pubX: Uint8Array;
}

export interface HandshakeContext {
  nowMs?: number;
  clockSkewMs?: number;
  /** `required` is fail-closed; host-side `preferred` also accepts legacy clients. */
  hybridPq?: HybridPqMode;
}

export interface ClientHandshakeState {
  ephPrivate: Uint8Array;
  nonceClient: Uint8Array;
  pqSecretKey?: Uint8Array;
  pqMode: HybridPqMode;
}

export interface HostHandshakeResult {
  accept: SessionAcceptFrame;
  keys: TrafficKeys;
  clientId: string;
}

function transcript(
  appId: string,
  dev: string,
  sxC: string,
  epkC: string,
  ncC: string,
  hostEdB64: string,
  hostXB64: string,
  epkH?: string,
  nh?: string,
  pqInit?: SessionInitFrame["pq"],
  pqAccept?: SessionAcceptFrame["pq"]
): Uint8Array {
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
  if (pqInit) parts.push("pq", pqInit.suite, pqInit.ek);
  if (epkH !== undefined && nh !== undefined) parts.push(epkH, nh);
  if (pqAccept) parts.push(pqAccept.suite, pqAccept.ct);
  return sha256Bytes(new TextEncoder().encode(canonicalJson(parts)));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/* --------------------------------- client ------------------------------ */

/**
 * Begins a session handshake. `host` MUST come from the persisted paired-app
 * record or freshly verified QR data - never from an untrusted wire source.
 */
export function clientBeginSession(
  identity: DeviceIdentity,
  host: { appId: string; pubEdB64: string; pubXB64: string },
  ctx: HandshakeContext = {}
): { init: SessionInitFrame; state: ClientHandshakeState } {
  const ephPrivate = randomBytes(32);
  const ephPublic = x25519Public(ephPrivate);
  const nonceClient = randomBytes(32);
  const pqMode = ctx.hybridPq ?? "disabled";
  const pqKeys = pqMode === "disabled" ? undefined : ml_kem768.keygen();
  const pq = pqKeys
    ? { suite: HYBRID_PQ_SUITE, ek: bytesToBase64(pqKeys.publicKey) }
    : undefined;

  const sig = signBytes(
    transcript(
      host.appId,
      identity.deviceId,
      bytesToBase64(identity.xPublicKey),
      bytesToBase64(ephPublic),
      bytesToBase64(nonceClient),
      host.pubEdB64,
      host.pubXB64,
      undefined,
      undefined,
      pq
    ),
    identity.edPrivateKey
  );

  const init: SessionInitFrame = {
    kind: "sinit",
    v: "1.0",
    app: host.appId,
    dev: identity.deviceId,
    sx: bytesToBase64(identity.xPublicKey),
    epk: bytesToBase64(ephPublic),
    nc: bytesToBase64(nonceClient),
    ts: ctx.nowMs ?? Date.now(),
    sig: bytesToBase64(sig),
    ...(pq ? { pq } : {})
  };

  return {
    init,
    state: {
      ephPrivate,
      nonceClient,
      pqMode,
      ...(pqKeys ? { pqSecretKey: pqKeys.secretKey } : {})
    }
  };
}

/** Completes the client side after receiving SessionAcceptFrame. */
export function clientCompleteSession(
  identity: DeviceIdentity,
  state: ClientHandshakeState,
  sentInit: SessionInitFrame,
  accept: SessionAcceptFrame,
  trustedHost: TrustedPeerPubs
): TrafficKeys {
  const epkH = base64ToBytes(accept.epk);
  const nh = base64ToBytes(accept.nh);
  if (epkH.length !== 32 || nh.length !== 32) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad accept key material lengths");
  }
  if (state.pqMode === "required" && !accept.pq) {
    throw new CrosslinkError(ErrorCodes.VERSION_UNSUPPORTED, "peer did not complete required hybrid PQ exchange");
  }
  if (Boolean(state.pqSecretKey) !== Boolean(accept.pq)) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "hybrid PQ negotiation does not match the offer");
  }
  if (accept.pq && accept.pq.suite !== HYBRID_PQ_SUITE) {
    throw new CrosslinkError(ErrorCodes.VERSION_UNSUPPORTED, "unsupported hybrid PQ suite");
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
    accept.nh,
    sentInit.pq,
    accept.pq
  );
  if (!verifySignature(base64ToBytes(accept.sig), transcriptHash, trustedHost.pubEd)) {
    throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "host handshake signature invalid");
  }

  const sharedE = diffieHellman(state.ephPrivate, epkH);
  const sharedS = diffieHellman(identity.xPrivateKey, trustedHost.pubX);
  let pqShared: Uint8Array | undefined;
  try {
    if (accept.pq && state.pqSecretKey) {
      const ciphertext = base64ToBytes(accept.pq.ct);
      if (ciphertext.length !== ml_kem768.lengths.cipherText) {
        throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad ML-KEM ciphertext length");
      }
      pqShared = ml_kem768.decapsulate(ciphertext, state.pqSecretKey);
    }
    const ikm = pqShared ? concat(concat(sharedE, sharedS), pqShared) : concat(sharedE, sharedS);
    const okm = deriveOkm(
      ikm,
      concat(state.nonceClient, nh),
      pqShared ? PQ_KEY_INFO : KEY_INFO,
      64
    );
    return { c2h: okm.slice(0, 32), h2c: okm.slice(32, 64) };
  } finally {
    state.pqSecretKey?.fill(0);
    pqShared?.fill(0);
  }
}

/* ---------------------------------- host ------------------------------- */

/**
 * Host-side completion. `clientPubEd` MUST come from the persisted device
 * record looked up by `init.dev` (key continuity) - never from the wire.
 */
export function hostCompleteSession(
  identity: DeviceIdentity,
  appId: string,
  clientPubEd: Uint8Array,
  init: SessionInitFrame,
  ctx: HandshakeContext = {}
): HostHandshakeResult {
  const now = ctx.nowMs ?? Date.now();
  const skew = ctx.clockSkewMs ?? Limits.CLOCK_SKEW_MS;
  if (typeof init.ts !== "number" || Math.abs(now - init.ts) > skew) {
    throw new CrosslinkError(ErrorCodes.SESSION_EXPIRED, "handshake timestamp outside skew");
  }
  if (init.app !== appId) {
    throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "handshake targets a different application");
  }
  const pqMode = ctx.hybridPq ?? "disabled";
  if (pqMode === "required" && !init.pq) {
    throw new CrosslinkError(ErrorCodes.VERSION_UNSUPPORTED, "hybrid PQ exchange is required");
  }
  if (init.pq && init.pq.suite !== HYBRID_PQ_SUITE) {
    throw new CrosslinkError(ErrorCodes.VERSION_UNSUPPORTED, "unsupported hybrid PQ suite");
  }
  if (init.pq && pqMode === "disabled") {
    throw new CrosslinkError(ErrorCodes.VERSION_UNSUPPORTED, "hybrid PQ exchange is disabled");
  }
  if (!DEVICE_ID_RE.test(init.dev)) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "device id malformed");
  }

  const sxC = base64ToBytes(init.sx);
  const epkC = base64ToBytes(init.epk);
  const ncC = base64ToBytes(init.nc);
  if (epkC.length !== 32 || ncC.length !== 32 || sxC.length !== 32) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad init key material lengths");
  }

  const hostEdB64 = bytesToBase64(identity.edPublicKey);
  const hostXB64 = bytesToBase64(identity.xPublicKey);

  const t0Hash = transcript(
    appId,
    init.dev,
    init.sx,
    init.epk,
    init.nc,
    hostEdB64,
    hostXB64,
    undefined,
    undefined,
    init.pq
  );
  if (!verifySignature(base64ToBytes(init.sig), t0Hash, clientPubEd)) {
    throw new CrosslinkError(ErrorCodes.UNAUTHORIZED, "client handshake signature invalid");
  }

  const ephPrivate = randomBytes(32);
  const ephPublic = x25519Public(ephPrivate);
  const nonceHost = randomBytes(32);
  let pqShared: Uint8Array | undefined;
  let pqAccept: SessionAcceptFrame["pq"] | undefined;
  if (init.pq) {
    const encapsulationKey = base64ToBytes(init.pq.ek);
    if (encapsulationKey.length !== ml_kem768.lengths.publicKey) {
      throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "bad ML-KEM encapsulation key length");
    }
    const encapsulated = ml_kem768.encapsulate(encapsulationKey);
    pqShared = encapsulated.sharedSecret;
    pqAccept = { suite: HYBRID_PQ_SUITE, ct: bytesToBase64(encapsulated.cipherText) };
  }

  const t1Hash = transcript(
    appId,
    init.dev,
    init.sx,
    init.epk,
    init.nc,
    hostEdB64,
    hostXB64,
    bytesToBase64(ephPublic),
    bytesToBase64(nonceHost),
    init.pq,
    pqAccept
  );
  const accept: SessionAcceptFrame = {
    kind: "sack",
    v: "1.0",
    epk: bytesToBase64(ephPublic),
    nh: bytesToBase64(nonceHost),
    sig: bytesToBase64(signBytes(t1Hash, identity.edPrivateKey)),
    ...(pqAccept ? { pq: pqAccept } : {})
  };

  const sharedE = diffieHellman(ephPrivate, epkC);
  const sharedS = diffieHellman(identity.xPrivateKey, sxC);
  const ikm = pqShared ? concat(concat(sharedE, sharedS), pqShared) : concat(sharedE, sharedS);
  const okm = deriveOkm(
    ikm,
    concat(ncC, nonceHost),
    pqShared ? PQ_KEY_INFO : KEY_INFO,
    64
  );
  pqShared?.fill(0);

  return {
    accept,
    keys: { c2h: okm.slice(0, 32), h2c: okm.slice(32, 64) },
    clientId: init.dev
  };
}
