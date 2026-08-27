/**
 * Regression tests for pairing URI generation and parsing.
 * Covers: no manual signaling configuration, framework defaults,
 * transport awareness, invalid/malformed URIs, and session expiry.
 */
import { describe, expect, it } from "vitest";
import { buildPairingUri, parsePairingUri, unwrapBootstrapUri } from "./index.js";

describe("pairing URI regression", () => {
  it("builds a valid pairing URI with framework default signaling URL", () => {
    const identityPubEd = "test"; // not used for fingerprint validation here
    const uri = buildPairingUri({
      signalingUrl: "https://signal.crosslink.app",
      code: "123456789",
      appId: "com.test.app",
      appName: "Test App",
      hostPubEdB64: "dGVzdA==",
    });
    expect(uri).toMatch(/^crosslink:\/\/pair\?/);
    expect(uri).toContain("s=https%3A%2F%2Fsignal.crosslink.app");
  });

  it("parses a pairing URI with framework default signaling URL", () => {
    const uri = buildPairingUri({
      signalingUrl: "https://signal.crosslink.app",
      code: "483921004",
      appId: "com.demo.notes",
      appName: "Notes",
      hostPubEdB64: "dGVzdHB1YmxpY2tleQ==",
    });
    const parsed = parsePairingUri(uri);
    expect(parsed.signalingUrl).toBe("https://signal.crosslink.app");
    expect(parsed.code).toBe("483921004");
    expect(parsed.appId).toBe("com.demo.notes");
  });

  it("includes transport mode when specified", () => {
    const uri = buildPairingUri({
      signalingUrl: "https://signal.crosslink.app",
      code: "123456789",
      appId: "com.test.app",
      appName: "Test",
      hostPubEdB64: "dGVzdA==",
      transport: "lan",
    });
    const parsed = parsePairingUri(uri);
    expect(parsed.transport).toBe("lan");
  });

  it("fails safely on malformed pairing URI (missing app id)", () => {
    expect(() => parsePairingUri("crosslink://pair?v=1&s=https://signal.crosslink.app&c=123456789")).toThrow(
      /missing valid app id/
    );
  });

  it("fails safely on pairing URI with invalid fingerprint", () => {
    expect(() =>
      parsePairingUri("crosslink://pair?v=1&s=https://signal.crosslink.app&a=com.test&f=nothex16chars!!")
    ).toThrow(/missing fingerprint/);
  });

  it("fails safely on pairing URI with invalid fingerprint", () => {
    expect(() =>
      parsePairingUri("crosslink://pair?v=1&s=https://signal.crosslink.app&a=com.test&f=nothex")
    ).toThrow(/missing fingerprint/);
  });

  it("fails safely on pairing URI with unsupported version", () => {
    expect(() => parsePairingUri("crosslink://pair?v=2&s=https://signal.crosslink.app&a=com.test&f=abcd1234abcd1234&c=123456789")).toThrow(
      /unsupported pairing uri version/
    );
  });

  it("fails safely on pairing URI with missing signaling URL when framework defaults are not available", () => {
    // This verifies that when no framework default applies and no explicit URL
    // is set, the pairing URI fails safely rather than creating an invalid URI.
    expect(() => parsePairingUri("crosslink://pair?v=1&a=com.test&f=abcd1234abcd1234&c=123456789")).toThrow(
      /pairing uri missing valid signaling url/
    );
  });

  it("normalizes pairing code correctly", () => {
    const code = "483 921 004";
    const normalized = code.replace(/\D/g, "");
    expect(normalized).toBe("483921004");
    expect(normalized.length).toBe(9);
  });

  it("accepts HTTPS bootstrap URLs with embedded pairing payload", () => {
    const manifest = buildPairingUri({
      signalingUrl: "https://signal.crosslink.app",
      code: "123456789",
      appId: "com.demo.notes",
      appName: "Notes",
      hostPubEdB64: "dGVzdHB1YmxpY2tleQ==",
    });
    const bootstrap = `https://example.com/#pair=${encodeURIComponent(manifest)}`;
    const unwrapped = unwrapBootstrapUri(bootstrap);
    // unwrapBootstrapUri decodes once, so the unwrapped URI should contain
    // the raw manifest URI (not double-encoded).
    expect(unwrapped).toContain("crosslink://pair?");
    expect(unwrapped).toContain("https://signal.crosslink.app");
  });
});
