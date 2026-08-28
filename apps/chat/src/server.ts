#!/usr/bin/env node
/**
 * Crosslink Chat Demo — desktop host + mobile companion.
 *
 * The point of this demo is what a developer actually writes. Pairing, QR
 * codes, the mobile bootstrap, the installable manifest, the service worker,
 * the offline screen and the reconnect flow are all Crosslink's; this file
 * declares an application, exposes three RPC methods, and serves a desktop
 * page with its own chat routes.
 *
 * Two HTTP surfaces, deliberately separated:
 *
 *   Control (127.0.0.1 only)  the desktop UI, its chat routes, and Crosslink's
 *                             own `/__crosslink/*` control surface. These mint
 *                             pairing codes and revoke devices, so they must
 *                             not be reachable from the network — Crosslink's
 *                             handler refuses non-loopback peers itself.
 *   Bootstrap                 the mobile page and everything it needs, served
 *                             by Crosslink on the same port as the transport.
 *                             One port means one router mapping.
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
import { createCrosslinkServer, type CrosslinkServerConfig } from "@crosslink/sdk-node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");

const controlPort = Number(process.env.PORT ?? 8100);
const lanPort = process.env.CROSSLINK_LAN_PORT ? Number(process.env.CROSSLINK_LAN_PORT) : undefined;
const networkMode = (process.env.CROSSLINK_NETWORK_MODE ?? "auto") as
  NonNullable<CrosslinkServerConfig["networkMode"]>;

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
    shortName: "Chat",
    icon: "/icon-192.png",
    accentColor: "#38bdf8",
    backgroundColor: "#0f172a",
    appearance: "dark"
  },
  // The developer's mobile UI. Crosslink serves it, and everything around it:
  // manifest, service worker, icons, browser SDK, install handoff, pairing,
  // Add to Home Screen, offline and revoked screens.
  mobile: { entry: path.join(publicDir, "mobile.html") },
  capabilities: [
    { id: "chat.send", title: "Send messages", risk: "low" },
    { id: "chat.read", title: "Read messages", risk: "low" }
  ],
  // Optional. Unset means pairing and transport run directly against this
  // machine — no service to deploy, nothing to pay for.
  signalingUrl: process.env.CROSSLINK_SIGNALING_URL,
  relayUrl: process.env.CROSSLINK_RELAY_URL,
  tunnelUrl: process.env.CROSSLINK_TUNNEL_URL,
  networkMode,
  remote: {
    portForwarded: process.env.CROSSLINK_PORT_FORWARDED === "1",
    publicHost: process.env.CROSSLINK_PUBLIC_HOST,
    externalPort: process.env.CROSSLINK_EXTERNAL_PORT
      ? Number(process.env.CROSSLINK_EXTERNAL_PORT)
      : undefined
  },
  lan: { enabled: true, bind: "all", port: lanPort },
  // A demo pairs unattended; a real app should leave this off so a human sees
  // and confirms the SAS before a device is trusted.
  pairing: { autoApprove: true, ttlMs: 300_000 },
  // Codes are minted only through the loopback control surface, so a mode
  // change can replace the QR immediately without an internet-facing endpoint.
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

// ─── desktop control surface (loopback only) ────────────────────────────

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
  ".png": "image/png"
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
    if (body.length > maxBytes) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

/** Serves a file from `public/`, refusing anything that escapes it. */
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

/**
 * Crosslink's control surface, with this demo's own routes behind it.
 *
 * The pairing widget in `index.html` talks to `/__crosslink/*`; nothing in
 * this file mints a code, renders a QR or lists a device.
 */
const crosslinkControl = host.createControlHandler({ fallback: chatRoutes });

async function chatRoutes(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${controlPort}`);
  const pathname = url.pathname;

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

  // Everything Crosslink knows about reachability — the panel a developer
  // looks at when pairing fails.
  if (pathname === "/api/diagnostics" && req.method === "GET") {
    json(res, 200, {
      status: host.status(),
      connectivity: host.getConnectivity(),
      endpoints: host.connectionEndpoints(),
      remote: host.getRemoteDiagnostics(),
      bootstrap: host.describeMobileDelivery(),
      messages: messages.length
    });
    return;
  }

  if (pathname === "/api/health") {
    json(res, 200, { started: true, connectivity: host.getConnectivity(), messages: messages.length });
    return;
  }

  await serveStatic(res, pathname);
}

const control = http.createServer((req, res) => {
  crosslinkControl(req, res).catch((err) => {
    console.error("[chat] control request failed", err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  });
});

control.listen(controlPort, "127.0.0.1", () => {
  const install = host.describeMobileDelivery();
  console.log(`\n  Crosslink Chat Demo`);
  console.log(`  ────────────────────`);
  console.log(`  Desktop UI → http://127.0.0.1:${controlPort}`);
  console.log(`  Phone page → ${install.origin ?? "(no route advertised yet)"}`);
  console.log(`\n  ${host.getConnectivity().message}`);
  for (const endpoint of host.connectionEndpoints()) {
    console.log(`  ${endpoint.kind.padEnd(7)} ${endpoint.url}`);
  }
  // Says plainly whether Add to Home Screen and the cached offline screen are
  // actually available on this origin, rather than letting it be discovered on
  // a phone.
  console.log(`\n  ${install.message}`);
  console.log(`\n  Open the desktop UI and scan the QR with your phone.\n`);
});

async function shutdown(): Promise<void> {
  await host.stop();
  control.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
