/**
 * NAT-PMP client (RFC 6886).
 *
 * Two operations are used: opcode 0 asks the gateway for its external address,
 * opcode 2 asks it to map an external TCP port to a port on this machine.
 * Both are single unicast datagrams to the gateway on port 5351.
 */
import { ipv4ToString, readUint16, readUint32, udpRequest } from "./udp.js";

export const NATPMP_PORT = 5351;

const RESULT_CODES: Record<number, string> = {
  0: "success",
  1: "unsupported version",
  2: "not authorized — port mapping is disabled on the router",
  3: "network failure — the router has no upstream address yet",
  4: "out of resources — the router's mapping table is full",
  5: "unsupported opcode"
};

export interface NatPmpMapping {
  internalPort: number;
  externalPort: number;
  /** Seconds the router promised to hold the mapping. */
  lifetimeSeconds: number;
}

/** Gateway's external (WAN-side) IPv4 address, or null if it will not say. */
export async function natPmpExternalAddress(
  gateway: string,
  timeoutMs = 3000
): Promise<string | null> {
  const reply = await udpRequest({
    host: gateway,
    port: NATPMP_PORT,
    payload: Uint8Array.from([0, 0]),
    timeoutMs,
    accept: (r) => r.length >= 12 && r[0] === 0 && r[1] === 128
  });
  if (!reply) return null;
  const result = readUint16(reply, 2);
  if (result !== 0) throw new Error(natPmpError(result));
  return ipv4ToString(reply, 8);
}

/**
 * Requests an inbound TCP mapping. `suggestedExternalPort` is advisory — the
 * router may hand back a different port, and the returned value is the one that
 * must be advertised.
 */
export async function natPmpMapTcp(
  gateway: string,
  internalPort: number,
  suggestedExternalPort: number,
  lifetimeSeconds: number,
  timeoutMs = 3000
): Promise<NatPmpMapping | null> {
  const payload = new Uint8Array(12);
  payload[0] = 0; // version
  payload[1] = 2; // opcode 2 = map TCP
  // bytes 2-3 reserved, already zero
  payload[4] = internalPort >> 8;
  payload[5] = internalPort & 0xff;
  payload[6] = suggestedExternalPort >> 8;
  payload[7] = suggestedExternalPort & 0xff;
  payload[8] = (lifetimeSeconds >>> 24) & 0xff;
  payload[9] = (lifetimeSeconds >>> 16) & 0xff;
  payload[10] = (lifetimeSeconds >>> 8) & 0xff;
  payload[11] = lifetimeSeconds & 0xff;

  const reply = await udpRequest({
    host: gateway,
    port: NATPMP_PORT,
    payload,
    timeoutMs,
    accept: (r) => r.length >= 16 && r[0] === 0 && r[1] === 130
  });
  if (!reply) return null;
  const result = readUint16(reply, 2);
  if (result !== 0) throw new Error(natPmpError(result));
  return {
    internalPort: readUint16(reply, 8),
    externalPort: readUint16(reply, 10),
    lifetimeSeconds: readUint32(reply, 12)
  };
}

/** Releasing is a map request with lifetime 0 and external port 0. */
export async function natPmpUnmapTcp(
  gateway: string,
  internalPort: number,
  timeoutMs = 2000
): Promise<void> {
  await natPmpMapTcp(gateway, internalPort, 0, 0, timeoutMs).catch(() => null);
}

function natPmpError(code: number): string {
  return `NAT-PMP refused: ${RESULT_CODES[code] ?? `result code ${code}`}`;
}
