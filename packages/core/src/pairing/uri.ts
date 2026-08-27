/**
 * Crosslink pairing URI (QR content).
 *
 *   crosslink://pair?v=1&s=<signaling http(s) url>&c=<9-digit code>&a=<appId>&n=<name>&f=<fp16>
 *
 * `f` carries the first 16 hex chars of sha256(hostIdentityPubEd) so clients
 * can pin the host identity before any network exchange. Plain https URLs
 * carrying the same parameters are accepted for camera deep-link fallbacks.
 */
import { base64ToBytes } from "@crosslink/protocol";
import { fingerprintFromPublicKey } from "./device-id.js";

export const PAIRING_URI_SCHEME = "crosslink://pair";

export interface ParsedPairingUri {
  signalingUrl: string;
  code: string;
  appId: string;
  appName: string;
  /** first 16 hex chars of host fingerprint */
  fp16: string;
}

/** First 16 hex chars of the host identity fingerprint (QR pin). */
export function fingerprint16(pubEdB64: string): string {
  return fingerprintFromPublicKey(base64ToBytes(pubEdB64)).slice(0, 16);
}

export function buildPairingUri(input: {
  signalingUrl: string;
  code: string;
  appId: string;
  appName: string;
  hostPubEdB64: string;
}): string {
  const params = new URLSearchParams({
    v: "1",
    s: input.signalingUrl,
    c: input.code.replace(/\s/g, ""),
    a: input.appId,
    n: input.appName,
    f: fingerprint16(input.hostPubEdB64)
  });
  return `${PAIRING_URI_SCHEME}?${params.toString()}`;
}

export function parsePairingUri(text: string): ParsedPairingUri {
  const trimmed = text.trim();
  let params: URLSearchParams;

  if (trimmed.startsWith(PAIRING_URI_SCHEME)) {
    params = new URLSearchParams(trimmed.slice(PAIRING_URI_SCHEME.length));
  } else if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    params =
      url.searchParams.get("c") !== null
        ? url.searchParams
        : new URLSearchParams(url.hash.replace(/^#/, ""));
  } else {
    throw new Error("not a crosslink pairing URI");
  }

  const version = params.get("v");
  const signalingUrl = params.get("s");
  const code = normalizeCode(params.get("c") ?? "");
  const appId = params.get("a");
  const appName = params.get("n") ?? appId ?? "";
  const fp16 = (params.get("f") ?? "").toLowerCase();

  if (version !== "1") throw new Error(`unsupported pairing uri version: ${String(version)}`);
  if (!signalingUrl || !/^https?:\/\//i.test(signalingUrl)) {
    throw new Error("pairing uri missing valid signaling url");
  }
  if (!/^\d{9}$/.test(code)) throw new Error("pairing uri missing 9-digit code");
  if (!appId || appId.length > 256 || !/^[\w.@:/-]+$/.test(appId)) {
    throw new Error("pairing uri missing valid app id");
  }
  if (!/^[0-9a-f]{16}$/.test(fp16)) throw new Error("pairing uri missing fingerprint");

  return { signalingUrl, code, appId, appName, fp16 };
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
