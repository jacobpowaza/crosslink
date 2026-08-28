#!/usr/bin/env node
/**
 * WebRTC upgrade host.
 *
 * Demonstrates the full arc a real product wants:
 *
 *   1. A phone or laptop pairs and connects over whatever route the QR
 *      advertises — the host's own address on this network, a router-mapped
 *      public address, or a relay when neither is available.
 *   2. The client offers to upgrade. The SDP exchange travels over the session
 *      that is already up — encrypted, authenticated, capability-gated — so no
 *      separate signaling channel exists to secure or to keep alive.
 *   3. If a direct path exists, traffic moves onto a DataChannel. If it does
 *      not, nothing happens and the existing session carries on.
 *
 * It also shows the permission model doing real work: `files.read` is granted
 * at pairing, while `shell.exec` is high-risk and `confirmEachUse`, so every
 * single invocation stops at a prompt on this terminal no matter what the
 * device was granted.
 *
 * Usage:
 *   node examples/webrtc-upgrade/src/host.ts            # same Wi-Fi
 *   node examples/webrtc-upgrade/src/host.ts --remote   # ask the router for a port
 *
 * A relay is optional, for clients that can reach neither:
 *   npm run stack
 *   CROSSLINK_SIGNALING_URL=http://127.0.0.1:8081 \
 *   CROSSLINK_RELAY_URL=http://127.0.0.1:8082 \
 *   node examples/webrtc-upgrade/src/host.ts
 *
 * Then serve examples/webrtc-upgrade/public and open it on the client device.
 *
 * WebRTC in Node needs a native implementation. Install one of:
 *   npm i @roamhq/wrtc          # or
 *   npm i node-datachannel
 * Without it the host still runs and still works over its existing session; it
 * just declines upgrade requests, which is exactly how it should degrade.
 */
import { createInterface } from "node:readline";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { createCrosslinkServer, type CrosslinkServer } from "@crosslink/sdk-node";
import { consoleLogger, type ConsentRequest } from "@crosslink/core";
import { exposeWebrtcOffer } from "@crosslink/webrtc-adapter";

// Optional. With neither set the client connects to this host directly over
// the address in the QR; a relay only adds a route for clients that cannot.
const signalingUrl = process.env.CROSSLINK_SIGNALING_URL;
const relayUrl = process.env.CROSSLINK_RELAY_URL;
const remote = process.argv.includes("--remote");

/* ------------------------------------------------------------------ */
/* WebRTC implementation discovery                                     */
/* ------------------------------------------------------------------ */

interface PeerFactory {
  (): unknown;
}

/**
 * Finds a usable RTCPeerConnection. Node has none built in, so this checks
 * the globals first (Deno, Bun, a polyfill) and then the two common native
 * packages, treating absence as a normal outcome.
 */
async function findPeerFactory(): Promise<{ create: PeerFactory; via: string } | null> {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  const globalCtor = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  if (typeof globalCtor === "function") {
    return {
      create: () => new (globalCtor as new (c: unknown) => unknown)({ iceServers }),
      via: "globalThis.RTCPeerConnection"
    };
  }

  for (const name of ["@roamhq/wrtc", "wrtc", "node-datachannel/polyfill"]) {
    try {
      const mod = (await import(/* @vite-ignore */ name)) as {
        RTCPeerConnection?: new (c: unknown) => unknown;
        default?: { RTCPeerConnection?: new (c: unknown) => unknown };
      };
      const Ctor = mod.RTCPeerConnection ?? mod.default?.RTCPeerConnection;
      if (Ctor) return { create: () => new Ctor({ iceServers }), via: name };
    } catch {
      /* not installed; try the next one */
    }
  }
  return null;
}

const webrtc = await findPeerFactory();

/* ------------------------------------------------------------------ */
/* the host                                                            */
/* ------------------------------------------------------------------ */

const SHARED_DIR = path.resolve("examples/webrtc-upgrade/shared");

const server: CrosslinkServer = createCrosslinkServer({
  application: {
    id: "com.example.webrtc-upgrade",
    name: "WebRTC Upgrade Demo",
    version: "1.0.0"
  },
  capabilities: [
    { id: "files.read", title: "Read shared files", risk: "low", defaultGranted: true },
    {
      id: "files.write",
      title: "Write shared files",
      description: "Create and modify files in the shared folder",
      risk: "medium"
    },
    {
      id: "shell.exec",
      title: "Run a command on this computer",
      description: "Runs a single shell command and returns its output",
      risk: "high",
      // The grant is a licence to ask, not a standing permission. Every
      // invocation stops at the prompt below.
      confirmEachUse: true
    }
  ],
  signalingUrl,
  relayUrl,
  relayToken: process.env.CROSSLINK_RELAY_TOKEN,
  signalingToken: process.env.CROSSLINK_SIGNALING_TOKEN,
  networkMode: remote ? "remote" : "auto",
  lan: { enabled: true, bind: "all" },
  logger: consoleLogger({ level: process.env.CROSSLINK_LOG_LEVEL === "debug" ? "debug" : "info" }),

  // A host-authored policy, applied before the user is ever asked. A client
  // may request anything; only these can ever be granted.
  permissions: {
    allow: ["files.read", "files.write", "shell.exec"],
    maxAutoGrantRisk: "low",
    requireApproval: "high",
    maxDevices: 5,
    grantTtlMs: 30 * 24 * 3600_000
  },

  pairing: {
    approve: async (request) => {
      console.log(`\n  Pairing request from "${request.deviceName}"`);
      console.log(`  Compare this code on both screens: ${request.sas}`);
      console.log(`  Capabilities on offer: ${request.requestedCaps.join(", ") || "(none)"}`);
      if (request.requiresExplicitApproval.length > 0) {
        console.log(`  Needs your explicit yes: ${request.requiresExplicitApproval.join(", ")}`);
      }
      if (request.deniedCaps.length > 0) {
        console.log(
          `  Refused by policy: ${request.deniedCaps.map((d) => `${d.id} (${d.reason})`).join(", ")}`
        );
      }
      const answer = await ask("  Approve? [y]es / [r]ead-only / [N]o: ");
      if (answer === "r") return ["files.read"];
      return answer === "y" || answer === "yes";
    }
  },

  // Asked before every `confirmEachUse` invocation.
  onConsentRequest: async (request: ConsentRequest) => {
    console.log(`\n  "${request.title}" requested by ${request.deviceId.slice(0, 20)}…`);
    console.log(`  ${JSON.stringify(request.input)}`);
    const answer = await ask("  Allow? [o]nce / [s]ession / [a]lways / [N]o: ");
    if (answer === "o") return "once";
    if (answer === "s") return "session";
    if (answer === "a") return "always";
    return false;
  },
  consent: { promptTimeoutMs: 60_000 }
});

/* ------------------------------------------------------------------ */
/* methods                                                             */
/* ------------------------------------------------------------------ */

server
  .expose(
    "files.list",
    async () => {
      const entries = await readdir(SHARED_DIR).catch(() => []);
      return entries.filter((name) => !name.startsWith("."));
    },
    { capability: "files.read" }
  )
  .expose(
    "files.read",
    async (input) => {
      const name = path.basename(String((input as { name?: string })?.name ?? ""));
      if (!name) throw Object.assign(new Error("name is required"), { code: "validation_failed" });
      // basename above keeps this inside the shared folder.
      const body = await readFile(path.join(SHARED_DIR, name), "utf8");
      return { name, body: body.slice(0, 64 * 1024) };
    },
    {
      capability: "files.read",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", minLen: 1, maxLen: 128 } }
      }
    }
  )
  .expose(
    "shell.run",
    async (input) => {
      // Reaching this handler means the user answered the consent prompt.
      const cmd = String((input as { cmd?: string })?.cmd ?? "");
      const { execFile } = await import("node:child_process");
      return new Promise((resolve) => {
        execFile("/bin/sh", ["-c", cmd], { timeout: 10_000 }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: stdout.slice(0, 8192), stderr: stderr.slice(0, 2048) });
        });
      });
    },
    {
      capability: "shell.exec",
      inputSchema: {
        type: "object",
        required: ["cmd"],
        properties: { cmd: { type: "string", minLen: 1, maxLen: 500 } }
      }
    }
  )
  .expose("link.info", (_input, ctx) => ({
    deviceId: ctx.deviceId,
    grantedCaps: server.grantedCapabilities(ctx.deviceId),
    webrtcAvailable: webrtc !== null
  }));

/* ------------------------------------------------------------------ */
/* the upgrade endpoint                                                */
/* ------------------------------------------------------------------ */

if (webrtc) {
  exposeWebrtcOffer(server, {
    createPeer: () => webrtc.create() as never,
    // The DataChannel is a pipe, not a credential: handing it to the server
    // runs the ordinary CLX1 handshake over it, so the device authenticates
    // again exactly as it did over the relay.
    onTransport: (transport, deviceId) => {
      console.log(`  ${deviceId.slice(0, 20)}… upgraded to a direct connection`);
      server.acceptExternalTransport(transport);
    },
    timeoutMs: 15_000
  });
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

await server.start();

server.typedOn("deviceConnected", ({ deviceId, transport }) => {
  console.log(`  ${deviceId.slice(0, 20)}… connected over ${transport}`);
});
server.typedOn("deviceDisconnected", ({ deviceId, transport }) => {
  console.log(`  ${deviceId.slice(0, 20)}… disconnected (${transport})`);
});

console.log("\nWebRTC Upgrade Demo");
console.log(`  fingerprint  ${server.fingerprintHex.slice(0, 32)}…`);
console.log(
  `  webrtc       ${webrtc ? `available via ${webrtc.via}` : "unavailable — no upgrade (install @roamhq/wrtc to enable)"}`
);
for (const endpoint of server.connectionEndpoints()) {
  console.log(`  ${endpoint.kind.padEnd(12)} ${endpoint.url}`);
}
const remoteDiagnostics = server.getRemoteDiagnostics();
if (remoteDiagnostics && !remoteDiagnostics.reachable) {
  console.log(`  remote       ${remoteDiagnostics.message}`);
}
console.log("  commands     code | devices | revoke <id> | consent | status | quit\n");

await printPairingCode();

async function printPairingCode(): Promise<void> {
  const info = await server.getPairingCode();
  console.log(`\n  Pairing code: ${info.code}   (valid for 2 minutes)`);
  if (info.uri && process.stdout.isTTY) {
    console.log(await QRCode.toString(info.uri, { type: "terminal", small: true }));
  } else if (info.uri) {
    console.log(`  Open on the client:\n  ${info.uri}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* console                                                             */
/* ------------------------------------------------------------------ */

const rl = createInterface({ input: process.stdin, terminal: false });
const pendingAsk: Array<(answer: string) => void> = [];

rl.on("line", (line) => {
  const waiting = pendingAsk.shift();
  if (waiting) {
    waiting(line.trim().toLowerCase());
    return;
  }
  void handleCommand(line.trim());
});

function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => pendingAsk.push(resolve));
}

async function handleCommand(line: string): Promise<void> {
  const [cmd, ...rest] = line.split(/\s+/);
  try {
    switch (cmd) {
      case "code":
        await printPairingCode();
        break;
      case "devices":
        for (const d of server.listDevices()) {
          const live = server.grantedCapabilities(d.deviceId);
          console.log(
            `  ${d.revokedAt ? "revoked" : "active "} ${d.name.padEnd(16)} ${d.deviceId.slice(0, 20)}… caps=[${live.join(",")}]`
          );
        }
        break;
      case "revoke":
        console.log(rest[0] && server.revokeDevice(rest[0]) ? "  revoked" : "  not found");
        break;
      case "consent":
        server.clearConsent();
        console.log("  cleared remembered consent; every use will prompt again");
        break;
      case "status":
        console.log(JSON.stringify(server.status(), null, 2));
        break;
      case "quit":
        await server.stop();
        process.exit(0);
        break;
      case "":
        break;
      default:
        console.log("  commands: code | devices | revoke <id> | consent | status | quit");
    }
  } catch (err) {
    console.error("  error:", (err as Error).message);
  }
}

process.on("SIGINT", () => {
  void server.stop().then(() => process.exit(0));
});
