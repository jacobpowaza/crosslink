/**
 * Client-side connection lifecycle for one paired application:
 * candidate transports, CLX1 handshake initiation, connection states,
 * automatic reconnection with backoff, offline queueing of idempotent calls,
 * subscription restoration, revocation handling.
 */
import {
  CrosslinkError,
  ErrorCodes,
  Limits,
  base64ToBytes,
  encodeMessage,
  type CrosslinkMessage,
} from "@crosslink/protocol";
import { clientBeginSession, clientCompleteSession, type HybridPqMode } from "../handshake.js";
import type { DeviceIdentity } from "../identity.js";
import { noopLogger, type Logger } from "../logger.js";
import type { PairedAppRecord } from "../pairing/types.js";
import { RpcClient } from "../rpc/client.js";
import { CrosslinkSession } from "../session.js";
import type { CrosslinkTransport } from "../transport.js";

/** User-facing connection states (product vocabulary). */
export type ConnectionState =
  | "offline"
  | "discovering"
  | "pairing"
  | "connecting"
  | "direct"
  | "turn-relayed"
  | "crosslink-relayed"
  | "reconnecting"
  | "unauthorized"
  | "revoked"
  | "protocol-incompatible";

const KIND_STATE = {
  "memory": "direct",
  "lan": "direct",
  "webrtc-direct": "direct",
  "turn-relayed": "turn-relayed",
  "crosslink-relayed": "crosslink-relayed"
} as const;

export interface TransportCandidate {
  /** diagnostics label reported through onStateChange detail */
  kind: keyof typeof KIND_STATE;
  connect(): Promise<CrosslinkTransport>;
}

export interface ClientLinkOptions {
  identity: DeviceIdentity;
  appId: string;
  /** Trusted host key material from the persisted PairedAppRecord. */
  hostRecord: () => PairedAppRecord;
  candidates: TransportCandidate[];
  onStateChange?(state: ConnectionState, detail?: Record<string, unknown>): void;
  /** All decrypted application messages (after RPC dispatch hooks). */
  onMessage?(msg: CrosslinkMessage): void;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  handshakeTimeoutMs?: number;
  autoReconnect?: boolean;
  logger?: Logger;
  /** Optional X25519 + ML-KEM-768 handshake mode. */
  hybridPq?: HybridPqMode;
}

interface QueuedCall {
  method: string;
  input?: unknown;
  resolve(value: unknown): void;
  reject(err: CrosslinkError): void;
}

export class ClientLink {
  private session?: CrosslinkSession;
  private rpcClient?: RpcClient;
  private state: ConnectionState = "offline";
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly queue: QueuedCall[] = [];
  private readonly desiredSubscriptions = new Map<
    string,
    Set<(p: unknown) => void>
  >();
  /** per-callback detach handle for the *current* session, if any */
  private readonly activeSubscriptions = new Map<(p: unknown) => void, () => void>();

  private readonly log: Logger;

  constructor(private readonly options: ClientLinkOptions) {
    this.log = (options.logger ?? noopLogger).child({
      component: "client-link",
      appId: options.appId,
      device: options.identity.deviceId
    });
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  get connected(): boolean {
    return this.session?.isOpen ?? false;
  }

  /** Active RPC surface; throws when not connected (calls may be queued). */
  get rpc(): RpcClient {
    if (!this.rpcClient || !this.connected) {
      throw new CrosslinkError(ErrorCodes.NOT_CONNECTED, "not connected");
    }
    return this.rpcClient;
  }

  /* ------------------------------ lifecycle --------------------------- */

  async connect(): Promise<void> {
    // Do not override a terminal state (revoked / unauthorized / protocol-incompatible).
    if (this.stopped && (this.state === "revoked" || this.state === "unauthorized" || this.state === "protocol-incompatible")) {
      throw new CrosslinkError(
        this.state === "revoked" ? ErrorCodes.DEVICE_REVOKED :
        this.state === "unauthorized" ? ErrorCodes.UNAUTHORIZED :
        ErrorCodes.VERSION_UNSUPPORTED,
        `cannot connect: ${this.state}`
      );
    }
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.setState("connecting");
    const errors: unknown[] = [];

    for (const candidate of this.options.candidates) {
      let transport: CrosslinkTransport;
      this.log.debug("link.candidate-dial", { candidate: candidate.kind });
      try {
        transport = await candidate.connect();
      } catch (err) {
        this.log.debug("link.candidate-failed", { candidate: candidate.kind, error: err });
        errors.push(err);
        continue;
      }
      const opened = await this.handshakeOver(transport);
      if (opened) {
        this.attempts = 0;
        this.log.info("link.connected", { candidate: candidate.kind, queued: this.queue.length });
        this.setState(KIND_STATE[candidate.kind], { transport: candidate.kind });
        void this.flushQueue();
        return;
      }
      // Terminal states (revoked / unauthorized / protocol-incompatible) are
      // set by handshakeOver; do NOT try further candidates which would
      // overwrite the terminal state with "connecting".
      if (this.stopped) break;
    }

    // Terminal transitions (revoked/unauthorized/incompatible) already set
    // `stopped`; report a precise error instead of retrying, but never
    // silently resolve.
    if (this.stopped) {
      const code =
        this.state === "revoked"
          ? ErrorCodes.DEVICE_REVOKED
          : this.state === "unauthorized"
            ? ErrorCodes.UNAUTHORIZED
            : this.state === "protocol-incompatible"
              ? ErrorCodes.VERSION_UNSUPPORTED
              : ErrorCodes.HOST_OFFLINE;
      throw new CrosslinkError(code, `cannot connect: ${this.state}`);
    }
    this.log.warn("link.all-candidates-failed", {
      candidates: this.options.candidates.map((c) => c.kind),
      failures: errors.length
    });
    throw new CrosslinkError(ErrorCodes.HOST_OFFLINE, "no transport candidate succeeded");
  }

  close(): void {
    this.log.info("link.close-requested", { state: this.state });
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.rpcClient?.failAll(ErrorCodes.NOT_CONNECTED, "client closed");
    this.session?.close("client-close");
    this.session = undefined;
    this.rpcClient = undefined;
    this.setState("offline");
  }

  /**
   * Moves an established connection onto a better transport without
   * re-pairing: dials `candidate`, runs a fresh CLX1 handshake over it, and
   * swaps it in only once that succeeds. A failed upgrade is a no-op - the
   * current connection is left exactly as it was.
   *
   * This is how a relayed session becomes a direct one: the SDP exchange that
   * sets up the WebRTC candidate travels over the session being replaced. See
   * `@crosslink/webrtc-adapter`.
   *
   * In-flight requests on the old session are failed with NOT_CONNECTED and
   * must be retried; subscriptions are restored automatically.
   */
  async upgrade(candidate: TransportCandidate): Promise<boolean> {
    if (!this.connected) {
      this.log.debug("link.upgrade-skipped", { reason: "not-connected" });
      return false;
    }
    const previousKind = this.session?.meta.transportKind;
    this.log.info("link.upgrade-attempt", { from: previousKind, to: candidate.kind });

    let transport: CrosslinkTransport;
    try {
      transport = await candidate.connect();
    } catch (err) {
      this.log.warn("link.upgrade-dial-failed", { to: candidate.kind, error: err });
      return false;
    }

    const oldSession = this.session;
    const oldRpc = this.rpcClient;

    // handshakeOver installs the new session on success and leaves everything
    // untouched on failure, so there is nothing to roll back either way.
    const ok = await this.handshakeOver(transport);
    if (!ok) {
      this.log.warn("link.upgrade-handshake-failed", { to: candidate.kind });
      return false;
    }

    oldRpc?.failAll(ErrorCodes.NOT_CONNECTED, "connection upgraded; retry this request");
    try {
      oldSession?.close("upgraded");
    } catch {
      /* the old pipe is being discarded either way */
    }

    this.attempts = 0;
    this.log.info("link.upgraded", { from: previousKind, to: candidate.kind });
    this.setState(KIND_STATE[candidate.kind], { transport: candidate.kind, upgraded: true });
    return true;
  }

  /** The transport the live session is running over, if any. */
  get transportKind(): string | undefined {
    return this.session?.meta.transportKind;
  }

  /* ------------------------------- security --------------------------- */

  /** Called by SDK layers when the host revokes this device. */
  markRevoked(): void {
    this.log.warn("link.revoked");
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.rpcClient?.failAll(ErrorCodes.DEVICE_REVOKED, "device revoked");
    this.session?.close("revoked");
    this.session = undefined;
    this.rpcClient = undefined;
    this.setState("revoked");
  }

  /* --------------------------------- rpc ------------------------------ */

  async call<T>(method: string, input?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (!this.rpcClient || !this.connected) {
      throw new CrosslinkError(ErrorCodes.NOT_CONNECTED, "not connected");
    }
    return this.rpcClient.call<T>(method, input, opts);
  }

  stream<T>(
    method: string,
    input: unknown,
    onChunk: (d: unknown, n: number) => void,
    opts: { timeoutMs?: number } = {}
  ): Promise<T> {
    if (!this.rpcClient || !this.connected) {
      return Promise.reject(new CrosslinkError(ErrorCodes.NOT_CONNECTED, "not connected"));
    }
    return this.rpcClient.stream<T>(method, input, onChunk as never, opts);
  }

  /**
   * Subscribes to a host event. The subscription is remembered across
   * reconnects: the desired set is the source of truth, and every fresh
   * session re-issues SUB for it with the caller's real callbacks attached.
   */
  subscribe(event: string, cb: (payload: unknown) => void): () => void {
    let cbs = this.desiredSubscriptions.get(event);
    if (!cbs) {
      cbs = new Set();
      this.desiredSubscriptions.set(event, cbs);
    }
    cbs.add(cb);

    let detach = this.rpcClient && this.connected
      ? this.rpcClient.subscribe(event, cb as never)
      : undefined;
    this.activeSubscriptions.set(cb, () => detach?.());

    return () => {
      const set = this.desiredSubscriptions.get(event);
      set?.delete(cb);
      if (set && set.size === 0) this.desiredSubscriptions.delete(event);
      this.activeSubscriptions.get(cb)?.();
      this.activeSubscriptions.delete(cb);
      detach = undefined;
    };
  }

  /** Queues an idempotent call while offline; flushed after reconnection. */
  queueIdempotent<T>(method: string, input?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        method,
        input,
        resolve: resolve as (v: unknown) => void,
        reject
      });
    });
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /* ------------------------------ internals --------------------------- */

  private async handshakeOver(transport: CrosslinkTransport): Promise<boolean> {
    const record = this.options.hostRecord();
    const { init, state } = clientBeginSession(this.options.identity, {
      appId: this.options.appId,
      pubEdB64: record.pubEdB64,
      pubXB64: record.pubXB64
    }, { hybridPq: this.options.hybridPq ?? "disabled" });

    let reply: Record<string, unknown>;
    try {
      reply = await this.requestFrame(
        transport,
        encodeMessage(init),
        this.options.handshakeTimeoutMs ?? 10_000
      );
    } catch (err) {
      this.log.warn("link.handshake-failed", { transport: transport.kind, error: err });
      try {
        transport.close("handshake-error");
      } catch {
        /* already closed */
      }
      return false;
    }

    if (reply.kind === "sack") {
      const keys = clientCompleteSession(
        this.options.identity,
        state,
        init,
        reply as never,
        { pubEd: base64ToBytes(record.pubEdB64), pubX: base64ToBytes(record.pubXB64) }
      );
      this.attachSession(transport, keys);
      return true;
    }

    if (reply.kind === "srej") {
      const code = String(reply.code ?? "");
      this.log.warn("link.handshake-rejected", {
        code,
        message: String(reply.message ?? "").slice(0, 200)
      });
      transport.close(code);
      if (code === ErrorCodes.DEVICE_REVOKED) {
        this.markRevoked();
        return false;
      }
      if (code === ErrorCodes.VERSION_UNSUPPORTED) {
        this.setState("protocol-incompatible", { version: init.v });
        this.stopped = true;
        return false;
      }
      if (code === ErrorCodes.UNAUTHORIZED) {
        this.setState("unauthorized");
        this.stopped = true;
        return false;
      }
      return false;
    }

    this.log.warn("link.unexpected-handshake-frame", {
      kind: String(reply.kind).slice(0, 32)
    });
    transport.close("unexpected-handshake-frame");
    return false;
  }

  private attachSession(transport: CrosslinkTransport, keys: ConstructorParameters<typeof CrosslinkSession>[1]): void {
    const session = new CrosslinkSession(
      transport,
      keys,
      {
        role: "client",
        appId: this.options.appId,
        peerDeviceId: "host",
        transportKind: transport.kind
      },
      {
        onMessage: (msg) => {
          if (this.rpcClient) this.rpcClient.handleMessage(msg);
          this.options.onMessage?.(msg);
        },
        onClose: (reason) => {
          // Tear down the underlying transport too: over multiplexed
          // transports (e.g. crosslink-relayed) a session-level goodbye does
          // not imply the pipe closed, and the next dial would find it busy.
          try {
            transport.close("session-ended");
          } catch {
            /* best effort */
          }
          // A superseded session (upgraded to a better transport) closing must
          // not be mistaken for losing the connection we are actually on.
          if (this.session !== session) {
            this.log.debug("link.stale-session-closed", { reason: String(reason ?? "") });
            return;
          }
          // If the host told us we're revoked, enter terminal state immediately
          // rather than waiting for a reconnect+handshake cycle.
          if (reason === "device-revoked") {
            this.markRevoked();
            return;
          }
          this.handleDisconnect();
        }
      },
      {
        maxFrameBytes: this.options.maxFrameBytes ?? Limits.DEFAULT_MAX_FRAME_BYTES,
        logger: this.options.logger
      }
    );
    this.session = session;
    this.rpcClient = new RpcClient(session, this.options.requestTimeoutMs);

    // Restore subscriptions from previous sessions, re-attaching the real
    // callbacks rather than a placeholder - otherwise events delivered after a
    // reconnect would be routed into a no-op and silently dropped.
    for (const [event, cbs] of this.desiredSubscriptions) {
      for (const cb of cbs) {
        const detach = this.rpcClient.subscribe(event, cb as never);
        this.activeSubscriptions.set(cb, detach);
      }
    }
    if (this.desiredSubscriptions.size > 0) {
      this.log.debug("link.subscriptions-restored", {
        events: [...this.desiredSubscriptions.keys()]
      });
    }
  }

  private handleDisconnect(): void {
    this.log.info("link.disconnected", { state: this.state, stopped: this.stopped });
    this.activeSubscriptions.clear();
    this.rpcClient?.failAll();
    this.session = undefined;
    this.rpcClient = undefined;
    if (this.stopped) {
      // Preserve terminal states (revoked / unauthorized / protocol-incompatible)
      // — do not overwrite them with "offline".
      if (this.state !== "revoked" && this.state !== "unauthorized" && this.state !== "protocol-incompatible") {
        this.setState("offline");
      }
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const attempt = ++this.attempts;
    const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    const jitter = backoff * (0.7 + Math.random() * 0.6);
    this.log.info("link.reconnect-scheduled", { attempt, delayMs: Math.round(jitter) });
    this.setState("reconnecting", { attempt, delayMs: Math.round(jitter) });
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch(() => {
        if (!this.stopped) this.scheduleReconnect();
      });
    }, jitter);
  }

  private async flushQueue(): Promise<void> {
    while (this.queue.length > 0 && this.connected) {
      const item = this.queue.shift()!;
      try {
        const result = await this.rpcClient!.call(item.method, item.input);
        item.resolve(result);
      } catch (err) {
        this.log.warn("link.queued-call-failed", { method: item.method, error: err });
        item.reject(CrosslinkError.from(err));
      }
    }
  }

  private setState(state: ConnectionState, detail?: Record<string, unknown>): void {
    if (this.state !== state || detail) {
      this.log.debug("link.state", { from: this.state, to: state, ...(detail ?? {}) });
      this.state = state;
      this.options.onStateChange?.(state, detail);
    }
  }

  private isFatal(errors: unknown[]): boolean {
    return errors.some(
      (e) =>
        e instanceof CrosslinkError &&
        [ErrorCodes.DEVICE_REVOKED, ErrorCodes.UNAUTHORIZED, ErrorCodes.VERSION_UNSUPPORTED].includes(
          e.code as never
        )
    );
  }

  private requestFrame(
    transport: CrosslinkTransport,
    payload: Uint8Array,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(reject, new Error("handshake timed out")), timeoutMs);

      function finish(fail: typeof reject | typeof resolve, value?: unknown): void {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (fail === resolve && value !== undefined) resolve(value as Record<string, unknown>);
        else reject(value instanceof Error ? value : new Error(String(value ?? "handshake failed")));
      }

      transport.onData((data) => {
        try {
          const frame = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
          finish(resolve, frame);
        } catch (err) {
          finish(reject, err instanceof Error ? err : new Error("bad handshake frame"));
        }
      });
      transport.onClose(() => finish(reject, new Error("transport closed during handshake")));

      Promise.resolve()
        .then(() => transport.send(payload))
        .catch((err) => finish(reject, err instanceof Error ? err : new Error(String(err))));
    });
  }
}
