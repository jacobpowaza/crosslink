/**
 * UPnP Internet Gateway Device client: SSDP discovery followed by SOAP calls.
 *
 * Many consumer routers ship with UPnP enabled but NAT-PMP and PCP disabled, so
 * this is the third leg of the mapping strategy rather than a legacy fallback.
 * Only the three actions Crosslink needs are implemented — external address,
 * add mapping, delete mapping.
 */
import dgram from "node:dgram";
import { URL } from "node:url";

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;

const DEVICE_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANPPPConnection:1"
];

const SERVICE_TYPES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1"
];

export interface UpnpGateway {
  /** Absolute URL the SOAP actions are POSTed to. */
  controlUrl: string;
  serviceType: string;
}

export interface UpnpMapping {
  externalPort: number;
  internalPort: number;
  lifetimeSeconds: number;
  /** True when the router would only accept a lease of 0 (never expires). */
  permanent?: boolean;
}

/** A SOAP fault from the gateway, carrying the UPnP error code when it gave one. */
export interface UpnpFault extends Error {
  upnpErrorCode?: number;
}

/** Multicasts an M-SEARCH and resolves the first IGD that answers. */
export async function discoverUpnpGateway(timeoutMs = 3000): Promise<UpnpGateway | null> {
  const locations = await ssdpSearch(timeoutMs);
  for (const location of locations) {
    try {
      const gateway = await describeGateway(location, Math.min(timeoutMs, 3000));
      if (gateway) return gateway;
    } catch {
      /* this device is not a usable IGD; try the next responder */
    }
  }
  return null;
}

function ssdpSearch(timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const locations: string[] = [];
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(locations);
    };
    const timer = setTimeout(finish, timeoutMs);

    socket.on("error", finish);
    socket.on("message", (msg) => {
      const text = msg.toString("utf8");
      const location = /^location:\s*(\S+)/im.exec(text)?.[1];
      if (location && !locations.includes(location)) locations.push(location);
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* not required on every platform */
      }
      for (const target of DEVICE_TARGETS) {
        const search = [
          "M-SEARCH * HTTP/1.1",
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          "MX: 2",
          `ST: ${target}`,
          "",
          ""
        ].join("\r\n");
        socket.send(Buffer.from(search), SSDP_PORT, SSDP_ADDRESS, () => {
          /* a failed send just means one fewer responder */
        });
      }
    });
  });
}

async function describeGateway(location: string, timeoutMs: number): Promise<UpnpGateway | null> {
  const res = await fetch(location, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const xml = await res.text();

  for (const serviceType of SERVICE_TYPES) {
    // Device descriptions nest <service> blocks; find the one whose
    // <serviceType> matches, then read the <controlURL> from that same block.
    const block = new RegExp(
      `<service>(?:(?!</service>)[\\s\\S])*?${escapeRegExp(serviceType)}[\\s\\S]*?</service>`,
      "i"
    ).exec(xml)?.[0];
    if (!block) continue;
    const controlUrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!controlUrl) continue;
    return { controlUrl: new URL(controlUrl, location).toString(), serviceType };
  }
  return null;
}

export async function upnpExternalAddress(
  gateway: UpnpGateway,
  timeoutMs = 3000
): Promise<string | null> {
  const body = await soap(gateway, "GetExternalIPAddress", "", timeoutMs);
  return /<NewExternalIPAddress>\s*([^<]*?)\s*<\/NewExternalIPAddress>/i.exec(body)?.[1] || null;
}

/** UPnP fault codes worth reacting to rather than merely reporting. */
export const UPNP_ONLY_PERMANENT_LEASES = 725;
export const UPNP_CONFLICT_IN_MAPPING = 718;

export async function upnpAddPortMapping(
  gateway: UpnpGateway,
  input: {
    internalClient: string;
    internalPort: number;
    externalPort: number;
    lifetimeSeconds: number;
    description: string;
  },
  timeoutMs = 4000
): Promise<UpnpMapping> {
  const request = async (lifetimeSeconds: number): Promise<void> => {
    const args =
      `<NewRemoteHost></NewRemoteHost>` +
      `<NewExternalPort>${input.externalPort}</NewExternalPort>` +
      `<NewProtocol>TCP</NewProtocol>` +
      `<NewInternalPort>${input.internalPort}</NewInternalPort>` +
      `<NewInternalClient>${input.internalClient}</NewInternalClient>` +
      `<NewEnabled>1</NewEnabled>` +
      `<NewPortMappingDescription>${escapeXml(input.description)}</NewPortMappingDescription>` +
      `<NewLeaseDuration>${lifetimeSeconds}</NewLeaseDuration>`;
    await soap(gateway, "AddPortMapping", args, timeoutMs);
  };

  let lifetimeSeconds = input.lifetimeSeconds;
  try {
    await request(lifetimeSeconds);
  } catch (err) {
    // A large family of consumer routers rejects any finite lease with fault
    // 725 and will only create permanent mappings. Retrying with lease 0 is
    // what every working UPnP client does; refusing to would mean no remote
    // access at all on those routers. The mapping is still released on
    // shutdown, so "permanent" does not mean left behind.
    if ((err as UpnpFault).upnpErrorCode !== UPNP_ONLY_PERMANENT_LEASES) throw err;
    lifetimeSeconds = 0;
    await request(lifetimeSeconds);
  }

  // AddPortMapping has no return values: success is the absence of a fault, and
  // the external port is exactly the one that was asked for.
  return {
    externalPort: input.externalPort,
    internalPort: input.internalPort,
    // A permanent mapping needs no renewal; report the requested lease so the
    // caller's renewal timer still refreshes it after a router reboot.
    lifetimeSeconds: lifetimeSeconds === 0 ? input.lifetimeSeconds : lifetimeSeconds,
    permanent: lifetimeSeconds === 0
  };
}

export async function upnpDeletePortMapping(
  gateway: UpnpGateway,
  externalPort: number,
  timeoutMs = 3000
): Promise<void> {
  const args =
    `<NewRemoteHost></NewRemoteHost>` +
    `<NewExternalPort>${externalPort}</NewExternalPort>` +
    `<NewProtocol>TCP</NewProtocol>`;
  await soap(gateway, "DeletePortMapping", args, timeoutMs).catch(() => "");
}

async function soap(
  gateway: UpnpGateway,
  action: string,
  args: string,
  timeoutMs: number
): Promise<string> {
  const envelope =
    `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${gateway.serviceType}">${args}</u:${action}></s:Body>` +
    `</s:Envelope>`;

  const res = await fetch(gateway.controlUrl, {
    method: "POST",
    headers: {
      "content-type": 'text/xml; charset="utf-8"',
      soapaction: `"${gateway.serviceType}#${action}"`
    },
    body: envelope,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(text)?.[1];
    const desc = /<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/i.exec(text)?.[1];
    const fault: UpnpFault = new Error(
      `UPnP ${action} failed: ${desc ?? `HTTP ${res.status}`}${code ? ` (${code})` : ""}`
    );
    if (code) fault.upnpErrorCode = Number(code);
    throw fault;
  }
  return text;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
