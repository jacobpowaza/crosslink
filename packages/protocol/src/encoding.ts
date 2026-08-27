/**
 * Base64 / base64url / hex byte helpers, isomorphic across Node and browsers.
 * Binary payloads inside JSON messages use the BinaryRef shape.
 */

export interface BinaryRef {
  /** discriminator marking this object as a binary payload */
  $b: true;
  /** optional MIME type */
  c?: string;
  /** standard base64 payload */
  d: string;
}

/* ------------------------------------------------------------------ */
/* base64                                                              */
/* ------------------------------------------------------------------ */

declare const Buffer: {
  from(data: string, encoding: string): { toString(encoding: string): string };
  from(data: Uint8Array): { toString(encoding: string): string };
};

const HAS_BUFFER = typeof Buffer !== "undefined";

export function bytesToBase64(bytes: Uint8Array): string {
  if (HAS_BUFFER) return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (HAS_BUFFER) {
    const buf = Buffer.from(b64, "base64") as unknown as Uint8Array;
    return new Uint8Array(buf);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return base64ToBytes(b64);
}

/* ------------------------------------------------------------------ */
/* hex                                                                 */
/* ------------------------------------------------------------------ */

const HEX = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new TypeError("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* utf8                                                                */
/* ------------------------------------------------------------------ */

const te = new TextEncoder();
const td = new TextDecoder();

export const utf8ToBytes = (s: string): Uint8Array => te.encode(s);
export const bytesToUtf8 = (b: Uint8Array): string => td.decode(b);

/* ------------------------------------------------------------------ */
/* binary refs                                                         */
/* ------------------------------------------------------------------ */

export function encodeBinary(bytes: Uint8Array, mime?: string): BinaryRef {
  const ref: BinaryRef = { $b: true, d: bytesToBase64(bytes) };
  if (mime !== undefined) ref.c = mime;
  return ref;
}

export function decodeBinary(ref: unknown): Uint8Array {
  if (!isBinaryRef(ref)) throw new TypeError("not a BinaryRef");
  return base64ToBytes(ref.d);
}

export function isBinaryRef(value: unknown): value is BinaryRef {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BinaryRef).$b === true &&
    typeof (value as BinaryRef).d === "string"
  );
}
