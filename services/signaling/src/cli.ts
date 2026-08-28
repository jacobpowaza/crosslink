#!/usr/bin/env node
import { createSignalingServer } from "./index.js";
import { loadOrCreateDevTokens, writeStackConfig } from "@crosslink/dev-tokens";

/** Reads `--flag value` or `--flag=value` from argv. */
function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

const positionalPort = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const port = Number(flag("port") ?? process.env.PORT ?? positionalPort ?? 8081);

// Prefer the environment variable: an argv token is visible to every process.
// With no explicit token, fall back to per-machine dev tokens so the default
// local stack is closed to unauthenticated hosts.
const devTokens = loadOrCreateDevTokens();
const authToken =
  process.env.CROSSLINK_SIGNALING_TOKEN ?? flag("auth-token") ?? devTokens.signalingToken;

const server = await createSignalingServer({
  port,
  host: process.env.HOST ?? flag("host") ?? "0.0.0.0",
  ...(process.env.CROSSLINK_REGION ? { region: process.env.CROSSLINK_REGION } : {}),
  ...(process.env.CROSSLINK_REDIS_URL ? { redisUrl: process.env.CROSSLINK_REDIS_URL } : {}),
  ...(authToken ? { authToken } : {})
});

console.log(`[crosslink-signaling] listening on :${server.port}`);
console.log(
  `[crosslink-signaling] host auth REQUIRED (${process.env.CROSSLINK_SIGNALING_TOKEN || flag("auth-token") ? "from config" : "per-machine dev tokens in .crosslink-data/dev-tokens.json"})`
);
if (process.env.CROSSLINK_REDIS_URL) {
  console.log("[crosslink-signaling] shared state: Redis");
}

writeStackConfig({ signaling: { port: server.port } });
process.on("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});
