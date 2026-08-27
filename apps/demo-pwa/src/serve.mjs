#!/usr/bin/env node
/**
 * Serves apps/demo-pwa/public and prints pairing instructions.
 * Run the whole stack with: npm run stack -w root
 *
 * Security notes:
 *  - Path traversal is blocked by resolving against the web root and
 *    rejecting anything that escapes it (encoded or not).
 *  - Every response carries a strict CSP and related hardening headers.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public"));
const port = Number(process.env.PORT ?? 8090);

function getQrTarget() {
  if (process.env.CROSSLINK_QR_URL) return process.env.CROSSLINK_QR_URL;
  if (process.env.CROSSLINK_PUBLIC_URL) return process.env.CROSSLINK_PUBLIC_URL;
  try {
    const tunnelPath = path.resolve(root, "..", "..", ".tunnel-urls.json");
    if (existsSync(tunnelPath)) {
      const urls = JSON.parse(readFileSync(tunnelPath, "utf8"));
      const hit = urls.pwa || urls.notes || urls.web || urls.public;
      if (hit) return hit.endsWith("/") ? hit : `${hit}/`;
    }
  } catch {}
  return defaultLanUrl();
}

/** URL encoded by the QR widget. */
const qrTarget = getQrTarget();

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

const securityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss: http: https:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin"
};

let qrSvgPromise = null;
function getQrSvg() {
  qrSvgPromise ??= QRCode.toString(qrTarget, {
    type: "svg",
    margin: 1,
    width: 320,
    color: { dark: "#0f172a", light: "#e2e8f0" }
  });
  return qrSvgPromise;
}

function defaultLanUrl() {
  // CROSSLINK_LAN_HOST pins the address (see @crosslink/sdk-node's
  // resolveLanHost) - useful when the machine has more than one active
  // network and auto-detection picks an interface the phone can't reach.
  const pinned = process.env.CROSSLINK_LAN_HOST;
  if (pinned) return `http://${pinned}:${port}/`;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && !nic.internal) return `http://${nic.address}:${port}/`;
    }
  }
  return `http://127.0.0.1:${port}/`;
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]);
  } catch {
    res.writeHead(400).end("bad request");
    return;
  }

  if (urlPath === "/qr.svg") {
    res.setHeader("cache-control", "public, max-age=300");
    res.writeHead(200, { "content-type": types[".svg"] }).end(await getQrSvg());
    return;
  }

  // Resolve inside the web root; reject anything that escapes it.
  const file = path.resolve(root, "." + (urlPath === "/" ? "/index.html" : urlPath));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    res.setHeader(
      "cache-control",
      ext === ".html" ? "no-cache" : "public, max-age=3600"
    );
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, () => {
  console.log(`demo PWA → http://127.0.0.1:${port}`);
  console.log(`QR widget encodes → ${qrTarget} (override with CROSSLINK_QR_URL)`);
});
