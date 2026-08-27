#!/usr/bin/env node
/**
 * Crosslink Chat Demo — Web App (Host) + Mobile Client
 *
 * Architecture:
 *   Web app (this server) runs the Crosslink host, serves a chat UI + QR code.
 *   Mobile client (opened by scanning QR) runs the Crosslink browser SDK,
 *   auto-pairs, and chats with the web app through encrypted RPC.
 *
 *   Both directions flow through Crosslink:
 *     Mobile  → RPC chat.send → Server → SSE broadcast → Web UI
 *     Web UI  → POST /api/send → Server → RPC chat.new_message → Mobile
 *
 * Usage:
 *   npm run stack        # start signaling + relay
 *   npm run demo:chat    # start this server (port 8100)
 */
import http from "node:http";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCrosslinkServer } from "@crosslink/sdk-node";
import { buildPairingUri } from "@crosslink/core";
import { bytesToBase64 } from "@crosslink/protocol";
import QRCode from "qrcode";

import { startTunnel } from "untun";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "public");
const port = Number(process.env.PORT ?? 8100);

function isPrivateOrLocal(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

function getLanAddress(): string {
  const interfaces = Object.values(os.networkInterfaces());
  // Prefer private/local interfaces (Wi-Fi / Ethernet) over VPN/public ones.
  for (const list of interfaces) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && !nic.internal && isPrivateOrLocal(nic.address)) {
        return nic.address;
      }
    }
  }
  // Fallback: any non-internal IPv4
  for (const list of interfaces) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && !nic.internal) return nic.address;
    }
  }
  return "127.0.0.1";
}

const signalingUrl = process.env.CROSSLINK_SIGNALING_URL;
const relayUrl = process.env.CROSSLINK_RELAY_URL;

let activePublicUrl: string | null = process.env.CROSSLINK_PUBLIC_URL?.replace(/\/+$/, "") ?? null;
let cachedWanIp: string | null = process.env.CROSSLINK_PUBLIC_IP ?? null;

let activeCloudflareTunnel: { getURL: () => Promise<string>; close: () => Promise<void> } | null = null;
let activeCloudflareUrl: string | null = null;

let activeNgrokProcess: any = null;
let activeNgrokUrl: string | null = null;

async function stopCloudflareTunnel(): Promise<void> {
  if (activeCloudflareTunnel) {
    try {
      await activeCloudflareTunnel.close();
    } catch {}
    activeCloudflareTunnel = null;
    activeCloudflareUrl = null;
    console.log("  [tunnel] Cloudflare tunnel stopped.");
  }
}

async function stopNgrokTunnel(): Promise<void> {
  if (activeNgrokProcess) {
    try {
      activeNgrokProcess.kill("SIGTERM");
    } catch {}
    activeNgrokProcess = null;
    activeNgrokUrl = null;
    console.log("  [tunnel] ngrok tunnel stopped.");
  }
}

async function ensureCloudflareTunnel(localPort: number): Promise<string | null> {
  if (activeCloudflareUrl) return activeCloudflareUrl;
  await stopNgrokTunnel();
  console.log(`\n  [tunnel] Starting zero-cost Cloudflare Quick Tunnel on port ${localPort}...`);
  try {
    // Suppress interactive binary-download prompt and prevent untun's signal
    // handlers from killing our server when tunnel switches/stops.
    const originalExit = process.exit;
    const originalOff = process.off.bind(process);
    const suppressExit = (code?: number) => {
      console.log(`  [tunnel] Suppressed exit(${code ?? ""}) from tunnel library.`);
    };
    (process as any).exit = suppressExit;
    const tunnel = await startTunnel({ port: localPort, acceptCloudflareNotice: true });
    (process as any).exit = originalExit;
    if (tunnel) {
      // Remove the destructive signal handlers that untun installs.
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      for (const sig of signals) {
        try {
          // untun registers with process.once; getEventListeners isn't standard,
          // so we just rely on the cleanup function in tunnel.close() below.
        } catch {}
      }
      activeCloudflareTunnel = tunnel;
      const url = await tunnel.getURL();
      if (url) {
        activeCloudflareUrl = url.replace(/\/+$/, "");
        console.log(`  \x1b[32m✔ Cloudflare Quick Tunnel Active:\x1b[0m ${activeCloudflareUrl}`);
        console.log(`  \x1b[32m✔ Direct Mobile Access: "Add to Home Screen" screen is SKIPPED\x1b[0m\n`);
        return activeCloudflareUrl;
      }
    }
  } catch (err) {
    console.warn(`  [tunnel] Cloudflare tunnel failed: ${(err as Error).message}`);
  }
  return null;
}

async function ensureNgrokTunnel(localPort: number): Promise<string | null> {
  if (activeNgrokUrl) return activeNgrokUrl;
  await stopCloudflareTunnel();

  // Check if ngrok is already running and exposing a tunnel
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json();
      const t = data.tunnels?.find((x: any) => x.proto === "https") || data.tunnels?.[0];
      if (t?.public_url) {
        activeNgrokUrl = t.public_url.replace(/\/+$/, "");
        console.log(`\n  \x1b[32m✔ Connected to active ngrok tunnel:\x1b[0m ${activeNgrokUrl}\n`);
        return activeNgrokUrl;
      }
    }
  } catch {}

  console.log(`\n  [tunnel] Spawning ngrok http ${localPort}...`);
  try {
    activeNgrokProcess = spawn("ngrok", ["http", String(localPort), "--log=stdout", "--log-format=json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeNgrokProcess.on("exit", () => {
      activeNgrokProcess = null;
      activeNgrokUrl = null;
    });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(800) });
        if (res.ok) {
          const data = await res.json();
          const t = data.tunnels?.find((x: any) => x.proto === "https") || data.tunnels?.[0];
          if (t?.public_url) {
            activeNgrokUrl = t.public_url.replace(/\/+$/, "");
            console.log(`  \x1b[32m✔ ngrok Tunnel Active:\x1b[0m ${activeNgrokUrl}\n`);
            return activeNgrokUrl;
          }
        }
      } catch {}
    }
  } catch (err) {
    console.warn(`  [tunnel] ngrok spawn failed: ${(err as Error).message}`);
  }
  return null;
}

async function getPublicWanIp(): Promise<string | null> {
  if (cachedWanIp) return cachedWanIp;
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const data = await res.json();
      if (data?.ip) {
        cachedWanIp = data.ip;
        return cachedWanIp;
      }
    }
  } catch {}
  try {
    const res = await fetch("https://icanhazip.com", { signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text) {
        cachedWanIp = text;
        return cachedWanIp;
      }
    }
  } catch {}
  return null;
}

function getPublicOrLanUrl(): string {
  if (activePublicUrl) return activePublicUrl;
  if (activeCloudflareUrl) return activeCloudflareUrl;
  if (activeNgrokUrl) return activeNgrokUrl;
  return `http://${getLanAddress()}:${port}`;
}

// ─── state ──────────────────────────────────────────────────────────────
interface ChatMsg {
  id: string;
  sender: string;
  text: string;
  at: number;
}
const messages: ChatMsg[] = [];
const sseClients = new Set<http.ServerResponse>();

function broadcast(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ─── crosslink host ─────────────────────────────────────────────────────
let latestPairingUri: string | null = null;
let latestPairingCode: string | null = null;

const host = createCrosslinkServer({
  application: {
    id: "com.crosslink.chat",
    name: "Crosslink Chat",
    version: "1.0.0",
    pwaConfig: {
      shortName: "Chat",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
      themeColor: "#0f172a",
      bgColor: "#0f172a",
      display: "standalone",
      startUrl: "/mobile.html",
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
    { id: "chat.read", title: "Read messages", risk: "low" },
  ],
  signalingUrl,
  relayUrl,
  lan: { enabled: true, bind: "all" },
  pairing: { autoApprove: true, ttlMs: 120_000 },
  security: { pairingRateLimitMs: 0 },
  resolvePresenceUrl: (url, _ctx) => {
    // Rewrite 127.0.0.1 / localhost to the LAN IP so phone clients can reach
    // the relay as a fallback when the direct LAN transport doesn't work.
    return url
      .replace(/127\.0\.0\.1/g, getLanAddress())
      .replace(/localhost/g, getLanAddress());
  },
});

host
  .expose("chat.send", (input) => {
    const { sender = "mobile", text = "" } = (input ?? {}) as { sender?: string; text?: string };
    if (!text || typeof text !== "string") throw new Error("text is required");
    const msg: ChatMsg = {
      id: crypto.randomUUID().slice(0, 8),
      sender,
      text: text.slice(0, 2000),
      at: Date.now(),
    };
    messages.push(msg);
    broadcast("chat.update", { messages });
    return { ok: true, id: msg.id };
  }, { capability: "chat.send" })
  .expose("chat.history", () => ({ messages }), { capability: "chat.read" })
  .expose("chat.info", () => ({
    name: "Crosslink Chat",
    appId: "com.crosslink.chat",
    messages: messages.length,
  }));

host.on("deviceConnected", (info) => {
  broadcast("status", { mobile: true, deviceId: info.deviceId });
});
host.on("deviceDisconnected", (info) => {
  broadcast("status", { mobile: false, deviceId: info.deviceId });
});

try {
  await host.start();
} catch (err) {
  console.warn(`\n  \x1b[33m[Crosslink Host]\x1b[0m Failed to connect to local signaling/relay: ${(err as Error).message}`);
  console.warn(`  Ensure \`npm run stack\` is active.\n`);
}

// ─── http server ────────────────────────────────────────────────────────
const securityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function respond(res: http.ServerResponse, status: number, ct: string, body: string | Buffer) {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
  res.writeHead(status, { "content-type": ct });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const pathname = url.pathname;

  // ── API: pairing QR ──
  if (pathname === "/api/pair" && req.method === "GET") {
    try {
      const modeParam = (url.searchParams.get("mode") || "local").toLowerCase();

      // Ensure host is ready before generating pairing codes.
      const st = host.status() as Record<string, any>;
      if (!st.started) {
        throw new Error("Crosslink host has not finished starting. Ensure `npm run stack` (signaling + relay) is active and this server has started fully.");
      }

      const code = await host.getPairingCode();
      latestPairingUri = code.uri;
      latestPairingCode = String(code.code ?? "").replace(/\D/g, "");

      let baseUrl = `http://${getLanAddress()}:${port}`;
      let skipParam = "";
      let effectiveMode = "local";

      if (modeParam === "cloudflare" || modeParam === "open-lan-cloudflared" || modeParam === "cloudflared") {
        effectiveMode = "cloudflare";
        const cfUrl = await ensureCloudflareTunnel(port);
        if (cfUrl) {
          baseUrl = cfUrl;
          skipParam = "";
        }
      } else if (modeParam === "ngrok") {
        effectiveMode = "ngrok";
        const ngUrl = await ensureNgrokTunnel(port);
        if (ngUrl) {
          baseUrl = ngUrl;
        }
      } else if (modeParam === "open-lan" || modeParam === "open-lan-remote" || modeParam === "remote") {
        effectiveMode = "open-lan";
        await stopCloudflareTunnel();
        await stopNgrokTunnel();
        const wanIp = await getPublicWanIp();
        const candidateUrl = wanIp ? `http://${wanIp}:${port}` : `http://${getLanAddress()}:${port}`;
        // Verify the endpoint is actually reachable from the WAN before advertising it.
        // Just knowing the router's public IP is not enough; the router must map
        // the port to this machine (UPnP/NAT-PMP/PCP) or a tunnel must be active.
        let reachable = false;
        if (wanIp) {
          try {
            // Quick self-check: try to reach our own public endpoint from outside
            // perspective (at least confirms routing/firewall allows it).
            const check = await fetch(`${candidateUrl}/api/health`, {
              signal: AbortSignal.timeout(2000),
              // Disable redirect following to avoid false positives.
            });
            reachable = check.ok;
          } catch {
            reachable = false;
          }
        }
        if (!reachable && wanIp) {
          // The public IP is known but not actually reachable (no port mapping).
          // Fall back to LAN address; user should still see bootstrap (add-to-home) flow.
          baseUrl = `http://${getLanAddress()}:${port}`;
          skipParam = "";
          console.warn(`  [pair] WAN IP ${wanIp}:${port} not reachable externally — no router port mapping detected. Falling back to LAN.`);
        } else {
          baseUrl = candidateUrl;
        }
      } else {
        // Default: local Wi-Fi / LAN — always show bootstrap (add-to-home) flow.
        effectiveMode = "local";
        await stopCloudflareTunnel();
        await stopNgrokTunnel();
        baseUrl = `http://${getLanAddress()}:${port}`;
        skipParam = "";
      }

      const hostIdentityPub = (host as any).identity?.edPublicKey;
      const connectUri = buildPairingUri({
        signalingUrl: signalingUrl || "",
        appId: "com.crosslink.chat",
        appName: "Crosslink Chat",
        hostPubEdB64: hostIdentityPub ? bytesToBase64(hostIdentityPub) : ""
      });

      const mobileUrl = `${baseUrl}/mobile.html?pair=${encodeURIComponent(connectUri)}${skipParam}`;
      const mobileQr = await QRCode.toString(mobileUrl, { type: "svg", margin: 1, width: 280 });
      respond(res, 200, "application/json", JSON.stringify({
        code: code.code,
        mobileUrl,
        mobileQr,
        expiresAt: code.expiresAt,
        mode: effectiveMode,
      }));
    } catch (err) {
      respond(res, 500, "application/json", JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // ── API: send message (from web UI) ──
  if (pathname === "/api/send" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const { sender = "web", text } = JSON.parse(body);
      if (!text || typeof text !== "string") {
        respond(res, 400, "application/json", JSON.stringify({ error: "text required" }));
        return;
      }
      const msg: ChatMsg = {
        id: crypto.randomUUID().slice(0, 8),
        sender,
        text: text.slice(0, 2000),
        at: Date.now(),
      };
      messages.push(msg);
      broadcast("chat.update", { messages });
      // notify mobile via crosslink event
      host.emit("chat.new_message", msg);
      respond(res, 200, "application/json", JSON.stringify({ ok: true, id: msg.id }));
    } catch {
      respond(res, 400, "application/json", JSON.stringify({ error: "invalid json" }));
    }
    return;
  }

  // ── API: SSE stream ──
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ messages })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── API: app config (PWA identity) ──
  if (pathname === "/api/config" && req.method === "GET") {
    const appCfg = (host as any).config?.application ?? {};
    respond(res, 200, "application/json", JSON.stringify({
      appName: appCfg.name ?? "Crosslink",
      appId: appCfg.id ?? "",
      pwaConfig: appCfg.pwaConfig ?? {},
      offline: appCfg.offline ?? {},
    }));
    return;
  }

  // ── dynamic manifest ──
  if (pathname === "/manifest.webmanifest" && req.method === "GET") {
    const cfg = (host as any).config?.application?.pwaConfig ?? {};
    const manifest = {
      name: (host as any).config?.application?.name ?? "Crosslink",
      short_name: cfg.shortName ?? ((host as any).config?.application?.name ?? "Crosslink"),
      start_url: cfg.startUrl ?? "/mobile.html",
      display: cfg.display ?? "standalone",
      theme_color: cfg.themeColor ?? "#0f172a",
      background_color: cfg.bgColor ?? "#0f172a",
      icons: cfg.icons ?? [{ src: "/icon-192.png", sizes: "192x192" }],
    };
    respond(res, 200, "application/manifest+json", JSON.stringify(manifest));
    return;
  }

  // ── API: health ──
  if (pathname === "/api/health") {
    const st = host.status() as Record<string, any>;
    respond(res, 200, "application/json", JSON.stringify({
      started: st.started,
      transports: st.transports,
      devices: st.devices,
      messages: messages.length,
    }));
    return;
  }

  // ── API: revoke device ──
  if (pathname === "/api/revoke" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { deviceId = "" } = JSON.parse(body || "{}");
      const target = String(deviceId || "").trim();
      let revokedId: string | null = null;
      let ok = false;
      if (target) {
        ok = host.revokeDevice(target);
        if (ok) revokedId = target;
      } else {
        // Empty deviceId: revoke the first non-revoked device for testing.
        const devices = host.listDevices();
        const firstNonRevoked = devices.find((d) => !d.revokedAt);
        if (firstNonRevoked) {
          ok = host.revokeDevice(firstNonRevoked.deviceId);
          if (ok) revokedId = firstNonRevoked.deviceId;
        } else {
          ok = false;
        }
      }
      respond(res, 200, "application/json", JSON.stringify({
        ok,
        deviceId: revokedId ?? target,
        revoked: ok,
        message: ok ? (revokedId ? `Device ${revokedId} revoked.` : "No device to revoke.") : (target ? `Failed to revoke device ${target}.` : "No paired device found."),
      }));
    } catch (err) {
      respond(res, 500, "application/json", JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  // ── API: list connected devices ──
  if (pathname === "/api/devices" && req.method === "GET") {
    try {
      const devices = host.listDevices();
      const deviceData = devices.map(d => ({
        deviceId: d.deviceId,
        name: d.name,
        deviceType: d.name.toLowerCase().includes("mobile") ? "mobile" : 
                   d.name.toLowerCase().includes("desktop") ? "desktop" :
                   d.name.toLowerCase().includes("tablet") ? "tablet" : "unknown",
        location: "Local Network", // Could be enhanced with GeoIP
        ipAddress: "Local", // Could be enhanced to show actual IP
        lastConnected: d.lastSeen || null,
        firstPaired: d.addedAt,
        status: d.revokedAt ? "Revoked" : (d.lastSeen && Date.now() - d.lastSeen < 300000 ? "Online" : "Offline"),
        trusted: !d.revokedAt,
        caps: d.caps,
        revokedAt: d.revokedAt || null
      }));
      respond(res, 200, "application/json", JSON.stringify({ devices: deviceData }));
    } catch (err) {
      respond(res, 500, "application/json", JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // ── API: revoke device ──
  if (pathname === "/api/devices/revoke" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { deviceId } = JSON.parse(body || "{}");
      if (!deviceId) {
        respond(res, 400, "application/json", JSON.stringify({ ok: false, error: "deviceId required" }));
        return;
      }
      const ok = host.revokeDevice(deviceId);
      respond(res, 200, "application/json", JSON.stringify({ ok, deviceId }));
    } catch (err) {
      respond(res, 500, "application/json", JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }

  // ── API: verify pairing code ──
  if (pathname === "/api/verify-pair" && req.method === "POST") {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { code = "" } = JSON.parse(body || "{}");
      const entered = String(code ?? "").replace(/\D/g, "");
      const psid = (host as any).pairing?.resolveCode?.(entered);
      const expected = (latestPairingCode ?? "").replace(/\D/g, "");
      const ok = entered.length === 9 && (Boolean(psid) || (expected.length === 9 && entered === expected));
      respond(res, 200, "application/json", JSON.stringify({
        ok,
        error: ok ? undefined : "Incorrect pairing code. Please try again."
      }));
    } catch {
      respond(res, 400, "application/json", JSON.stringify({ ok: false, error: "invalid request" }));
    }
    return;
  }

  // ── mobile page ──
  if (pathname === "/mobile" || pathname === "/mobile.html") {
    try {
      const html = await readFile(path.join(root, "mobile.html"), "utf8");
      respond(res, 200, MIME[".html"], html);
    } catch {
      respond(res, 404, "text/plain", "mobile.html not found");
    }
    return;
  }

  // ── static files ──
  let filePath: string;
  if (pathname === "/") {
    filePath = path.join(root, "index.html");
  } else {
    filePath = path.join(root, pathname);
  }

  // prevent path traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root)) {
    respond(res, 403, "text/plain", "forbidden");
    return;
  }

  try {
    const data = await readFile(resolved);
    const ext = path.extname(resolved);
    const ct = MIME[ext] ?? "application/octet-stream";
    const cache = "no-cache, no-store, must-revalidate";
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    res.writeHead(200, { "content-type": ct, "cache-control": cache });
    res.end(data);
  } catch {
    respond(res, 404, "text/plain", "not found");
  }
});

server.listen(port, "0.0.0.0", () => {
  const lan = getLanAddress();
  console.log(`\n  Crosslink Chat Demo`);
  console.log(`  ────────────────────`);
  console.log(`  Web app  → http://localhost:${port}`);
  console.log(`  Local IP → http://${lan}:${port}`);
  console.log(`  Mobile   → http://${lan}:${port}/mobile.html`);
  console.log(`\n  Open the web app on your computer, click "Show QR Code",`);
  console.log(`  then scan it with your phone to start chatting.\n`);
  const st = host.status() as Record<string, any>;
  if (st.transports.lan) console.log(`  LAN       ✓ ${st.transports.lan.url}`);
  if (st.transports.relay) console.log(`  Relay     ✓ ${st.transports.relay.url}`);
  if (st.transports.signaling) console.log(`  Signaling ✓ ${st.transports.signaling.url}`);
  console.log();
});

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await stopCloudflareTunnel();
  await stopNgrokTunnel();
  await host.stop();
  server.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await stopCloudflareTunnel();
  await stopNgrokTunnel();
  await host.stop();
  server.close();
  process.exit(0);
});
