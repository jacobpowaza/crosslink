/**
 * Transport-level framing.
 *
 * Message-oriented transports (WebSocket, WebRTC data channel) deliver each
 * `encodeMessage` blob as one message. Stream transports (TCP, pipes, files)
 * use `encodeFrame`: 4-byte big-endian unsigned length prefix followed by the
 * UTF-8 canonical JSON payload. FrameDecoder reassembles both cases because it
 * simply buffers whatever arrives.
 */
import { CrosslinkError, ErrorCodes } from "./errors.js";
import { canonicalJson, type Json } from "./json.js";
import { Limits } from "./limits.js";
import { validateMessage } from "./messages.js";
import { bytesToUtf8, utf8ToBytes } from "./encoding.js";
import { SUPPORTED_VERSIONS } from "./version.js";

export function encodeMessage(msg: object): Uint8Array {
  return utf8ToBytes(canonicalJson(msg));
}

export function decodeMessage(data: Uint8Array | string): unknown {
  let text: string;
  try {
    text = typeof data === "string" ? data : bytesToUtf8(data);
  } catch {
    throw new CrosslinkError(ErrorCodes.PARSE_ERROR, "payload is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CrosslinkError(ErrorCodes.PARSE_ERROR, "payload is not valid JSON");
  }
  rejectProto(parsed, 0);
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as { v?: unknown }).v === "string" &&
    !SUPPORTED_VERSIONS.includes((parsed as { v: string }).v)
  ) {
    throw new CrosslinkError(ErrorCodes.VERSION_UNSUPPORTED, "protocol version is not supported");
  }
  const problem = validateMessage(parsed);
  if (problem) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, `invalid message: ${problem}`);
  }
  return parsed;
}

/** Rejects deeply nested payloads before JSON.parse has a chance to explode. */
function rejectProto(value: unknown, depth: number): void {
  if (depth > 64) {
    throw new CrosslinkError(ErrorCodes.INVALID_MESSAGE, "payload nesting exceeds 64");
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectProto(item, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) rejectProto(item, depth + 1);
  }
}

export function encodeFrame(msg: object, maxFrameBytes = Limits.DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  const payload = encodeMessage(msg);
  if (payload.length > maxFrameBytes) {
    throw new CrosslinkError(
      ErrorCodes.PAYLOAD_TOO_LARGE,
      `frame ${payload.length}B exceeds limit ${maxFrameBytes}B`
    );
  }
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

export class FrameDecoder {
  private buf = new Uint8Array(0);

  constructor(private readonly maxFrameBytes = Limits.DEFAULT_MAX_FRAME_BYTES) {}

  /** Feed raw bytes; returns every complete message that became available. */
  push(chunk: Uint8Array): Json[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const out: Json[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const len = view.getUint32(0, false);
      if (len > this.maxFrameBytes) {
        throw new CrosslinkError(
          ErrorCodes.PAYLOAD_TOO_LARGE,
          `declared frame ${len}B exceeds limit ${this.maxFrameBytes}B`
        );
      }
      if (this.buf.length < 4 + len) break;
      const payload = this.buf.subarray(4, 4 + len);
      out.push(decodeMessage(payload) as Json);
      this.buf = this.buf.slice(4 + len);
    }
    return out;
  }
}
