#!/usr/bin/env node
/**
 * Reports whether this machine can be reached from the internet, and why not
 * when it cannot.
 *
 * Run this before blaming Crosslink for a phone that will not connect off
 * Wi-Fi: it exercises exactly the same discovery the host does at startup, and
 * prints what each router protocol answered.
 *
 *   node scripts/check-remote-access.mjs [port] [--public-host <host>] [--forwarded]
 *
 * `--forwarded` / `--public-host` check the manual path: no mapping is
 * negotiated, the address is advertised on the operator's word that a router
 * port-forward rule already points at this machine.
 */
import { createServer } from "node:http";
import {
  defaultGateway,
  discoverReflexiveAddress,
  localIpv4,
  openNatMapping,
  verifyExternalReachability
} from "@crosslink/nat-map";

const argv = process.argv.slice(2);
const port = Number(argv.find((a) => !a.startsWith("--")) ?? 0);
const publicHost = argv.includes("--public-host")
  ? argv[argv.indexOf("--public-host") + 1]
  : undefined;
const assumeForwarded = argv.includes("--forwarded") || Boolean(publicHost);

const probe = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("crosslink-reachability-probe");
});
await new Promise((resolve) => probe.listen(port, "0.0.0.0", resolve));
const internalPort = probe.address().port;

console.log("\n  Crosslink reachability check");
console.log("  ────────────────────────────");
console.log(`  local address    ${localIpv4() ?? "unknown"}`);
console.log(`  default gateway  ${(await defaultGateway()) ?? "not found"}`);

const stun = await discoverReflexiveAddress().catch(() => null);
console.log(
  `  public address   ${stun ? `${stun.address}:${stun.port} (via ${stun.server})` : "could not be determined"}`
);

console.log(`\n  Requesting an inbound mapping for local port ${internalPort}…\n`);
const mapping = await openNatMapping({
  internalPort,
  publicHost,
  assumeForwarded,
  description: "Crosslink reachability check"
});

for (const attempt of mapping.result.attempts) {
  console.log(`  ${attempt.ok ? "ok  " : "fail"}  ${attempt.protocol.padEnd(8)} ${attempt.detail}`);
}
console.log(`\n  ${mapping.result.message}`);

if (mapping.result.reachable) {
  const url = `http://${mapping.result.externalAddress}:${mapping.result.externalPort}/`;
  const check = await verifyExternalReachability(url);
  console.log(`\n  Self-check ${check.reachable ? "succeeded" : "did not succeed"}: ${check.detail}`);
  if (!check.reachable) {
    console.log(
      "  Many routers cannot route a request from inside the network back to their own\n" +
        "  public address (no NAT hairpinning), so this alone does not mean the mapping failed.\n" +
        `  Confirm from a phone on cellular data: open ${url}`
    );
  }
}

await mapping.release();
probe.close();
console.log();
