/**
 * Regression tests for pairing URI generation and parsing.
 * Covers: no manual signaling configuration, framework defaults,
 * transport awareness, invalid/malformed URIs, and session expiry.
 */
import { describe, expect, it } from "vitest";
import { buildPairingUri, normalizeCode, parsePairingUri, unwrapBootstrapUri } from "./index.js";

describe("pairing URI regression", () => {
  it("builds a valid pairing URI with framework default signaling URL", () => {
    const identityPubEd = "test"; // not used for fingerprint validation here
    const uri = buildPairingUri({
      endpoints: [{ kind: "sig", url: "https://signal.crosslink.app" }],
      code: "123456789",
      appId: "com.test.app",
      appName: "Test App",
      hostPubEdB64: "dGVzdA==",
    });
    expect(uri).toMatch(/^crosslink:\/\/pair\?/);
    expect(uri).toContain("e=sig%7Ehttps%3A%2F%2Fsignal.crosslink.app");
  });

  it("parses a pairing URI with framework default signaling URL", () => {
    const uri = buildPairingUri({
      endpoints: [{ kind: "sig", url: "https://signal.crosslink.app" }],
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
      endpoints: [{ kind: "sig", url: "https://signal.crosslink.app" }],
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

  it("fails safely on pairing URI with invalid fingerprint (garbage characters)", () => {
    expect(() =>
      parsePairingUri("crosslink://pair?v=1&s=https://signal.crosslink.app&a=com.test&f=nothex16chars!!")
    ).toThrow(/missing fingerprint/);
  });

  it("fails safely on pairing URI with invalid fingerprint (wrong length)", () => {
    expect(() =>
      parsePairingUri("crosslink://pair?v=1&s=https://signal.crosslink.app&a=com.test&f=nothex")
    ).toThrow(/missing fingerprint/);
  });

  it("fails safely on pairing URI with unsupported version", () => {
    expect(() =>
      parsePairingUri("crosslink://pair?v=99&s=https://signal.crosslink.app&a=com.test&f=abcd1234abcd1234&c=123456789")
    ).toThrow(/unsupported pairing uri version/);
  });

  it("fails safely on pairing URI with missing signaling URL when framework defaults are not available", () => {
    // This verifies that when no framework default applies and no explicit URL
    // is set, the pairing URI fails safely rather than creating an invalid URI.
    expect(() => parsePairingUri("crosslink://pair?v=1&a=com.test&f=abcd1234abcd1234&c=123456789")).toThrow(
      /pairing uri advertises no usable endpoint/
    );
  });

  describe("normalizeCode", () => {
    it("passes through an already-clean 9-digit code", () => {
      expect(normalizeCode("483921004")).toBe("483921004");
    });

    it("strips spaces from a spaced code", () => {
      expect(normalizeCode("483 921 004")).toBe("483921004");
    });

    it("strips dashes from a dashed code", () => {
      expect(normalizeCode("483-921-004")).toBe("483921004");
    });

    it("returns the trimmed input unchanged when it is not 9 digits", () => {
      expect(normalizeCode("  12345  ")).toBe("12345");
    });
  });

  it("accepts HTTPS bootstrap URLs with embedded pairing payload", () => {
    const manifest = buildPairingUri({
      endpoints: [{ kind: "sig", url: "https://signal.crosslink.app" }],
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

  describe("v2 endpoint behavior", () => {
    it("round-trips multiple endpoints (lan + wan + sig) through build/parse", () => {
      const uri = buildPairingUri({
        endpoints: [
          { kind: "wan", url: "https://1.2.3.4:9000" },
          { kind: "sig", url: "https://signal.crosslink.app" },
          { kind: "lan", url: "ws://192.168.1.50:8100" },
        ],
        code: "123456789",
        appId: "com.test.app",
        appName: "Test",
        hostPubEdB64: "dGVzdA==",
      });
      const parsed = parsePairingUri(uri);
      expect(parsed.endpoints).toHaveLength(3);
      expect(parsed.endpoints.map((e) => e.kind)).toEqual(["lan", "wan", "sig"]);
      expect(parsed.endpoints.find((e) => e.kind === "lan")?.url).toBe("ws://192.168.1.50:8100");
      expect(parsed.endpoints.find((e) => e.kind === "wan")?.url).toBe("https://1.2.3.4:9000");
      expect(parsed.endpoints.find((e) => e.kind === "sig")?.url).toBe("https://signal.crosslink.app");
    });

    it("returns endpoints in ENDPOINT_PREFERENCE order (lan, wan, sig) regardless of build order", () => {
      const uri = buildPairingUri({
        endpoints: [
          { kind: "sig", url: "https://signal.crosslink.app" },
          { kind: "lan", url: "ws://192.168.1.50:8100" },
          { kind: "wan", url: "https://1.2.3.4:9000" },
        ],
        code: "123456789",
        appId: "com.test.app",
        appName: "Test",
        hostPubEdB64: "dGVzdA==",
      });
      const parsed = parsePairingUri(uri);
      expect(parsed.endpoints.map((e) => e.kind)).toEqual(["lan", "wan", "sig"]);
    });

    it("throws when endpoints is empty", () => {
      expect(() =>
        buildPairingUri({
          endpoints: [],
          code: "123456789",
          appId: "com.test.app",
          appName: "Test",
          hostPubEdB64: "dGVzdA==",
        })
      ).toThrow(/no reachable endpoint/);
    });

    it("throws when endpoints contains only invalid URLs", () => {
      expect(() =>
        buildPairingUri({
          endpoints: [{ kind: "sig", url: "not-a-url" }],
          code: "123456789",
          appId: "com.test.app",
          appName: "Test",
          hostPubEdB64: "dGVzdA==",
        })
      ).toThrow(/no reachable endpoint/);
    });

    it("drops unknown endpoint kinds and malformed URLs in an e= parameter rather than throwing", () => {
      const parsed = parsePairingUri(
        "crosslink://pair?v=2&e=bogus~https://x.test,sig~not-a-url,sig~https://signal.crosslink.app&a=com.test&f=abcd1234abcd1234&c=123456789"
      );
      expect(parsed.endpoints).toHaveLength(1);
      expect(parsed.endpoints[0]).toEqual({ kind: "sig", url: "https://signal.crosslink.app" });
    });

    it("refuses a loopback lan endpoint, which on the phone would name the phone", () => {
      expect(() =>
        buildPairingUri({
          endpoints: [{ kind: "lan", url: "ws://127.0.0.1:8100" }],
          code: "123456789",
          appId: "com.test.app",
          appName: "Test",
          hostPubEdB64: "dGVzdA==",
        })
      ).toThrow(/no reachable endpoint/);
    });

    it("refuses a loopback wan endpoint, which is never a public route", () => {
      expect(() =>
        buildPairingUri({
          endpoints: [{ kind: "wan", url: "ws://localhost:8100" }],
          code: "123456789",
          appId: "com.test.app",
          appName: "Test",
          hostPubEdB64: "dGVzdA==",
        })
      ).toThrow(/no reachable endpoint/);
    });

    it("keeps a loopback sig endpoint: a locally-run signaling stack is supported", () => {
      const uri = buildPairingUri({
        endpoints: [{ kind: "sig", url: "http://127.0.0.1:7100" }],
        code: "123456789",
        appId: "com.test.app",
        appName: "Test",
        hostPubEdB64: "dGVzdA==",
      });
      expect(parsePairingUri(uri).endpoints).toEqual([{ kind: "sig", url: "http://127.0.0.1:7100" }]);
    });

    it("drops a loopback lan endpoint on parse but keeps the usable ones", () => {
      const parsed = parsePairingUri(
        "crosslink://pair?v=2&e=lan~ws://127.0.0.1:8100,lan~ws://192.168.1.50:8100&a=com.test&f=abcd1234abcd1234&c=123456789"
      );
      expect(parsed.endpoints).toEqual([{ kind: "lan", url: "ws://192.168.1.50:8100" }]);
    });

    it("still parses a legacy v=1&s=https://… URI into a single sig endpoint", () => {
      const parsed = parsePairingUri(
        "crosslink://pair?v=1&s=https://signal.crosslink.app&a=com.test&f=abcd1234abcd1234&c=123456789"
      );
      expect(parsed.endpoints).toEqual([{ kind: "sig", url: "https://signal.crosslink.app" }]);
      expect(parsed.signalingUrl).toBe("https://signal.crosslink.app");
    });
  });
});
