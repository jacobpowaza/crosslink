#!/usr/bin/env node
/**
 * Crosslink Chat Demo — desktop host + mobile PWA client.
 *
 * The point of this demo is to show what a developer actually writes. Every
 * piece of pairing, QR, connectivity and transport logic lives in the SDK; this
 * file configures a host, exposes three RPC methods, and serves two pages.
 *
 * Two HTTP surfaces, deliberately separated:
 *
 *   Control (127.0.0.1 only)  the desktop UI and its /api routes. These read
 *                             and mutate host state — pairing codes, the paired
 *                             device list, revocation — so they must not be
 *                             reachable from the network. Binding to loopback
 *                             is what enforces that; there is no token to leak.
 *   Bootstrap                 the mobile page, the SDK bundle, the service
 *                             worker and icons — served by the SDK on the very
 *                             same port as the Crosslink transport. One port
 *                             means one router mapping, so the installable page
 *                             is reachable from wherever the transport is.
 *                             Static files only, no host state.
 *
 * The phone never talks to the control surface at all: it pairs over the
 * Crosslink WebSocket endpoint carried in the QR code.
 *
 * Usage:
 *   npm run demo:chat                      # LAN
 *   npm run demo:chat:tunnel               # any Wi-Fi through a public HTTPS tunnel
 *   CROSSLINK_NETWORK_MODE=remote npm run demo:chat   # LAN + router port mapping
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInstallStartUrl,
  createCrosslinkServer,
  type CrosslinkServerConfig
} from "@crosslink/sdk-node";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const controlPort = Number(process.env.PORT ?? 8100);
const lanPort = process.env.CROSSLINK_LAN_PORT
  ? Number(process.env.CROSSLINK_LAN_PORT)
  : undefined;
const tunnelUrl = process.env.CROSSLINK_TUNNEL_URL;

/**
 * `remote` asks the SDK to make this machine reachable from outside the local
 * network, and to fail loudly if it cannot — rather than handing out a QR that
 * silently only works on this Wi-Fi.
 */
const networkMode = (process.env.CROSSLINK_NETWORK_MODE ?? "auto") as
  NonNullable<CrosslinkServerConfig["networkMode"]>;
let pairingNetworkMode = networkMode;

// ─── state ──────────────────────────────────────────────────────────────

interface ChatMsg {
  id: string;
  sender: string;
  text: string;
  at: number;
}

const messages: ChatMsg[] = [];
const sseClients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ─── crosslink host ─────────────────────────────────────────────────────

const host = createCrosslinkServer({
  application: {
    id: "com.crosslink.chat",
    name: "Crosslink Chat",
    version: "1.0.0",
    pwaConfig: {
      shortName: "Chat",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
      ],
      themeColor: "#0f172a",
      bgColor: "#0f172a",
      display: "standalone",
      startUrl: "/mobile.html"
    },
    offline: {
      title: "Crosslink Chat is offline",
      message: "Open Crosslink Chat on your computer to reconnect automatically.",
      icon: "/icon-192.png",
      appName: "Crosslink Chat",
      themeColor: "#0f172a",
      bgColor: "#0f172a"
    }
  },
  capabilities: [
    { id: "chat.send", title: "Send messages", risk: "low" },
    { id: "chat.read", title: "Read messages", risk: "low" }
  ],
  // Optional. Unset means pairing and transport run directly against this
  // machine — no service to deploy, nothing to pay for.
  signalingUrl: process.env.CROSSLINK_SIGNALING_URL,
  relayUrl: process.env.CROSSLINK_RELAY_URL,
  tunnelUrl,
  networkMode,
  lan: { enabled: true, bind: "all", port: lanPort, httpHandler: serveBootstrap },
  // A demo pairs unattended; a real app should leave this off so a human sees
  // and confirms the SAS before a device is trusted.
  pairing: { autoApprove: true, ttlMs: 300_000 },
  // Pairing codes are minted only through the loopback-bound desktop control
  // surface, so mode changes can replace the QR immediately without exposing
  // an internet-facing code-generation endpoint.
  security: { pairingRateLimitMs: 0 }
});

host
  .expose(
    "chat.send",
    (input) => {
      const { sender = "mobile", text = "" } = (input ?? {}) as { sender?: string; text?: string };
      if (!text || typeof text !== "string") throw new Error("text is required");
      const msg = addMessage(sender, text);
      return { ok: true, id: msg.id };
    },
    {
      capability: "chat.send",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLen: 1, maxLen: 2000 },
          sender: { type: "string", maxLen: 64 }
        }
      }
    }
  )
  .expose("chat.history", () => ({ messages }), { capability: "chat.read" })
  .expose(
    "chat.info",
    () => ({ name: "Crosslink Chat", appId: "com.crosslink.chat", messages: messages.length }),
    // Even a read-only method is gated: an ungated method is callable by any
    // paired device regardless of what the user granted it.
    { capability: "chat.read" }
  );

host.declareEvent("chat.new_message");

host.on("deviceConnected", (info) => broadcast("status", { mobile: true, deviceId: info.deviceId }));
host.on("deviceDisconnected", (info) => broadcast("status", { mobile: false, deviceId: info.deviceId }));
// A pairing code is single-use. Once a device redeems one — or a device is
// revoked and has to pair again — the code still on screen would fail with
// `pairing_expired`, so the browser mints a fresh one immediately.
host.on("devicePaired", () => broadcast("pair.refresh", {}));
host.on("deviceRevoked", () => broadcast("pair.refresh", {}));

function addMessage(sender: string, text: string): ChatMsg {
  const msg: ChatMsg = {
    id: crypto.randomUUID().slice(0, 8),
    sender: sender.slice(0, 64),
    text: text.slice(0, 2000),
    at: Date.now()
  };
  messages.push(msg);
  broadcast("chat.update", { messages });
  return msg;
}

await host.start();

// ─── http plumbing ──────────────────────────────────────────────────────

const securityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin"
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

function respond(res: http.ServerResponse, status: number, ct: string, body: string | Buffer): void {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
  res.writeHead(status, { "content-type": ct });
  res.end(body);
}

const json = (res: http.ServerResponse, status: number, body: unknown): void =>
  respond(res, status, "application/json", JSON.stringify(body));

async function readJsonBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    // Bounded so a slow oversized upload cannot grow the process heap.
    if (body.length > maxBytes) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

/**
 * Serves a file from `public/`, refusing anything that escapes it.
 *
 * The boundary check includes the separator: without it, a sibling directory
 * whose name merely starts with the public directory's name would pass.
 */
async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(path.join(publicDir, requested));
  if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
    respond(res, 403, "text/plain", "forbidden");
    return;
  }
  try {
    const data = await readFile(resolved);
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    res.writeHead(200, {
      "content-type": MIME[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-cache, no-store, must-revalidate"
    });
    res.end(data);
  } catch {
    respond(res, 404, "text/plain", "not found");
  }
}

function pwaManifest(installId?: string): unknown {
  const app = host.config.application;
  const cfg = app.pwaConfig ?? {};
  const baseStartUrl = cfg.startUrl ?? "/mobile.html";
  const validInstallId = installId && installId.length >= 24 && installId.length <= 256
    ? installId
    : undefined;
  const startUrl = validInstallId ? buildInstallStartUrl(baseStartUrl, validInstallId) : baseStartUrl;
  return {
    name: app.name,
    short_name: cfg.shortName ?? app.name,
    id: baseStartUrl,
    start_url: startUrl,
    display: cfg.display ?? "standalone",
    theme_color: cfg.themeColor ?? "#0f172a",
    background_color: cfg.bgColor ?? "#0f172a",
    icons: cfg.icons ?? [{ src: "/icon-192.png", sizes: "192x192" }]
  };
}

/** Why there is no `wan` endpoint, when the host asked for one. */
function remoteNote(): string | null {
  const diagnostics = host.getRemoteDiagnostics();
  if (!diagnostics || diagnostics.reachable) return null;
  return diagnostics.message;
}

// ─── control surface (loopback only) ────────────────────────────────────

const control = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${controlPort}`);
  const pathname = url.pathname;

  // The pairing QR. Endpoints, transport choice and the QR itself all come
  // from the SDK — this demo does not construct a pairing URL.
  if (pathname === "/api/pair" && req.method === "GET") {
    try {
      const requestedMode = url.searchParams.get("mode");
      if (["auto", "local-only", "lan-and-relay", "remote"].includes(requestedMode ?? "")) {
        pairingNetworkMode = requestedMode as typeof pairingNetworkMode;
      }
      host.config.networkMode = pairingNetworkMode;
      const info = await host.getPairingCode();
      const bootstrapUrl = `${bootstrapOrigin()}/mobile.html#pair=${encodeURIComponent(info.uri!)}`;
      // The QR points at an https/http page rather than the `crosslink://`
      // scheme because iOS has no handler for a custom scheme: the camera would
      // simply refuse to open it.
      const qrSvg = await QRCode.toString(bootstrapUrl, { type: "svg", margin: 1, width: 280 });
      json(res, 200, {
        code: info.code,
        expiresAt: info.expiresAt,
        mobileUrl: bootstrapUrl,
        mobileQr: qrSvg,
        endpoints: info.endpoints,
        mode: pairingNetworkMode,
        // Only present when remote access was attempted and did not produce a
        // public route; the UI shows the reason rather than implying success.
        remoteNote: remoteNote()
      });
    } catch (err) {
      const message = (err as Error).message;
      // The SDK throttles pairing-code generation, and refuses to hand out a QR
      // that has no route at all; both are the caller's situation, not a fault.
      const status = /rate limit/i.test(message)
        ? 429
        : /not reachable|no reachable endpoint/i.test(message)
          ? 409
          : 500;
      json(res, status, { error: message });
    }
    return;
  }

  if (pathname === "/api/network-mode" && req.method === "POST") {
    try {
      const { mode } = (await readJsonBody(req)) as { mode?: string };
      if (!mode || !["auto", "local-only", "lan-and-relay", "remote"].includes(mode)) {
        json(res, 400, { error: "invalid network mode" });
        return;
      }
      pairingNetworkMode = mode as typeof pairingNetworkMode;
      host.config.networkMode = pairingNetworkMode;
      json(res, 200, { mode: pairingNetworkMode });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (pathname === "/api/send" && req.method === "POST") {
    try {
      const { sender = "web", text } = (await readJsonBody(req)) as { sender?: string; text?: string };
      if (!text || typeof text !== "string") {
        json(res, 400, { error: "text required" });
        return;
      }
      const msg = addMessage(sender, text);
      host.emit("chat.new_message", msg);
      json(res, 200, { ok: true, id: msg.id });
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
    }
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(`data: ${JSON.stringify({ messages })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (pathname === "/api/devices" && req.method === "GET") {
    json(res, 200, {
      devices: host.listDevices().filter((d) => d.revokedAt === undefined).map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        firstPaired: d.addedAt,
        lastConnected: d.lastSeen ?? null,
        status: d.revokedAt ? "revoked" : d.lastSeen && Date.now() - d.lastSeen < 300_000 ? "online" : "offline",
        caps: d.caps,
        revokedAt: d.revokedAt ?? null
      }))
    });
    return;
  }

  if (pathname === "/api/revoke" && req.method === "POST") {
    try {
      const { deviceId } = (await readJsonBody(req)) as { deviceId?: string };
      const target = String(deviceId ?? "").trim();
      if (!target) {
        json(res, 400, { ok: false, error: "deviceId required" });
        return;
      }
      json(res, 200, { ok: host.revokeDevice(target), deviceId: target });
    } catch (err) {
      json(res, 400, { ok: false, error: (err as Error).message });
    }
    return;
  }

  // Everything the SDK knows about reachability, including what each router
  // protocol answered — the panel a developer looks at when pairing fails.
  if (pathname === "/api/diagnostics" && req.method === "GET") {
    json(res, 200, {
      status: host.status(),
      connectivity: host.getConnectivity(),
      endpoints: host.connectionEndpoints(),
      remote: host.getRemoteDiagnostics(),
      bootstrapOrigin: bootstrapOrigin(),
      messages: messages.length
    });
    return;
  }

  if (pathname === "/api/health") {
    json(res, 200, { started: true, connectivity: host.getConnectivity(), messages: messages.length });
    return;
  }

  await serveStatic(res, pathname === "/" ? "/index.html" : pathname);
});

// ─── bootstrap surface (reachable from the phone) ───────────────────────

async function serveBootstrap(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://bootstrap.invalid");
  const pathname = requestUrl.pathname;
  if (pathname === "/manifest.webmanifest") {
    res.setHeader("cache-control", "no-store");
    respond(
      res,
      200,
      "application/manifest+json",
      JSON.stringify(pwaManifest(requestUrl.searchParams.get("crosslink_install") ?? undefined))
    );
    return;
  }
  if (pathname.startsWith("/__crosslink/install/")) {
    res.setHeader("cache-control", "no-store");
    const handoffId = decodeURIComponent(pathname.slice("/__crosslink/install/".length));
    const handoff = host.getInstallHandoff(handoffId);
    json(res, handoff ? 200 : 404, handoff ?? { error: "install handoff unavailable or expired" });
    return;
  }
  // Anything without a file extension is the mobile page: an installed PWA that
  // reopens on a deep path must still boot rather than 404.
  const asset = pathname === "/" ? "/mobile.html" : pathname;
  await serveStatic(res, path.extname(asset) ? asset : "/mobile.html");
}

/**
 * Origin the phone should use for the installable page.
 *
 * Prefers the public route so an installed PWA keeps working off this Wi-Fi;
 * the origin is what the browser stores as the app's identity, so picking the
 * LAN address when a public one exists would pin the install to one network.
 */
function bootstrapOrigin(): string {
  const endpoints = host.connectionEndpoints();
  const preferred =
    endpoints.find((e) => e.kind === "tunnel")?.url ??
    endpoints.find((e) => e.kind === "wan")?.url ??
    endpoints.find((e) => e.kind === "lan")?.url;
  if (!preferred) return `http://127.0.0.1:${controlPort}`;
  const url = new URL(preferred);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

control.listen(controlPort, "127.0.0.1", () => {
  console.log(`\n  Crosslink Chat Demo`);
  console.log(`  ────────────────────`);
  console.log(`  Desktop UI → http://127.0.0.1:${controlPort}`);
  console.log(`  Phone page → ${bootstrapOrigin()}/mobile.html`);
  console.log(`\n  ${host.getConnectivity().message}`);
  for (const endpoint of host.connectionEndpoints()) {
    console.log(`  ${endpoint.kind.padEnd(7)} ${endpoint.url}`);
  }
  console.log(`\n  Open the desktop UI, click "Show QR Code", scan it with your phone.\n`);
});

async function shutdown(): Promise<void> {
  await host.stop();
  control.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
