/**
 * Connection endpoints advertised in a pairing payload.
 *
 * A host is reachable by several routes at once — its LAN address, a
 * router-mapped public address, a signaling/relay service, an explicitly
 * configured tunnel — and which of those a given phone can actually use is not
 * knowable at QR-generation time. So the QR carries every candidate the host
 * genuinely has, tagged by kind, and the client picks.
 *
 * This is the single source of truth for how endpoints are encoded. Nothing
 * else in the codebase may construct or parse an endpoint string.
 */

/**
 * - `lan`     private-network address. Only works on the same network.
 * - `wan`     public address with a confirmed inbound router mapping.
 * - `sig`     signaling/rendezvous service that brokers a connection.
 * - `relay`   relay service that forwards encrypted frames.
 * - `tunnel`  provider tunnel (ngrok, Cloudflare, …) the developer opted into.
 */
export const ENDPOINT_KINDS = ["lan", "wan", "sig", "relay", "tunnel"] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

export interface PairingEndpoint {
  kind: EndpointKind;
  /** Absolute ws:// wss:// http:// or https:// URL. */
  url: string;
}

/**
 * Order the client attempts endpoints in.
 *
 * LAN first because a same-network connection is faster, private, and costs no
 * third party anything. `wan` next because a direct public route still avoids a
 * relay. Service-brokered routes last, cheapest-to-operate first.
 */
export const ENDPOINT_PREFERENCE: readonly EndpointKind[] = ["lan", "wan", "sig", "relay", "tunnel"];

/**
 * Kinds whose URL names the host machine itself, rather than a service that
 * brokers a connection to it.
 *
 * The distinction matters for loopback: `lan~ws://127.0.0.1` names the *phone*
 * once the QR is scanned, so it is never a route anyone can take. But
 * `sig~ws://127.0.0.1` is a service address, and a developer running the
 * signaling stack on the same machine — or an in-process test — is a supported
 * configuration.
 */
export const HOST_DIRECT_KINDS: readonly EndpointKind[] = ["lan", "wan"];

export function isHostDirectKind(kind: EndpointKind): boolean {
  return HOST_DIRECT_KINDS.includes(kind);
}

const KIND_SEPARATOR = "~";
const LIST_SEPARATOR = ",";
const MAX_ENDPOINTS = 8;
const MAX_URL_LENGTH = 512;

/** Sorts endpoints into the canonical attempt order, stably. */
export function sortEndpoints(endpoints: readonly PairingEndpoint[]): PairingEndpoint[] {
  return [...endpoints].sort(
    (a, b) => ENDPOINT_PREFERENCE.indexOf(a.kind) - ENDPOINT_PREFERENCE.indexOf(b.kind)
  );
}

export function filterEndpoints(
  endpoints: readonly PairingEndpoint[],
  kinds: readonly EndpointKind[]
): PairingEndpoint[] {
  return endpoints.filter((e) => kinds.includes(e.kind));
}

/**
 * Encodes endpoints for the `e` query parameter as `kind~url,kind~url`.
 *
 * Deliberately not JSON+base64: a QR code's capacity is limited and its error
 * correction degrades with length, so the shortest encoding that survives
 * `URLSearchParams` percent-encoding wins.
 */
export function encodeEndpoints(endpoints: readonly PairingEndpoint[]): string {
  return sortEndpoints(dedupe(endpoints))
    .slice(0, MAX_ENDPOINTS)
    .map((e) => `${e.kind}${KIND_SEPARATOR}${e.url}`)
    .join(LIST_SEPARATOR);
}

/**
 * Parses the `e` parameter. Unknown kinds and malformed URLs are dropped rather
 * than throwing: a newer host may advertise a transport this client does not
 * understand, and that must not make an otherwise-usable QR unscannable.
 */
export function decodeEndpoints(encoded: string): PairingEndpoint[] {
  const out: PairingEndpoint[] = [];
  for (const entry of encoded.split(LIST_SEPARATOR)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(KIND_SEPARATOR);
    if (idx <= 0) continue;
    const kind = trimmed.slice(0, idx) as EndpointKind;
    const url = trimmed.slice(idx + 1);
    if (!ENDPOINT_KINDS.includes(kind)) continue;
    if (!isValidEndpointUrl(url, kind)) continue;
    out.push({ kind, url });
    if (out.length >= MAX_ENDPOINTS) break;
  }
  return sortEndpoints(dedupe(out));
}

/**
 * Shape check, plus — when the kind is given and names the host directly — a
 * rejection of loopback addresses. Advertising `lan~ws://127.0.0.1` produces a
 * QR that scans, resolves, and then fails to connect for reasons no error
 * message can explain, because on the phone that address is the phone.
 */
export function isValidEndpointUrl(url: string, kind?: EndpointKind): boolean {
  if (!url || url.length > MAX_URL_LENGTH) return false;
  if (!/^(wss?|https?):\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return false;
    if (kind && isHostDirectKind(kind) && isLoopbackHost(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** True for addresses that only ever refer to the machine doing the asking. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host === "0.0.0.0") return true;
  return /^127\./.test(host);
}

/** ws:// for http://, wss:// for https://; already-ws URLs pass through. */
export function toWebSocketUrl(url: string): string {
  return url.replace(/^http(s?):\/\//i, "ws$1://");
}

/** http:// for ws://, https:// for wss://; already-http URLs pass through. */
export function toHttpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//i, "http$1://");
}

function dedupe(endpoints: readonly PairingEndpoint[]): PairingEndpoint[] {
  const seen = new Set<string>();
  const out: PairingEndpoint[] = [];
  for (const e of endpoints) {
    const key = `${e.kind}${KIND_SEPARATOR}${e.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
