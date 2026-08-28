import dgram from "node:dgram";

export interface UdpExchange {
  host: string;
  port: number;
  payload: Uint8Array;
  timeoutMs: number;
  /** Retransmit interval; NAT-PMP mandates exponential backoff from 250ms. */
  retryMs?: number;
  /** Rejects the reply if it is not for us (wrong opcode, wrong nonce, …). */
  accept?: (reply: Uint8Array) => boolean;
}

/**
 * One request/response over UDP with retransmission.
 *
 * NAT-PMP and PCP are both unreliable-datagram protocols against a device that
 * frequently drops the first packet while it wakes its mapping table, so a
 * single send with a long timeout behaves much worse than several short ones.
 * Resolves `null` on timeout rather than throwing: "the router did not answer"
 * is an expected outcome, not an error.
 */
export function udpRequest(opts: UdpExchange): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    let retryTimer: NodeJS.Timeout | undefined;

    const finish = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (retryTimer) clearTimeout(retryTimer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };

    const deadline = setTimeout(() => finish(null), opts.timeoutMs);

    socket.on("error", () => finish(null));
    socket.on("message", (msg) => {
      const bytes = new Uint8Array(msg);
      if (opts.accept && !opts.accept(bytes)) return;
      finish(bytes);
    });

    let attempt = 0;
    const send = (): void => {
      if (settled) return;
      socket.send(opts.payload, opts.port, opts.host, (err) => {
        // ENETUNREACH/EHOSTUNREACH means this gateway guess is wrong; give up
        // immediately instead of burning the whole timeout on retries.
        if (err) finish(null);
      });
      attempt += 1;
      const backoff = (opts.retryMs ?? 250) * 2 ** (attempt - 1);
      retryTimer = setTimeout(send, backoff);
    };

    socket.bind(0, () => send());
  });
}

export function readUint16(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

export function readUint32(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] * 0x1000000 + ((buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3])
  );
}

export function ipv4ToString(buf: Uint8Array, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

export function ipv4ToBytes(ip: string): Uint8Array {
  // Matched as a whole rather than split-and-Number: `Number("")` is 0, so
  // "1.2..4" would otherwise pass validation and silently become 1.2.0.4.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) throw new Error(`not an IPv4 address: ${ip}`);
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) throw new Error(`not an IPv4 address: ${ip}`);
  return Uint8Array.from(parts);
}
