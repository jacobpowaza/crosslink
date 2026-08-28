/**
 * Inbound reachability for a Crosslink host.
 *
 * Getting a phone on cellular to reach a desktop behind a home router needs two
 * separate facts: the router's public address, and an inbound port on that
 * router forwarded to this machine. This package establishes both without any
 * user configuration, by asking the router directly (PCP, then NAT-PMP, then
 * UPnP IGD) and confirming the resulting address with STUN.
 *
 * Every step reports what it actually observed. A caller must never advertise a
 * public endpoint that was not really mapped — see `NatMappingResult.reachable`
 * and `confidence`.
 */
import {
  defaultGateway,
  isCgnatIpv4,
  isPrivateIpv4,
  localIpv4
} from "./gateway.js";
import { natPmpExternalAddress, natPmpMapTcp, natPmpUnmapTcp } from "./natpmp.js";
import { pcpMapTcp, pcpUnmapTcp } from "./pcp.js";
import { discoverReflexiveAddress } from "./stun.js";
import {
  discoverUpnpGateway,
  upnpAddPortMapping,
  upnpDeletePortMapping,
  upnpExternalAddress,
  type UpnpGateway
} from "./upnp.js";

export { defaultGateway, isCgnatIpv4, isPrivateIpv4, localIpv4 } from "./gateway.js";
export { discoverReflexiveAddress, DEFAULT_STUN_SERVERS, type StunResult } from "./stun.js";

/** Which router protocol produced a mapping. `none` means no mapping exists. */
export type NatProtocol = "pcp" | "natpmp" | "upnp" | "none";

/**
 * How much the result can be trusted before advertising it:
 *  - `verified`  an independent observer (STUN) confirmed the external address
 *                the router reported, so the endpoint is safe to publish.
 *  - `router`    the router accepted the mapping but nothing corroborated the
 *                external address. Usually correct; publish with a warning.
 *  - `none`      no mapping. The endpoint must not be published as remote.
 */
export type NatConfidence = "verified" | "router" | "none";

export interface NatMappingResult {
  protocol: NatProtocol;
  /** True only when an inbound mapping actually exists right now. */
  mapped: boolean;
  internalPort: number;
  /** Port to advertise on the public address. Equals internalPort when unmapped. */
  externalPort: number;
  /** Router's WAN address, when one could be determined. */
  externalAddress?: string;
  /** Address STUN saw us come from — the ground truth for the public address. */
  reflexiveAddress?: string;
  /** True when a remote client can be expected to reach `externalAddress:externalPort`. */
  reachable: boolean;
  confidence: NatConfidence;
  /** Seconds the mapping was granted for; renew before it lapses. */
  lifetimeSeconds: number;
  /** Set when the ISP places this host behind carrier-grade NAT. */
  cgnat: boolean;
  /** Ordered log of what was attempted and why it did or did not work. */
  attempts: NatAttempt[];
  /** Human-readable summary suitable for a diagnostics panel. */
  message: string;
}

export interface NatAttempt {
  protocol: Exclude<NatProtocol, "none"> | "stun" | "gateway";
  ok: boolean;
  detail: string;
}

export interface NatMapOptions {
  internalPort: number;
  /** Preferred public port. Defaults to `internalPort`. */
  externalPort?: number;
  /** Force one protocol instead of trying all three. */
  protocol?: "pcp" | "natpmp" | "upnp" | "auto";
  /** Mapping lease in seconds. Default 2 hours; renew with `renewNatMapping`. */
  lifetimeSeconds?: number;
  description?: string;
  /** Per-protocol network timeout. Default 3000ms. */
  timeoutMs?: number;
  /** Skip STUN corroboration (useful in tests and offline environments). */
  skipStun?: boolean;
}

/** Handle for releasing or renewing a mapping this process created. */
export interface NatMappingHandle {
  result: NatMappingResult;
  renew(): Promise<NatMappingResult>;
  release(): Promise<void>;
}

const DEFAULT_LIFETIME = 7200;

/**
 * Attempts to create an inbound TCP mapping, trying PCP, NAT-PMP, then UPnP.
 *
 * Never throws for an ordinary "the router said no" outcome — that is reported
 * as `mapped: false` with the reason in `attempts`, because a host must be able
 * to start up and fall back to LAN-only operation on a router that forbids
 * automatic mapping.
 */
export async function tryNatMapping(opts: NatMapOptions): Promise<NatMappingResult> {
  const internalPort = opts.internalPort;
  const wantedExternal = opts.externalPort ?? internalPort;
  const lifetime = opts.lifetimeSeconds ?? DEFAULT_LIFETIME;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const description = opts.description ?? "Crosslink";
  const attempts: NatAttempt[] = [];

  const result: NatMappingResult = {
    protocol: "none",
    mapped: false,
    internalPort,
    externalPort: wantedExternal,
    reachable: false,
    confidence: "none",
    lifetimeSeconds: 0,
    cgnat: false,
    attempts,
    message: ""
  };

  // STUN runs regardless of whether mapping succeeds: knowing the public
  // address is what lets us tell "router refused" apart from "ISP CGNAT, no
  // mapping could ever work", and those need different advice.
  const stun = opts.skipStun ? null : await discoverReflexiveAddress().catch(() => null);
  if (stun) {
    result.reflexiveAddress = stun.address;
    result.cgnat = isCgnatIpv4(stun.address);
    attempts.push({
      protocol: "stun",
      ok: true,
      detail: `public address ${stun.address}:${stun.port} via ${stun.server}`
    });
  } else if (!opts.skipStun) {
    attempts.push({ protocol: "stun", ok: false, detail: "no STUN server answered" });
  }

  const gateway = await defaultGateway();
  const client = localIpv4();
  attempts.push({
    protocol: "gateway",
    ok: Boolean(gateway),
    detail: gateway ? `default gateway ${gateway}, local address ${client ?? "unknown"}` : "no default gateway found"
  });

  if (result.cgnat) {
    result.message =
      `This connection is behind carrier-grade NAT (${result.reflexiveAddress}). ` +
      "The ISP shares one public address across many customers, so no router port " +
      "mapping can make this machine reachable. Use a relay or a tunnel for remote access.";
    return result;
  }

  const want = (p: NatMapOptions["protocol"]): boolean =>
    !opts.protocol || opts.protocol === "auto" || opts.protocol === p;

  if (gateway && client && want("pcp")) {
    try {
      const mapping = await pcpMapTcp(gateway, client, internalPort, wantedExternal, lifetime, timeoutMs);
      if (mapping) {
        attempts.push({
          protocol: "pcp",
          ok: true,
          detail: `mapped external ${mapping.externalAddress}:${mapping.externalPort} for ${mapping.lifetimeSeconds}s`
        });
        applyMapping(result, "pcp", mapping.externalPort, mapping.lifetimeSeconds, mapping.externalAddress);
      } else {
        attempts.push({ protocol: "pcp", ok: false, detail: "no PCP response from the gateway" });
      }
    } catch (err) {
      attempts.push({ protocol: "pcp", ok: false, detail: String((err as Error).message) });
    }
  }

  if (!result.mapped && gateway && want("natpmp")) {
    try {
      const mapping = await natPmpMapTcp(gateway, internalPort, wantedExternal, lifetime, timeoutMs);
      if (mapping) {
        const external = await natPmpExternalAddress(gateway, timeoutMs).catch(() => null);
        attempts.push({
          protocol: "natpmp",
          ok: true,
          detail: `mapped external port ${mapping.externalPort} for ${mapping.lifetimeSeconds}s` +
            (external ? ` on ${external}` : "")
        });
        applyMapping(result, "natpmp", mapping.externalPort, mapping.lifetimeSeconds, external ?? undefined);
      } else {
        attempts.push({ protocol: "natpmp", ok: false, detail: "no NAT-PMP response from the gateway" });
      }
    } catch (err) {
      attempts.push({ protocol: "natpmp", ok: false, detail: String((err as Error).message) });
    }
  }

  if (!result.mapped && client && want("upnp")) {
    try {
      const igd = await discoverUpnpGateway(timeoutMs);
      if (!igd) {
        attempts.push({ protocol: "upnp", ok: false, detail: "no UPnP gateway answered SSDP" });
      } else {
        const mapping = await upnpAddPortMapping(
          igd,
          {
            internalClient: client,
            internalPort,
            externalPort: wantedExternal,
            lifetimeSeconds: lifetime,
            description
          },
          Math.max(timeoutMs, 4000)
        );
        const external = await upnpExternalAddress(igd, timeoutMs).catch(() => null);
        attempts.push({
          protocol: "upnp",
          ok: true,
          detail: `mapped external port ${mapping.externalPort} for ${mapping.lifetimeSeconds}s` +
            (external ? ` on ${external}` : "")
        });
        applyMapping(result, "upnp", mapping.externalPort, mapping.lifetimeSeconds, external ?? undefined);
        upnpGateways.set(mappingKey(internalPort, mapping.externalPort), igd);
      }
    } catch (err) {
      attempts.push({ protocol: "upnp", ok: false, detail: String((err as Error).message) });
    }
  }

  // The router's own idea of its WAN address is unreliable on double-NAT and on
  // routers that report the modem's private address. STUN is the tiebreaker.
  if (result.mapped) {
    if (result.externalAddress && isPrivateIpv4(result.externalAddress)) {
      result.reachable = false;
      result.confidence = "none";
      result.message =
        `The router mapped a port but reports a private WAN address (${result.externalAddress}), ` +
        "which means there is a second router or modem in front of it. Remote access needs a " +
        "mapping on that device too, or a relay.";
      return result;
    }
    if (!result.externalAddress && result.reflexiveAddress) {
      result.externalAddress = result.reflexiveAddress;
    }
    if (
      result.reflexiveAddress &&
      result.externalAddress &&
      result.reflexiveAddress === result.externalAddress
    ) {
      result.confidence = "verified";
    } else if (result.externalAddress) {
      result.confidence = "router";
    }
    result.reachable = Boolean(result.externalAddress);
    result.message = result.reachable
      ? `Reachable at ${result.externalAddress}:${result.externalPort} via ${result.protocol.toUpperCase()} ` +
        `(${result.confidence === "verified" ? "confirmed by STUN" : "reported by the router"}).`
      : "The router accepted the mapping but would not report a public address.";
    return result;
  }

  result.message = result.reflexiveAddress
    ? `No router mapping is available (public address ${result.reflexiveAddress}). Enable UPnP or ` +
      "NAT-PMP on the router, forward a port manually, or use a relay or tunnel for remote access."
    : "No router mapping is available and no public address could be determined. Remote access " +
      "needs a relay or a tunnel.";
  return result;
}

/**
 * Creates a mapping and returns a handle that renews it on a timer and releases
 * it on shutdown. Leaving a stale mapping behind on the router is both a
 * housekeeping problem and a security one, so hosts should always release.
 */
export async function openNatMapping(opts: NatMapOptions): Promise<NatMappingHandle> {
  let result = await tryNatMapping(opts);
  const key = mappingKey(result.internalPort, result.externalPort);

  return {
    get result() {
      return result;
    },
    async renew() {
      result = await tryNatMapping({ ...opts, externalPort: result.externalPort });
      return result;
    },
    async release() {
      if (!result.mapped) return;
      const gateway = await defaultGateway();
      const client = localIpv4();
      if (result.protocol === "pcp" && gateway && client) {
        await pcpUnmapTcp(gateway, client, result.internalPort);
      } else if (result.protocol === "natpmp" && gateway) {
        await natPmpUnmapTcp(gateway, result.internalPort);
      } else if (result.protocol === "upnp") {
        const igd = upnpGateways.get(key);
        if (igd) await upnpDeletePortMapping(igd, result.externalPort);
        upnpGateways.delete(key);
      }
      result = { ...result, mapped: false, reachable: false, confidence: "none" };
    }
  };
}

/**
 * Confirms an advertised endpoint really is reachable from outside.
 *
 * `verifyUrl` should be an endpoint on a *different* network — a signaling
 * service, or any HTTP echo — that will connect back. Fetching one's own public
 * address from behind the NAT only works on routers that support hairpinning,
 * so a failure here is not proof the endpoint is broken; treat it as a signal,
 * not a verdict.
 */
export async function verifyExternalReachability(
  url: string,
  timeoutMs = 3000
): Promise<{ reachable: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual"
    });
    return {
      reachable: res.status < 500,
      detail: `HTTP ${res.status} from ${url}`
    };
  } catch (err) {
    return {
      reachable: false,
      detail: `${url}: ${String((err as Error).message)} ` +
        "(a router without NAT hairpinning fails this check even when the mapping works)"
    };
  }
}

/**
 * Public IPv4 address of this machine, via STUN with an HTTP fallback.
 * Returns null when neither can answer — never a guess.
 */
export async function discoverPublicIp(): Promise<string | null> {
  const stun = await discoverReflexiveAddress().catch(() => null);
  if (stun) return stun.address;
  for (const url of ["https://api.ipify.org?format=json", "https://icanhazip.com"]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      const ip = text.startsWith("{") ? (JSON.parse(text) as { ip?: string }).ip : text;
      if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
    } catch {
      /* try the next provider */
    }
  }
  return null;
}

const upnpGateways = new Map<string, UpnpGateway>();

function mappingKey(internalPort: number, externalPort: number): string {
  return `${internalPort}:${externalPort}`;
}

function applyMapping(
  result: NatMappingResult,
  protocol: Exclude<NatProtocol, "none">,
  externalPort: number,
  lifetimeSeconds: number,
  externalAddress?: string
): void {
  result.protocol = protocol;
  result.mapped = true;
  result.externalPort = externalPort;
  result.lifetimeSeconds = lifetimeSeconds;
  if (externalAddress) result.externalAddress = externalAddress;
}
