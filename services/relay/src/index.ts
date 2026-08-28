/**
 * Crosslink relay service - a dumb encrypted pipe.
 *
 * The relay forwards opaque binary frames between the host ("h") and client
 * ("c") ends of a channel. It holds no keys, cannot decrypt traffic, and only
 * observes unavoidable metadata: timing, volume, and channel identifiers.
 *
 * Channel creation is unauthenticated by default but returns a secret host
 * token; a channel is useless without either the token (host side) or the
 * random 128-bit channel id (client side). Operators running a private relay
 * set `authToken`, which gates channel creation and the host attach - one
 * shared secret makes a self-hosted relay closed to the internet at large.
 *
 * ## Multiplexing
 *
 * A host advertises one channel, but a person may have several paired devices
 * off-network at once. A host that connects with `mux=1` gets a multiplexed
 * channel: each attached client is assigned a stream id, and host-side binary
 * frames carry a 4-byte big-endian stream id prefix that the relay strips on
 * the way out and re-applies on the way in. Client-side framing is untouched,
 * so clients need no knowledge of any of this. Hosts that connect without
 * `mux=1` keep the original single-client behaviour.
 */
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

export interface RelayOptions {
  port?: number;
  host?: string;
  maxFrameBytes?: number;
  ratePerSec?: number;
  idleTimeoutMs?: number;
  maxChannelLifeMs?: number;
  /**
   * Shared secret required to create a channel and to attach as a host.
   * Presented as `Authorization: Bearer <token>` on POST /channels and as
   * `Authorization` or `?auth=` on the host websocket. Unset means open.
   */
  authToken?: string;
  /**
   * Optional second secret required of *clients*. Most deployments leave this
   * unset: knowledge of the 128-bit channel id already gates client attach,
   * and browser clients cannot hold a shared secret safely.
   */
  clientAuthToken?: string;
  /** Maximum simultaneously attached clients on a multiplexed channel. */
  maxClientsPerChannel?: number;
  /** Channels one IP may create per minute. */
  channelsPerMinutePerIp?: number;
  /** Hard cap on allocated channels held by this process. Default 10,000. */
  maxChannels?: number;
  /** Lifetime ingress-byte quota per channel. Default 1 GiB. */
  maxBytesPerChannel?: number;
  /** Sustained ingress bandwidth per channel. Default 4 MiB/s. */
  bytesPerSecondPerChannel?: number;
  /** Token-bucket burst allowance. Default 8 MiB. */
  byteBurstPerChannel?: number;
  /** Region identifier exposed by health/region discovery. */
  region?: string;
  /** Public URL clients should dial for this relay. */
  publicUrl?: string;
  /** Operator-configured failover catalog returned from `/regions`. */
  regions?: RelayRegion[];
}

export interface RelayRegion {
  id: string;
  url: string;
  priority?: number;
}

/** 4-byte big-endian stream id prefixed to host-side binary frames. */
export const STREAM_HEADER_BYTES = 4;

interface ClientEnd {
  streamId: number;
  ws: WebSocket;
  lastTraffic: number;
}

interface HostEnd {
  ws: WebSocket;
  lastTraffic: number;
  /** true when the host speaks the stream-id-prefixed framing */
  mux: boolean;
}

interface Channel {
  id: string;
  tokenHash: string;
  createdAt: number;
  host?: HostEnd;
  clients: Map<number, ClientEnd>;
  nextStreamId: number;
  bytesRelayed: number;
  byteTokens: number;
  byteTokenAt: number;
}

export interface RelayServer {
  port: number;
  close(): Promise<void>;
  stats(): { channels: number; active: number; bytesRelayed: number; clients: number; quotaDrops: number };
}

export function createRelayServer(options: RelayOptions = {}): Promise<RelayServer> {
  const limits = {
    maxFrameBytes: options.maxFrameBytes ?? 256 * 1024,
    ratePerSec: options.ratePerSec ?? 100,
    idleTimeoutMs: options.idleTimeoutMs ?? 600_000,
    maxChannelLifeMs: options.maxChannelLifeMs ?? 24 * 3600_000,
    maxClientsPerChannel: options.maxClientsPerChannel ?? 8,
    channelsPerMinutePerIp: options.channelsPerMinutePerIp ?? 30,
    maxChannels: options.maxChannels ?? 10_000,
    maxBytesPerChannel: options.maxBytesPerChannel ?? 1024 ** 3,
    bytesPerSecondPerChannel: options.bytesPerSecondPerChannel ?? 4 * 1024 ** 2,
    byteBurstPerChannel: options.byteBurstPerChannel ?? 8 * 1024 ** 2
  };
  const channels = new Map<string, Channel>();
  const creationWindows = new Map<string, { start: number; count: number }>();
  let quotaDrops = 0;

  const authOk = (presented: string | null | undefined, expected?: string): boolean => {
    if (!expected) return true;
    return constantTimeEq(presented ?? "", expected);
  };

  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    res.setHeader("content-type", "application/json");
    const url = req.url ?? "/";
    const ip = req.socket.remoteAddress ?? "unknown";

    if (url === "/health") {
      res.end(
        JSON.stringify({
          ok: true,
          service: "crosslink-relay",
          region: options.region ?? "local",
          auth: options.authToken ? "required" : "open"
        })
      );
      return;
    }
    if (url === "/regions") {
      const own = options.publicUrl
        ? [{ id: options.region ?? "local", url: options.publicUrl, priority: 0 }]
        : [];
      const regions = [...own, ...(options.regions ?? [])]
        .filter(validRelayRegion)
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
      res.end(JSON.stringify({ regions }));
      return;
    }
    if (url === "/stats") {
      // Operational metadata should not become an unauthenticated internet
      // endpoint on private deployments. The same operator token used for
      // channel creation gates stats when configured.
      if (!authOk(bearerFrom(req.headers.authorization), options.authToken)) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", "Bearer");
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (url === "/channels" && req.method === "POST") {
      if (!authOk(bearerFrom(req.headers.authorization), options.authToken)) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", 'Bearer realm="crosslink-relay"');
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const now = Date.now();
      if (channels.size >= limits.maxChannels) {
        res.statusCode = 503;
        res.setHeader("retry-after", "30");
        res.end(JSON.stringify({ error: "capacity_exceeded" }));
        return;
      }
      let win = creationWindows.get(ip);
      if (!win || now - win.start > 60_000) {
        win = { start: now, count: 0 };
        creationWindows.set(ip, win);
      }
      win.count += 1;
      if (win.count > limits.channelsPerMinutePerIp) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      const channelId = randomBytes(16).toString("hex");
      const token = randomBytes(32).toString("hex");
      channels.set(channelId, {
        id: channelId,
        tokenHash: sha256Hex(token),
        createdAt: now,
        clients: new Map(),
        nextStreamId: 1,
        bytesRelayed: 0,
        byteTokens: limits.byteBurstPerChannel,
        byteTokenAt: now
      });
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          channel_id: channelId,
          token,
          max_clients: limits.maxClientsPerChannel,
          max_bytes: limits.maxBytesPerChannel,
          region: options.region ?? "local"
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ server, maxPayload: limits.maxFrameBytes });

  wss.on("connection", (ws, req) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const channelId = u.searchParams.get("channel") ?? "";
    const role = u.searchParams.get("role");
    const token = u.searchParams.get("token") ?? "";
    const presentedAuth =
      bearerFrom(req.headers.authorization) ?? u.searchParams.get("auth") ?? "";

    const channel = channels.get(channelId);
    if (!channel || Date.now() - channel.createdAt > limits.maxChannelLifeMs) {
      if (channel) channels.delete(channelId);
      ws.close(4404, "unknown-channel");
      return;
    }

    /** stream id of this connection when role === "c" */
    let streamId = 0;

    if (role === "h") {
      if (!authOk(presentedAuth, options.authToken)) {
        ws.close(4401, "unauthorized");
        return;
      }
      if (!constantTimeEq(channel.tokenHash, sha256Hex(token))) {
        ws.close(4403, "bad-token");
        return;
      }
      const mux = u.searchParams.get("mux") === "1";
      channel.host?.ws.close(4429, "replaced");
      channel.host = { ws, lastTraffic: Date.now(), mux };
      // Acknowledge registration immediately so hosts can await it, and tell
      // the host which framing this channel agreed on.
      ws.send(JSON.stringify({ op: "host_ready", mux, max_clients: limits.maxClientsPerChannel }));
      // A host reconnecting to a channel with clients already attached must
      // learn about them, otherwise those streams are orphaned.
      for (const client of channel.clients.values()) {
        ws.send(JSON.stringify({ op: "peer_up", ...(mux ? { stream: client.streamId } : {}) }));
      }
    } else if (role === "c") {
      if (!authOk(presentedAuth, options.clientAuthToken)) {
        ws.close(4401, "unauthorized");
        return;
      }
      const muxed = channel.host?.mux === true;
      if (!muxed) {
        // Legacy single-client channel: one at a time, as before.
        const existing = [...channel.clients.values()].find(
          (c) => c.ws.readyState === WebSocket.OPEN
        );
        if (existing) {
          ws.close(4409, "channel-busy");
          return;
        }
        channel.clients.clear();
      } else if (channel.clients.size >= limits.maxClientsPerChannel) {
        ws.close(4429, "too-many-clients");
        return;
      }
      streamId = channel.nextStreamId++;
      channel.clients.set(streamId, { streamId, ws, lastTraffic: Date.now() });
    } else {
      ws.close(4400, "bad-role");
      return;
    }

    // A protocol-level receiver failure (oversized or malformed frame) is
    // emitted as an 'error' with no default handler, which takes the whole
    // process down. A misbehaving client must cost one connection, not the
    // relay, so absorb it and let the close handler clean up.
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });

    let windowStart = Date.now();
    let windowCount = 0;

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      windowCount += 1;
      if (windowCount > limits.ratePerSec) {
        ws.close(4429, "rate");
        return;
      }

      if (isBinary) {
        const buf = toBuffer(raw);
        if (buf.length > limits.maxFrameBytes) {
          ws.close(4409, "frame-too-large");
          return;
        }
        const quota = consumeBytes(channel, buf.length, now);
        if (quota === "lifetime") {
          quotaDrops += 1;
          channel.host?.ws.close(4408, "quota-exhausted");
          for (const client of channel.clients.values()) client.ws.close(4408, "quota-exhausted");
          channels.delete(channel.id);
          return;
        }
        if (quota === "rate") {
          quotaDrops += 1;
          ws.close(4429, "bandwidth-quota");
          return;
        }
        if (role === "h") {
          forwardFromHost(channel, buf, ws);
        } else {
          forwardFromClient(channel, buf, streamId);
        }
        touch(channel, now);
        channel.bytesRelayed += buf.length;
        return;
      }

      try {
        const msg = JSON.parse(raw.toString()) as { op?: string };
        if (msg.op !== "ping") {
          ws.close(4400, "control-not-allowed");
          return;
        }
        ws.send(JSON.stringify({ op: "pong" }));
      } catch {
        ws.close(4400, "bad-control");
      }
    });

    ws.on("close", () => {
      if (role === "h") {
        if (channel.host?.ws !== ws) return;
        const mux = channel.host.mux;
        channel.host = undefined;
        // Every client on a host-less channel is stranded; tell them so they
        // can fail fast and re-dial rather than waiting out a heartbeat.
        for (const client of channel.clients.values()) {
          sendJson(client.ws, { op: "peer_down" });
        }
        void mux;
        return;
      }
      const client = channel.clients.get(streamId);
      if (!client || client.ws !== ws) return;
      channel.clients.delete(streamId);
      if (channel.host) {
        sendJson(channel.host.ws, {
          op: "peer_down",
          ...(channel.host.mux ? { stream: streamId } : {})
        });
      }
    });

    queueMicrotask(() => {
      if (role !== "c") return;
      // Announce client arrival to both ends of the pipe.
      if (channel.host) {
        sendJson(channel.host.ws, {
          op: "peer_up",
          ...(channel.host.mux ? { stream: streamId } : {})
        });
      }
      sendJson(ws, { op: "peer_up" });
    });
  });

  /** host -> client: strip the stream prefix and route to that client. */
  function forwardFromHost(channel: Channel, buf: Buffer, from: WebSocket): void {
    if (channel.host?.ws !== from) return;
    if (!channel.host.mux) {
      const only = [...channel.clients.values()][0];
      if (only && only.ws.readyState === WebSocket.OPEN) {
        only.ws.send(buf, { binary: true });
      }
      return;
    }
    if (buf.length < STREAM_HEADER_BYTES) {
      from.close(4400, "missing-stream-header");
      return;
    }
    const target = channel.clients.get(buf.readUInt32BE(0));
    if (!target || target.ws.readyState !== WebSocket.OPEN) return;
    target.ws.send(buf.subarray(STREAM_HEADER_BYTES), { binary: true });
  }

  /** client -> host: prefix the stream id so the host can demultiplex. */
  function forwardFromClient(channel: Channel, buf: Buffer, streamId: number): void {
    const host = channel.host;
    if (!host || host.ws.readyState !== WebSocket.OPEN) return;
    if (!host.mux) {
      host.ws.send(buf, { binary: true });
      return;
    }
    const framed = Buffer.allocUnsafe(buf.length + STREAM_HEADER_BYTES);
    framed.writeUInt32BE(streamId, 0);
    buf.copy(framed, STREAM_HEADER_BYTES);
    host.ws.send(framed, { binary: true });
  }

  function touch(channel: Channel, now: number): void {
    if (channel.host) channel.host.lastTraffic = now;
    for (const client of channel.clients.values()) client.lastTraffic = now;
  }

  function snapshot(): { channels: number; active: number; bytesRelayed: number; clients: number; quotaDrops: number } {
    let active = 0;
    let clients = 0;
    let bytes = 0;
    for (const channel of channels.values()) {
      if (channel.host && channel.clients.size > 0) active += 1;
      clients += channel.clients.size;
      bytes += channel.bytesRelayed;
    }
    return { channels: channels.size, active, bytesRelayed: bytes, clients, quotaDrops };
  }

  function consumeBytes(channel: Channel, bytes: number, now: number): "ok" | "rate" | "lifetime" {
    if (channel.bytesRelayed + bytes > limits.maxBytesPerChannel) return "lifetime";
    const elapsedSeconds = Math.max(0, now - channel.byteTokenAt) / 1000;
    channel.byteTokens = Math.min(
      limits.byteBurstPerChannel,
      channel.byteTokens + elapsedSeconds * limits.bytesPerSecondPerChannel
    );
    channel.byteTokenAt = now;
    if (bytes > channel.byteTokens) return "rate";
    channel.byteTokens -= bytes;
    return "ok";
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, channel] of channels) {
      const expired = now - channel.createdAt > limits.maxChannelLifeMs;
      const hostIdle = !channel.host || now - channel.host.lastTraffic > limits.idleTimeoutMs;
      const clientsIdle = [...channel.clients.values()].every(
        (c) => now - c.lastTraffic > limits.idleTimeoutMs
      );
      if (expired || (hostIdle && clientsIdle)) {
        channel.host?.ws.close(4408, "expired");
        for (const client of channel.clients.values()) client.ws.close(4408, "expired");
        channels.delete(id);
      }
    }
    if (creationWindows.size > 10_000) creationWindows.clear();
  }, 30_000);

  const port = options.port ?? 0;
  return new Promise((resolve) => {
    server.listen(port, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
        stats: snapshot,
        close: () =>
          new Promise<void>((resolveClose) => {
            clearInterval(sweeper);
            for (const client of wss.clients) client.terminate();
            wss.close(() => server.close(() => resolveClose()));
          })
      });
    });
  });
}

function toBuffer(raw: RawData): Buffer {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  return raw as Buffer;
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function validRelayRegion(region: RelayRegion): boolean {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(region.id)) return false;
  try {
    const parsed = new URL(region.url);
    return parsed.protocol === "https:" || parsed.protocol === "wss:" ||
      ((parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
        (parsed.protocol === "http:" || parsed.protocol === "ws:"));
  } catch {
    return false;
  }
}

/** Extracts the credential from an `Authorization: Bearer <token>` header. */
function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function constantTimeEq(a: string, b: string): boolean {
  // Compare digests so the comparison is length-independent: a raw
  // timingSafeEqual leaks the secret's length through the early return.
  const ba = Buffer.from(sha256Hex(a), "hex");
  const bb = Buffer.from(sha256Hex(b), "hex");
  return timingSafeEqual(ba, bb);
}
