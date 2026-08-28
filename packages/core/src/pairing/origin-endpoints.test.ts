// The browser rule that shapes Crosslink's whole mobile architecture: an https
// page may not open a ws:// socket. It decides which routes an installable
// Crosslink origin can actually take, so it is asserted here rather than left
// to be discovered as an unexplained connection timeout on a phone.
import { describe, it, expect } from "vitest";
import { filterEndpointsForOrigin, type PairingEndpoint } from "./endpoints.js";

const LAN: PairingEndpoint = { kind: "lan", url: "ws://192.168.1.83:8787" };
const WAN: PairingEndpoint = { kind: "wan", url: "ws://203.0.113.10:8787" };
const RELAY: PairingEndpoint = { kind: "relay", url: "wss://relay.example.com" };
const TUNNEL: PairingEndpoint = { kind: "tunnel", url: "https://demo.trycloudflare.com" };
const LOOPBACK: PairingEndpoint = { kind: "sig", url: "ws://127.0.0.1:8081" };

describe("filterEndpointsForOrigin", () => {
  it("keeps every endpoint outside a browser", () => {
    const { usable, blocked } = filterEndpointsForOrigin([LAN, RELAY], null);
    expect(usable).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });

  it("keeps every endpoint on an http page", () => {
    // An http origin has no mixed-content restriction, which is exactly why the
    // LAN route works there — and why that origin cannot install.
    const { usable, blocked } = filterEndpointsForOrigin([LAN, WAN, RELAY], "http://192.168.1.83:8787");
    expect(usable).toHaveLength(3);
    expect(blocked).toHaveLength(0);
  });

  it("blocks insecure routes on an https page and says why", () => {
    const { usable, blocked } = filterEndpointsForOrigin(
      [LAN, WAN, RELAY, TUNNEL],
      "https://example.github.io"
    );
    expect(usable.map((e) => e.kind).sort()).toEqual(["relay", "tunnel"]);
    expect(blocked.map((b) => b.endpoint.kind).sort()).toEqual(["lan", "wan"]);
    expect(blocked[0].reason).toContain("mixed content");
  });

  it("allows loopback from an https page", () => {
    // Browsers treat loopback as potentially trustworthy, and a developer
    // running the services locally is a supported configuration.
    const { usable } = filterEndpointsForOrigin([LOOPBACK], "https://example.github.io");
    expect(usable).toHaveLength(1);
  });

  it("reports an unparseable endpoint as blocked rather than usable", () => {
    const broken: PairingEndpoint = { kind: "lan", url: "not-a-url" };
    const { usable, blocked } = filterEndpointsForOrigin([broken], "https://example.github.io");
    expect(usable).toHaveLength(0);
    expect(blocked[0].reason).toContain("could not be parsed");
  });

  it("leaves a published origin with nothing usable when the host is LAN-only", () => {
    // The honest consequence of the architecture: a published https bootstrap
    // and a host that advertises only ws:// cannot reach each other, and the
    // framework has to say so rather than retry forever.
    const { usable, blocked } = filterEndpointsForOrigin([LAN], "https://example.github.io");
    expect(usable).toHaveLength(0);
    expect(blocked).toHaveLength(1);
  });
});
