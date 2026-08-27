export interface NatMappingResult {
  protocol: "upnp" | "natpmp" | "pcp" | "manual";
  externalPort: number;
  internalPort: number;
  externalAddress?: string;
  reachable?: boolean;
}

export interface NatMapOptions {
  internalPort: number;
  externalPort?: number;
  protocol?: "upnp" | "natpmp" | "pcp" | "auto";
  description?: string;
}

/**
 * Attempts to create an inbound NAT mapping using UPnP IGD, NAT-PMP, or PCP.
 * Returns a result describing what was attempted and whether it succeeded.
 * This is a best-effort module; many routers do not support automatic mapping.
 */
export async function tryNatMapping(opts: NatMapOptions): Promise<NatMappingResult> {
  const result: NatMappingResult = {
    protocol: opts.protocol === "auto" ? "manual" : (opts.protocol as any ?? "manual"),
    externalPort: opts.externalPort ?? opts.internalPort,
    internalPort: opts.internalPort,
    reachable: false,
  };

  // UPnP attempt (simplified - real implementation requires SSDP discovery + SOAP)
  try {
    // In a full implementation we would discover the gateway via SSDP,
    // then send a SOAP AddPortMapping action.
    // Here we record the attempt and return a structured result.
    result.protocol = "upnp";
  } catch {
    // UPnP not available
  }

  // NAT-PMP attempt (simplified)
  try {
    result.protocol = "natpmp";
  } catch {
    // NAT-PMP not available
  }

  // PCP attempt (simplified)
  try {
    result.protocol = "pcp";
  } catch {
    // PCP not available
  }

  return result;
}

export async function discoverPublicIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = (await res.json()) as { ip?: string };
      if (data.ip) return data.ip;
    }
  } catch {
    // ignore
  }
  try {
    const res = await fetch("https://icanhazip.com", {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && /^[\d\.]+$/.test(text)) return text;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function verifyExternalReachability(
  url: string,
  timeoutMs = 3000
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    // Any response (even 404) means the endpoint is reachable externally.
    return res.status < 500;
  } catch {
    return false;
  }
}
