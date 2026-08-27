/**
 * An established, encrypted session over any transport.
 *
 * Responsibilities: outer-frame dispatch (handshake frames are handled before
 * construction), AEAD sealing/opening, heartbeat keepalive with liveness
 * detection, orderly close.
 */
import {
  ByeFrame,
  EncryptedFrame,
  Limits,
  encodeMessage,
  isOuterKind,
  type CrosslinkMessage,
} from "@crosslink/protocol";
import { noopLogger, type Logger } from "./logger.js";
import { SessionCipher, type Role, type TrafficKeys } from "./session-cipher.js";
import type { ConnectionKind, CrosslinkTransport } from "./transport.js";

export interface SessionMeta {
  role: Role;
  appId: string;
  peerDeviceId: string;
  transportKind: ConnectionKind;
}

export interface SessionHandlers {
  onMessage(msg: CrosslinkMessage, session: CrosslinkSession): void;
  onClose(err?: unknown): void;
}

export interface SessionOptions {
  maxFrameBytes?: number;
  heartbeat?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  logger?: Logger;
}

export class CrosslinkSession {
  readonly cipher: SessionCipher;
  readonly log: Logger;
  private closed = false;
  private lastRecvAt = Date.now();
  private hbTimer?: ReturnType<typeof setInterval>;
  private readonly maxFrameBytes: number;

  constructor(
    private readonly transport: CrosslinkTransport,
    keys: TrafficKeys,
    readonly meta: SessionMeta,
    private handlers: SessionHandlers,
    opts: SessionOptions = {}
  ) {
    this.maxFrameBytes = opts.maxFrameBytes ?? Limits.DEFAULT_MAX_FRAME_BYTES;
    this.cipher = new SessionCipher(keys, meta.role, this.maxFrameBytes);
    this.log = (opts.logger ?? noopLogger).child({
      role: meta.role,
      appId: meta.appId,
      peer: meta.peerDeviceId,
      transport: meta.transportKind
    });
    this.log.info("session.opened");

    transport.onData((data) => this.handleData(data));
    transport.onClose((reason) => this.handleClosed(reason));

    if (opts.heartbeat !== false) {
      const interval = opts.heartbeatIntervalMs ?? Limits.HEARTBEAT_INTERVAL_MS;
      const timeout = opts.heartbeatTimeoutMs ?? Limits.HEARTBEAT_TIMEOUT_MS;
      this.hbTimer = setInterval(() => {
        const silentFor = Date.now() - this.lastRecvAt;
        if (silentFor > timeout) {
          this.log.warn("session.heartbeat-timeout", { silentForMs: silentFor, timeoutMs: timeout });
          this.close("heartbeat-timeout");
          return;
        }
        try {
          this.sendOuter({ kind: "oping", ts: Date.now() });
        } catch {
          /* transport dead; close handler will fire */
        }
      }, interval);
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Sends an application-layer message, encrypted. */
  send(msg: CrosslinkMessage): void {
    this.sendOuter(this.cipher.seal(msg));
  }

  private sendOuter(frame: object): void {
    if (this.closed) throw Object.assign(new Error("session closed"), { code: "not_connected" });
    this.transport.send(encodeMessage(frame));
  }

  private handleData(data: Uint8Array): void {
    this.lastRecvAt = Date.now();
    let frame: Record<string, unknown>;
    try {
      const text = new TextDecoder().decode(data);
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.log.warn("session.malformed-frame", { bytes: data.length });
      this.close("malformed-outer-frame");
      return;
    }
    if (!isOuterKind(frame.kind)) {
      this.log.warn("session.unknown-frame-kind", { kind: String(frame.kind).slice(0, 32) });
      this.close("unknown-outer-kind");
      return;
    }
    switch (frame.kind) {
      case "enc":
        try {
          const msg = this.cipher.open(frame as unknown as EncryptedFrame);
          this.handlers.onMessage(msg, this);
        } catch (err) {
          // Authentication failure or invalid inner message: fatal.
          this.log.error("session.decrypt-failed", { error: err });
          this.close(err);
        }
        break;
      case "oping":
        try {
          this.sendOuter({ kind: "opong", ts: frame.ts });
        } catch {
          /* closing anyway */
        }
        break;
      case "opong":
        break;
      case "bye":
      case "srej":
        this.handleClosed(frame.reason ?? frame.code ?? "bye");
        break;
      default:
        break;
    }
  }

  close(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.log.info("session.closed", { reason: describe(reason), initiator: "local" });
    if (this.hbTimer) clearInterval(this.hbTimer);
    try {
      const bye: ByeFrame = {
        kind: "bye",
        reason: typeof reason === "string" ? reason.slice(0, 128) : undefined
      };
      this.transport.send(encodeMessage(bye));
    } catch {
      /* best effort */
    }
    try {
      this.transport.close(reason);
    } catch {
      /* best effort */
    }
    this.handlers.onClose(reason);
  }

  private handleClosed(reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.log.info("session.closed", { reason: describe(reason), initiator: "peer" });
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.handlers.onClose(reason);
  }
}

/** Reduces an arbitrary close reason to something safe to log. */
function describe(reason: unknown): string {
  if (reason === undefined) return "unspecified";
  if (typeof reason === "string") return reason.slice(0, 128);
  if (reason instanceof Error) return `${reason.name}: ${reason.message.slice(0, 96)}`;
  return String(reason).slice(0, 128);
}
