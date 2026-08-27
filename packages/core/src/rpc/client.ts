/**
 * Client-side RPC: call / stream / subscribe / cancel with timeouts and
 * pending-request cleanup on connection loss.
 */
import {
  CrosslinkError,
  ErrorCodes,
  Limits,
  MessageTypes,
  makeRequestId,
  type CrosslinkMessage,
  type Json,
} from "@crosslink/protocol";
import { randomBytes } from "../crypto/primitives.js";
import type { CrosslinkSession } from "../session.js";

export interface CallOptions {
  timeoutMs?: number;
}

interface PendingEntry {
  resolve(value: Json | undefined): void;
  reject(err: CrosslinkError): void;
  timer?: ReturnType<typeof setTimeout>;
  onChunk?: (d: Json, n: number) => void;
}

export class RpcClient {
  private pending = new Map<string, PendingEntry>();
  private nextSeq = 0;
  /** event name -> subscription state */
  private subs = new Map<string, { subId: string; cbs: Set<(p: Json | undefined) => void> }>();

  constructor(
    private readonly session: CrosslinkSession,
    private readonly defaultTimeoutMs: number = Limits.DEFAULT_REQUEST_TIMEOUT_MS
  ) {}

  get activeRequests(): number {
    return this.pending.size;
  }

  async call<T = Json>(method: string, input?: unknown, options: CallOptions = {}): Promise<T> {
    return (await this.execute(method, input, undefined, options)) as T;
  }

  async stream<T = Json>(
    method: string,
    input: unknown,
    onChunk: (d: Json, n: number) => void,
    options: CallOptions = {}
  ): Promise<T> {
    return (await this.execute(method, input, onChunk, options)) as T;
  }

  subscribe(event: string, cb: (payload: Json | undefined) => void): () => void {
    let state = this.subs.get(event);
    if (!state) {
      const subId = `sub_${this.nextSeq++}_${bytesToUrlSafe(randomBytes(6))}`;
      state = { subId, cbs: new Set() };
      this.subs.set(event, state);
      this.session.send({ v: "1.0", t: MessageTypes.SUB, s: subId, e: event });
    }
    state.cbs.add(cb);
    return () => {
      const current = this.subs.get(event);
      if (!current) return;
      current.cbs.delete(cb);
      if (current.cbs.size === 0) {
        this.subs.delete(event);
        try {
          this.session.send({ v: "1.0", t: MessageTypes.UNSUB, s: current.subId });
        } catch {
          /* session closing */
        }
      }
    };
  }

  /** Subscription ids to replay after reconnecting (re-SUB on fresh session). */
  subscribedEvents(): string[] {
    return [...this.subs.keys()];
  }

  cancel(requestId: string): void {
    try {
      this.session.send({ v: "1.0", t: MessageTypes.CANCEL, i: requestId });
    } catch {
      /* session closing */
    }
  }

  handleMessage(msg: CrosslinkMessage): void {
    switch (msg.t) {
      case MessageTypes.RES: {
        const entry = this.pending.get(msg.i);
        if (entry) {
          this.clearPending(msg.i, entry);
          entry.resolve(msg.p);
        }
        break;
      }
      case MessageTypes.END: {
        const entry = this.pending.get(msg.i);
        if (entry) {
          this.clearPending(msg.i, entry);
          entry.resolve(msg.p);
        }
        break;
      }
      case MessageTypes.ERR: {
        const entry = this.pending.get(msg.i);
        if (entry) {
          this.clearPending(msg.i, entry);
          entry.reject(new CrosslinkError(msg.e.code, msg.e.message, msg.e.data));
        }
        break;
      }
      case MessageTypes.CHUNK: {
        const entry = this.pending.get(msg.i);
        entry?.onChunk?.(msg.d, msg.n);
        break;
      }
      case MessageTypes.EVT: {
        const state = this.subs.get(msg.e);
        if (state && msg.s === state.subId) {
          for (const cb of [...state.cbs]) {
            try {
              cb(msg.p);
            } catch {
              /* listener errors never break the client */
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /** Rejects all in-flight requests; called when the transport dies. */
  failAll(reasonCode: string = ErrorCodes.PEER_LOST, message = "connection lost"): void {
    for (const [id, entry] of [...this.pending]) {
      this.clearPending(id, entry);
      entry.reject(new CrosslinkError(reasonCode, message));
    }
  }

  private execute(
    method: string,
    input: unknown,
    onChunk: ((d: Json, n: number) => void) | undefined,
    options: CallOptions
  ): Promise<Json | undefined> {
    const id = makeRequestId(() => randomBytes(12));
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<Json | undefined>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        onChunk
      };
      entry.timer = setTimeout(() => {
        this.pending.delete(id);
        entry.reject(
          new CrosslinkError(ErrorCodes.TIMEOUT, `${method} timed out after ${timeoutMs}ms`)
        );
        this.cancel(id);
      }, timeoutMs);
      this.pending.set(id, entry);

      try {
        this.session.send({
          v: "1.0",
          t: MessageTypes.REQ,
          i: id,
          m: method,
          ...(input !== undefined ? { p: input as Json } : {}),
          ts: Date.now()
        });
      } catch {
        this.clearPending(id, entry);
        entry.reject(new CrosslinkError(ErrorCodes.NOT_CONNECTED, "session closed"));
      }
    });
  }

  private clearPending(id: string, entry: PendingEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
  }
}

function bytesToUrlSafe(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
