/**
 * mDNS/DNS-SD local network discovery for Crosslink.
 *
 * Advertises a Crosslink host as a `_crosslink._tcp` service on the local
 * network, allowing nearby devices to discover it without any signaling server.
 *
 * This is an optional transport — LAN WebSocket and relay remain the defaults.
 * mDNS is useful when:
 * - Both devices are on the same network
 * - You want zero-config discovery without a signaling server
 * - You're on a network where multicast DNS works (most home/office networks)
 *
 * Requirements:
 * - `bonjour-service` package (optional dependency)
 * - UDP multicast support (most networks, not VPNs or containerized environments)
 */
import type { Logger } from "@crosslink/core";

const SERVICE_TYPE = "crosslink";

export interface MdnsOptions {
  /** Human-readable name for this host (shown in discovery UIs). */
  name: string;
  /** Port the LAN WebSocket server is listening on. */
  port: number;
  /** Application ID to advertise. */
  appId: string;
  /** Host fingerprint (first 16 hex) for verification. */
  fingerprint: string;
  /** Structured log sink. */
  logger?: Logger;
}

export interface MdnsBrowser {
  /** Stop advertising and shut down. */
  close(): void;
  /** The port being advertised. */
  readonly port: number;
}

interface BonjourInstance {
  publish(options: {
    name: string;
    type: string;
    port: number;
    txt: Record<string, string>;
  }): { stop(): void };
  find(
    options: { type: string },
    callback: (service: ServiceLike) => void
  ): { stop(): void };
  unpublishAll(): void;
  destroy(): void;
}

interface ServiceLike {
  name?: string;
  type: string;
  port: number;
  addresses?: string[];
  referer?: { address: string };
  txt?: Record<string, string>;
}

/**
 * Dynamically imports bonjour-service, returning the Bonjour class.
 */
async function importBonjour(): Promise<{ Bonjour: new () => BonjourInstance }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = await import("bonjour-service");
  return mod as { Bonjour: new () => BonjourInstance };
}

/**
 * Advertises this host via mDNS/DNS-SD on the local network.
 * Returns a handle to stop advertising when done.
 *
 * The service record contains TXT fields:
 * - `id`: application ID
 * - `fp`: first 16 hex of the host fingerprint
 * - `v`: protocol version
 *
 * Clients can discover this by browsing for `_crosslink._tcp.local`.
 */
export async function advertiseMdns(options: MdnsOptions): Promise<MdnsBrowser> {
  const { Bonjour } = await importBonjour();
  const bonjour = new Bonjour();

  const service = bonjour.publish({
    name: options.name,
    type: SERVICE_TYPE,
    port: options.port,
    txt: {
      id: options.appId,
      fp: options.fingerprint.slice(0, 16),
      v: "1.0"
    }
  });

  options.logger?.info("mdns.advertised", {
    name: options.name,
    type: `${SERVICE_TYPE}.local`,
    port: options.port
  });

  return {
    close: () => {
      service.stop();
      bonjour.unpublishAll();
      bonjour.destroy();
      options.logger?.debug("mdns.stopped");
    },
    port: options.port
  };
}

export interface MdnsHost {
  name: string;
  host: string;
  port: number;
  appId: string;
  fingerprintPrefix: string;
}

/**
 * Browses the local network for `_crosslink._tcp` services.
 * Returns hosts as they are discovered, and calls `onFound` for each.
 *
 * The browser runs until `close()` is called on the returned handle.
 */
export async function browseMdns(
  onFound: (host: MdnsHost) => void,
  logger?: Logger
): Promise<{ close(): void }> {
  const { Bonjour } = await importBonjour();
  const bonjour = new Bonjour();

  const browser = bonjour.find({ type: SERVICE_TYPE }, (service: ServiceLike) => {
    const host: MdnsHost = {
      name: service.name ?? "unknown",
      host: service.referer?.address ?? service.addresses?.[0] ?? "unknown",
      port: service.port,
      appId: String(service.txt?.id ?? ""),
      fingerprintPrefix: String(service.txt?.fp ?? "")
    };
    logger?.debug("mdns.found", { name: host.name, host: host.host, port: host.port });
    onFound(host);
  });

  return {
    close: () => {
      browser.stop();
      bonjour.destroy();
      logger?.debug("mdns.browse-stopped");
    }
  };
}
