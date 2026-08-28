/**
 * The two ways a phone can carry out the pairing exchange with a host.
 *
 * The cryptographic protocol is identical either way — claim, challenge, SAS,
 * complete — so the client speaks to a `PairingChannel` and does not care which
 * one it got. What differs is only who moves the frames:
 *
 * - `DirectPairingChannel` opens a WebSocket straight to the host, using an
 *   endpoint from the QR (`lan~ws://…` on the same Wi-Fi, `wan~ws://…` through
 *   a router port mapping). No service in the middle, nothing to deploy, and
 *   nothing to pay for — this is the zero-infrastructure path.
 * - `BrokeredPairingChannel` relays frames through a signaling service, for
 *   hosts that are only reachable that way.
 *
 * Direct is tried first; brokered is the fallback.
 */
import type { SignalingPeer } from "./signaling-peer.js";
import { openWithTimeout, type WsLike } from "./ws.js";

export interface PairingHostInfo {
  appId: string;
  name: string;
  fingerprint: string;
  pubEdB64: string;
  pubXB64: string;
  relay?: { url: string; channel: string };
  lan?: { host: string; port: number };
}

export interface ResolvedPairingSession {
  psid: string;
  app: PairingHostInfo;
}

export interface PairingChannel {
  readonly kind: "direct" | "brokered";
  /** Turns the scanned 9-digit code into a session id plus host presence. */
  resolve(code: string): Promise<ResolvedPairingSession>;
  send(frame: object): void;
  /** Next frame from the host. Rejects if the channel fails first. */
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

/** Pairing over a WebSocket opened straight to the host. */
export class DirectPairingChannel implements PairingChannel {
  readonly kind = "direct" as const;

  private queue: Record<string, unknown>[] = [];
  private waiters: Array<{
    resolve(frame: Record<string, unknown>): void;
    reject(err: Error): void;
  }> = [];
  private failure?: Error;

  private constructor(private readonly ws: WsLike) {
    // Node's built-in WebSocket delivers binary frames as `Blob` unless told
    // otherwise, and a Blob can only be read asynchronously — which would
    // reorder the pairing exchange. ArrayBuffer keeps every frame synchronous.
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* some implementations expose it read-only; the Blob path still works */
    }
    ws.addEventListener("message", (ev) => {
      const frame = parseFrame(ev.data);
      // A host may share this socket with non-pairing traffic; anything that is
      // not a JSON object is not ours and is dropped rather than surfaced.
      if (!frame) return;
      if (frame instanceof Promise) {
        void frame.then((resolved) => {
          if (resolved) this.deliver(resolved);
        });
        return;
      }
      this.deliver(frame);
    });
    ws.addEventListener("close", () => this.fail(new Error("host closed the pairing connection")));
    ws.addEventListener("error", () => this.fail(new Error("pairing connection failed")));
  }

  static async open(
    url: string,
    wsFactory: (url: string) => WsLike,
    timeoutMs: number
  ): Promise<DirectPairingChannel> {
    const ws = wsFactory(url);
    const channel = new DirectPairingChannel(ws);
    try {
      await openWithTimeout(ws, timeoutMs);
    } catch (err) {
      throw new Error(`cannot reach ${url}: ${String((err as Error)?.message ?? err)}`, { cause: err });
    }
    return channel;
  }

  async resolve(code: string): Promise<ResolvedPairingSession> {
    this.send({ kind: "pair_hello", code });
    const frame = await this.next();
    if (frame.kind === "pair_error") {
      throw new Error(pairErrorMessage(frame));
    }
    if (frame.kind !== "pair_ready" || typeof frame.ps !== "string") {
      throw new Error(`unexpected reply to pair_hello: ${String(frame.kind)}`);
    }
    return { psid: frame.ps, app: frame.app as PairingHostInfo };
  }

  send(frame: object): void {
    this.ws.send(new TextEncoder().encode(JSON.stringify(frame)));
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  private deliver(frame: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(frame);
    else this.queue.push(frame);
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }
}

/** Pairing relayed through a signaling service. */
export class BrokeredPairingChannel implements PairingChannel {
  readonly kind = "brokered" as const;
  private hostConn = "";

  constructor(private readonly peer: SignalingPeer) {}

  async resolve(code: string): Promise<ResolvedPairingSession> {
    const found = await this.peer.resolve(code);
    this.hostConn = found.hostConn;
    return { psid: found.psid, app: found.app as PairingHostInfo };
  }

  send(frame: object): void {
    this.peer.sendTo(this.hostConn, JSON.stringify(frame));
  }

  async next(): Promise<Record<string, unknown>> {
    const blob = await this.peer.nextBlob(this.hostConn);
    return JSON.parse(blob) as Record<string, unknown>;
  }

  close(): void {
    this.peer.close();
  }
}

export function pairErrorMessage(frame: Record<string, unknown>): string {
  const error = frame.error as { code?: string; message?: string } | undefined;
  return `PAIRING_FAILED${error?.code ? ` (${error.code})` : ""}: ${
    error?.message ?? "the host rejected the pairing attempt"
  }`;
}

type ParsedFrame = Record<string, unknown> | null;

function parseFrame(data: unknown): ParsedFrame | Promise<ParsedFrame> {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text().then(decodeJsonObject);
  }
  if (typeof data === "string") return decodeJsonObject(data);
  try {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (!bytes) return null;
    return decodeJsonObject(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function decodeJsonObject(text: string): ParsedFrame {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
