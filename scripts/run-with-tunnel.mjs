#!/usr/bin/env node
/**
 * run-with-tunnel.mjs — runs a demo host pointed at the public ngrok URLs
 * that `npm run tunnel` wrote to .tunnel-urls.json.
 *
 *   Usage:  node scripts/run-with-tunnel.mjs <demo-key>
 *   Demo keys: echo | notes | todo | webrtc
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const keys = {
  echo:   "examples/echo-host/src/cli.ts",
  notes:  "examples/notes-host/src/cli.ts",
  todo:   "examples/todo-host/src/cli.ts",
  chat:   "apps/chat/src/server.ts",
  webrtc: "examples/webrtc-upgrade/src/host.ts",
};

const arg = process.argv[2];
if (!arg || !(arg in keys)) {
  console.error("Usage: run-with-tunnel.mjs <demo-key>");
  console.error("  demo-keys:", Object.keys(keys).join(", "));
  process.exit(1);
}

if (!existsSync(".tunnel-urls.json")) {
  console.error("No .tunnel-urls.json — run `npm run tunnel` first.");
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(".tunnel-urls.json", "utf8"));
const signaling = parsed.signaling;
const relay = parsed.relay;
const publicUrl = parsed.chat || parsed.web || parsed.public || "";

const p = spawn("node", [keys[arg]], {
  stdio: "inherit",
  env: {
    ...process.env,
    CROSSLINK_SIGNALING_URL: signaling,
    CROSSLINK_RELAY_URL: relay,
    ...(publicUrl ? { CROSSLINK_PUBLIC_URL: publicUrl } : {}),
  },
});

p.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => p.kill("SIGINT"));
