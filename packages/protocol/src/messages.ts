/**
 * Crosslink application-layer messages (inside an established encrypted
 * session). One JSON object per frame. See docs/reference/protocol.mdx.
 */
import { ALL_ERROR_CODES, ErrorCodes } from "./errors.js";
import type { Json } from "./json.js";

export const PROTOCOL = "crosslink";

/** All message types. */
export const MessageTypes = {
  HELLO: "hello",
  HELLO_OK: "hello_ok",
  REQ: "req",
  RES: "res",
  ERR: "err",
  CHUNK: "chunk",
  END: "end",
  EVT: "evt",
  SUB: "sub",
  UNSUB: "unsub",
  CANCEL: "cancel",
  PING: "ping",
  PONG: "pong",
  BYE: "bye"
} as const;

export type MessageType = (typeof MessageTypes)[keyof typeof MessageTypes];

export interface HelloMsg {
  v: string;
  t: "hello";
  /** versions the sender supports, highest last */
  versions: string[];
  deviceId: string;
  appId: string;
  features?: string[];
}

export interface HelloOkMsg {
  v: string;
  t: "hello_ok";
  version: string;
  features?: string[];
}

export interface RequestMsg {
  v: string;
  t: "req";
  i: string;
  m: string;
  p?: Json;
  /** true when safe to auto-retry/queue across reconnects */
  idem?: true;
  ts?: number;
}

export interface ResponseMsg {
  v: string;
  t: "res";
  i: string;
  p?: Json;
}

export interface ErrorMessage {
  v: string;
  t: "err";
  i: string;
  e: { code: string; message: string; data?: unknown };
}

export interface ChunkMsg {
  v: string;
  t: "chunk";
  i: string;
  n: number;
  d: Json;
}

export interface EndMsg {
  v: string;
  t: "end";
  i: string;
  p?: Json;
}

export interface EventMsg {
  v: string;
  t: "evt";
  s: string;
  e: string;
  p?: Json;
}

export interface SubMsg {
  v: string;
  t: "sub";
  s: string;
  e: string;
}

export interface UnsubMsg {
  v: string;
  t: "unsub";
  s: string;
}

export interface CancelMsg {
  v: string;
  t: "cancel";
  i: string;
}

export interface PingMsg {
  v: string;
  t: "ping";
  ts: number;
}

export interface PongMsg {
  v: string;
  t: "pong";
  ts: number;
}

export interface ByeMsg {
  v: string;
  t: "bye";
  code?: string;
  reason?: string;
}

export type CrosslinkMessage =
  | HelloMsg
  | HelloOkMsg
  | RequestMsg
  | ResponseMsg
  | ErrorMessage
  | ChunkMsg
  | EndMsg
  | EventMsg
  | SubMsg
  | UnsubMsg
  | CancelMsg
  | PingMsg
  | PongMsg
  | ByeMsg;

/* ------------------------------------------------------------------ */
/* identifiers                                                         */
/* ------------------------------------------------------------------ */

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const EVENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const DEVICE_ID_RE = /^cd1_[0-9a-f]{32}$/;
const VERSION_RE = /^\d+\.\d+$/;

export function makeRequestId(rand: (n: number) => Uint8Array): string {
  return toUrlSafeBase64ish(rand(12));
}

function toUrlSafeBase64ish(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  // base64 then URL-safe; ids are opaque so trailing padding is stripped
  const b64 = globalThis.btoa !== undefined ? btoa(out) : BufferFrom(out);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

declare const Buffer: { from(s: string): { toString(e: string): string } };
function BufferFrom(s: string): string {
  return Buffer.from(s).toString("base64");
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Structural validation of a decoded message. Returns null when valid,
 * otherwise a machine-readable problem description.
 *
 * Deliberately cheap and allocation-light — it runs on every inbound frame.
 * Deep payload validation belongs to schema validators at the RPC layer.
 */
export function validateMessage(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return "not-an-object";
  const m = msg as Record<string, unknown>;
  if (typeof m.v !== "string" || !VERSION_RE.test(m.v)) return "bad-version";
  if (!isMessageType(m.t)) return "bad-type";

  switch (m.t) {
    case MessageTypes.HELLO: {
      if (!Array.isArray(m.versions) || m.versions.length === 0) return "hello-versions";
      if (!m.versions.every((x) => typeof x === "string" && VERSION_RE.test(x))) {
        return "hello-version-format";
      }
      if (typeof m.deviceId !== "string" || !DEVICE_ID_RE.test(m.deviceId)) return "hello-device-id";
      if (typeof m.appId !== "string" || m.appId.length === 0 || m.appId.length > 256) {
        return "hello-app-id";
      }
      break;
    }
    case MessageTypes.HELLO_OK:
      if (typeof m.version !== "string" || !VERSION_RE.test(m.version)) return "hello-ok-version";
      break;
    case MessageTypes.REQ:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return "req-id";
      if (typeof m.m !== "string" || !METHOD_RE.test(m.m)) return "req-method";
      if (m.idem !== undefined && m.idem !== true) return "req-idem-flag";
      break;
    case MessageTypes.RES:
    case MessageTypes.END:
    case MessageTypes.CANCEL:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return `${m.t}-id`;
      break;
    case MessageTypes.ERR:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return "err-id";
      if (
        typeof m.e !== "object" ||
        m.e === null ||
        typeof (m.e as Record<string, unknown>).code !== "string" ||
        !ALL_ERROR_CODES.includes((m.e as Record<string, unknown>).code as string) ||
        typeof (m.e as Record<string, unknown>).message !== "string"
      ) {
        return "err-body";
      }
      break;
    case MessageTypes.CHUNK:
      if (typeof m.i !== "string" || !REQUEST_ID_RE.test(m.i)) return "chunk-id";
      if (typeof m.n !== "number" || !Number.isInteger(m.n) || m.n < 0) return "chunk-n";
      if (m.d === undefined) return "chunk-data-missing";
      break;
    case MessageTypes.EVT:
      if (typeof m.s !== "string" || !REQUEST_ID_RE.test(m.s)) return "evt-sub";
      if (typeof m.e !== "string" || !EVENT_RE.test(m.e)) return "evt-name";
      break;
    case MessageTypes.SUB:
    case MessageTypes.UNSUB:
      if (typeof m.s !== "string" || !REQUEST_ID_RE.test(m.s)) return `${m.t}-sub`;
      if (m.t === MessageTypes.SUB && (typeof m.e !== "string" || !EVENT_RE.test(m.e))) {
        return "sub-event";
      }
      break;
    case MessageTypes.PING:
    case MessageTypes.PONG:
      if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return "ts";
      break;
    case MessageTypes.BYE:
      break;
  }
  return null;
}

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && Object.values(MessageTypes).includes(value as MessageType);
}

/** Error codes that indicate the session itself is broken (no point retrying). */
export function isFatalErrorCode(code: string): boolean {
  return (
    code === ErrorCodes.DEVICE_REVOKED ||
    code === ErrorCodes.SESSION_EXPIRED ||
    code === ErrorCodes.VERSION_UNSUPPORTED ||
    code === ErrorCodes.UNAUTHORIZED
  );
}
