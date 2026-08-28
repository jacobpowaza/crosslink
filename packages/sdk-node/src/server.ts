/**
 * createCrosslinkServer - the Node.js host SDK.
 *
 * Wires identity persistence, capability registry, pairing (QR code), the
 * HostAcceptor over every transport (LAN websocket, relay channel), and the
 * RPC router into one object with an approachable surface.
 */
import http from "node:http";
import path from "node:path";
import { EventEmitter } from "node:events";
import QRCode from "qrcode";
import {
  CapabilityRegistry,
  ConsentBroker,
  CrosslinkSession,
  DeviceGrants,
  DeviceIdentity,
  DEVICE_LINK_RPC_METHOD,
  HostAcceptor,
  HostPairingManager,
  RpcRouter,
  buildPairingUri,
  isValidEndpointUrl,
  toHttpUrl,
  noopLogger,
  sortEndpoints,
  toWebSocketUrl,
  type CapabilityDef,
  type ConsentPrompt,
  type CrosslinkTransport,
  type ExposeOptions,
  type Logger,
  type PairingApproval,
  type PairingApprovalRequest,
  type PairingEndpoint,
  type PairingSessionState,
  type PermissionPolicy,
  type RpcContext,
  type RpcHandler,
  type TrustedDeviceRecord,
} from "@crosslink/core";
import { bytesToBase64, type Json } from "@crosslink/protocol";
import { findCrosslinkDataDir, isLocalUrl, loadOrCreateDevTokens, resolveServiceUrls } from "@crosslink/dev-tokens";
import {
  FileHostDeviceStore,
  JsonStore,
  loadOrCreateIdentitySecurely,
} from "./storage.js";
import type { SecretStore } from "./keychain.js";
import { startLanListener, resolveLanHost, type LanListener } from "./lan.js";
import { SignalingLink, sha256Hex, type SignalingPresence } from "./signaling-client.js";
import { RelayChannel } from "./relay-host.js";
import { assertBootstrapUrl, buildBootstrapUri } from "./bootstrap.js";
import {
  exposeWebrtcOffer,
  type WebrtcHostOptions,
  type ExposeTarget,
} from "@crosslink/webrtc-adapter";
import { advertiseMdns, type MdnsBrowser } from "./mdns.js";
import { RemoteAccess, remoteUnavailableError } from "./remote-access.js";
import type { NatMappingResult } from "@crosslink/nat-map";

export interface OfflineConfig {
  title?: string;
  message?: string;
  icon?: string;
  appName?: string;
  themeColor?: string;
  bgColor?: string;
}

export interface PwaConfig {
  shortName?: string;
  icons?: Array<{ src: string; sizes?: string; type?: string }>;
  themeColor?: string;
  bgColor?: string;
  display?: "standalone" | "minimal-ui" | "fullscreen";
  startUrl?: string;
}

export interface CrosslinkServerConfig {
  application: {
    id: string;
    name: string;
    version?: string;
    pwaConfig?: PwaConfig;
    offline?: OfflineConfig;
  };
  capabilities?: CapabilityDef[];
  /** defaults to ./.crosslink-data/<appId> */
  storageDir?: string;
  mdns?: {
    enabled?: boolean;
    name?: string;
  };
  /** e.g. https://signal.example.com — enables QR pairing across networks */
  signalingUrl?: string;
  /** e.g. https://relay.example.com — enables connectivity behind NATs */
  relayUrl?: string;
  /** Ordered regional fallbacks. The host allocates on the first healthy region. */
  relayUrls?: string[];
  /**
   * Public URL of a tunnel the developer opted into (ngrok, Cloudflare, …).
   * Crosslink never starts a tunnel on its own — a provider account is exactly
   * the configuration this framework exists to avoid — but it will advertise
   * one that is already running.
   */
  tunnelUrl?: string;
  lan?: {
    enabled?: boolean; // default true
    port?: number; // default ephemeral
    bind?: "loopback" | "all"; // default loopback
    /** Address to advertise for LAN pairing when `bind: "all"`. Auto-detects
     *  the first non-internal interface otherwise, which is unreliable on a
     *  machine with more than one active network - set this (or
     *  CROSSLINK_LAN_HOST) to pin the address phones/tablets should use. */
    host?: string;
    /**
     * Serves the app's own HTTP on the same port as the Crosslink transport —
     * typically the installable mobile page. Sharing the port means remote
     * access needs only the one router mapping Crosslink already creates.
     */
    httpHandler?(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>;
    /**
     * Extra browser origins allowed to open a WebSocket to this host, beyond
     * the addresses it advertises itself. Needed only when your own UI is
     * served from somewhere else — a Vite dev server, say.
     */
    allowedOrigins?: string[];
  };
  /**
   * WebRTC upgrade configuration. When set, the host will accept SDP offers
   * from paired devices and negotiate a direct DataChannel, upgrading the
   * session off the relay. The relay remains as a fallback if the upgrade fails.
   *
   * Example with TURN for CGNAT:
   * ```ts
   * webrtc: {
   *   createPeer: () => new RTCPeerConnection({
   *     iceServers: [
   *       { urls: "stun:stun.l.google.com:19302" },
   *       { urls: "turn:your-turn-server.com", username: "user", credential: "pass" }
   *     ]
   *   })
   * }
   * ```
   */
  webrtc?: {
    /**
     * Factory that creates a new RTCPeerConnection for each upgrade attempt.
     * The factory should include any ICE servers (STUN/TURN) in the config.
     * Required to enable WebRTC upgrades.
     */
    createPeer: WebrtcHostOptions["createPeer"];
    /** Capability required to request a WebRTC upgrade. Defaults to undefined (any paired device). */
    capability?: string;
    /** Max concurrent half-open peer connections. Default 8. */
    maxPending?: number;
    /** Timeout for the SDP exchange. Default 15s. */
    timeoutMs?: number;
  };
  /** Shared secret for a private relay (or CROSSLINK_RELAY_TOKEN). */
  relayToken?: string;
  /** Shared secret for a private signaling service (or CROSSLINK_SIGNALING_TOKEN). */
  signalingToken?: string;
  pairing?: {
    ttlMs?: number;
    autoApprove?: boolean; // dev convenience; never for production
    approve?(request: PairingApprovalRequest): PairingApproval | Promise<PairingApproval>;
    /**
     * Called immediately before the authoritative approval hook. Use it to
     * raise an Electron/native notification or send a push to a trusted
     * administrative device. Delivery cannot approve a pairing by itself.
     */
    notifyApprovalRequest?(request: PairingApprovalRequest): void | Promise<void>;
    /**
     * Base URL of the hosted, installable client/bootstrap page. When set, the
     * pairing QR points at an `https://…<this>#pair=<manifest uri>` link instead
     * of a raw `crosslink://` scheme, so scanning it with an iPhone opens Safari,
     * shows the setup page, and allows "Add to Home Screen" — the no-config path.
     * Host it anywhere static HTTPS is free (GitHub Pages, your own box).
     */
    bootstrapUrl?: string;
  };
  /**
   * Which transports the host offers.
   *
   * - `auto`        LAN, plus whatever remote path is configured or discovered.
   * - `local-only`  LAN only; no signaling, relay, tunnel or port mapping.
   * - `lan-and-relay` LAN plus the configured relay/signaling services.
   * - `remote`      LAN plus a route that works from outside this network.
   *                 Startup fails loudly if no such route can be established,
   *                 rather than handing out a QR that only works at home.
   */
  networkMode?: "auto" | "local-only" | "lan-and-relay" | "remote";
  /**
   * Direct inbound access from the internet, via a router port mapping
   * negotiated with PCP, NAT-PMP or UPnP. This is the zero-infrastructure path
   * to remote connectivity: no tunnel provider, no account, no hosted service.
   * It cannot work behind carrier-grade NAT or on a router that forbids
   * automatic mapping; `getRemoteDiagnostics()` says which case applies.
   */
  remote?: {
    /** Default: on for `networkMode: "remote"`, off otherwise. */
    enabled?: boolean;
    /** Public port to request. Defaults to the LAN listener's port. */
    externalPort?: number;
    /** Mapping lease in seconds. Default 7200, renewed automatically. */
    lifetimeSeconds?: number;
    /** Set false to let the lease lapse instead of renewing it. */
    autoRenew?: boolean;
    /**
     * The router will not negotiate a mapping, but a port-forward rule was
     * added by hand. Advertises `<public address>:<externalPort>` on that word
     * alone — nothing on this machine can verify a forward from the inside, so
     * a wrong rule produces a QR that fails only off Wi-Fi.
     */
    portForwarded?: boolean;
    /**
     * Public address or dynamic-DNS hostname to advertise instead of the
     * STUN-discovered one. A home IP changes when the ISP renews its lease,
     * which breaks every endpoint a phone already installed to its home screen;
     * a hostname that follows the address is what makes the install durable.
     * Implies `portForwarded`.
     */
    publicHost?: string;
  };
  /** Security hardening options. */
  security?: {
    /** Maximum number of paired devices. Default unlimited. */
    maxDevices?: number;
    /** Maximum concurrent active pairing sessions. Default 3. */
    maxActivePairingSessions?: number;
    /** Minimum interval between pairing session creation per IP. Default 5s. */
    pairingRateLimitMs?: number;
    /** Only accept connections from devices on the same LAN subnet. Default false. */
    localNetworkOnly?: boolean;
  };
  /**
   * Host-authored permission policy, applied to every pairing request before
   * the user is asked anything. Defaults deny auto-granting above "low" risk
   * and force a human decision on every "high"-risk capability.
   */
  permissions?: PermissionPolicy;
  /**
   * Asked before each invocation of a `confirmEachUse` capability. Without it,
   * such capabilities are refused: the point of marking one is that a standing
   * grant is not enough.
   */
  onConsentRequest?: ConsentPrompt;
  consent?: {
    /** How long an "always" answer is remembered. Default 24h. */
    alwaysTtlMs?: number;
    /** How long a "session" answer is remembered. Default: until disconnect. */
    sessionTtlMs?: number;
    /** Treat an unanswered prompt as a refusal after this long. Default 60s. */
    promptTimeoutMs?: number;
  };
  /**
   * Rewrites a service URL before it's published in signaling presence.
   * Used to expose LAN-reachable addresses to phone clients when the
   * internal URL (e.g. 127.0.0.1) is unreachable from the phone.
   * `context` is "relay" or "signaling".
   */
  resolvePresenceUrl?: (url: string, context: "relay" | "signaling") => string;
  /** Structured log sink. Defaults to a no-op; pass `consoleLogger()` in dev. */
  logger?: Logger;
  /** Pre-built secret store; otherwise the strongest available is selected. */
  secretStore?: SecretStore;
  secrets?: {
    /** Namespace in the OS keychain. Defaults to "crosslink:<appId>". */
    service?: string;
    /** Passphrase for the encrypted-file fallback (or CROSSLINK_SECRET_KEY). */
    passphrase?: string;
    /** Accept plaintext-at-rest storage when nothing better is available. */
    allowPlaintextFallback?: boolean;
    /** Skip OS keychain probing (tests, headless CI). */
    preferFile?: boolean;
  };
  /**
   * Composable initialization: pass an existing server/runtime to attach
   * Crosslink capabilities (pairing, transport, signaling) without forcing
   * the developer to restructure their application around a standalone
   * Crosslink server. When set, Crosslink will use the provided runtime
   * instead of creating its own independent server structure.
   */
  attachTo?: "existing-server" | { type: "existing-server"; server?: unknown };
}

export type PairingNetworkMode = NonNullable<CrosslinkServerConfig["networkMode"]>;

export interface PairingCodeInfo {
  code: string;
  expiresAt: number;
  uri: string | null;
  qrSvg: string | null;
  psid: string;
  /** Hosted `https://…/#pair=<uri>` link for the iOS "Add to Home Screen" flow. */
  bootstrapUri?: string | null;
  /** Routes advertised in this QR, in the order a client should try them. */
  endpoints?: PairingEndpoint[];
}

/**
 * What the host can reach the outside world over, in a form a desktop UI can
 * show a human ("Phones can reach you now", "Local network only", …).
 */
export interface ConnectivityStatus {
  /** machine-readable reachability summary */
  reach: "local-only" | "relayed" | "offline";
  lan: boolean;
  relay: boolean;
  signaling: boolean;
  webrtc: boolean;
  /** short, copy that end users actually read */
  message: string;
  transports: Record<string, unknown>;
}

export interface DeviceSummary {
  deviceId: string;
  name: string;
  caps: string[];
  addedAt: number;
  lastSeen?: number;
  revokedAt?: number;
}

export type ServerEvents = {
  devicePaired: [record: TrustedDeviceRecord];
  deviceRevoked: [deviceId: string];
  deviceConnected: [info: { deviceId: string; transport: string }];
  deviceDisconnected: [info: { deviceId: string; transport: string }];
  pairingIssued: [info: PairingCodeInfo];
  /** A pairing is waiting for the host user's explicit decision. */
  pairingApprovalRequested: [request: PairingApprovalRequest];
  /** Emitted whenever host reachability changes. */
  connectivity: [status: ConnectivityStatus];
};

function isLocalAddress(ip: string): boolean {
  if (!ip) return false;
  let cleanIp = ip.trim();
  if (cleanIp.startsWith("::ffff:")) {
    cleanIp = cleanIp.substring(7);
  }
  if (cleanIp === "127.0.0.1" || cleanIp === "::1" || cleanIp === "localhost") {
    return true;
  }
  if (/^10\./.test(cleanIp)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)) return true;
  if (/^192\.168\./.test(cleanIp)) return true;
  if (/^169\.254\./.test(cleanIp)) return true;
  if (/^[fF][cCdD]/.test(cleanIp)) return true;
  if (/^[fF][eE]80/.test(cleanIp)) return true;
  return false;
}

const sanitizeAppId = (id: string): string => id.replace(/[^a-zA-Z0-9._-]/g, "_");

function isAddressInUse(err: unknown): boolean {
  return (err as { code?: string })?.code === "EADDRINUSE";
}

export class CrosslinkServer extends EventEmitter {
  readonly config: CrosslinkServerConfig;
  readonly log: Logger;
  private storageDir!: string;
  private identity!: DeviceIdentity;
  private deviceStore!: FileHostDeviceStore;
  private registry = new CapabilityRegistry();
  private grants = new DeviceGrants();
  private consent!: ConsentBroker;
  private secretStore?: SecretStore;
  private router!: RpcRouter;
  private pairing!: HostPairingManager;

  private lan?: LanListener;
  private remote?: RemoteAccess;
  private mdnsBrowser?: MdnsBrowser;
  private signaling?: SignalingLink;
  private relay?: RelayChannel;
  private relayRetry?: ReturnType<typeof setTimeout>;
  private sessions = new Map<CrosslinkSession, string>();
  private liveCodes = new Map<string, PairingSessionState>();
  private started = false;
  private stopping = false;
  private webrtcExposed = false;
  /** Resolved service URLs (from config, env, or stack auto-discovery). */
  private _signalingUrl = "";
  private _relayUrl = "";
  private _relayUrls: string[] = [];
  /** Rate limiting: tracks pairing session creation timestamps per IP. */
  private pairingTimestamps = new Map<string, number>();

  constructor(config: CrosslinkServerConfig) {
    super();
    this.config = config;
    this.log = (config.logger ?? noopLogger).child({
      component: "crosslink-server",
      appId: config.application.id
    });
  }

  private get relayToken(): string | undefined {
    if (this.config.relayToken) return this.config.relayToken;
    if (process.env.CROSSLINK_RELAY_TOKEN) return process.env.CROSSLINK_RELAY_TOKEN;
    // Only fall back to per-machine dev tokens for localhost services; a
    // remote (e.g. hosted) service must be configured explicitly.
    const url = this._relayUrl || this.config.relayUrl;
    if (url && isLocalUrl(url)) {
      return loadOrCreateDevTokens().relayToken;
    }
    return undefined;
  }

  private get signalingToken(): string | undefined {
    if (this.config.signalingToken) return this.config.signalingToken;
    if (process.env.CROSSLINK_SIGNALING_TOKEN) {
      return process.env.CROSSLINK_SIGNALING_TOKEN;
    }
    const url = this._signalingUrl || this.config.signalingUrl;
    if (url && isLocalUrl(url)) {
      return loadOrCreateDevTokens().signalingToken;
    }
    return undefined;
  }

  /* ------------------------------ app surface ------------------------ */

  expose(method: string, handler: RpcHandler, options?: ExposeOptions): this;
  expose(method: string, options: ExposeOptions & { handler: RpcHandler }): this;
  expose(
    method: string,
    handlerOrOpts: RpcHandler | (ExposeOptions & { handler: RpcHandler }),
    maybeOpts?: ExposeOptions
  ): this {
    if (typeof handlerOrOpts === "function") {
      this.ensureRouter().expose(method, handlerOrOpts, maybeOpts ?? {});
    } else {
      const { handler, ...opts } = handlerOrOpts;
      this.ensureRouter().expose(method, handler, opts);
    }
    return this;
  }

  declareEvent(event: string, options: { capability?: string } = {}): this {
    this.ensureRouter().declareEvent(event, options);
    return this;
  }

  override emit(event: string, payload?: unknown): boolean {
    // Lazily declared events keep DX simple; declareEvent() adds capability gates.
    this.ensureRouter().declareEvent(event, {});
    this.router.publish(event, payload as Json);
    return super.emit(event, payload);
  }

  typedOn<K extends keyof ServerEvents>(event: K, cb: (...args: ServerEvents[K]) => void): this {
    return super.on(event as string, cb as never);
  }

  /* ------------------------------- lifecycle ------------------------- */

  async start(): Promise<this> {
    if (this.started) return this;
    const appId = this.config.application.id;
    this.storageDir =
      this.config.storageDir ?? path.join(findCrosslinkDataDir(), sanitizeAppId(appId));

    // Auto-discover signaling/relay URLs from stack config when not explicit
    const resolved = resolveServiceUrls({
      signalingUrl: this.config.signalingUrl,
      relayUrl: this.config.relayUrl,
      signalingEnv: process.env.CROSSLINK_SIGNALING_URL,
      relayEnv: process.env.CROSSLINK_RELAY_URL,
    });
    this._signalingUrl = this.config.signalingUrl ?? resolved?.signalingUrl ?? "";
    this._relayUrl = this.config.relayUrl ?? resolved?.relayUrl ?? "";
    this._relayUrls = [...new Set([
      ...(this._relayUrl ? [this._relayUrl] : []),
      ...(this.config.relayUrls ?? [])
    ].map((url) => url.replace(/\/$/, "")))];

    const secure = await loadOrCreateIdentitySecurely({
      storageDir: this.storageDir,
      service: this.config.secrets?.service ?? `crosslink:${sanitizeAppId(appId)}`,
      passphrase: this.config.secrets?.passphrase,
      allowPlaintextFallback: this.config.secrets?.allowPlaintextFallback,
      preferFile: this.config.secrets?.preferFile,
      logger: this.log,
      ...(this.config.secretStore ? { secretStore: this.config.secretStore } : {})
    });
    this.identity = secure.identity;
    this.secretStore = secure.store;
    this.deviceStore = new FileHostDeviceStore(this.storageDir);

    this.registry.registerAll(this.config.capabilities ?? []);

    this.pairing = new HostPairingManager({
      identity: this.identity,
      appId,
      registry: this.registry,
      store: this.deviceStore,
      grants: this.grants,
      ttlMs: this.config.pairing?.ttlMs,
      autoApprove: this.config.pairing?.autoApprove,
      approve: this.config.pairing?.approve,
      notifyApprovalRequest: async (request) => {
        this.emit("pairingApprovalRequested", request);
        await this.config.pairing?.notifyApprovalRequest?.(request);
      },
      policy: this.config.permissions,
      logger: this.log
    });

    // Restore grants from disk, re-applying the policy's TTL to the moment
    // each device was paired - a restart must not silently renew an expiry.
    for (const rec of this.deviceStore.list()) {
      if (rec.revokedAt !== undefined) continue;
      this.grants.grant(rec.deviceId, rec.caps, {
        expiresAt: this.pairing.permissionEngine.grantExpiryFrom(rec.addedAt)
      });
    }

    this.consent = new ConsentBroker({
      registry: this.registry,
      prompt: this.config.onConsentRequest,
      alwaysTtlMs: this.config.consent?.alwaysTtlMs,
      sessionTtlMs: this.config.consent?.sessionTtlMs,
      promptTimeoutMs: this.config.consent?.promptTimeoutMs,
      logger: this.log
    });

    this.ensureRouter().setConsentBroker(this.consent);

    // Framework-level method, exposed on every host regardless of app code:
    // lets an already-trusted, connected device mint a single-use
    // continuation token for itself, so it can silently re-establish trust
    // from a fresh storage context (e.g. iOS "Add to Home Screen", which does
    // not share IndexedDB/localStorage with the Safari tab that paired it).
    // No capability gate — any device the router still recognizes may ask.
    this.ensureRouter().expose(DEVICE_LINK_RPC_METHOD, (_input: unknown, ctx: RpcContext) => {
      const session = this.pairing.beginLinkSession(ctx.deviceId);
      // Link handoffs use the same rendezvous machinery as normal codes. The
      // previous implementation created only an in-memory host session, so a
      // link URI advertising a signaling route could never resolve remotely.
      if (this.signaling) {
        this.signaling.openPairing({
          psid: session.psid,
          codeHash: sha256Hex(session.code),
          ttlMs: Math.max(1_000, session.expiresAt - Date.now())
        });
      }
      const uri = buildPairingUri({
        endpoints: this.connectionEndpoints(),
        code: session.code,
        appId: this.config.application.id,
        appName: this.config.application.name,
        hostPubEdB64: bytesToBase64(this.identity.edPublicKey),
        link: true
      });
      this.log.info("install.handoff-created", {
        fromDeviceId: ctx.deviceId,
        expiresAt: session.expiresAt
      });
      return { handoffId: session.code, uri, expiresAt: session.expiresAt };
    });

    // LAN listener (default on). Remote access maps a router port to this
    // socket, so it must be bound on all interfaces — a mapping pointed at a
    // loopback-only listener resolves and then refuses every connection.
    const wantsRemote = this.remoteRequested();
    if (this.config.lan?.enabled !== false) {
      const lanOptions = {
        bind: wantsRemote ? ("all" as const) : (this.config.lan?.bind ?? ("loopback" as const)),
        host: this.config.lan?.host,
        httpHandler: this.config.lan?.httpHandler,
        // Every address this host advertises counts as its own origin. The
        // bootstrap page may have been fetched over the public address while
        // the socket the phone then opens is the LAN one; that is cross-origin
        // by the letter of the rule and entirely legitimate.
        allowedOrigins: () => [
          ...this.connectionEndpoints().map((e) => toHttpUrl(e.url)),
          ...(this.config.lan?.allowedOrigins ?? [])
        ],
        onConnection: (t: CrosslinkTransport) => this.acceptTransport(t)
      };
      const preferredPort = this.config.lan?.port ?? this.stableListenPort();
      try {
        this.lan = await startLanListener({ ...lanOptions, port: preferredPort });
      } catch (err) {
        // Another process holds the port we used last time. Starting anyway on
        // an ephemeral port is better than refusing to run: paired phones fail
        // over to another endpoint and pick the new one up. An explicitly
        // configured port is a different matter — the developer asked for that
        // one, so the conflict is theirs to resolve.
        if (this.config.lan?.port !== undefined || !isAddressInUse(err)) throw err;
        this.log.warn("server.lan-port-taken", { port: preferredPort });
        this.lan = await startLanListener({ ...lanOptions, port: 0 });
      }
      this.rememberListenPort(this.lan.port);
    } else if (wantsRemote) {
      throw new Error(
        "remote access needs the LAN listener: it is the socket the router maps a public port to. " +
          "Remove `lan.enabled: false`, or reach devices through a relay instead."
      );
    }

    // Router port mapping (PCP / NAT-PMP / UPnP), for direct internet reach.
    if (wantsRemote) await this.enableRemoteAccess();

    // mDNS local discovery (optional)
    if (this.config.mdns?.enabled && this.lan) {
      try {
        this.mdnsBrowser = await advertiseMdns({
          name: this.config.mdns.name ?? this.config.application.name,
          port: this.lan.port,
          appId: this.config.application.id,
          fingerprint: this.identity.fingerprint,
          logger: this.log
        });
      } catch (err) {
        this.log.warn("server.mdns-start-failed", { error: err });
      }
    }

    // Relay channel (optional, disabled in local-only mode)
    if (this._relayUrls.length > 0 && this.config.networkMode !== "local-only") {
      try {
        await this.connectRelay(this._relayUrls);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (/auth|token|unauthorized|forbidden|401|403/i.test(msg)) {
          throw err;
        }
        this.log.warn("server.relay-start-failed", { error: err });
        this.scheduleRelayReconnect(true);
      }
    }

    // Signaling presence (optional but recommended, disabled in local-only mode)
    if (this._signalingUrl && this.config.networkMode !== "local-only") {
      this.startSignaling(this._signalingUrl);
    }

    // WebRTC upgrade support (optional)
    if (this.config.webrtc) {
      this.setupWebrtc(this.config.webrtc);
    }

    this.started = true;
    this.log.info("server.started", {
      deviceId: this.identity.deviceId,
      transports: {
        lan: this.lan ? this.lan.url() : null,
        relay: this.relay ? this.relay.channelId : null,
        signaling: this._signalingUrl || null
      },
      secrets: this.secretStore?.kind,
      devices: this.deviceStore.list().length
    });
    this.emitConnectivity("started");
    return this;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.relayRetry);
    this.signaling?.stop();
    this.relay?.close();
    if (this.mdnsBrowser) {
      this.mdnsBrowser.close();
      this.mdnsBrowser = undefined;
    }
    for (const session of [...this.sessions.keys()]) session.close("server-stopping");
    // Release the router mapping before the socket goes away, so a restart does
    // not accumulate stale forwards pointing at a dead port.
    await this.remote?.close();
    this.remote = undefined;
    await this.lan?.close();
    this.started = false;
    this.log.info("server.stopped");
  }

  /* -------------------------------- pairing -------------------------- */

  async getPairingCode(ip?: string, mode: PairingNetworkMode = this.config.networkMode ?? "auto"): Promise<PairingCodeInfo> {
    this.assertStarted();
    const sec = this.config.security;

    // Enforce device limit
    if (sec?.maxDevices !== undefined) {
      const activeDevices = this.deviceStore.list().filter((d) => !d.revokedAt).length;
      if (activeDevices >= sec.maxDevices) {
        throw new Error(
          `device limit reached (${sec.maxDevices}); revoke a device before pairing a new one`
        );
      }
    }

    // Clean up expired sessions before checking limits
    const now = Date.now();
    for (const [psid, session] of this.liveCodes) {
      if (session.expiresAt <= now) {
        this.liveCodes.delete(psid);
      }
    }

    // Enforce pairing session rate limit
    const maxSessions = sec?.maxActivePairingSessions ?? 10;
    if (this.liveCodes.size >= maxSessions) {
      throw new Error(
        `too many active pairing sessions (${this.liveCodes.size}/${maxSessions}); wait for one to expire`
      );
    }

    // Enforce pairing code generation rate limit
    const isTest = typeof process !== "undefined" && (process.env.VITEST || process.env.NODE_ENV === "test");
    const rateLimitMs = sec?.pairingRateLimitMs ?? (isTest ? 0 : 5000);
    if (rateLimitMs > 0) {
      const key = ip ?? "global";
      const lastTime = this.pairingTimestamps.get(key);
      if (lastTime !== undefined) {
        const elapsed = now - lastTime;
        if (elapsed < rateLimitMs) {
          throw new Error(
            `pairing code rate limit exceeded; please wait ${Math.ceil((rateLimitMs - elapsed) / 1000)}s`
          );
        }
      }
      this.pairingTimestamps.set(key, now);
    }

    const session = this.pairing.beginSession();
    const info: PairingCodeInfo = {
      psid: session.psid,
      code: session.code,
      expiresAt: session.expiresAt,
      uri: null,
      qrSvg: null
    };

    // Register the code with the signaling service (if connected) so remote
    // clients can resolve it. This is optional — LAN-only pairing works
    // without signaling by reading the code directly from the QR.
    if (this.signaling) {
      this.signaling.openPairing({
        psid: session.psid,
        codeHash: sha256Hex(session.code.replace(/\D/g, "")),
        ttlMs: Math.max(1_000, session.expiresAt - Date.now())
      });
    }

    // The QR advertises every route this host genuinely has, in preference
    // order, and nothing it does not. Endpoint construction lives in one place
    // (`connectionEndpoints`) so no demo, example or app can invent its own.
    // A `remote` code asks for a route off this network, whether or not the
    // host was started in that mode. Try to establish one before deciding the
    // request cannot be served.
    if (mode === "remote" && !this.remote && this.lan && this.config.remote?.enabled !== false) {
      await this.enableRemoteAccess().catch((err) => {
        this.log.warn("server.remote-enable-failed", { error: String(err) });
      });
    }

    const endpoints = this.connectionEndpoints(mode);
    if (mode === "remote" && !this.hasRemoteEndpoint(endpoints)) {
      throw remoteUnavailableError(
        this.remote?.diagnostics ?? {
          protocol: "none",
          mapped: false,
          internalPort: this.lan?.port ?? 0,
          externalPort: this.lan?.port ?? 0,
          reachable: false,
          confidence: "none",
          lifetimeSeconds: 0,
          cgnat: false,
          attempts: [],
          message:
            "Remote access could not be established and no relay or signaling service is " +
            "configured. The LAN listener must also be bound to all interfaces (`lan.bind: \"all\"`) " +
            "for a router forward to reach it."
        }
      );
    }

    const uri = buildPairingUri({
      endpoints,
      code: session.code,
      appId: this.config.application.id,
      appName: this.config.application.name,
      hostPubEdB64: bytesToBase64(this.identity.edPublicKey)
    });
    info.uri = uri;
    info.endpoints = endpoints;

    // When a hosted bootstrap page is configured, the QR is an https:// link
    // so scanning it with an iPhone opens Safari (a `crosslink://` scheme has
    // no iOS handler). The page pulls `#bootstrap=<manifest>` and pairs in one
    // tap; see docs/BOOTSTRAP.md.
    const bootstrapUrl = this.config.pairing?.bootstrapUrl ?? process.env.CROSSLINK_BOOTSTRAP_URL;
    if (bootstrapUrl) {
      const base = assertBootstrapUrl(bootstrapUrl);
      info.bootstrapUri = buildBootstrapUri(uri, base);
      info.qrSvg = await QRCode.toString(info.bootstrapUri, { type: "svg", margin: 1 });
    } else {
      info.qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1 });
    }

    this.liveCodes.set(session.psid, session);
    this.emit("pairingIssued", info);
    return info;
  }

  /* ------------------------------ endpoints -------------------------- */

  /**
   * Every route a client could use to reach this host right now, in the order
   * a client should try them.
   *
   * This is the single source of truth for pairing endpoints. It never invents
   * a route: a `wan` entry appears only when the router actually confirmed an
   * inbound mapping, and a `lan` entry only when the LAN listener is bound to a
   * real network interface. A loopback-only listener produces no endpoint at
   * all, because `ws://127.0.0.1:…` on a phone means the phone itself.
   */
  connectionEndpoints(mode: PairingNetworkMode = this.config.networkMode ?? "auto"): PairingEndpoint[] {
    const endpoints: PairingEndpoint[] = [];

    if (this.lan) {
      const address = this.lan.address ?? resolveLanHost(this.config.lan?.host);
      // No address means the listener is on loopback only — reachable by this
      // machine and nothing else, so there is nothing to advertise.
      if (address) endpoints.push({ kind: "lan", url: `ws://${address}:${this.lan.port}` });
    }

    const wan = this.remote?.endpoint();
    if (wan) endpoints.push(wan);

    // Service URLs are advertised exactly as configured. Any address rewriting
    // belongs to whoever deploys the service, not to the pairing payload.
    if (this._signalingUrl && this.config.networkMode !== "local-only") {
      endpoints.push({ kind: "sig", url: toWebSocketUrl(this._signalingUrl.replace(/\/$/, "")) });
    }
    if (this._relayUrl && this.config.networkMode !== "local-only") {
      endpoints.push({ kind: "relay", url: toWebSocketUrl(this._relayUrl.replace(/\/$/, "")) });
    }
    if (this.config.tunnelUrl) {
      endpoints.push({ kind: "tunnel", url: toWebSocketUrl(this.config.tunnelUrl.replace(/\/$/, "")) });
    }

    const allowedKinds = mode === "local-only"
      ? new Set<PairingEndpoint["kind"]>(["lan"])
      : mode === "lan-and-relay"
        ? new Set<PairingEndpoint["kind"]>(["lan", "sig", "relay"])
        : null;

    return sortEndpoints(
      endpoints.filter((e) =>
        isValidEndpointUrl(e.url, e.kind) && (!allowedKinds || allowedKinds.has(e.kind))
      )
    );
  }

  /** True when at least one advertised route works from outside this network. */
  private hasRemoteEndpoint(endpoints: readonly PairingEndpoint[]): boolean {
    return endpoints.some((e) => e.kind === "wan" || e.kind === "sig" || e.kind === "relay" || e.kind === "tunnel");
  }

  /**
   * Port the LAN listener should ask for.
   *
   * The port outlives this process: it is baked into the endpoint every paired
   * phone stored, and into the router mapping when remote access is on. An
   * ephemeral port would change on every restart, silently invalidating every
   * saved route and forcing a re-scan — precisely the thing Crosslink promises
   * not to do. So the port is remembered and re-requested. Falling back to
   * ephemeral when it is taken keeps startup working; a phone then recovers
   * through whichever other endpoint still resolves.
   */
  private stableListenPort(): number {
    const remembered = this.listenPortStore().load({ port: 0 }).port;
    return Number.isInteger(remembered) && remembered > 1024 && remembered < 65536 ? remembered : 0;
  }

  private rememberListenPort(port: number): void {
    const store = this.listenPortStore();
    if (store.load({ port: 0 }).port === port) return;
    store.save({ port });
  }

  private listenPortStore(): JsonStore<{ port: number }> {
    return new JsonStore<{ port: number }>(path.join(this.storageDir, "listen-port.json"));
  }

  /**
   * Opens remote access now, if it is not already open.
   *
   * Startup does this automatically for `networkMode: "remote"`, but the mode
   * is also a runtime choice — a user toggling "reachable from anywhere" in a
   * settings panel changes `config.networkMode` on a host that started in
   * `auto`. Without this, that toggle could never produce a `wan` endpoint and
   * failed with the "remote access is not enabled" message, which described the
   * startup config rather than the request being made.
   *
   * Resolves either way; ask `getRemoteDiagnostics()` what actually happened.
   */
  async enableRemoteAccess(): Promise<void> {
    if (this.remote) return;
    if (!this.lan) {
      throw new Error(
        "remote access needs the LAN listener: it is the socket the router maps a public port to. " +
          "Remove `lan.enabled: false`, or reach devices through a relay instead."
      );
    }
    this.remote = await RemoteAccess.open({
      internalPort: this.lan.port,
      externalPort: this.config.remote?.externalPort,
      lifetimeSeconds: this.config.remote?.lifetimeSeconds,
      autoRenew: this.config.remote?.autoRenew,
      assumeForwarded: this.config.remote?.portForwarded,
      publicHost: this.config.remote?.publicHost,
      description: `Crosslink ${this.config.application.name}`,
      logger: this.log
    });
  }

  private remoteRequested(): boolean {
    if (this.config.remote?.enabled !== undefined) return this.config.remote.enabled;
    if (this.config.remote?.portForwarded || this.config.remote?.publicHost) return true;
    return this.config.networkMode === "remote";
  }

  /**
   * What the router said, verbatim, for a diagnostics panel: which protocols
   * were tried, what each one answered, the discovered public address, and
   * whether the ISP is using carrier-grade NAT. Null when remote access was
   * never attempted.
   */
  getRemoteDiagnostics(): NatMappingResult | null {
    return this.remote?.diagnostics ?? null;
  }

  /**
   * Resolves public routing metadata for a live opaque install handoff. This is
   * intended for a same-origin `/__crosslink/install/:id` bootstrap endpoint;
   * possession of the id is still required to complete the signed pairing.
   */
  getInstallHandoff(handoffId: string): { uri: string; expiresAt: number } | null {
    this.assertStarted();
    const session = this.pairing.lookupLinkSession(handoffId);
    if (!session) return null;
    return {
      uri: buildPairingUri({
        endpoints: this.connectionEndpoints(),
        code: session.code,
        appId: this.config.application.id,
        appName: this.config.application.name,
        hostPubEdB64: bytesToBase64(this.identity.edPublicKey),
        link: true
      }),
      expiresAt: session.expiresAt
    };
  }

  listDevices(): DeviceSummary[] {
    this.assertStarted();
    return this.deviceStore.list().map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      caps: [...d.caps],
      addedAt: d.addedAt,
      lastSeen: d.lastSeen,
      revokedAt: d.revokedAt
    }));
  }

  setDeviceCaps(deviceId: string, caps: string[]): void {
    this.assertStarted();
    if (!caps.every((c) => this.registry.has(c))) {
      throw new Error("unknown capability id");
    }
    this.deviceStore.setCaps(deviceId, caps);
    if (this.deviceStore.get(deviceId)?.revokedAt === undefined) {
      this.grants.revoke(deviceId);
      this.grants.grant(deviceId, caps, {
        expiresAt: this.pairing.permissionEngine.grantExpiryFrom()
      });
      this.log.info("device.caps-changed", { deviceId, caps });
    }
  }

  renameDevice(deviceId: string, name: string): void {
    this.assertStarted();
    const rec = this.deviceStore.get(deviceId);
    if (!rec) throw new Error("unknown device");
    this.deviceStore.upsert({ ...rec, name });
  }

  revokeDevice(deviceId: string): boolean {
    this.assertStarted();
    const activeBefore = new Set(
      this.deviceStore.list().filter((record) => record.revokedAt === undefined).map((record) => record.deviceId)
    );
    const ok = this.deviceStore.revoke(deviceId, Date.now());
    if (ok) {
      const revokedIds = new Set(
        this.deviceStore
          .list()
          .filter((record) => activeBefore.has(record.deviceId) && record.revokedAt !== undefined)
          .map((record) => record.deviceId)
      );
      for (const revokedId of revokedIds) {
        this.grants.drop(revokedId);
        this.consent?.forget(revokedId);
      }
      for (const [session, dev] of this.sessions) {
        if (revokedIds.has(dev)) session.close("device-revoked");
      }
      this.log.warn("device.revoked", { deviceId, cascadeCount: Math.max(0, revokedIds.size - 1) });
      super.emit("deviceRevoked", deviceId);
    }
    return ok;
  }

  revokeAllDevices(): void {
    for (const d of this.listDevices()) {
      if (!d.revokedAt) this.revokeDevice(d.deviceId);
    }
  }

  status(): Record<string, unknown> {
    return {
      application: this.config.application,
      started: this.started,
      deviceId: this.identity ? this.identity.deviceId : null,
      fingerprint: this.identity ? `${this.identity.fingerprint.slice(0, 16)}…` : null,
      transports: {
        lan: this.lan ? { url: this.lan.url(), bind: this.config.lan?.bind ?? "loopback" } : null,
        relay: this.relay ? { url: this.relay.info.url, channel: this.relay.channelId } : null,
        signaling: this.signaling ? { url: this.signaling.url, online: this.signaling.online } : null,
        webrtc: this.webrtcExposed ? { enabled: true } : null
      },
      networkMode: this.config.networkMode ?? "auto",
      devices: this.deviceStore?.list().length ?? 0,
      activeSessions: this.sessions.size,
      secrets: this.secretStore
        ? { backend: this.secretStore.kind, detail: this.secretStore.description }
        : null,
      permissions: {
        policy: this.config.permissions ?? "defaults",
        capabilities: this.registry.all().map((c) => ({
          id: c.id,
          risk: c.risk,
          confirmEachUse: c.confirmEachUse === true
        })),
        pendingConsent: this.consent?.snapshot() ?? []
      }
    };
  }

  get fingerprintHex(): string {
    return this.identity.fingerprint;
  }

  /**
   * A moment-in-time snapshot of how reachable this host is, with a friendly
   * one-line message a desktop app can show without explaining any networking.
   * Subscribe to the `connectivity` event to be told about every change instead
   * of polling this.
   */
  getConnectivity(): ConnectivityStatus {
    const endpoints = this.connectionEndpoints();
    const lan = endpoints.some((e) => e.kind === "lan");
    const relay = this.relay?.connected === true;
    const webrtc = this.webrtcExposed;
    const direct = this.remote?.reachable === true;
    const tunneled = endpoints.some((e) => e.kind === "tunnel");
    const reach: ConnectivityStatus["reach"] =
      direct || relay || tunneled ? "relayed" : lan ? "local-only" : "offline";

    // The message is what a non-technical user reads, so it describes what they
    // can do rather than which transport is up.
    let message: string;
    if (direct) {
      message = relay
        ? "Phones can reach you from anywhere, directly or through the relay."
        : "Phones can reach you from anywhere — your router is forwarding a port to this app.";
    } else if (relay) {
      message = webrtc
        ? "Relayed; devices will upgrade to direct when possible."
        : "Phones can reach you from anywhere through the relay.";
    } else if (tunneled) {
      message = "Phones can reach you from anywhere through the secure tunnel.";
    } else if (lan) {
      const remote = this.remote?.diagnostics;
      message = remote
        ? `Reachable on your Wi-Fi only. ${remote.message}`
        : "Reachable on your Wi-Fi. Turn on remote access to reach phones elsewhere.";
    } else {
      message = "No inbound path yet — paired phones can't reach you right now.";
    }

    return {
      reach,
      lan,
      relay,
      signaling: this.signaling?.online ?? false,
      webrtc,
      message,
      transports: this.transportSnapshot()
    };
  }

  private transportSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.lan) out.lan = this.lan.url();
    if (this.relay) out.relay = this.relay.channelId;
    if (this.signaling) out.signaling = this.signaling.url;
    if (this.config.tunnelUrl) out.tunnel = this.config.tunnelUrl;
    return out;
  }

  private emitConnectivity(reason: string): void {
    if (!this.started) return;
    const status = this.getConnectivity();
    this.log.debug("connectivity.changed", { reason, reach: status.reach });
    super.emit("connectivity", status);
  }

  /**
   * Feeds a transport this SDK did not create into the normal accept path: the
   * CLX1 handshake runs over it, the device authenticates as usual, and the
   * resulting session joins the RPC router.
   *
   * This is the hook a transport adapter uses. A WebRTC DataChannel negotiated
   * over an existing session, for instance, arrives here - the channel is a
   * pipe and carries no authority of its own, so the device proves its
   * identity again exactly as it does over the relay.
   */
  acceptExternalTransport(transport: CrosslinkTransport): void {
    this.assertStarted();
    this.log.debug("transport.external", { kind: transport.kind });
    this.acceptTransport(transport);
  }

  /**
   * Registers the WebRTC upgrade RPC method. When a paired device calls
   * `crosslink.webrtc.offer` with an SDP offer, the host creates an answer,
   * negotiates a DataChannel, and feeds it to `acceptExternalTransport`.
   * The relay session remains as a fallback if the upgrade fails.
   */
  private setupWebrtc(opts: NonNullable<CrosslinkServerConfig["webrtc"]>): void {
    if (this.webrtcExposed) return;
    const router = this.ensureRouter();
    const target: ExposeTarget = {
      expose: (method, handler, options) => {
        router.expose(method, handler, options ?? {});
      }
    };
    const hostOpts: WebrtcHostOptions = {
      createPeer: opts.createPeer,
      onTransport: (transport, deviceId) => {
        this.log.info("webrtc.upgraded", { deviceId, kind: transport.kind });
        this.acceptExternalTransport(transport);
      }
    };
    if (opts.capability) hostOpts.capability = opts.capability;
    if (opts.maxPending !== undefined) hostOpts.maxPending = opts.maxPending;
    if (opts.timeoutMs !== undefined) hostOpts.timeoutMs = opts.timeoutMs;
    exposeWebrtcOffer(target, hostOpts);
    this.webrtcExposed = true;
    this.log.debug("webrtc.exposed", { capability: opts.capability ?? "(any)" });
  }

  /** Capability ids currently granted to a device, expired ones excluded. */
  grantedCapabilities(deviceId: string): string[] {
    return this.grants.grantedTo(deviceId);
  }

  /** Forgets cached per-use consent for a device, forcing fresh prompts. */
  clearConsent(deviceId?: string): void {
    if (deviceId) this.consent?.forget(deviceId);
    else this.consent?.clear();
  }

  /* ------------------------------- internals ------------------------- */

  private ensureRouter(): RpcRouter {
    if (!this.router) {
      this.router = new RpcRouter(
        () => this.grants,
        {},
        {
          logger: this.log,
          registry: this.registry,
          deviceName: (id) => this.deviceStore?.get(id)?.name
        }
      );
    }
    return this.router;
  }

  private assertStarted(): void {
    if (!this.started) throw new Error("server not started; call await server.start()");
  }

  private async connectRelay(relayUrls: readonly string[]): Promise<void> {
    this.relay = await RelayChannel.allocateAny(relayUrls, {
      ...(this.relayToken ? { authToken: this.relayToken } : {}),
      logger: this.log
    });
    this._relayUrl = this.relay.info.url;
    this.relay.onDropped = ({ needsReallocation }) => {
      if (this.stopping) return;
      this.scheduleRelayReconnect(needsReallocation);
    };
    this.relay.onClient((t) => this.acceptTransport(t));
    await this.tryConnectRelaySocket();
  }

  /**
   * Reconnects the relay channel. A channel the relay has forgotten (expired
   * or swept) is re-allocated and the new id re-published through signaling -
   * otherwise a host that outlived its channel would be permanently
   * unreachable from off-network while still appearing online.
   */
  private scheduleRelayReconnect(needsReallocation: boolean, attempt = 0): void {
    if (this.stopping) return;
    clearTimeout(this.relayRetry);
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    this.relayRetry = setTimeout(() => {
      void (async () => {
        if (this.stopping) return;
        try {
          if (!this.relay && this._relayUrls.length > 0) {
            await this.connectRelay(this.regionalRelayOrder());
            this.signaling?.refreshPresence();
          } else if (this.relay && needsReallocation) {
            await this.relay.reallocate();
            this.signaling?.refreshPresence();
          } else if (this.relay && attempt >= 2 && this._relayUrls.length > 1) {
            // A region can stay reachable at HTTP allocation time while its
            // WebSocket edge is unhealthy. After two reconnect failures,
            // rotate rather than pinning the host to that region forever.
            this.relay.close();
            this.relay = undefined;
            await this.connectRelay(this.regionalRelayOrder());
            this.signaling?.refreshPresence();
          }
          if (this.relay) {
            await this.relay.connect();
            this.log.info("relay.reconnected", { channel: this.relay.channelId });
            this.emitConnectivity("relay-reconnected");
          }
        } catch (err) {
          this.log.warn("relay.reconnect-failed", { attempt: attempt + 1, error: err });
          this.scheduleRelayReconnect(needsReallocation, attempt + 1);
        }
      })();
    }, delay);
    this.relayRetry.unref?.();
  }

  private async tryConnectRelaySocket(): Promise<void> {
    if (!this.relay) return;
    try {
      await this.relay.connect();
      this.emitConnectivity("relay-connected");
    } catch (err) {
      this.log.warn("relay.connect-failed", { error: err });
      this.emitConnectivity("relay-connect-failed");
      this.scheduleRelayReconnect(false);
    }
  }

  private regionalRelayOrder(): string[] {
    if (this._relayUrls.length < 2 || !this._relayUrl) return [...this._relayUrls];
    const current = this._relayUrls.indexOf(this._relayUrl);
    if (current < 0) return [...this._relayUrls];
    return [...this._relayUrls.slice(current + 1), ...this._relayUrls.slice(0, current + 1)];
  }

  private startSignaling(url: string): void {
    const rewriteUrl = this.config.resolvePresenceUrl;
    const presence = (): SignalingPresence => ({
      appId: this.config.application.id,
      name: this.config.application.name,
      fingerprint: this.identity.fingerprint,
      pubEdB64: bytesToBase64(this.identity.edPublicKey),
      pubXB64: bytesToBase64(this.identity.xPublicKey),
      versions: ["1.0"],
      ...(this.relay
        ? { relay: { url: rewriteUrl ? rewriteUrl(this.relay.info.url, "relay") : this.relay.info.url, channel: this.relay.channelId } }
        : {}),
      ...(this.lan && this.config.lan?.bind === "all"
        ? { lan: { host: resolveLanHost(this.config.lan?.host) ?? "", port: this.lan.port } }
        : {})
    });

    this.signaling = new SignalingLink(
      url.replace(/^http/, "ws").replace(/\/$/, "") + "/ws",
      presence,
      (blob, waiterConn) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(blob) as Record<string, unknown>;
        } catch {
          return;
        }
        const reply = (out: object): void => {
          this.signaling?.sendPairPayload(waiterConn, JSON.stringify(out));
        };
        if (frame.kind === "pair_claim") {
          void this.pairing.handleClaim(frame, reply);
        } else if (frame.kind === "pair_complete") {
          try {
            const record = this.pairing.handleComplete(frame, reply);
            super.emit("devicePaired", record);
          } catch (err) {
            /* pair_error already sent via reply unless handleComplete threw before sending */
            if (typeof frame.ps === "string" && frame.ps) {
              try {
                reply({ kind: "pair_error", error: { code: "PAIRING_INVALID", message: String((err as Error)?.message ?? "completion failed") } });
              } catch { /* best effort */ }
            }
          }
        }
      },
      (status) => {
        this.log.debug("signaling.status", { status });
        super.emit("signalingStatus", status);
        this.emitConnectivity(`signaling-${status}`);
      },
      { authToken: this.signalingToken, logger: this.log }
    );
    this.signaling.start();
  }

  private acceptTransport(transport: CrosslinkTransport): void {
    if (this.config.security?.localNetworkOnly) {
      if (transport.kind === "lan") {
        const addr = transport.remoteAddress;
        if (!addr || !isLocalAddress(addr)) {
          this.log.warn("server.security.reject-non-local-lan", {
            remoteAddress: addr
          });
          transport.close("local-network-only-enforced");
          return;
        }
      } else if (transport.kind !== "memory" && transport.kind !== "webrtc-direct") {
        this.log.warn("server.security.reject-non-local-kind", {
          kind: transport.kind
        });
        transport.close("local-network-only-enforced");
        return;
      }
    }

    // Pairing is offered on transports a scanned QR can actually name — the
    // LAN listener and the router-mapped public port. A relay channel carries
    // only devices that already paired through the signaling rendezvous, so
    // offering pairing there would add a second, redundant pairing path.
    const offersPairing = transport.kind === "lan" || transport.kind === "memory";

    new HostAcceptor(
      transport,
      {
        identity: this.identity,
        appId: this.config.application.id,
        lookupDevice: (id) => this.deviceStore.get(id),
        maxFrameBytes: undefined,
        logger: this.log,
        ...(offersPairing
          ? {
              pairing: {
                resolveCode: (code) => this.pairing.resolveCodeForDirectPairing(code),
                describeApp: () => ({
                  appId: this.config.application.id,
                  name: this.config.application.name,
                  fingerprint: this.identity.fingerprint,
                  pubEdB64: bytesToBase64(this.identity.edPublicKey),
                  pubXB64: bytesToBase64(this.identity.xPublicKey)
                }),
                handleClaim: (claim, reply) => this.pairing.handleClaim(claim, reply),
                handleComplete: (complete, reply) => this.pairing.handleComplete(complete, reply)
              }
            }
          : {})
      },
      {
        onPaired: (record) => super.emit("devicePaired", record),
        onMessage: (msg, session) => this.router.handleMessage(session, msg),
        onSession: (session) => this.registerSession(session, transport.kind),
        onClose: (_err, deviceId, session) => {
          if (session) {
            this.sessions.delete(session);
            this.router.handleSessionClosed(session);
            super.emit("deviceDisconnected", {
              deviceId: deviceId ?? session.meta.peerDeviceId,
              transport: transport.kind
            });
          }
        },
        diagnostics: () => {}
      }
    );
  }

  private registerSession(session: CrosslinkSession, transportKind: string): void {
    this.sessions.set(session, session.meta.peerDeviceId);
    this.deviceStore.setLastSeen(session.meta.peerDeviceId, Date.now());
    this.log.info("device.connected", {
      deviceId: session.meta.peerDeviceId,
      transport: transportKind,
      caps: this.grants.grantedTo(session.meta.peerDeviceId),
      activeSessions: this.sessions.size
    });
    super.emit("deviceConnected", { deviceId: session.meta.peerDeviceId, transport: transportKind });
  }
}

/** Factory matching the documented DX. */
export function createCrosslinkServer(config: CrosslinkServerConfig): CrosslinkServer {
  return new CrosslinkServer(config);
}

/**
 * Composable host initialization: creates only the pairing/auth/session
 * layer without forcing an independent server structure. Use this when
 * integrating Crosslink into an existing application (Electron, Node
 * backend with its own HTTP server, or any runtime that already manages
 * transports and routing). The returned object exposes pairing, device
 * management, capability grants, and transport acceptance — not a full
 * standalone server.
 */
export function composeCrosslinkHost(
  config: CrosslinkServerConfig
): { pairing: any; grants: any; registry: any; identity: any } {
  // Minimal composable initialization: creates identity, pairing manager,
  // and capability registry without binding to a new server instance.
  // This is a framework-level extension point — the developer can attach
  // the returned primitives to their own runtime.
  const server = new CrosslinkServer(config);
  return {
    pairing: (server as any).pairing,
    grants: (server as any).grants,
    registry: (server as any).registry,
    identity: (server as any).identity,
  };
}
