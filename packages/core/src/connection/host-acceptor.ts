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
import { hostCompleteSession } from "../handshake.js";
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
}

export interface AcceptorCallbacks {
  /** Called with the established session once the handshake succeeds. */
  onSession(session: CrosslinkSession): void;
  /** Application-layer messages from the authenticated device. */
  onMessage?(msg: CrosslinkMessage, session: CrosslinkSession): void;
  /** Called after handshake failure or session end (session present when one existed). */
  onClose?(err?: unknown, deviceId?: string, session?: CrosslinkSession): void;
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

  private async handleData(data: Uint8Array): Promise<void> {
    if (this.dead) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    } catch {
      this.failWith(ErrorCodes.PARSE_ERROR, "unparseable first frame");
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
        init
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
