/**
 * Crosslink signaling service.
 *
 * A tiny presence directory + pairing-code router. It never sees plaintext
 * application data: pairing payloads are opaque signed blobs routed by hashed
 * code, and presence entries are signed by host identity keys.
 *
 * State is in-memory and cheap to rebuild; horizontal scaling can add Redis
 * pub/sub behind the same interface later (see docs/guides/self-hosting.mdx).
 */
import http from "node:http";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const MAX_BLOB_BYTES = 16 * 1024;
const HOST_STALE_MS = 90_000;
const SWEEP_INTERVAL_MS = 30_000;
const MAX_MSGS_PER_WINDOW = 120;
const WINDOW_MS = 10_000;
// A pairing code is a live 9-digit secret with a 120s TTL; the message
// rate limit already bounds one connection's guess throughput, but nothing
// stopped an attacker from mass-opening connections to multiply it. This
// cap is generous for real users - several devices/tabs behind one carrier-
// grade NAT - while still bounding how many parallel guessers one IP can
// run inside a code's lifetime.
const DEFAULT_MAX_CONNECTIONS_PER_IP = 50;
// Exceeding the per-connection rate limit only warned; an offender could
// keep the connection open and keep sending indefinitely. This grace
// allowance lets one legitimate burst through with a warning before the
// connection is actually closed.
const DEFAULT_RATE_LIMIT_VIOLATIONS_BEFORE_CLOSE = 3;
// A host normally has at most a couple of concurrent pairing sessions in
// flight (one QR code, maybe a retry). Without a cap, host_hello/pair_open
// let a single connection's `pairs` map grow without bound between sweeps.
const DEFAULT_MAX_PAIRS_PER_HOST = 20;
// Signaling is meant to double as a public directory, so this is generous,
// but an unbounded `conns`/`byApp` map from repeated host_hello calls is
// still unbounded memory growth between sweeps.
const DEFAULT_MAX_HOSTS = 5_000;

interface PresenceInfo {
  appId: string;
  name: string;
  fingerprint: string;
  pubEdB64: string;
  pubXB64: string;
  versions: string[];
  relay?: { url: string; channel: string };
  lan?: { host: string; port: number };
}

interface PairSession {
  psid: string;
  codeHash: string;
  expiresAt: number;
}

interface HostConn {
  kind: "host";
  ws: WebSocket;
  presence: PresenceInfo;
  pairs: Map<string, PairSession>;
  lastSeen: number;
}

interface PeerConn {
  kind: "peer";
  ws: WebSocket;
  lastSeen: number;
}

type Conn = HostConn | PeerConn;

export interface SignalingOptions {
  port?: number;
  host?: string;
  /** advertised in /health for operators */
  region?: string;
  /**
   * Shared secret a host must present to register presence. Sent as
   * `Authorization: Bearer <token>` on the websocket upgrade, or as `?auth=`.
   * Unset means any host may register (fine for a public directory, wrong for
   * a private self-hosted one).
   *
   * Clients never need this: resolving a pairing code already requires the
   * code itself, and a browser cannot hold a shared secret safely.
   */
  authToken?: string;
  /** Concurrent WebSocket connections one IP may hold open. Default 50. */
  maxConnectionsPerIp?: number;
  /** Rate-limit warnings a connection gets before it's disconnected. Default 3. */
  rateLimitViolationsBeforeClose?: number;
  /** Concurrent pairing sessions (`pair_open` calls) one host connection may
   *  register at once. Default 20. */
  maxPairsPerHost?: number;
  /** Total distinct hosts (by appId) this instance will register at once. Default 5000. */
  maxHosts?: number;
}

export interface SignalingServer {
  port: number;
  close(): Promise<void>;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function createSignalingServer(options: SignalingOptions = {}): Promise<SignalingServer> {
  return new Promise((resolve) => {
    const limits = {
      maxConnectionsPerIp: options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP,
      rateLimitViolationsBeforeClose:
        options.rateLimitViolationsBeforeClose ?? DEFAULT_RATE_LIMIT_VIOLATIONS_BEFORE_CLOSE,
      maxPairsPerHost: options.maxPairsPerHost ?? DEFAULT_MAX_PAIRS_PER_HOST,
      maxHosts: options.maxHosts ?? DEFAULT_MAX_HOSTS
    };
    const conns = new Map<string, Conn>();
    const byApp = new Map<string, string>();
    const connsByIp = new Map<string, number>();

    const hostAuthOk = (presented: string): boolean => {
      if (!options.authToken) return true;
      return constantTimeEq(presented, options.authToken);
    };

    const server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      res.setHeader("content-type", "application/json");
      // Presence is public routing metadata (signaling is untrusted by design);
      // browser clients must be able to read it cross-origin.
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET, OPTIONS");
      res.setHeader("x-content-type-options", "nosniff");
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url === "/health") {
        res.end(
          JSON.stringify({
            ok: true,
            service: "crosslink-signaling",
            region: options.region ?? "local",
            hosts: byApp.size,
            hostAuth: options.authToken ? "required" : "open"
          })
        );
        return;
      }
      if (url === "/apps" || url?.startsWith("/apps/")) {
        const wanted = url.startsWith("/apps/") ? decodeURIComponent(url.slice(6)) : null;
        const apps = [...conns.values()]
          .filter((c): c is HostConn => c.kind === "host")
          .filter((c) => !wanted || c.presence.appId === wanted)
          .map((c) => ({ ...c.presence }));
        if (wanted && apps.length === 0) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not_found" }));
          return;
        }
        res.end(JSON.stringify(wanted ? apps[0] : apps));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });

    const wss = new WebSocketServer({ server, maxPayload: MAX_BLOB_BYTES * 2 });

    wss.on("connection", (ws, req) => {
      const ip = req.socket.remoteAddress ?? "unknown";
      // Per-IP concurrent-connection cap: message-rate limiting is per
      // *connection*, so without this an attacker multiplies pair_resolve
      // throughput - and thus brute-force speed against a live pairing
      // code - simply by opening more sockets.
      const ipCount = (connsByIp.get(ip) ?? 0) + 1;
      if (ipCount > limits.maxConnectionsPerIp) {
        ws.close(4429, "too-many-connections");
        return;
      }
      connsByIp.set(ip, ipCount);
      let ipCounted = true;
      const releaseIp = (): void => {
        if (!ipCounted) return;
        ipCounted = false;
        const remaining = (connsByIp.get(ip) ?? 1) - 1;
        if (remaining <= 0) connsByIp.delete(ip);
        else connsByIp.set(ip, remaining);
      };

      const connId = randomUUID();
      const presentedAuth =
        bearerFrom(req.headers.authorization) ??
        new URL(req.url ?? "/", "http://localhost").searchParams.get("auth") ??
        "";
      const conn: PeerConn = { kind: "peer", ws, lastSeen: Date.now() };
      conns.set(connId, conn);
      let windowStart = Date.now();
      let windowCount = 0;
      let rateViolations = 0;

      const send = (obj: unknown): boolean => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(obj));
        return true;
      };

      // As on the relay: a receiver-level failure must cost this connection,
      // not the process. Must also release the per-IP slot, or a peer that
      // errors out (rather than closing cleanly) permanently eats into its
      // IP's cap.
      ws.on("error", () => {
        releaseIp();
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      });

      const tooFast = (): boolean => {
        const now = Date.now();
        if (now - windowStart > WINDOW_MS) {
          windowStart = now;
          windowCount = 0;
        }
        windowCount += 1;
        return windowCount > MAX_MSGS_PER_WINDOW;
      };

      ws.on("message", (raw: RawData) => {
        conn.lastSeen = Date.now();
        if (tooFast()) {
          rateViolations += 1;
          send({ op: "error", error: { code: "rate_limited", message: "slow down" } });
          // A legitimate client gets a few warnings for one burst; past
          // that it's either broken or hostile, and staying connected only
          // keeps costing us a message budget and (previously) nothing else.
          if (rateViolations > limits.rateLimitViolationsBeforeClose) {
            ws.close(4429, "rate_limited");
          }
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          send({ op: "error", error: { code: "invalid_message", message: "bad json" } });
          return;
        }

        switch (msg.op) {
          case "host_hello": {
            if (!hostAuthOk(presentedAuth)) {
              send({ op: "error", error: { code: "unauthorized", message: "host token required" } });
              ws.close(4401, "unauthorized");
              return;
            }
            const app = msg.app as Partial<PresenceInfo> | undefined;
            if (
              !app ||
              typeof app.appId !== "string" ||
              typeof app.pubEdB64 !== "string" ||
              typeof app.fingerprint !== "string"
            ) {
              send({ op: "error", error: { code: "invalid_message", message: "missing app fields" } });
              return;
            }
            if (byApp.has(app.appId) && byApp.get(app.appId) !== connId) {
              // previous registration for this app is superseded
              const old = conns.get(byApp.get(app.appId)!);
              if (old && old.kind === "host") {
                old.ws.close(4000, "superseded");
              }
            } else if (!byApp.has(app.appId) && byApp.size >= limits.maxHosts) {
              // Only a genuinely new appId consumes a slot; re-registering
              // (or superseding) an existing one does not, so this can't be
              // used to lock out the app that's already at capacity.
              send({ op: "error", error: { code: "capacity_exceeded", message: "too many registered hosts" } });
              return;
            }
            const host: HostConn = {
              kind: "host",
              ws,
              presence: {
                appId: app.appId,
                name: String(app.name ?? app.appId),
                fingerprint: app.fingerprint,
                pubEdB64: app.pubEdB64,
                pubXB64: String(app.pubXB64 ?? ""),
                versions: Array.isArray(app.versions) ? app.versions.map(String) : [],
                ...(app.relay ? { relay: app.relay as PresenceInfo["relay"] } : {}),
                ...(app.lan ? { lan: app.lan as PresenceInfo["lan"] } : {})
              },
              pairs: new Map(),
              lastSeen: Date.now()
            };
            conns.set(connId, host);
            byApp.set(app.appId, connId);
            send({ op: "host_ok", conn: connId });
            break;
          }

          case "pair_open": {
            const host = assertHost(conns.get(connId));
            if (!host) {
              send({ op: "error", error: { code: "unauthorized", message: "register first" } });
              return;
            }
            const psid = String(msg.psid ?? "");
            const codeHash = String(msg.code_hash ?? "");
            if (!psid || !codeHash) {
              send({ op: "error", error: { code: "invalid_message", message: "missing psid/code_hash" } });
              return;
            }
            if (!host.pairs.has(psid) && host.pairs.size >= limits.maxPairsPerHost) {
              send({ op: "error", error: { code: "capacity_exceeded", message: "too many pairing sessions" } });
              return;
            }
            host.pairs.set(psid, {
              psid,
              codeHash,
              expiresAt: Date.now() + Math.min(Number(msg.ttl_ms ?? 120_000), 300_000)
            });
            break;
          }

          case "hb": {
            const conn0 = conns.get(connId);
            if (conn0) conn0.lastSeen = Date.now();
            break;
          }

          case "pair_resolve": {
            const rawCode = typeof msg.code === "string" ? msg.code : "";
            const normalizedCode = rawCode.replace(/\D/g, "");
            const codeHash = String(normalizedCode.length === 9 ? sha256Hex(normalizedCode) : "");
            const target = [...conns.values()].find(
              (c): c is HostConn =>
                c.kind === "host" &&
                [...c.pairs.values()].some(
                  (p) => p.codeHash === codeHash && p.expiresAt > Date.now()
                )
            );
            if (!target) {
              send({ op: "pair_not_found" });
              return;
            }
            const pair = [...target.pairs.values()].find(
              (p) => p.codeHash === codeHash && p.expiresAt > Date.now()
            )!;
            send({
              op: "pair_found",
              psid: pair.psid,
              host_conn: byApp.get(target.presence.appId) ?? "",
              app: target.presence
            });
            break;
          }

          case "pair_payload": {
            // Bidirectional opaque blob routing during a pairing exchange.
            const to = String(msg.to ?? "");
            const blob = msg.blob;
            if (typeof blob !== "string" || blob.length > MAX_BLOB_BYTES) {
              send({ op: "error", error: { code: "payload_too_large", message: "blob too large" } });
              return;
            }
            const dest = conns.get(to);
            if (!dest) {
              send({ op: "error", error: { code: "not_found", message: "destination unknown" } });
              return;
            }
            dest.ws.send(
              JSON.stringify({
                op: "pair_deliver",
                from: connId,
                blob
              })
            );
            break;
          }

          default:
            send({ op: "error", error: { code: "invalid_message", message: `unknown op ${String(msg.op)}` } });
        }
      });

      ws.on("close", () => {
        releaseIp();
        const conn0 = conns.get(connId);
        conns.delete(connId);
        if (conn0?.kind === "host") {
          if (byApp.get(conn0.presence.appId) === connId) byApp.delete(conn0.presence.appId);
        }
      });
    });

    const sweeper = setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of conns) {
        if (now - conn.lastSeen > HOST_STALE_MS) {
          conn.ws.close(4001, "stale");
          conns.delete(id);
          if (conn.kind === "host" && byApp.get(conn.presence.appId) === id) {
            byApp.delete(conn.presence.appId);
          }
        } else if (conn.kind === "host") {
          for (const [psid, pair] of conn.pairs) {
            if (pair.expiresAt < now - 5_000) conn.pairs.delete(psid);
          }
        }
      }
    }, SWEEP_INTERVAL_MS);

    const port = options.port ?? 0;
    server.listen(port, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        port: actualPort,
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

function assertHost(conn: Conn | undefined): HostConn | null {
  return conn && conn.kind === "host" ? conn : null;
}

/** Extracts the credential from an `Authorization: Bearer <token>` header. */
function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function constantTimeEq(a: string, b: string): boolean {
  // Digest first so the comparison is length-independent.
  return timingSafeEqual(
    Buffer.from(sha256Hex(a), "hex"),
    Buffer.from(sha256Hex(b), "hex")
  );
}
