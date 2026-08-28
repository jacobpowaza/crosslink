#!/usr/bin/env node
/**
 * Echo Host - the smallest useful Crosslink app.
 *
 *   npm run dev -w examples/echo-host
 *   # scan the printed QR with any Crosslink client
 */
import { createCrosslinkServer } from "@crosslink/sdk-node";
import QRCode from "qrcode";
import { readFileSync } from "node:fs";

const args = new Set(process.argv.slice(2));

const server = createCrosslinkServer({
  application: { id: "com.example.echo", name: "Echo Host", version: "1.0.0" },
  capabilities: [{ id: "echo.use", title: "Use echo methods", risk: "low" }],
  // Nothing to configure: the phone pairs against this process directly over
  // the address in the QR. `--remote` additionally asks the router for an
  // inbound port so a phone off this Wi-Fi can reach it too.
  networkMode: args.has("--remote") ? "remote" : "auto",
  signalingUrl: process.env.CROSSLINK_SIGNALING_URL,
  relayUrl: process.env.CROSSLINK_RELAY_URL,
  lan: { enabled: true, bind: "all" },
  pairing: {
    autoApprove: args.has("--yes"),
    approve: async (req) => {
      console.log(`\nPairing request from "${req.deviceName}"`);
      console.log(`  SAS codes must match: ${req.sas}`);
      console.log(`  Requested: ${req.requestedCaps.join(", ") || "(none)"}`);
      process.stdout.write("Approve? [y/N] ");
      const answer = await new Promise<string>((resolve) => {
        const onData = (buf: Buffer) => {
          process.stdin.removeListener("data", onData);
          resolve(buf.toString().trim().toLowerCase());
        };
        process.stdin.on("data", onData);
      });
      return answer === "y" || answer === "yes";
    }
  }
});

let echoCount = 0;
server
  .expose("echo.ping", (input) => {
    echoCount += 1;
    return { pong: true, sentAt: (input as { sentAt?: number })?.sentAt, n: echoCount };
  }, { capability: "echo.use" })
  .expose("echo.stats", () => ({ echoes: echoCount, startedAt: startedAt }), {
    capability: "echo.use"
  })
  .expose("app.info", () => ({ name: "Echo Host", appId: "com.example.echo" }))
  .declareEvent("echo.pinged");

const startedAt = Date.now();

await server.start();

console.log("Echo Host ready.");
console.log(`  fingerprint ${server.fingerprintHex.slice(0, 32)}…`);
for (const endpoint of server.connectionEndpoints()) {
  console.log(`  ${endpoint.kind.padEnd(7)} ${endpoint.url}`);
}
const remote = server.getRemoteDiagnostics();
if (remote && !remote.reachable) console.log(`  remote      ${remote.message}`);

// The startup snapshot above can lag live transports (a relay or signaling
// link connects asynchronously); print updates as they happen.
server.on("connectivity", (status) => {
  console.log(`  status      ${status.message}`);
});

async function printPairingCode(): Promise<void> {
  const info = await server.getPairingCode();
  console.log(`\nPairing code: ${info.code}   (expires in 2 minutes)`);
  if (info.qrSvg && process.stdout.isTTY) {
    const qr = await QRCode.toString(info.uri!, { type: "terminal", small: true });
    console.log(qr);
  } else if (info.uri) {
    console.log(`  or open this URI on the client:\n  ${info.uri}`);
  }
}

await printPairingCode();
setInterval(async () => {
  try {
    await printPairingCode();
  } catch {
    /* host shutting down */
  }
}, 110_000).unref();

process.on("SIGINT", async () => {
  console.log("\nShutting down…");
  await server.stop();
  process.exit(0);
});
