import http from "node:http";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import type { CrosslinkTransport } from "@crosslink/core";

export interface LanListener {
  port: number;
  /** best-guess LAN address for QR-less manual entry */
  address?: string;
  url(): string;
  close(): Promise<void>;
}

export interface LanListenerOptions {
  port?: number;
  bind?: "loopback" | "all";
  /** Address to advertise for LAN pairing. Overrides interface auto-detection;
   *  see {@link resolveLanHost}. */
  host?: string;
  /**
   * Serves plain HTTP on the same port as the Crosslink WebSocket.
   *
   * One port means one router mapping: the phone's installable bootstrap page
   * and the transport it connects over share an address, so remote access does
   * not need a second forwarded port that nothing maps. Unhandled requests fall
   * through to the default JSON probe response.
   */
  httpHandler?(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>;
  /**
   * Frame cap applied once a connection has completed its first message
   * (see {@link preAuthMaxPayloadBytes}). This is also what's passed to
   * `ws` as its server-wide `maxPayload`, since `ws` only supports one
   * value for every connection regardless of state.
   */
  maxPayloadBytes?: number;
  /**
   * Frame cap applied to a connection's very first message, before it has
   * proven anything about itself. `ws`'s `maxPayload` can't vary by
   * connection state, so this is enforced explicitly in the message
   * handler, ahead of `maxPayloadBytes`: `ws` still buffers up to
   * `maxPayloadBytes` while receiving, but this check runs before that
   * first frame is handed to the transport consumer, so an oversized
   * pre-auth frame never reaches JSON.parse. A `sinit`/`pair_hello`/
   * `pair_claim` handshake frame is a few hundred bytes at most; 16 KiB
   * (matching the pairing-blob cap signaling enforces elsewhere) is
   * already generous headroom. Default 16 KiB.
   */
  preAuthMaxPayloadBytes?: number;
  /**
   * Concurrent connections this listener accepts before refusing new
   * upgrades. Without a cap, an attacker on the LAN can open sockets
   * without bound and exhaust file descriptors / memory. A LAN listener
   * only ever expects a handful of paired devices for one household or
   * office, so 64 is generous while still bounding the blast radius.
   * Default 64.
   */
  maxConnections?: number;
  /**
   * Browser origins allowed to open a WebSocket to this listener, beyond the
   * listener's own origin.
   *
   * A page on any website can open `ws://192.168.1.83:8100` from a visitor's
   * browser, and DNS rebinding can make a hostile page look same-origin to the
   * network. Such a page cannot finish a Crosslink handshake — it has no device
   * key and no pairing code — but there is no reason to let it try, so
   * cross-origin browser upgrades are refused by default.
   *
   * Pass a function when the set is not known at startup. The host uses this to
   * admit every address it advertises: the bootstrap page a phone installs may
   * have been fetched over the public address while the socket it then opens is
   * the LAN one, which is cross-origin by the letter of the rule and entirely
   * legitimate.
   *
   * Requests with no `Origin` header (native apps, CLI clients, the SDK's own
   * WebSocket in Node) are always allowed: `Origin` is a browser guarantee, and
   * its absence is not a signal of anything.
   */
  allowedOrigins?: string[] | (() => string[]);
  /**
   * Time a connection may sit open without sending a first message before
   * it's terminated. Guards against sockets opened and held idle - never
   * completing a handshake - purely to consume a slot. Default 10s.
   */
  handshakeTimeoutMs?: number;
  /**
   * Idle timeout for connections that *have* completed a first message.
   * Paired with a keepalive ping (see {@link keepaliveIntervalMs}) so a
   * silent-but-alive connection isn't reaped out from under a real peer.
   * Default 10 minutes.
   */
  idleTimeoutMs?: number;
  /** How often the idle/handshake sweep runs and established connections
   *  are pinged. Default 30s. */
  keepaliveIntervalMs?: number;
  onConnection(transport: CrosslinkTransport): void;
}

export function firstLanAddress(): string | undefined {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

/**
 * Picks the address advertised to phones/tablets for LAN pairing.
 *
 * Auto-detection (`firstLanAddress`) just grabs the first non-internal IPv4
 * interface, which is wrong on any machine with more than one active network
 * (e.g. Wi-Fi + a wired adapter, or two Wi-Fi radios) - the guessed address
 * may not be reachable from a device on the *other* network. `explicit` (a
 * `lan.host` config value) and `CROSSLINK_LAN_HOST` let the app - or whoever
 * is running it - pin the exact address to advertise instead.
 */
export function resolveLanHost(explicit?: string): string | undefined {
  return explicit ?? process.env.CROSSLINK_LAN_HOST ?? firstLanAddress();
}

/** Per-connection bookkeeping shared between the message handler (which
 *  updates it) and the sweep interval (which reads it). */
interface ConnState {
  ws: WebSocket;
  lastTraffic: number;
  /** true once this connection has received one message within the
   *  pre-auth cap; gates which payload cap and which timeout apply. */
  handshakeDone: boolean;
  /** cleared on ping, set on pong; a connection that misses a beat is
   *  presumed dead and reaped on the next sweep. */
  alive: boolean;
}

export function startLanListener(options: LanListenerOptions): Promise<LanListener> {
  const bind = options.bind ?? "loopback";
  const limits = {
    maxPayloadBytes: options.maxPayloadBytes ?? 8 * 1024 * 1024,
    preAuthMaxPayloadBytes: options.preAuthMaxPayloadBytes ?? 16 * 1024,
    maxConnections: options.maxConnections ?? 64,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 600_000,
    keepaliveIntervalMs: options.keepaliveIntervalMs ?? 30_000
  };
  const allowedOrigins = (): Set<string> => {
    const list =
      typeof options.allowedOrigins === "function"
        ? options.allowedOrigins()
        : (options.allowedOrigins ?? []);
    return new Set(list.map((o) => o.toLowerCase()));
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (options.httpHandler) {
        void Promise.resolve(options.httpHandler(req, res)).catch(() => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        });
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "crosslink-lan" }));
    });
    // `ws` re-emits the HTTP server's errors on the WebSocketServer, and an
    // 'error' event with no listener is an unhandled throw that takes the
    // process down. Without this, a caller's EADDRINUSE fallback never gets to
    // run: the promise rejects and the process dies anyway.
    let settled = false;
    // Set once the pieces that need tearing down exist; a failure before that
    // has nothing to clean up.
    let cleanup: (() => void) | undefined;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup?.();
      reject(err);
    };
    server.on("error", fail);

    // ws applies maxPayload uniformly to every connection regardless of
    // state, so it's set to the larger post-handshake limit; the smaller
    // pre-auth limit is enforced explicitly in adaptServerSocket, ahead of
    // handing the frame to the transport consumer (see preAuthMaxPayloadBytes).
    const wss = new WebSocketServer({
      server,
      maxPayload: limits.maxPayloadBytes,
      verifyClient: (
        info: { origin: string; req: http.IncomingMessage },
        cb: (ok: boolean, code?: number, message?: string) => void
      ) => {
        const ok = isOriginAllowed(info.origin, info.req.headers.host, allowedOrigins());
        // 403 rather than ws's default 401: nothing about this is a missing
        // credential, and a wrong status sends whoever debugs it looking for one.
        cb(ok, 403, "origin not allowed");
      }
    });

    wss.on("error", fail);

    const states = new Set<ConnState>();

    wss.on("connection", (ws, req) => {
      // Concurrent-connection cap: without this, an attacker can open
      // sockets without bound and hold them, exhausting file descriptors
      // and memory well before any per-message limit engages.
      if (states.size >= limits.maxConnections) {
        ws.close(4429, "too-many-connections");
        return;
      }

      const state: ConnState = { ws, lastTraffic: Date.now(), handshakeDone: false, alive: true };
      states.add(state);
      ws.on("close", () => states.delete(state));
      ws.on("pong", () => {
        state.alive = true;
      });

      options.onConnection(
        // lazy import avoids cycle; inline adapter here instead
        adaptServerSocket(ws, req.socket.remoteAddress, state, limits.preAuthMaxPayloadBytes)
      );
    });

    // Mirrors the relay's sweeper: connections that never complete a
    // handshake are reaped after handshakeTimeoutMs (they're either dead or
    // hostile - a real peer sends its first frame immediately on connect);
    // established connections get a ping/pong keepalive and are reaped
    // after idleTimeoutMs of silence with no live pong.
    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const state of states) {
        if (!state.handshakeDone) {
          if (now - state.lastTraffic > limits.handshakeTimeoutMs) state.ws.terminate();
          continue;
        }
        if (!state.alive) {
          state.ws.terminate();
          continue;
        }
        if (now - state.lastTraffic > limits.idleTimeoutMs) {
          state.alive = false;
          try {
            state.ws.ping();
          } catch {
            /* noop */
          }
        }
      }
    }, limits.keepaliveIntervalMs);

    cleanup = () => {
      clearInterval(sweeper);
      wss.close();
      server.close();
    };

    const host = bind === "all" ? "0.0.0.0" : "127.0.0.1";
    server.listen(options.port ?? 0, host, () => {
      settled = true;
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (options.port ?? 0);
      const lanAddr = bind === "all" ? resolveLanHost(options.host) : undefined;
      resolve({
        port,
        address: lanAddr,
        url: () => (lanAddr ? `ws://${lanAddr}:${port}` : `ws://127.0.0.1:${port}`),
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

function messageLength(raw: WebSocket.RawData): number {
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0);
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return (raw as Buffer).length;
}

function adaptServerSocket(
  ws: WebSocket,
  remoteAddress: string | undefined,
  state: ConnState,
  preAuthMaxPayloadBytes: number
): CrosslinkTransport {
  let dataHandler: ((data: Uint8Array) => void) | undefined;
  let closeHandler: ((reason?: unknown) => void) | undefined;
  let closed = false;
  ws.on("message", (raw: WebSocket.RawData) => {
    if (closed) return;
    state.lastTraffic = Date.now();
    if (!state.handshakeDone) {
      // Reject before this frame is handed to the transport consumer (and
      // so before it's ever JSON.parse'd) - an unauthenticated peer gets
      // one shot at a small handshake frame, not the full application
      // payload budget.
      if (messageLength(raw) > preAuthMaxPayloadBytes) {
        closed = true;
        try {
          ws.close(4409, "handshake-frame-too-large");
        } catch {
          /* noop */
        }
        return;
      }
      state.handshakeDone = true;
    }
    const buf = Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer);
    dataHandler?.(new Uint8Array(buf));
  });
  ws.on("close", () => {
    if (closed) return;
    closed = true;
    closeHandler?.("lan-closed");
  });
  ws.on("error", () => {
    if (closed) return;
    closed = true;
    closeHandler?.("lan-error");
  });
  return {
    kind: "lan",
    remoteAddress,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    send(bytes) {
      if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("lan transport closed"));
      return new Promise((resolve, reject) => {
        ws.send(Buffer.from(bytes), { binary: true }, (err) => (err ? reject(err) : resolve()));
      });
    },
    close(reason) {
      if (closed) return;
      try {
        ws.close(1000, typeof reason === "string" ? reason.slice(0, 100) : undefined);
      } catch {
        /* noop */
      }
    }
  };
}

/**
 * Same-origin check for a WebSocket upgrade.
 *
 * The bootstrap page a phone installs is served from this very listener, so its
 * `Origin` matches the `Host` it connects to; anything else is a third-party
 * page reaching into the local network.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: ReadonlySet<string>
): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (Boolean(host) && originHost === String(host).toLowerCase()) return true;
  // Compared by host rather than by full origin so http:// and https:// forms
  // of the same advertised address both pass.
  for (const entry of allowed) {
    try {
      if (new URL(entry).host.toLowerCase() === originHost) return true;
    } catch {
      if (entry.toLowerCase() === originHost) return true;
    }
  }
  return false;
}
