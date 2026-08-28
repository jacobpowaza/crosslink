import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for RFC1918 / CGNAT / link-local IPv4 space. */
export function isPrivateIpv4(ip: string): boolean {
  const m = IPV4.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

/**
 * True for the 100.64.0.0/10 carrier-grade NAT range. A host whose "public"
 * address falls in here is behind the ISP's NAT as well as its own router, so
 * no amount of local port mapping makes it reachable from the internet.
 */
export function isCgnatIpv4(ip: string): boolean {
  const m = IPV4.exec(ip);
  if (!m) return false;
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

/** Primary non-internal IPv4 address of this machine, if any. */
export function localIpv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

/**
 * Best-effort default-gateway IPv4 address.
 *
 * NAT-PMP and PCP are unicast UDP to the gateway, so the address has to be
 * known before either can be tried. The routing table is authoritative; the
 * `.1` guess is a last resort that is right on the overwhelming majority of
 * consumer routers and costs one timed-out UDP probe when it is wrong.
 */
export async function defaultGateway(): Promise<string | null> {
  const fromRoutes = await gatewayFromRoutingTable();
  if (fromRoutes) return fromRoutes;
  const local = localIpv4();
  if (!local) return null;
  const parts = local.split(".");
  parts[3] = "1";
  return parts.join(".");
}

async function gatewayFromRoutingTable(): Promise<string | null> {
  const attempts: Array<[string, string[]]> =
    process.platform === "win32"
      ? [["powershell", ["-NoProfile", "-Command", "(Get-NetRoute -DestinationPrefix 0.0.0.0/0).NextHop"]]]
      : process.platform === "darwin"
        ? [["route", ["-n", "get", "default"]], ["netstat", ["-rn", "-f", "inet"]]]
        : [["ip", ["route", "show", "default"]], ["netstat", ["-rn"]]];

  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await run(cmd, args, { timeout: 2000 });
      const ip = firstGatewayIn(stdout);
      if (ip) return ip;
    } catch {
      /* command unavailable on this platform; try the next one */
    }
  }
  return null;
}

function firstGatewayIn(stdout: string): string | null {
  // `route -n get default` and `ip route show default` both label the hop.
  const labelled = /(?:gateway|via)\s*:?\s+(\d{1,3}(?:\.\d{1,3}){3})/i.exec(stdout);
  if (labelled && isPrivateIpv4(labelled[1])) return labelled[1];
  // `netstat -rn` prints "default  192.168.1.1  UGScg  en0".
  for (const line of stdout.split("\n")) {
    if (!/^(default|0\.0\.0\.0)\b/.test(line.trim())) continue;
    const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line);
    if (ip && isPrivateIpv4(ip[1])) return ip[1];
  }
  // Windows PowerShell prints the next hop alone on its own line.
  const bare = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/m.exec(stdout);
  if (bare && isPrivateIpv4(bare[1])) return bare[1];
  return null;
}
