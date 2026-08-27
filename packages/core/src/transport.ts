/**
 * Transport abstraction. Application code never knows whether bytes travel
 * over LAN WebSocket, WebRTC, a relay, or an in-process pipe.
 */
import type { Json } from "@crosslink/protocol";
import { FrameDecoder } from "@crosslink/protocol";

export type ConnectionKind =
  | "memory"
  | "lan"
  | "webrtc-direct"
  | "turn-relayed"
  | "crosslink-relayed";

export interface CrosslinkTransport {
  readonly kind: ConnectionKind;
  readonly remoteAddress?: string;
  send(data: Uint8Array): void | Promise<void>;
  close(reason?: unknown): void;
  onData(cb: (data: Uint8Array) => void): void;
  onClose(cb: (reason?: unknown) => void): void;
}

/** Convenience for transports that deliver whole JSON objects. */
export function objectTransportAdapter(
  sendObj: (obj: object) => void,
  opts: { kind: ConnectionKind }
): {
  transport: CrosslinkTransport;
  emitObject: (obj: object) => void;
} {
  const decoder = new FrameDecoder();
  const dataCbs: Array<(d: Uint8Array) => void> = [];
  const closeCbs: Array<(r?: unknown) => void> = [];
  let closed = false;

  const transport: CrosslinkTransport = {
    kind: opts.kind,
    send(objOrBytes: unknown) {
      if (closed) throw new Error("transport closed");
      const bytes =
        objOrBytes instanceof Uint8Array
          ? (objOrBytes as Uint8Array)
          : new TextEncoder().encode(JSON.stringify(objOrBytes));
      for (const cb of dataCbs) cb(bytes);
    },
    close(reason?: unknown) {
      if (closed) return;
      closed = true;
      for (const cb of [...closeCbs]) cb(reason);
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    }
  };

  return { transport, emitObject: sendObj };
}

/* ------------------------------------------------------------------ */
/* in-memory transports (tests + same-process examples)                */
/* ------------------------------------------------------------------ */

export interface MemoryTransportOptions {
  latencyMs?: number;
  /** drop every Nth frame to exercise error paths */
  dropEveryNth?: number;
}

class MemoryTransport implements CrosslinkTransport {
  readonly kind: ConnectionKind = "memory";
  private dataCbs: Array<(d: Uint8Array) => void> = [];
  private closeCbs: Array<(r?: unknown) => void> = [];
  private peer?: MemoryTransport;
  private sent = 0;
  private closed = false;

  constructor(private readonly opts: MemoryTransportOptions) {}

  attachPeer(peer: MemoryTransport): void {
    this.peer = peer;
  }

  send(data: Uint8Array): void {
    if (this.closed || !this.peer || this.peer.closed) {
      throw new Error("memory transport not connected");
    }
    this.sent += 1;
    if (this.opts.dropEveryNth && this.sent % this.opts.dropEveryNth === 0) return;
    const deliver = () => {
      for (const cb of [...this.peer!.dataCbs]) cb(data.slice());
    };
    if (this.opts.latencyMs) setTimeout(deliver, this.opts.latencyMs);
    else deliver();
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of [...this.closeCbs]) cb(reason);
    // Deliver the peer-side disconnect through the same latency pipeline so
    // frames sent before the close are observed before the close event.
    const notifyPeer = () => {
      for (const cb of [...(this.peer?.closeCbs ?? [])]) cb("peer-closed");
    };
    if (this.opts.latencyMs) setTimeout(notifyPeer, this.opts.latencyMs);
    else notifyPeer();
  }

  onData(cb: (d: Uint8Array) => void): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: (r?: unknown) => void): void {
    this.closeCbs.push(cb);
  }
}

/** Creates one connected pair of in-memory transports. */
export function createMemoryPair(
  opts: MemoryTransportOptions = {}
): [CrosslinkTransport, CrosslinkTransport] {
  const a = new MemoryTransport(opts);
  const b = new MemoryTransport(opts);
  a.attachPeer(b);
  b.attachPeer(a);
  return [a, b];
}

/** Host-side listener accepting many in-memory client connections. */
export class MemoryListener {
  private cbs: Array<(t: CrosslinkTransport) => void> = [];

  onConnection(cb: (t: CrosslinkTransport) => void): void {
    this.cbs.push(cb);
  }

  connectClient(opts: MemoryTransportOptions = {}): CrosslinkTransport {
    const clientT = new MemoryTransport(opts);
    const serverT = new MemoryTransport(opts);
    clientT.attachPeer(serverT);
    serverT.attachPeer(clientT);
    queueMicrotask(() => {
      for (const cb of [...this.cbs]) cb(serverT);
    });
    return clientT;
  }
}

export type AnyJson = Json;
