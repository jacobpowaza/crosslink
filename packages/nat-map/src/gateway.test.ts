import { describe, expect, it } from "vitest";
import { isCgnatIpv4, isPrivateIpv4 } from "./gateway.js";

describe("isPrivateIpv4", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["192.169.0.1", false],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.255.255", false],
    ["172.32.0.0", false],
    ["169.254.1.1", true],
    ["169.254.255.255", true],
    ["169.253.1.1", false],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["8.8.8.8", false],
    ["203.0.113.5", false],
    ["100.64.0.1", false], // CGNAT, but not RFC1918/link-local/loopback
    ["100.100.0.1", false],
    ["not-an-ip", false],
    ["1.2.3.4.5", false]
  ])("isPrivateIpv4(%s) === %s", (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected);
  });
});

describe("isCgnatIpv4", () => {
  it.each([
    ["100.64.0.0", true],
    ["100.64.0.1", true],
    ["100.100.0.1", true],
    ["100.127.255.255", true],
    ["100.63.255.255", false],
    ["100.128.0.0", false],
    ["10.0.0.1", false],
    ["192.168.1.1", false],
    ["8.8.8.8", false],
    ["not-an-ip", false]
  ])("isCgnatIpv4(%s) === %s", (ip, expected) => {
    expect(isCgnatIpv4(ip)).toBe(expected);
  });
});
