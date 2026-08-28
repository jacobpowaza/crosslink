/**
 * Crosslink pairing URI (QR content) — the single canonical pairing payload.
 *
 *   crosslink://pair?v=2&e=<endpoints>&c=<9-digit code>&a=<appId>&n=<name>&f=<fp16>
 *
 * `e` is the endpoint list (see `endpoints.ts`): every route the host actually
 * has, in preference order. `f` carries the first 16 hex chars of
 * sha256(hostIdentityPubEd) so a client pins the host identity before any
 * network exchange. Plain https URLs carrying the same parameters are accepted
 * for camera deep-link fallbacks.
 *
 * v1 payloads carried a single mandatory `s=<signaling url>` instead. They are
 * still parsed — an installed PWA may hold an old link — but never emitted.
 * Nothing outside this module may build or parse a pairing URI.
 */
import { base64ToBytes } from "@crosslink/protocol";
import { fingerprintFromPublicKey } from "./device-id.js";
import {
  decodeEndpoints,
  encodeEndpoints,
  filterEndpoints,
  isValidEndpointUrl,
  type PairingEndpoint
} from "./endpoints.js";

export const PAIRING_URI_SCHEME = "crosslink://pair";
export const PAIRING_URI_VERSION = 2;

export interface ParsedPairingUri {
  version: number;
  /** Every route the host advertised, already in attempt order. */
  endpoints: PairingEndpoint[];
  code: string;
  appId: string;
  appName: string;
  /** first 16 hex chars of host fingerprint */
  fp16: string;
  /** Transport the host wants used: auto | lan | remote | relay | webrtc. */
  transport?: string;
  /**
   * First signaling/relay endpoint, for the code-resolution step that still
   * requires a rendezvous service. Undefined for a LAN- or WAN-direct payload.
   */
  signalingUrl?: string;
  /**
   * Marks this as a device-link continuation URI rather than a normal
   * human-witnessed pairing: `code` is an opaque single-use token (not a
   * 9-digit code), and the client completes it silently, skipping the SAS
   * confirmation prompt, since trust was already established elsewhere.
   */
  link?: boolean;
}

export interface BuildPairingUriInput {
  endpoints: readonly PairingEndpoint[];
  code?: string;
  appId: string;
  appName: string;
  hostPubEdB64: string;
  transport?: string;
  /** See `ParsedPairingUri.link`. */
  link?: boolean;
}

/** First 16 hex chars of the host identity fingerprint (QR pin). */
export function fingerprint16(pubEdB64: string): string {
  return fingerprintFromPublicKey(base64ToBytes(pubEdB64)).slice(0, 16);
}

/**
 * Builds the canonical v2 pairing URI.
 *
 * Throws when `endpoints` is empty. A pairing URI with no route is not a
 * degraded payload that a client might still salvage — it is unusable, and
 * emitting one moves the failure from the host (where the reason is known and
 * can be reported) to the phone (where it cannot).
 */
export function buildPairingUri(input: BuildPairingUriInput): string {
  const usable = input.endpoints.filter((e) => isValidEndpointUrl(e.url, e.kind));
  if (usable.length === 0) {
    throw new Error(
      "cannot build a pairing URI: the host has no reachable endpoint. " +
        "Enable LAN, configure a signaling/relay service, or enable remote access."
    );
  }
  const cleanCode = (input.code ?? "").replace(/\s/g, "");
  const params = new URLSearchParams({
    v: String(PAIRING_URI_VERSION),
    e: encodeEndpoints(usable),
    ...(cleanCode ? { c: cleanCode } : {}),
    a: input.appId,
    n: input.appName,
    f: fingerprint16(input.hostPubEdB64),
    ...(input.transport ? { t: input.transport } : {}),
    ...(input.link ? { l: "1" } : {})
  });
  return `${PAIRING_URI_SCHEME}?${params.toString()}`;
}

/**
 * Removes session credentials and link intent from a pairing target while
 * retaining its public routing metadata and pinned host fingerprint. Manual
 * 9-digit-code pairing must always use this shape so stale `l=1` state cannot
 * select the silent device-link protocol.
 */
export function normalPairingTarget(text: string): string {
  const parsed = parsePairingUri(unwrapBootstrapUri(text));
  const params = new URLSearchParams({
    v: String(PAIRING_URI_VERSION),
    e: encodeEndpoints(parsed.endpoints),
    a: parsed.appId,
    n: parsed.appName,
    f: parsed.fp16,
    ...(parsed.transport ? { t: parsed.transport } : {})
  });
  return `${PAIRING_URI_SCHEME}?${params.toString()}`;
}

/** Builds a link URI from a credential-free public target plus an opaque handoff id. */
export function linkPairingTarget(text: string, handoffId: string): string {
  const target = normalPairingTarget(text);
  const params = new URLSearchParams(target.slice(PAIRING_URI_SCHEME.length).replace(/^\?/, ""));
  params.set("c", handoffId);
  params.set("l", "1");
  return `${PAIRING_URI_SCHEME}?${params.toString()}`;
}

export function parsePairingUri(text: string): ParsedPairingUri {
  const params = paramsFrom(text.trim());

  const version = Number(params.get("v"));
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported pairing uri version: ${String(params.get("v"))}`);
  }

  const endpoints = readEndpoints(params, version);
  const rawCode = params.get("c");
  const link = params.get("l") === "1";
  // Opaque install handoff ids may coincidentally contain exactly nine digits.
  // Normalizing before checking link mode would then strip the rest of the
  // token and make otherwise valid handoffs fail nondeterministically.
  const code = rawCode ? (link ? rawCode.trim() : normalizeCode(rawCode)) : "";
  const appId = params.get("a");
  const appName = params.get("n") ?? appId ?? "";
  const fp16 = (params.get("f") ?? "").toLowerCase();
  const transport = params.get("t") ?? undefined;

  if (endpoints.length === 0) {
    throw new Error(
      "pairing uri advertises no usable endpoint " +
        "(expected e=lan~ws://… / wan~ws://… / sig~wss://…)"
    );
  }
  if (!appId || appId.length > 256 || !/^[\w.@:/-]+$/.test(appId)) {
    throw new Error("pairing uri missing valid app id");
  }
  if (!/^[0-9a-f]{16}$/.test(fp16)) throw new Error("pairing uri missing fingerprint");

  const brokered = filterEndpoints(endpoints, ["sig", "relay", "tunnel"]);
  return {
    version,
    endpoints,
    code,
    appId,
    appName,
    fp16,
    transport,
    signalingUrl: brokered[0]?.url,
    link
  };
}

function paramsFrom(trimmed: string): URLSearchParams {
  if (trimmed.startsWith(PAIRING_URI_SCHEME)) {
    return new URLSearchParams(trimmed.slice(PAIRING_URI_SCHEME.length).replace(/^\?/, ""));
  }
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("not a crosslink pairing URI");
  const url = new URL(trimmed);
  const hasQueryPayload = ["c", "e", "s", "a"].some((k) => url.searchParams.get(k) !== null);
  return hasQueryPayload ? url.searchParams : new URLSearchParams(url.hash.replace(/^#/, ""));
}

/**
 * v2 reads `e`; v1 is upgraded in place by treating its single `s` as one
 * brokered endpoint, so every consumer downstream sees the same shape.
 */
function readEndpoints(params: URLSearchParams, version: number): PairingEndpoint[] {
  if (version === 2) return decodeEndpoints(params.get("e") ?? "");
  const legacy = params.get("s") ?? "";
  return isValidEndpointUrl(legacy, "sig") ? [{ kind: "sig", url: legacy }] : [];
}

/** Accepts "483921004", "483 921 004", "483-921-004". */
export function normalizeCode(input: string): string {
  const digits = input.replace(/\D/g, "");
  return digits.length === 9 ? digits : input.trim();
}

export const BOOTSTRAP_FRAGMENT_KEY = "pair";

/**
 * Recovers the manifest pairing URI from a hosted bootstrap URL, or returns
 * the input unchanged if it is already a manifest URI (raw `crosslink://` or a
 * bare `https://…?c=…`/`…#pair=…`). A phone's camera produces the hosted link;
 * an in-app scanner produces the scheme. Both should land in `pairFromQr`.
 */
export function unwrapBootstrapUri(text: string): string {
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
    // The payload may itself be URL-encoded; decode once here so callers
    // always receive a manifest URI, not yet another wrapper.
    if (embedded) return decodeEmojiSafe(embedded);
  } catch {
    /* not a URL — treat as a raw manifest URI */
  }
  return trimmed;
}

function decodeEmojiSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
