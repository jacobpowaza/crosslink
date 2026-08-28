/**
 * Minimal STUN binding client (RFC 5389) for public-address discovery.
 *
 * Preferred over an HTTP "what is my IP" service: it is the same mechanism
 * WebRTC already uses, needs no third-party HTTP endpoint, works on networks
 * that block outbound HTTP to unknown hosts, and reveals the *port* the NAT
 * assigned, which is what tells us whether the NAT is endpoint-independent.
 */
import { ipv4ToString, readUint16, udpRequest } from "./udp.js";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;

export const DEFAULT_STUN_SERVERS = [
  "stun.l.google.com:19302",
  "stun1.l.google.com:19302",
  "stun.cloudflare.com:3478"
];

export interface StunResult {
  address: string;
  port: number;
  server: string;
}

/** Queries STUN servers in order and returns the first reflexive address. */
export async function discoverReflexiveAddress(
  servers: string[] = DEFAULT_STUN_SERVERS,
  timeoutMs = 2500
): Promise<StunResult | null> {
  for (const server of servers) {
    const [host, portText] = splitHostPort(server);
    const result = await stunBinding(host, portText, timeoutMs);
    if (result) return { ...result, server };
  }
  return null;
}

async function stunBinding(
  host: string,
  port: number,
  timeoutMs: number
): Promise<{ address: string; port: number } | null> {
  const transactionId = new Uint8Array(12);
  crypto.getRandomValues(transactionId);

  const request = new Uint8Array(20);
  request[0] = (BINDING_REQUEST >> 8) & 0xff;
  request[1] = BINDING_REQUEST & 0xff;
  // bytes 2-3: message length, zero — this request carries no attributes
  request[4] = (MAGIC_COOKIE >>> 24) & 0xff;
  request[5] = (MAGIC_COOKIE >>> 16) & 0xff;
  request[6] = (MAGIC_COOKIE >>> 8) & 0xff;
  request[7] = MAGIC_COOKIE & 0xff;
  request.set(transactionId, 8);

  const reply = await udpRequest({
    host,
    port,
    payload: request,
    timeoutMs,
    retryMs: 500,
    accept: (r) =>
      r.length >= 20 &&
      readUint16(r, 0) === BINDING_SUCCESS &&
      transactionId.every((b, i) => r[8 + i] === b)
  });
  if (!reply) return null;
  return parseAddressAttribute(reply);
}

function parseAddressAttribute(msg: Uint8Array): { address: string; port: number } | null {
  const length = readUint16(msg, 2);
  let offset = 20;
  const end = Math.min(msg.length, 20 + length);

  while (offset + 4 <= end) {
    const type = readUint16(msg, offset);
    const valueLength = readUint16(msg, offset + 2);
    const value = offset + 4;
    if (value + valueLength > msg.length) break;

    if (type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) {
      const family = msg[value + 1];
      // Only IPv4 is meaningful here: an IPv6 reflexive address needs no NAT
      // mapping at all and is handled as a separate direct-route candidate.
      if (family === 0x01 && valueLength >= 8) {
        const xor = type === ATTR_XOR_MAPPED_ADDRESS;
        const port = readUint16(msg, value + 2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0);
        if (!xor) return { address: ipv4ToString(msg, value + 4), port };
        const bytes = new Uint8Array(4);
        for (let i = 0; i < 4; i += 1) {
          bytes[i] = msg[value + 4 + i] ^ ((MAGIC_COOKIE >>> (24 - 8 * i)) & 0xff);
        }
        return { address: ipv4ToString(bytes, 0), port };
      }
    }
    // Attributes are padded to a 4-byte boundary.
    offset = value + valueLength + ((4 - (valueLength % 4)) % 4);
  }
  return null;
}

function splitHostPort(server: string): [string, number] {
  const idx = server.lastIndexOf(":");
  if (idx === -1) return [server, 3478];
  return [server.slice(0, idx), Number(server.slice(idx + 1)) || 3478];
}
