#!/usr/bin/env node
/**
 * dev-tunnel.mjs — zero-cost cross-network dev stack for Crosslink.
 *
 *   Starts signaling + relay + tunnels (localtunnel by default for $0 zero-account
 *   experience, with optional Cloudflare Quick Tunnels and ngrok support),
 *   waits for public HTTPS endpoints to become active, and writes them to
 *   .tunnel-urls.json so demo hosts can pick them up automatically.
 *
 *   Supported providers:
 *     - localtunnel (default, zero config, zero account, 100% free)
 *     - cloudflare (via `cloudflared`, zero account, free)
 *     - ngrok (when CROSSLINK_TUNNEL_PROVIDER=ngrok or ngrok.yml present)
 *
 *   Usage:  npm run tunnel
 *   Stop:   Ctrl-C  (kills everything cleanly)
 */
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const procs = [];

function cleanup(code = 0) {
  for (const p of procs) {
    try { p.kill("SIGTERM"); } catch {}
  }
  try { unlinkSync(".tunnel-urls.json"); } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

function start(name, cmd, args) {
  const prefix = `\x1b[36m[${name}]\x1b[0m`;
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const tag = (line) => {
    const text = line.toString();
    for (const ln of text.split("\n")) {
      if (ln) console.log(`${prefix} ${ln}`);
    }
  };
  p.stdout.on("data", tag);
  p.stderr.on("data", tag);
  p.on("exit", (code, sig) => {
    if (sig !== "SIGTERM" && code !== 0) {
      console.error(`[${name}] exited unexpectedly (code=${code} sig=${sig})`);
      cleanup(code ?? 1);
    }
  });
  procs.push(p);
  return p;
}

// 1. Start Signaling + Relay on loopback.
start("signaling", "node", ["services/signaling/dist/cli.js"]);
start("relay",     "node", ["services/relay/dist/cli.js"]);

// Give the services a moment to bind
await sleep(600);

// Determine tunnel provider
const provider = (process.env.CROSSLINK_TUNNEL_PROVIDER || "auto").toLowerCase();
let urls = null;

if (provider === "ngrok" || (provider === "auto" && process.env.CROSSLINK_USE_NGROK === "true")) {
  console.log("\x1b[33m[tunnel] Using ngrok provider...\x1b[0m");
  start("ngrok", "ngrok", ["start", "signaling", "relay", "--log=stdout", "--log-format=json"]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (!res.ok) continue;
      const data = await res.json();
      const sig = data.tunnels.find((t) => t.name === "signaling");
      const rly = data.tunnels.find((t) => t.name === "relay");
      if (sig?.public_url && rly?.public_url) {
        urls = { signaling: sig.public_url, relay: rly.public_url };
        break;
      }
    } catch {}
  }
} else if (provider === "cloudflare") {
  console.log("\x1b[33m[tunnel] Using Cloudflare Quick Tunnel provider...\x1b[0m");
  const spawnCf = (name, port) => {
    return new Promise((resolve, reject) => {
      const p = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      procs.push(p);
      let resolved = false;
      const handler = (data) => {
        const text = data.toString();
        const m = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m && !resolved) {
          resolved = true;
          resolve(m[0]);
        }
      };
      p.stdout.on("data", handler);
      p.stderr.on("data", handler);
      setTimeout(() => {
        if (!resolved) reject(new Error(`Cloudflare tunnel timeout for ${name}`));
      }, 25_000);
    });
  };

  try {
    const [sigUrl, rlyUrl] = await Promise.all([
      spawnCf("signaling", 8081),
      spawnCf("relay", 8082),
    ]);
    urls = { signaling: sigUrl, relay: rlyUrl };
  } catch (err) {
    console.error(`[tunnel] Cloudflare tunnel failed: ${err.message}`);
  }
}

// Fallback to localtunnel (zero-cost, zero-account, no signup required)
if (!urls) {
  console.log("\x1b[33m[tunnel] Using free zero-account localtunnel provider...\x1b[0m");
  const spawnLt = (name, port) => {
    return new Promise((resolve, reject) => {
      const prefix = `\x1b[35m[tunnel:${name}]\x1b[0m`;
      const p = spawn("npx", ["--yes", "localtunnel", "--port", String(port)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      procs.push(p);
      let resolved = false;
      const handler = (data) => {
        const text = data.toString();
        for (const ln of text.split("\n")) {
          if (ln) console.log(`${prefix} ${ln}`);
        }
        const m = text.match(/your url is:\s*(https:\/\/[^\s]+)/i);
        if (m && !resolved) {
          resolved = true;
          resolve(m[1].trim());
        }
      };
      p.stdout.on("data", handler);
      p.stderr.on("data", handler);
      setTimeout(() => {
        if (!resolved) reject(new Error(`localtunnel timeout for ${name}`));
      }, 30_000);
    });
  };

  try {
    const [sigUrl, rlyUrl] = await Promise.all([
      spawnLt("signaling", 8081),
      spawnLt("relay", 8082),
    ]);
    urls = { signaling: sigUrl, relay: rlyUrl };
  } catch (err) {
    console.error(`\n[tunnel] Failed to spawn tunnels: ${err.message}`);
    cleanup(1);
  }
}

if (!urls) {
  console.error("\n[tunnel] Failed to establish public tunnels.");
  cleanup(1);
}

writeFileSync(".tunnel-urls.json", JSON.stringify(urls, null, 2));

console.log("\n\x1b[32m=========================================================\x1b[0m");
console.log("\x1b[32m  Public URLs — your phone can reach these from anywhere\x1b[0m");
console.log("\x1b[32m=========================================================\x1b[0m");
console.log(`\x1b[32m  CROSSLINK_SIGNALING_URL=${urls.signaling}\x1b[0m`);
console.log(`\x1b[32m  CROSSLINK_RELAY_URL=${urls.relay}\x1b[0m`);
console.log("\x1b[32m=========================================================\x1b[0m");
console.log("\n  Stack is up. Now in a SECOND terminal run one of:");
console.log("    npm run demo:chat:tunnel     # chat host + mobile web");
console.log("    npm run demo:notes:tunnel    # notes host");
console.log("    npm run demo:echo:tunnel     # echo demo");
console.log("    npm run demo:todo:tunnel     # todo host");
console.log("\n  Then scan the printed QR with your phone (any network / LTE).");
console.log("  Press Ctrl-C here to tear it all down.\n");

// Stay alive until killed
await new Promise(() => {});
