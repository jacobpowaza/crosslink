#!/usr/bin/env node
import { createRelayServer } from "./index.js";
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
const port = Number(flag("port") ?? process.env.PORT ?? positionalPort ?? 8082);

// A self-hosted relay is only as private as its token. Prefer the environment
// variable: an argv token is visible to every process on the machine. With no
// explicit token, fall back to the per-machine dev tokens so a default stack
// is closed to unauthenticated hosts instead of open.
const devTokens = loadOrCreateDevTokens();
const authToken =
  process.env.CROSSLINK_RELAY_TOKEN ?? flag("auth-token") ?? devTokens.relayToken;
const clientAuthToken =
  process.env.CROSSLINK_RELAY_CLIENT_TOKEN ?? flag("client-auth-token");

const server = await createRelayServer({
  port,
  host: process.env.HOST ?? flag("host") ?? "0.0.0.0",
  ...(authToken ? { authToken } : {}),
  ...(clientAuthToken ? { clientAuthToken } : {}),
  ...(process.env.CROSSLINK_RELAY_MAX_CLIENTS
    ? { maxClientsPerChannel: Number(process.env.CROSSLINK_RELAY_MAX_CLIENTS) }
    : {})
});

console.log(`[crosslink-relay] listening on :${server.port}`);
console.log(
  `[crosslink-relay] host auth REQUIRED (${process.env.CROSSLINK_RELAY_TOKEN || flag("auth-token") ? "from config" : "per-machine dev tokens in .crosslink-data/dev-tokens.json"})`
);
if (clientAuthToken) console.log("[crosslink-relay] client auth REQUIRED");

writeStackConfig({ relay: { port: server.port } });

setInterval(() => console.log("[crosslink-relay]", server.stats()), 60_000).unref();
process.on("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});
