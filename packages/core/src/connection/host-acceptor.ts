/**
 * Host-side transport acceptor: a per-connection state machine that performs
 * the CLX1 handshake on any inbound transport, enforces trust (device record,
 * revocation, version), then hands the established session to the host glue.
 */
import {
  CrosslinkError,
  ErrorCodes,
  Limits,
  MIN_SECURE_VERSION,
  SUPPORTED_VERSIONS,
  base64ToBytes,
  negotiateVersions,
  versionAtLeast,
  type CrosslinkMessage,
  type SessionInitFrame,
} from "@crosslink/protocol";
import { hostCompleteSession, type HybridPqMode } from "../handshake.js";
import type { DeviceIdentity } from "../identity.js";
import { noopLogger, type Logger } from "../logger.js";
import type { TrustedDeviceRecord } from "../pairing/types.js";
import { CrosslinkSession } from "../session.js";
import type { CrosslinkTransport } from "../transport.js";

export interface AcceptorDeps {
  identity: DeviceIdentity;
  appId: string;
  lookupDevice(deviceId: string): TrustedDeviceRecord | undefined;
  maxFrameBytes?: number;
  logger?: Logger;
  /** Optional X25519 + ML-KEM-768 handshake mode. */
  hybridPq?: HybridPqMode;
  /**
   * Enables pairing directly over this transport, with no rendezvous service.
   *
   * A phone that scanned a QR carrying a `lan` or `wan` endpoint dials the host
   * itself: there is no third party to relay pairing blobs through, so the
   * claim/challenge/complete exchange runs on this socket before any session
   * exists. Security is unchanged — the pairing code still authenticates the
   * claim and the QR fingerprint still pins the host — the only thing removed
   * is the broker in the middle.
   *
   * Omit to refuse pairing on this transport (e.g. a relay channel that should
   * only carry already-paired devices).
   */
  pairing?: {
    /**
     * Maps a scanned 9-digit code to a live pairing session id. Throws when the
     * code is wrong, expired, or when too many wrong codes have been tried.
     */
    resolveCode(rawCode: string): string;
    /** Presence the client needs before claiming: identity keys and app name. */
    describeApp(): {
      appId: string;
      name: string;
      fingerprint: string;
      pubEdB64: string;
      pubXB64: string;
    };
    handleClaim(claim: Record<string, unknown>, reply: (frame: object) => void): Promise<void>;
    handleComplete(complete: Record<string, unknown>, reply: (frame: object) => void): TrustedDeviceRecord;
  };
}

export interface AcceptorCallbacks {
  /** Called with the established session once the handshake succeeds. */
  onSession(session: CrosslinkSession): void;
  /** Application-layer messages from the authenticated device. */
  onMessage?(msg: CrosslinkMessage, session: CrosslinkSession): void;
  /** Called after handshake failure or session end (session present when one existed). */
  onClose?(err?: unknown, deviceId?: string, session?: CrosslinkSession): void;
  /** A device completed pairing directly over this transport. */
  onPaired?(record: TrustedDeviceRecord): void;
  diagnostics?(event: string, data?: Record<string, unknown>): void;
}

export class HostAcceptor {
  private dead = false;
  private readonly log: Logger;

  constructor(
    private readonly transport: CrosslinkTransport,
    private readonly deps: AcceptorDeps,
    private readonly callbacks: AcceptorCallbacks
  ) {
    this.log = (deps.logger ?? noopLogger).child({
      component: "host-acceptor",
      appId: deps.appId,
      transport: transport.kind
    });
    this.log.debug("acceptor.inbound");
    this.transport.onData((data) => void this.handleData(data));
    this.transport.onClose((reason) =>
      this.fail(reason instanceof Error ? reason : new Error(String(reason ?? "closed")))
    );
  }

  get kind(): string {
    return this.transport.kind;
  }

  /**
   * Runs one pairing frame against the host pairing manager and writes its
   * reply back on this socket.
   *
   * Errors are reported to the peer as `pair_error` and the connection is left
   * open: a mistyped pairing code should cost one frame, not the whole
   * connection, so the phone can retry without redialing.
   */
  private async handlePairingFrame(frame: Record<string, unknown>): Promise<void> {
    const pairing = this.deps.pairing;
    if (!pairing) {
      this.failWith(ErrorCodes.UNAUTHORIZED, "pairing is not offered on this transport");
      return;
    }
    const reply = (out: object): void => {
      if (this.dead) return;
      try {
        this.transport.send(new TextEncoder().encode(JSON.stringify(out)));
      } catch (err) {
        this.log.debug("acceptor.pair-reply-failed", { error: String(err) });
      }
    };
    try {
      if (frame.kind === "pair_hello") {
        // Direct equivalent of the signaling service's code resolution: the
        // client knows only the digits from the QR, and needs the session id
        // before it can build a signed claim bound to that session.
        const psid = pairing.resolveCode(String(frame.code ?? ""));
        reply({ kind: "pair_ready", ps: psid, app: pairing.describeApp() });
      } else if (frame.kind === "pair_claim") {
        await pairing.handleClaim(frame, reply);
      } else {
        const record = pairing.handleComplete(frame, reply);
        this.log.info("acceptor.paired-direct", { device: record.deviceId, transport: this.transport.kind });
        this.callbacks.onPaired?.(record);
      }
    } catch (err) {
      this.log.warn("acceptor.pair-failed", { kind: String(frame.kind), error: String((err as Error)?.message ?? err) });
      reply({
        kind: "pair_error",
        error: {
          code: (err as { code?: string }).code ?? "PAIRING_INVALID",
          message: String((err as Error)?.message ?? "pairing failed")
        }
      });
    }
  }

  private async handleData(data: Uint8Array): Promise<void> {
    if (this.dead) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    } catch {
      this.failWith(ErrorCodes.PARSE_ERROR, "unparseable first frame");
      return;
    }

    // Pairing frames arrive on a transport that has no session yet, and the
    // connection must survive them: the exchange is three round trips, and the
    // client only sends `sinit` afterwards (usually on a fresh connection).
    if (
      frame.kind === "pair_hello" ||
      frame.kind === "pair_claim" ||
      frame.kind === "pair_complete"
    ) {
      await this.handlePairingFrame(frame);
      return;
    }

    if (frame.kind !== "sinit") {
      this.failWith(ErrorCodes.INVALID_MESSAGE, "expected sinit");
      return;
    }
    const init = frame as unknown as SessionInitFrame;

    try {
      const chosen = negotiateVersions([init.v], SUPPORTED_VERSIONS);
      if (!chosen || !versionAtLeast(init.v, MIN_SECURE_VERSION)) {
        this.failWith(
          ErrorCodes.VERSION_UNSUPPORTED,
          `protocol version ${String(init.v)} unsupported`
        );
        return;
      }

      const record = this.deps.lookupDevice(init.dev);
      this.log.debug("acceptor.sinit", { device: init.dev, version: String(init.v) });
      if (!record) {
        this.failWith(ErrorCodes.UNAUTHORIZED, "device is not paired");
        return;
      }
      if (record.revokedAt !== undefined) {
        this.failWith(ErrorCodes.DEVICE_REVOKED, "device has been revoked");
        return;
      }

      const { accept, keys, clientId } = hostCompleteSession(
        this.deps.identity,
        this.deps.appId,
        base64ToBytes(record.pubEd),
        init,
        { hybridPq: this.deps.hybridPq ?? "disabled" }
      );
      record.lastSeen = Date.now();

      const session = new CrosslinkSession(
        this.transport,
        keys,
        {
          role: "host",
          appId: this.deps.appId,
          peerDeviceId: clientId,
          transportKind: this.transport.kind
        },
        {
          onMessage: (msg, s) => this.callbacks.onMessage?.(msg, s),
          onClose: (err) => this.callbacks.onClose?.(err, clientId, session)
        },
        {
          maxFrameBytes: this.deps.maxFrameBytes ?? Limits.DEFAULT_MAX_FRAME_BYTES,
          logger: this.deps.logger
        }
      );

      try {
        this.transport.send(
          new TextEncoder().encode(JSON.stringify(accept))
        );
      } catch {
        session.close("accept-send-failed");
        return;
      }

      this.dead = true;
      this.log.info("acceptor.session-established", { device: clientId, name: record.name });
      this.callbacks.onSession(session);
      this.callbacks.diagnostics?.("session-established", { device: clientId });
    } catch (err) {
      const cle = CrosslinkError.from(err);
      this.failWith(cle.code, cle.message);
    }
  }

  private failWith(code: string, message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.log.warn("acceptor.rejected", { code, message });
    try {
      this.transport.send(new TextEncoder().encode(JSON.stringify({ kind: "srej", code, message })));
    } catch {
      /* best effort */
    }
    this.transport.close(code);
    this.callbacks.onClose?.(new CrosslinkError(code, message));
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.log.debug("acceptor.transport-closed", { reason: err.message });
    this.callbacks.onClose?.(err);
  }
}
