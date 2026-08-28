import { describe, expect, it } from "vitest";
import { parseMdnsService } from "./mdns.js";

describe("mDNS candidate validation", () => {
  it("accepts a complete local DNS-SD record as an unverified candidate", () => {
    expect(parseMdnsService({
      name: "Notes\u0000 host",
      type: "crosslink",
      port: 8787,
      addresses: ["192.168.1.20"],
      txt: { id: "com.example.notes", fp: "AABBCCDDEEFF0011", v: "1.0" }
    })).toEqual({
      name: "Notes host",
      host: "192.168.1.20",
      port: 8787,
      appId: "com.example.notes",
      fingerprintPrefix: "aabbccddeeff0011",
      verified: false
    });
  });

  it.each([
    ["public address", { addresses: ["8.8.8.8"] }],
    ["loopback address", { addresses: ["127.0.0.1"] }],
    ["bad fingerprint", { txt: { id: "com.example.notes", fp: "nope", v: "1.0" } }],
    ["future version", { txt: { id: "com.example.notes", fp: "aabbccddeeff0011", v: "99" } }],
    ["bad port", { port: 70000 }]
  ])("rejects %s", (_label, override) => {
    const service = {
      name: "Notes",
      type: "crosslink",
      port: 8787,
      addresses: ["192.168.1.20"],
      txt: { id: "com.example.notes", fp: "aabbccddeeff0011", v: "1.0" },
      ...override
    };
    expect(parseMdnsService(service)).toBeNull();
  });
});
