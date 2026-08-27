import WebSocket from "ws";
import { createHash } from "node:crypto";
import { noopLogger, type Logger } from "@crosslink/core";

const HB_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export interface SignalingPresence {
  appId: string;
  name: string;
  fingerprint: string;
  pubEdB64: string;
  pubXB64: string;
  versions: string[];
  relay?: { url: string; channel: string };
  lan?: { host: string; port: number };
}

export interface PairingAnnouncement {
  psid: string;
  /** raw code; only its hash ever leaves the process */
  codeHash: string;
  ttlMs: number;
}

export interface SignalingLinkOptions {
  /** Shared secret for a private signaling service. */
  authToken?: string;
  logger?: Logger;
}

/**
 * Outbound connection to a Crosslink signaling service: publishes host
 * presence, announces pairing codes, routes opaque pairing blobs.
 */
export class SignalingLink {
  private ws?: WebSocket;
  private stopped = false;
  private hbTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private livePairings = new Map<string, PairingAnnouncement>();
  private pendingPayloads: Array<{ to: string; blob: string }> = [];
  private connId?: string;

  private readonly log: Logger;

  constructor(
    readonly url: string,
    private readonly presence: () => SignalingPresence,
    private readonly onPairIn: (blob: string, waiterConnId: string) => void,
    private readonly onStatus?: (status: "connecting" | "online" | "offline") => void,
    private readonly options: SignalingLinkOptions = {}
  ) {
    this.log = (options.logger ?? noopLogger).child({ component: "signaling-link", url });
  }

  /**
   * Re-sends the host presence record. Called when something the record
   * carries has changed - most importantly the relay channel id after a
   * re-allocation, which clients need in order to dial the host at all.
   */
  refreshPresence(): void {
    if (this.send({ op: "host_hello", app: this.presence() })) {
      this.log.info("signaling.presence-refreshed");
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.hbTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "stopping");
  }

  get online(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  openPairing(a: PairingAnnouncement): void {
    this.livePairings.set(a.psid, a);
    this.send({
      op: "pair_open",
      psid: a.psid,
      code_hash: a.codeHash,
      ttl_ms: a.ttlMs
    });
  }

  closePairing(psid: string): void {
    this.livePairings.delete(psid);
  }

  sendPairPayload(to: string, blob: string): void {
    if (!this.send({ op: "pair_payload", to, blob })) {
      // Link down mid-pairing: hold the blob and flush it on reconnect rather
      // than making the client time out for a reason it cannot see.
      this.log.warn("signaling.payload-deferred", { to });
      this.pendingPayloads.push({ to, blob });
    }
  }

  private send(obj: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    this.onStatus?.("connecting");
    const ws = new WebSocket(this.url, {
      ...(this.options.authToken
        ? { headers: { authorization: `Bearer ${this.options.authToken}` } }
        : {})
    });
    this.ws = ws;

    ws.on("open", () => {
      this.attempts = 0;
      this.onStatus?.("online");
      ws.send(JSON.stringify({ op: "host_hello", app: this.presence() }));
      for (const p of this.livePairings.values()) this.openPairing(p);
      const pending = this.pendingPayloads.splice(0);
      for (const p of pending) this.sendPairPayload(p.to, p.blob);
      this.hbTimer = setInterval(() => this.send({ op: "hb" }), HB_INTERVAL_MS);
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.op === "host_ok") {
        this.connId = String(msg.conn ?? "");
        this.log.info("signaling.registered", { conn: this.connId });
      }
      if (msg.op === "error") {
        const code = String((msg.error as { code?: string })?.code ?? "unknown");
        this.log.error("signaling.error", { code });
        if (code === "unauthorized") {
          // Retrying with the same (missing or wrong) token would loop
          // forever; stop and let the operator fix the configuration.
          this.stopped = true;
        }
      }
      if (msg.op === "pair_deliver" && typeof msg.blob === "string") {
        try {
          this.onPairIn(msg.blob, String(msg.from));
        } catch {
          /* handler error should not kill the link */
        }
      }
    });

    ws.on("close", (code: number) => {
      clearInterval(this.hbTimer);
      if (this.stopped) return;
      this.onStatus?.("offline");
      if (code === 4401) {
        this.log.error("signaling.unauthorized", {
          detail: "signaling service rejected this host; check CROSSLINK_SIGNALING_TOKEN"
        });
        this.stopped = true;
        return;
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempts++, RECONNECT_MAX_MS);
      this.log.debug("signaling.reconnect-scheduled", { code, delayMs: delay });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.reconnectTimer.unref?.();
    });
    ws.on("error", () => ws.terminate());
  }
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
