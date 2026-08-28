#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { startTunnel } from "untun";

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve a local port for Crosslink Chat");
  return port;
}

const hostPort = Number(process.env.CROSSLINK_LAN_PORT) || await availablePort();
console.log(`\n  Opening a public HTTPS tunnel to Crosslink Chat on port ${hostPort}…`);

const tunnel = await startTunnel({
  url: `http://127.0.0.1:${hostPort}`,
  acceptCloudflareNotice: ["1", "true"].includes(
    process.env.UNTUN_ACCEPT_CLOUDFLARE_NOTICE?.toLowerCase() ?? ""
  ),
  extraArgs: ["--no-autoupdate"]
});

if (!tunnel) {
  throw new Error("Tunnel setup was cancelled");
}

const publicUrl = await tunnel.getURL();
console.log(`  Public phone URL → ${publicUrl}/mobile.html\n`);

const child = spawn("npm", ["run", "demo:chat"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CROSSLINK_LAN_PORT: String(hostPort),
    CROSSLINK_TUNNEL_URL: publicUrl,
    CROSSLINK_BOOTSTRAP_URL: publicUrl
  },
  stdio: "inherit"
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill(signal);
  await tunnel.close();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    void stop(signal).finally(() => process.exit(128));
  });
}

child.once("error", async (error) => {
  await stop("SIGTERM");
  throw error;
});

child.once("exit", async (code, signal) => {
  await stop("SIGTERM");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
