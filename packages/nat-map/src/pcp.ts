/**
 * PCP client (RFC 6887), MAP opcode only.
 *
 * PCP is NAT-PMP's successor and shares port 5351. Routers that support both
 * answer PCP with better information (they echo the nonce, so a reply can be
 * matched to its request, and they report the assigned external IP rather than
 * requiring a second round trip). A PCP-unaware gateway either ignores the
 * datagram or replies "unsupported version", which is how the caller knows to
 * fall back to NAT-PMP.
 */
import { randomBytes } from "node:crypto";
import { ipv4ToBytes, ipv4ToString, readUint16, readUint32, udpRequest } from "./udp.js";

export const PCP_PORT = 5351;
const PCP_VERSION = 2;
const OPCODE_MAP = 1;
const PROTOCOL_TCP = 6;

const RESULT_CODES: Record<number, string> = {
  0: "success",
  1: "unsupported version",
  2: "not authorized — PCP is disabled on the router",
  3: "malformed request",
  4: "unsupported opcode",
  5: "unsupported option",
  6: "malformed option",
  7: "network failure",
  8: "no resources — the router's mapping table is full",
  9: "unsupported protocol",
  10: "user exceeded quota",
  11: "cannot provide external address",
  12: "address mismatch",
  13: "excessive remote peers"
};

export interface PcpMapping {
  internalPort: number;
  externalPort: number;
  externalAddress: string;
  lifetimeSeconds: number;
}

/**
 * Requests an inbound TCP mapping via PCP.
 *
 * `clientIpv4` must be this machine's address on the link toward the gateway;
 * PCP servers validate it against the datagram's source address and answer
 * ADDRESS_MISMATCH when they disagree.
 */
export async function pcpMapTcp(
  gateway: string,
  clientIpv4: string,
  internalPort: number,
  suggestedExternalPort: number,
  lifetimeSeconds: number,
  timeoutMs = 3000
): Promise<PcpMapping | null> {
  const nonce = new Uint8Array(randomBytes(12));
  const req = new Uint8Array(60);
  req[0] = PCP_VERSION;
  req[1] = OPCODE_MAP; // request (high bit clear)
  // bytes 2-3 reserved
  writeUint32(req, 4, lifetimeSeconds);
  ipv4Mapped(clientIpv4, req, 8); // client address, 16 bytes
  req.set(nonce, 24);
  req[36] = PROTOCOL_TCP;
  // bytes 37-39 reserved
  req[40] = internalPort >> 8;
  req[41] = internalPort & 0xff;
  req[42] = suggestedExternalPort >> 8;
  req[43] = suggestedExternalPort & 0xff;
  // bytes 44-59: suggested external address, all-zero = "you choose"

  const reply = await udpRequest({
    host: gateway,
    port: PCP_PORT,
    payload: req,
    timeoutMs,
    accept: (r) =>
      r.length >= 60 &&
      r[0] === PCP_VERSION &&
      r[1] === (0x80 | OPCODE_MAP) &&
      // The nonce is what distinguishes our reply from another client's.
      nonce.every((b, i) => r[24 + i] === b)
  });
  if (!reply) return null;

  const result = reply[3];
  if (result !== 0) throw new Error(`PCP refused: ${RESULT_CODES[result] ?? `result code ${result}`}`);

  return {
    lifetimeSeconds: readUint32(reply, 4),
    internalPort: readUint16(reply, 40),
    externalPort: readUint16(reply, 42),
    externalAddress: ipv4FromMapped(reply, 44)
  };
}

/** Releasing a PCP mapping is the same request with a zero lifetime. */
export async function pcpUnmapTcp(
  gateway: string,
  clientIpv4: string,
  internalPort: number,
  timeoutMs = 2000
): Promise<void> {
  await pcpMapTcp(gateway, clientIpv4, internalPort, 0, 0, timeoutMs).catch(() => null);
}

function writeUint32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** PCP addresses are always 16 bytes; IPv4 goes in as ::ffff:a.b.c.d. */
function ipv4Mapped(ip: string, out: Uint8Array, offset: number): void {
  out[offset + 10] = 0xff;
  out[offset + 11] = 0xff;
  out.set(ipv4ToBytes(ip), offset + 12);
}

function ipv4FromMapped(buf: Uint8Array, offset: number): string {
  return ipv4ToString(buf, offset + 12);
}
