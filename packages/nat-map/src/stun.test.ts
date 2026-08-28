import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { discoverReflexiveAddress } from "./stun.js";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_SOFTWARE = 0x8022;

function u16(v: number): [number, number] {
  return [(v >> 8) & 0xff, v & 0xff];
}

/** Builds a SOFTWARE attribute (ignored by the client) with padding to test offset math. */
function softwareAttr(text: string): number[] {
  const bytes = Array.from(Buffer.from(text, "utf8"));
  const pad = (4 - (bytes.length % 4)) % 4;
  return [...u16(ATTR_SOFTWARE), ...u16(bytes.length), ...bytes, ...new Array(pad).fill(0)];
}

function xorMappedAddressAttr(address: string, port: number): number[] {
  const ipBytes = address.split(".").map(Number);
  const magicBytes = [0x21, 0x12, 0xa4, 0x42];
  const xoredIp = ipBytes.map((b, i) => b ^ magicBytes[i]);
  const xoredPort = port ^ (MAGIC_COOKIE >>> 16);
  const value = [0x00, 0x01, ...u16(xoredPort), ...xoredIp];
  return [...u16(ATTR_XOR_MAPPED_ADDRESS), ...u16(value.length), ...value];
}

function mappedAddressAttr(address: string, port: number): number[] {
  const ipBytes = address.split(".").map(Number);
  const value = [0x00, 0x01, ...u16(port), ...ipBytes];
  return [...u16(ATTR_MAPPED_ADDRESS), ...u16(value.length), ...value];
}

function buildResponse(transactionId: Buffer, attrBytes: number[]): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(BINDING_SUCCESS, 0);
  header.writeUInt16BE(attrBytes.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, Buffer.from(attrBytes)]);
}

async function bindEphemeral(): Promise<{ socket: dgram.Socket; port: number }> {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  return { socket, port: (socket.address() as import("node:net").AddressInfo).port };
}

describe("stun", () => {
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

  it("sends a 20-byte binding request with the magic cookie and de-XORs XOR-MAPPED-ADDRESS, tolerating padded preceding attributes", async () => {
    const { socket, port } = await bindEphemeral();
    sockets.push(socket);

    let received: Buffer | null = null;
    socket.on("message", (msg, rinfo) => {
      received = Buffer.from(msg);
      const txId = received.subarray(8, 20);
      // SOFTWARE ("abc", 3 bytes -> 1 byte pad) precedes the address attribute,
      // exercising the 4-byte padding/offset arithmetic.
      const attrs = [...softwareAttr("abc"), ...xorMappedAddressAttr("203.0.113.5", 4500)];
      socket.send(buildResponse(txId, attrs), rinfo.port, rinfo.address);
    });

    const result = await discoverReflexiveAddress([`127.0.0.1:${port}`], 1500);

    expect(received).not.toBeNull();
    expect(received!.length).toBe(20);
    expect(received!.readUInt32BE(4)).toBe(MAGIC_COOKIE);

    expect(result).not.toBeNull();
    expect(result!.address).toBe("203.0.113.5");
    expect(result!.port).toBe(4500);
  });

  it("parses a plain MAPPED-ADDRESS attribute (no XOR)", async () => {
    const { socket, port } = await bindEphemeral();
    sockets.push(socket);

    socket.on("message", (msg, rinfo) => {
      const txId = Buffer.from(msg).subarray(8, 20);
      const attrs = mappedAddressAttr("198.51.100.7", 51820);
      socket.send(buildResponse(txId, attrs), rinfo.port, rinfo.address);
    });

    const result = await discoverReflexiveAddress([`127.0.0.1:${port}`], 1500);
    expect(result).not.toBeNull();
    expect(result!.address).toBe("198.51.100.7");
    expect(result!.port).toBe(51820);
  });

  it("ignores a reply whose transaction id does not match, resolving null", async () => {
    const { socket, port } = await bindEphemeral();
    sockets.push(socket);

    socket.on("message", (_msg, rinfo) => {
      const wrongTxId = Buffer.alloc(12, 0x11);
      const attrs = xorMappedAddressAttr("203.0.113.5", 4500);
      socket.send(buildResponse(wrongTxId, attrs), rinfo.port, rinfo.address);
    });

    const result = await discoverReflexiveAddress([`127.0.0.1:${port}`], 400);
    expect(result).toBeNull();
  });
});
