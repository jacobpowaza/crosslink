import { openWithTimeout, WsLike } from "./ws.js";

/**
 * Client-side signaling peer: resolves a pairing code to a host connection
 * and shuttles opaque pairing blobs. Never sees keys or SAS material.
 */
export class SignalingPeer {
  private queue: Array<{ from: string; blob: string }> = [];
  private resolvers: Array<(entry: { from: string; blob: string }) => void> = [];
  private failure?: Error;
  private failureWaiters: Array<(err?: Error) => void> = [];

  private constructor(private readonly ws: WsLike) {
    ws.addEventListener("message", (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.op === "pair_deliver" && typeof msg.blob === "string") {
        const entry = { from: String(msg.from), blob: msg.blob };
        const r = this.resolvers.shift();
        if (r) r(entry);
        else this.queue.push(entry);
        return;
      }
      if (msg.op === "error") {
        this.fail(new Error(`signaling error: ${JSON.stringify(msg.error ?? {})}`));
      }
      if (msg.op === "pair_not_found") {
        this.fail(new Error("PAIRING_EXPIRED: code not found or expired"));
      }
    });
    ws.addEventListener("close", () =>
      this.fail(new Error("signaling connection closed"))
    );
    ws.addEventListener("error", () => this.fail(new Error("signaling connection failed")));
  }

  static async open(wsFactory: () => WsLike, timeoutMs = 10_000): Promise<SignalingPeer> {
    const ws = wsFactory();
    const peer = new SignalingPeer(ws);
    try {
      await openWithTimeout(ws, timeoutMs);
    } catch (err) {
      throw new Error(`cannot reach signaling: ${String((err as Error)?.message ?? err)}`, { cause: err });
    }
    return peer;
  }

  /** Resolves a pairing code; returns psid, host connection id, and presence. */
  async resolve(code: string): Promise<{
    psid: string;
    hostConn: string;
    app: {
      appId: string;
      name: string;
      fingerprint: string;
      pubEdB64: string;
      pubXB64: string;
      relay?: { url: string; channel: string };
      lan?: { host: string; port: number };
    };
  }> {
    this.send({ op: "pair_resolve", code });
    // pair_found arrives as a direct op (handled below), errors fail the peer
    return new Promise((resolve, reject) => {
      const onMsg = (ev: { data: unknown }) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.op === "pair_found") {
          this.ws.removeEventListener?.("message", onMsg as never);
          resolve({
            psid: String(msg.psid),
            hostConn: String(msg.host_conn),
            app: msg.app as never
          });
        } else if (msg.op === "pair_not_found") {
          this.ws.removeEventListener?.("message", onMsg as never);
          reject(new Error("PAIRING_EXPIRED"));
        } else if (msg.op === "error") {
          this.ws.removeEventListener?.("message", onMsg as never);
          reject(new Error(String((msg.error as { code?: string })?.code ?? "error")));
        }
      };
      this.ws.addEventListener("message", onMsg);
    });
  }

  /** Sends an opaque blob to a connected peer (host or waiter). */
  sendTo(connId: string, blob: string): void {
    this.send({ op: "pair_payload", to: connId, blob });
  }

  /** Awaits the next blob delivered from `fromConnId`. */
  nextBlob(fromConnId: string, timeoutMs = 15_000): Promise<string> {
    const idx = this.queue.findIndex((q) => q.from === fromConnId);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0].blob);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failureWaiters = this.failureWaiters.filter((w) => w !== wake);
        reject(new Error("timeout awaiting pairing reply"));
      }, timeoutMs);
      const wake = (err?: Error) => {
        clearTimeout(timer);
        err ? reject(err) : reject(new Error("peer closed"));
      };
      this.resolvers.push((entry) => {
        clearTimeout(timer);
        this.failureWaiters = this.failureWaiters.filter((w) => w !== wake);
        if (entry.from === fromConnId) resolve(entry.blob);
        else {
          // wrong sender; keep waiting by re-queueing resolution
          this.queue.push(entry);
          this.resolvers.push((e2) => resolve(e2.blob));
          reject(new Error("blob from unexpected sender"));
        }
      });
      this.failureWaiters.push(wake);
      if (this.failure) wake(this.failure);
    });
  }

  close(): void {
    try {
      this.ws.close(1000, "done");
    } catch {
      /* noop */
    }
  }

  private send(obj: unknown): void {
    (this.ws as unknown as { send(data: string): unknown }).send(JSON.stringify(obj));
  }

  private fail(err: Error): void {
    this.failure = err;
    const waiters = this.failureWaiters.splice(0);
    for (const w of waiters) w(err);
  }
}
