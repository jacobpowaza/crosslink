/**
 * Crosslink signaling service.
 *
 * A tiny presence directory + pairing-code router. It never sees plaintext
 * application data: pairing payloads are opaque signed blobs routed by hashed
 * code, and presence entries are signed by host identity keys.
 *
 * State is in-memory and cheap to rebuild; horizontal scaling can add Redis
 * pub/sub behind the same interface later (see docs/SELF_HOSTING.md).
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
    const conns = new Map<string, Conn>();
    const byApp = new Map<string, string>();

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
      const connId = randomUUID();
      const presentedAuth =
        bearerFrom(req.headers.authorization) ??
        new URL(req.url ?? "/", "http://localhost").searchParams.get("auth") ??
        "";
      const conn: PeerConn = { kind: "peer", ws, lastSeen: Date.now() };
      conns.set(connId, conn);
      let windowStart = Date.now();
      let windowCount = 0;

      const send = (obj: unknown): boolean => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(obj));
        return true;
      };

      // As on the relay: a receiver-level failure must cost this connection,
      // not the process.
      ws.on("error", () => {
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
          send({ op: "error", error: { code: "rate_limited", message: "slow down" } });
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
