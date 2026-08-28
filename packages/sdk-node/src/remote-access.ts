/**
 * Inbound remote access for a Crosslink host.
 *
 * This is the piece that lets a phone on cellular reach a desktop behind a home
 * router without the developer or the user configuring anything: ask the router
 * for a port mapping (PCP → NAT-PMP → UPnP), confirm the resulting public
 * address with STUN, and publish `ws://<public address>:<mapped port>` as a
 * `wan` pairing endpoint.
 *
 * It is deliberately honest about failure. A router with UPnP disabled, or an
 * ISP using carrier-grade NAT, cannot be made to work by trying harder, and
 * pretending otherwise produces a QR code that silently only works at home.
 * When mapping fails the endpoint is `null` and `diagnostics.message` explains
 * why in words a developer can act on.
 */
import {
  openNatMapping,
  type NatMappingHandle,
  type NatMappingResult
} from "@crosslink/nat-map";
import type { Logger, PairingEndpoint } from "@crosslink/core";

export interface RemoteAccessOptions {
  /** Port the LAN listener is bound to; the mapping targets this port. */
  internalPort: number;
  /** Preferred public port. Defaults to `internalPort`. */
  externalPort?: number;
  /** Mapping lease. Default 2h, renewed at 75% of the lease. */
  lifetimeSeconds?: number;
  /** Keep the mapping alive by re-requesting it before the lease expires. */
  autoRenew?: boolean;
  description?: string;
  logger?: Logger;
  /** Skips STUN; used by tests so no packets leave the machine. */
  skipStun?: boolean;
  timeoutMs?: number;
}

const RENEW_FRACTION = 0.75;
const MIN_RENEW_MS = 60_000;

export class RemoteAccess {
  private renewTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  private constructor(
    private handle: NatMappingHandle,
    private readonly options: RemoteAccessOptions
  ) {}

  /**
   * Attempts to open remote access. Resolves even when mapping fails — callers
   * decide whether an unreachable host is fatal, because that depends on
   * whether the developer asked for `networkMode: "remote"` or just "auto".
   */
  static async open(options: RemoteAccessOptions): Promise<RemoteAccess> {
    const handle = await openNatMapping({
      internalPort: options.internalPort,
      externalPort: options.externalPort,
      lifetimeSeconds: options.lifetimeSeconds,
      description: options.description ?? "Crosslink",
      skipStun: options.skipStun,
      timeoutMs: options.timeoutMs
    });
    const access = new RemoteAccess(handle, options);
    options.logger?.info("remote.nat-mapping", {
      protocol: handle.result.protocol,
      mapped: handle.result.mapped,
      reachable: handle.result.reachable,
      confidence: handle.result.confidence,
      externalPort: handle.result.externalPort,
      cgnat: handle.result.cgnat
    });
    if (options.autoRenew !== false) access.scheduleRenew();
    return access;
  }

  get diagnostics(): NatMappingResult {
    return this.handle.result;
  }

  get reachable(): boolean {
    return this.handle.result.reachable;
  }

  /**
   * The `wan` endpoint to advertise, or null when there is nothing honest to
   * advertise. Never returns a private address: publishing one as `wan` is the
   * exact bug that makes a QR code appear to support remote access while only
   * ever working on the local network.
   */
  endpoint(): PairingEndpoint | null {
    const r = this.handle.result;
    if (!r.reachable || !r.externalAddress) return null;
    return { kind: "wan", url: `ws://${r.externalAddress}:${r.externalPort}` };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.renewTimer) clearTimeout(this.renewTimer);
    await this.handle.release().catch((err) => {
      this.options.logger?.warn("remote.nat-release-failed", { error: String(err) });
    });
  }

  /**
   * Routers drop mappings when the lease lapses, and some drop them on reboot
   * regardless, so the lease is re-requested at 75% of its length rather than
   * at expiry — a renewal that fails still leaves time to notice and report it.
   */
  private scheduleRenew(): void {
    const lifetime = this.handle.result.lifetimeSeconds;
    if (this.closed || !this.handle.result.mapped || lifetime <= 0) return;
    const delay = Math.max(MIN_RENEW_MS, lifetime * 1000 * RENEW_FRACTION);
    this.renewTimer = setTimeout(() => {
      void this.handle
        .renew()
        .then((result) => {
          this.options.logger?.info("remote.nat-renewed", {
            mapped: result.mapped,
            externalPort: result.externalPort
          });
        })
        .catch((err) => {
          this.options.logger?.warn("remote.nat-renew-failed", { error: String(err) });
        })
        .finally(() => this.scheduleRenew());
    }, delay);
    this.renewTimer.unref?.();
  }
}

/**
 * Turns NAT diagnostics into an error a developer can act on, for the case
 * where remote access was explicitly requested and could not be provided.
 * Falling back to LAN silently here would be the worst outcome: the QR would
 * scan, pairing would succeed at home, and fail everywhere else.
 */
export function remoteUnavailableError(diagnostics: NatMappingResult): Error {
  const attempted = diagnostics.attempts
    .map((a) => `  ${a.protocol}: ${a.ok ? "ok" : "failed"} — ${a.detail}`)
    .join("\n");
  return new Error(
    `remote access was requested but this host is not reachable from the internet.\n` +
      `${diagnostics.message}\n\nWhat was tried:\n${attempted}\n\n` +
      `Options: enable UPnP or NAT-PMP in the router's settings, forward a port to this ` +
      `machine manually and set remote.externalPort, run the signaling and relay services ` +
      `somewhere public and set signalingUrl/relayUrl, or opt into a tunnel provider.`
  );
}
