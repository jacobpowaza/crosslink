import WebSocket from "ws";
import { noopLogger, type CrosslinkTransport, type Logger } from "@crosslink/core";

const PING_INTERVAL_MS = 25_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** 4-byte big-endian stream id prefixed to every host-side binary frame. */
const STREAM_HEADER_BYTES = 4;

export interface RelayChannelInfo {
  /** base http(s) URL of the relay service */
  url: string;
  channelId: string;
}

export interface RelayChannelOptions {
  /** shared secret for a private relay (`Authorization: Bearer`) */
  authToken?: string;
  logger?: Logger;
}

/**
 * Host end of a relay channel.
 *
 * Keeps a single authenticated websocket (role=h; the bearer token never
 * leaves this process except over TLS to the relay) and synthesizes one
 * transport per attached client. The channel is multiplexed: several paired
 * devices can be relayed at once, each on its own stream id, so a phone on
 * cellular does not lock a laptop out of the same host.
 */
export class RelayChannel {
  private ws?: WebSocket;
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly streams = new Map<number, RelayClientTransport>();
  private attachCb?: (transport: CrosslinkTransport) => void;
  private closed = false;
  private readonly log: Logger;

  private constructor(
    readonly info: RelayChannelInfo,
    private token: string,
    private readonly options: RelayChannelOptions
  ) {
    this.log = (options.logger ?? noopLogger).child({
      component: "relay-channel",
      relay: info.url
    });
  }

  static async allocate(
    baseUrl: string,
    options: RelayChannelOptions = {}
  ): Promise<RelayChannel> {
    const { channelId, token } = await allocateChannel(baseUrl, options.authToken);
    return new RelayChannel({ url: baseUrl, channelId }, token, options);
  }

  /**
   * Allocates on the first reachable region, in caller preference order.
   * Authentication failures stop immediately (the same bad credential will
   * fail every region); availability/capacity failures fall through.
   */
  static async allocateAny(
    baseUrls: readonly string[],
    options: RelayChannelOptions = {}
  ): Promise<RelayChannel> {
    const failures: string[] = [];
    for (const baseUrl of [...new Set(baseUrls.map((url) => url.replace(/\/$/, "")))]) {
      try {
        return await RelayChannel.allocate(baseUrl, options);
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (/auth|token|unauthorized|forbidden|401|403/i.test(message)) throw error;
        failures.push(`${baseUrl}: ${message}`);
      }
    }
    throw new AggregateError(failures, "no relay region accepted a channel allocation");
  }

  get channelId(): string {
    return this.info.channelId;
  }

  get wsUrl(): string {
    return `${this.info.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
  }

  /** Number of clients currently relayed through this channel. */
  get activeClients(): number {
    return this.streams.size;
  }

  /** True while the channel websocket is open to the relay. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const query =
      `channel=${encodeURIComponent(this.info.channelId)}&role=h&mux=1` +
      `&token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(`${this.wsUrl}?${query}`, {
      ...(this.options.authToken
        ? { headers: { authorization: `Bearer ${this.options.authToken}` } }
        : {})
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay connect timeout")),
        CONNECT_TIMEOUT_MS
      );
      const settle = (err?: Error): void => {
        clearTimeout(timer);
        ws.off("message", onMsg);
        ws.off("error", onErr);
        ws.off("close", onClose);
        err ? reject(err) : resolve();
      };
      const onMsg = (raw: WebSocket.RawData, isBinary: boolean): void => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(raw.toString()) as { op?: string; mux?: boolean };
          if (msg.op === "host_ready") {
            if (msg.mux !== true) {
              settle(new Error("relay does not support multiplexed channels"));
              return;
            }
            settle();
          }
        } catch {
          /* ignore non-JSON control noise */
        }
      };
      const onErr = (err: Error): void => settle(err);
      const onClose = (code: number, reason: Buffer): void =>
        settle(new Error(`relay refused the channel: ${code} ${reason.toString() || ""}`.trim()));
      ws.on("message", onMsg);
      ws.once("error", onErr);
      ws.once("close", onClose);
    });

    this.log.info("relay.connected", { channel: this.info.channelId });

    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();

    ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.routeInbound(toBuffer(raw));
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.op === "peer_up") this.attachClient(Number(msg.stream ?? 0));
      if (msg.op === "peer_down") this.detachClient(Number(msg.stream ?? 0), "peer-detached");
    });

    ws.on("close", (code: number) => {
      clearInterval(this.pingTimer);
      this.detachAll("relay-disconnected");
      if (this.closed) return;
      this.log.warn("relay.dropped", { code });
      // 4404/4408 mean the relay no longer knows this channel (expired or
      // swept). Reconnecting to it would fail forever, so signal that the
      // caller must re-allocate and re-publish presence.
      this.onDropped?.({ needsReallocation: code === 4404 || code === 4408 });
    });
    ws.on("error", () => ws.terminate());
  }

  /**
   * Called when the relay link drops. `needsReallocation` distinguishes a
   * transient disconnect from a channel the relay has forgotten.
   */
  onDropped?: (info: { needsReallocation: boolean }) => void;

  /** Allocates a fresh channel id/token, e.g. after the old one expired. */
  async reallocate(): Promise<void> {
    const { channelId, token } = await allocateChannel(this.info.url, this.options.authToken);
    (this.info as { channelId: string }).channelId = channelId;
    this.token = token;
    this.log.info("relay.reallocated", { channel: channelId });
  }

  /** Registers the callback invoked with a fresh transport per attached client. */
  onClient(cb: (transport: CrosslinkTransport) => void): void {
    this.attachCb = cb;
    // Deliver any client that attached before the callback was registered.
    for (const transport of this.streams.values()) {
      if (transport.active) cb(transport);
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.detachAll("channel-closed");
    this.ws?.close(1000, "closing");
  }

  /** Sends one client's bytes, prefixed with its stream id. */
  sendToStream(streamId: number, bytes: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("relay channel is not connected"));
    }
    const framed = Buffer.allocUnsafe(bytes.length + STREAM_HEADER_BYTES);
    framed.writeUInt32BE(streamId, 0);
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(
      framed,
      STREAM_HEADER_BYTES
    );
    return new Promise((resolve, reject) => {
      ws.send(framed, { binary: true }, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Drops one client's stream without disturbing the others. */
  closeStream(streamId: number): void {
    this.streams.delete(streamId);
  }

  private routeInbound(buf: Buffer): void {
    if (buf.length < STREAM_HEADER_BYTES) return;
    const streamId = buf.readUInt32BE(0);
    const transport = this.streams.get(streamId);
    if (!transport) {
      // A frame for a stream we have not seen a peer_up for yet: attach it
      // rather than dropping the client's handshake on the floor.
      const created = this.attachClient(streamId);
      created?.feed(new Uint8Array(buf.subarray(STREAM_HEADER_BYTES)));
      return;
    }
    transport.feed(new Uint8Array(buf.subarray(STREAM_HEADER_BYTES)));
  }

  private attachClient(streamId: number): RelayClientTransport | undefined {
    const existing = this.streams.get(streamId);
    if (existing?.active) return existing;
    const transport = new RelayClientTransport(this, streamId);
    this.streams.set(streamId, transport);
    this.log.debug("relay.client-attached", { stream: streamId, active: this.streams.size });
    this.attachCb?.(transport);
    return transport;
  }

  private detachClient(streamId: number, reason: string): void {
    const transport = this.streams.get(streamId);
    if (!transport) return;
    this.streams.delete(streamId);
    this.log.debug("relay.client-detached", { stream: streamId, reason });
    transport.markClosed(reason);
  }

  private detachAll(reason: string): void {
    for (const streamId of [...this.streams.keys()]) this.detachClient(streamId, reason);
  }
}

async function allocateChannel(
  baseUrl: string,
  authToken?: string
): Promise<{ channelId: string; token: string }> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/channels`, {
    method: "POST",
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {}
  });
  if (res.status === 401) {
    throw new Error(
      "relay rejected the channel request: this relay requires an auth token (set CROSSLINK_RELAY_TOKEN or pass relayToken)"
    );
  }
  if (!res.ok) throw new Error(`relay channel allocation failed: ${res.status}`);
  const data = (await res.json()) as { channel_id: string; token: string };
  return { channelId: data.channel_id, token: data.token };
}

/**
 * One logical transport per relayed client session. Writes are forwarded into
 * the shared channel websocket under this client's stream id; closing it tears
 * down only that stream, never the channel or the other clients on it.
 */
class RelayClientTransport implements CrosslinkTransport {
  readonly kind = "crosslink-relayed";
  private _active = true;
  private dataCb?: (data: Uint8Array) => void;
  private closedCb?: (reason?: unknown) => void;

  constructor(
    private readonly channel: RelayChannel,
    readonly streamId: number
  ) {}

  get active(): boolean {
    return this._active;
  }

  /** Called by the owning channel when data arrives on this stream. */
  feed(data: Uint8Array): void {
    if (this._active) this.dataCb?.(data);
  }

  markClosed(reason?: unknown): void {
    if (!this._active) return;
    this._active = false;
    this.closedCb?.(reason);
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason?: unknown) => void): void {
    this.closedCb = cb;
  }

  send(bytes: Uint8Array): Promise<void> {
    if (!this._active) return Promise.reject(new Error("relay client transport closed"));
    return this.channel.sendToStream(this.streamId, bytes);
  }

  close(reason?: unknown): void {
    if (!this._active) return;
    this._active = false;
    this.closedCb?.(typeof reason === "string" ? reason : "closed");
    this.channel.closeStream(this.streamId);
  }
}

function toBuffer(raw: WebSocket.RawData): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return raw as Buffer;
}
