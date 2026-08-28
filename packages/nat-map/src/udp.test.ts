import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { ipv4ToBytes, ipv4ToString, readUint16, readUint32, udpRequest } from "./udp.js";

describe("readUint16", () => {
  it("reads a big-endian 16-bit value at an offset", () => {
    const buf = Uint8Array.from([0xff, 0x01, 0x02, 0x03, 0x04]);
    expect(readUint16(buf, 1)).toBe(0x0102);
  });

  it("round-trips 0 and 0xffff", () => {
    expect(readUint16(Uint8Array.from([0, 0]), 0)).toBe(0);
    expect(readUint16(Uint8Array.from([0xff, 0xff]), 0)).toBe(0xffff);
  });
});

describe("readUint32", () => {
  it("reads a big-endian 32-bit value at an offset", () => {
    const buf = Uint8Array.from([0, 0x12, 0x34, 0x56, 0x78]);
    expect(readUint32(buf, 1)).toBe(0x12345678);
  });

  it("handles the top bit set without going negative", () => {
    const buf = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
    expect(readUint32(buf, 0)).toBe(0xffffffff);
  });

  it("round-trips 0", () => {
    expect(readUint32(Uint8Array.from([0, 0, 0, 0]), 0)).toBe(0);
  });
});

describe("ipv4ToString / ipv4ToBytes round trip", () => {
  it.each(["192.168.1.1", "0.0.0.0", "255.255.255.255", "203.0.113.5"])(
    "round-trips %s",
    (ip) => {
      const bytes = ipv4ToBytes(ip);
      expect(bytes.length).toBe(4);
      expect(ipv4ToString(bytes, 0)).toBe(ip);
    }
  );

  it("reads from a non-zero offset", () => {
    const buf = Uint8Array.from([9, 9, 10, 0, 0, 1]);
    expect(ipv4ToString(buf, 2)).toBe("10.0.0.1");
  });

  it.each(["1.2.3", "1.2.3.4.5", "1.2.3.256", "1.2.3.-1", "a.b.c.d", "", "1.2.3.4."])(
    "rejects malformed IPv4 %j",
    (bad) => {
      expect(() => ipv4ToBytes(bad)).toThrow();
    }
  );

  // Regression: an empty octet used to slip through, because split(".") yields
  // "" for the missing octet and Number("") === 0, so "1.2..4" was silently
  // accepted as 1.2.0.4 instead of rejected.
  it("rejects malformed IPv4 with an empty octet (1.2..4)", () => {
    expect(() => ipv4ToBytes("1.2..4")).toThrow();
  });
});

describe("udpRequest", () => {
  const sockets: dgram.Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  });

  it("resolves null on timeout against an unanswered port", async () => {
    // Nothing is listening here; the deadline (not a socket error) should fire.
    const result = await udpRequest({
      host: "127.0.0.1",
      port: 1, // reserved, nothing listens
      payload: Uint8Array.from([1, 2, 3]),
      timeoutMs: 150,
      retryMs: 500
    });
    expect(result).toBeNull();
  });

  it("ignores datagrams rejected by accept and resolves null on timeout", async () => {
    const server = dgram.createSocket("udp4");
    sockets.push(server);
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    server.on("message", (_msg, rinfo) => {
      // Always replies with a byte the client's accept() will reject.
      server.send(Uint8Array.from([0xee]), rinfo.port, rinfo.address);
    });

    const result = await udpRequest({
      host: "127.0.0.1",
      port,
      payload: Uint8Array.from([1]),
      timeoutMs: 250,
      retryMs: 500,
      accept: (reply) => reply[0] === 0xaa
    });
    expect(result).toBeNull();
  });

  it("resolves with the datagram once accept matches", async () => {
    const server = dgram.createSocket("udp4");
    sockets.push(server);
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as import("node:net").AddressInfo).port;

    server.on("message", (_msg, rinfo) => {
      server.send(Uint8Array.from([0xaa, 0x42]), rinfo.port, rinfo.address);
    });

    const result = await udpRequest({
      host: "127.0.0.1",
      port,
      payload: Uint8Array.from([1]),
      timeoutMs: 1000,
      retryMs: 500,
      accept: (reply) => reply[0] === 0xaa
    });
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([0xaa, 0x42]);
  });
});
