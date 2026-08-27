import { describe, expect, it } from "vitest";
import {
  CrosslinkError,
  ErrorCodes,
  FrameDecoder,
  MessageTypes,
  PROTOCOL_VERSION,
  SUPPORTED_VERSIONS,
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToHex,
  canonicalJson,
  decodeBinary,
  decodeMessage,
  encodeBinary,
  encodeFrame,
  encodeMessage,
  hexToBytes,
  negotiateVersions,
  parseVersion,
  validateMessage,
  versionAtLeast,
} from "../src/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("canonicalJson", () => {
  it("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}'
    );
  });

  it("omits undefined values", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
  });
});

describe("framing", () => {
  const msg = { v: PROTOCOL_VERSION, t: MessageTypes.PING, ts: 123 };

  it("roundtrips frames through the decoder", () => {
    const decoder = new FrameDecoder(1024 * 1024);
    const frames = decoder.push(encodeFrame(msg));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ t: "ping" });
  });

  it("reassembles split chunks", () => {
    const decoder = new FrameDecoder();
    const whole = encodeFrame(msg);
    expect(decoder.push(whole.slice(0, 3))).toHaveLength(0);
    expect(decoder.push(whole.slice(3))).toHaveLength(1);
  });

  it("rejects declared sizes above the limit", () => {
    const decoder = new FrameDecoder(16);
    const evil = new Uint8Array(4);
    new DataView(evil.buffer).setUint32(0, 4096, false);
    expect(() => decoder.push(evil)).toThrow(CrosslinkError);
  });

  it("rejects invalid JSON", () => {
    const payload = new TextEncoder().encode("{nope");
    const out = new Uint8Array(4 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length, false);
    out.set(payload, 4);
    expect(() => new FrameDecoder().push(out)).toThrow(/JSON/);
  });

  it("decodeMessage validates structure", () => {
    expect(() =>
      decodeMessage(new TextEncoder().encode(JSON.stringify({ v: "1.0", t: "wat" })))
    ).toThrow(/bad-type/);
    expect(() =>
      decodeMessage(
        new TextEncoder().encode(JSON.stringify({ v: "1.0", t: "req", i: "ok", m: "bad method!" }))
      )
    ).toThrow(/req-method/);
    expect(decodeMessage(encodeMessage(msg))).toMatchObject({ t: "ping" });
  });
});

describe("versioning", () => {
  it("negotiates highest mutual", () => {
    expect(negotiateVersions(["0.9", "1.0", "1.2"], ["1.0", "1.1"])).toBe("1.0");
    expect(negotiateVersions(["2.0"], SUPPORTED_VERSIONS)).toBeNull();
    expect(versionAtLeast("1.0", "1.0")).toBe(true);
    expect(versionAtLeast("0.9", "1.0")).toBe(false);
    expect(parseVersion("1.10")).toEqual({ major: 1, minor: 10 });
    expect(parseVersion("banana")).toBeNull();
  });
});

describe("encoding helpers", () => {
  it("base64 roundtrip incl url-safe", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    const url = Buffer.from(bytes).toString("base64url");
    expect(base64UrlToBytes(url)).toEqual(bytes);
  });

  it("hex roundtrip", () => {
    expect(bytesToHex(hexToBytes("deadbeef"))).toBe("deadbeef");
    expect(() => hexToBytes("xyz")).toThrow();
  });

  it("binary refs roundtrip", () => {
    const ref = encodeBinary(new Uint8Array([1, 2, 3]), "image/png");
    expect(ref).toEqual({ $b: true, c: "image/png", d: "AQID" });
    expect([...decodeBinary(ref)]).toEqual([1, 2, 3]);
  });
});

describe("validateMessage", () => {
  it("accepts a valid request", () => {
    expect(validateMessage({ v: "1.0", t: "req", i: "abc_DEF-1", m: "notes.list" })).toBeNull();
  });

  it("rejects oversized ids and bad event names", () => {
    expect(validateMessage({ v: "1.0", t: "req", i: "x".repeat(65), m: "m" })).not.toBeNull();
    expect(validateMessage({ v: "1.0", t: "evt", s: "s", e: "BAD EVENT!" })).not.toBeNull();
  });
});

describe("fixtures (cross-language conformance)", () => {
  const fixturePath = fileURLToPath(new URL("../fixtures/messages-v1.json", import.meta.url));
  const corpus = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    cases: Array<{ name: string; obj: unknown; canonical: string; frame_hex: string }>;
  };

  for (const c of corpus.cases) {
    it(`fixture "${c.name}" encodes byte-stable`, () => {
      expect(canonicalJson(c.obj)).toBe(c.canonical);
      expect(bytesToHex(encodeFrame(c.obj as object))).toBe(c.frame_hex);
    });
  }

  it("error codes list is non-empty and stable", () => {
    expect(ErrorCodes.INTERNAL).toBe("internal");
  });
});
