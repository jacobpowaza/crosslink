#!/usr/bin/env node
/**
 * Serves the generated Crosslink bootstrap for local development.
 *
 * Bound to loopback deliberately. `127.0.0.1` is a secure context, so the
 * service worker registers, the offline shell is cached and Add to Home Screen
 * behaves like an install — the full experience, on the one address that gets
 * it without a certificate. On a LAN address over plain http the browser gives
 * none of that, which is why the published site in `dist/` exists.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const port = Number(process.env.PORT ?? 8090);

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
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.resolve(path.join(root, requested));
  // The separator is part of the check: a sibling directory whose name merely
  // starts with the root's name would otherwise pass.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(resolved);
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    res.writeHead(200, {
      "content-type": types[path.extname(resolved)] ?? "application/octet-stream",
      "cache-control": "no-cache"
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  Crosslink bootstrap (generated) → http://127.0.0.1:${port}`);
  console.log(`  Serving ${root}`);
  console.log(`  Run \`npm run build\` first if that directory is empty.\n`);
});
