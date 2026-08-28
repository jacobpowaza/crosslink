/**
 * Crosslink Offline Shell — Framework-level offline/fail-state system for PWAs.
 *
 * This module provides a cached PWA shell that launches when the Crosslink host
 * is completely unreachable. It handles:
 * - Offline UI display with developer-customizable branding
 * - Periodic reconnection attempts with exponential backoff
 * - Silent cryptographic authentication when host returns
 * - Automatic transition to developer app on successful auth
 * - Proper distinction between "host offline" vs "pairing required"
 */
import {
  CrosslinkClient,
  type CrosslinkClientOptions
} from "../client.js";
import {
  crosslinkLogoSvg,
  resolveCrosslinkTheme,
  CROSSLINK_REPOSITORY,
  CROSSLINK_ATTRIBUTION_TEXT,
  CROSSLINK_ATTRIBUTION_LINK_TEXT
} from "../ui/branding.js";
import {
  toHttpUrl,
  type ConnectionState,
  type RpcClient,
  type PairedAppRecord
} from "@crosslink/core";

export interface OfflineConfig {
  /** Title shown in offline state. Default: "<AppName> is unavailable" or "Crosslink is inactive" */
  title?: string;
  /** Message shown in offline state. Default mentions opening desktop app */
  message?: string;
  /** App icon URL for offline screen. Defaults to PWA manifest icon */
  icon?: string;
  /** App name for offline screen. Defaults to PWA name */
  appName?: string;
  /** Theme color for offline screen */
  themeColor?: string;
  /** Background color for offline screen */
  bgColor?: string;
  /** Application accent. Tints the Crosslink mark and the retry action. */
  accentColor?: string;
  /** Primary text colour. Derived from the background when omitted. */
  textColor?: string;
  /** Forces a palette instead of deriving one from the background. */
  appearance?: "light" | "dark" | "auto";
  /** Troubleshooting guide shown after the retry action. */
  debuggingUrl?: string;
}

export type OfflineConnectionState =
  | "connecting"
  | "connected"
  | "host-offline"
  | "authentication-required"
  | "authentication-failed"
  | "reconnecting";

export interface HostReachabilityResult {
  reachable: boolean;
  hostInfo?: {
    relay?: { url: string; channel: string };
    lan?: { host: string; port: number };
    fingerprint?: string;
  };
}

export interface OfflineShellOptions {
  /** Crosslink client options */
  clientOptions?: CrosslinkClientOptions;
  /** Existing or custom client instance */
  client?: CrosslinkClient;
  /** Offline UI configuration */
  offline?: OfflineConfig;
  /** Called when transitioning to connected state - load the developer app */
  onConnected: (rpc: RpcClient, client: CrosslinkClient) => Promise<void> | void;
  /** Called when authentication is required (revoked, unknown device, missing key, etc.) */
  onAuthRequired: () => Promise<void> | void;
  /** Called when connection state changes */
  onStateChange?: (state: OfflineConnectionState, detail?: Record<string, unknown>) => void;
  /** Minimum time between reconnection attempts (ms). Default: 1000 */
  minRetryDelay?: number;
  /** Maximum time between reconnection attempts (ms). Default: 30000 */
  maxRetryDelay?: number;
  /** Check host reachability interval when offline (ms). Default: 10000 */
  reachabilityCheckInterval?: number;
  /** Service Worker script URL to register. Default: "/sw.js" */
  serviceWorkerUrl?: string;
  /** Auto-register service worker in browser. Default: true */
  autoRegisterServiceWorker?: boolean;
  /** Auto-mount offline UI when host-offline. Default: true */
  autoMountOfflineUI?: boolean;
  /** Custom DOM container for offline UI. Defaults to document.body */
  container?: HTMLElement;
}

/**
 * Default offline configuration values
 */
export const DEFAULT_OFFLINE_CONFIG: Required<OfflineConfig> = {
  title: "Trying to reconnect",
  message: "Crosslink can't reach the app on your computer yet. We'll keep trying automatically.",
  icon: "",
  appName: "Crosslink",
  themeColor: "#000000",
  bgColor: "#000000",
  accentColor: "",
  textColor: "",
  appearance: "auto",
  debuggingUrl: "https://crosslink.mintlify.site/resources/debugging-mobile-reconnect"
};

export class CrosslinkOfflineShell {
  private client: CrosslinkClient;
  private options: Required<Omit<OfflineShellOptions, "clientOptions" | "client" | "container">> & {
    clientOptions?: CrosslinkClientOptions;
    container?: HTMLElement;
  };
  private currentState: OfflineConnectionState = "connecting";
  private reachabilityTimer: any = null;
  private reconnectTimer: any = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private isPageVisible = true;
  private attemptCount = 0;
  private isAttempting = false;
  private offlineElement: HTMLElement | null = null;

  constructor(options: OfflineShellOptions) {
    this.options = {
      clientOptions: options.clientOptions,
      offline: { ...DEFAULT_OFFLINE_CONFIG, ...options.offline },
      onConnected: options.onConnected,
      onAuthRequired: options.onAuthRequired,
      onStateChange: options.onStateChange ?? (() => {}),
      minRetryDelay: options.minRetryDelay ?? 1000,
      maxRetryDelay: options.maxRetryDelay ?? 30_000,
      reachabilityCheckInterval: options.reachabilityCheckInterval ?? 10_000,
      serviceWorkerUrl: options.serviceWorkerUrl ?? "/sw.js",
      autoRegisterServiceWorker: options.autoRegisterServiceWorker ?? true,
      autoMountOfflineUI: options.autoMountOfflineUI ?? true,
      container: options.container
    };

    if (options.client) {
      this.client = options.client;
    } else {
      const origOnStateChange = options.clientOptions?.onStateChange;
      const clientOpts: CrosslinkClientOptions = {
        ...options.clientOptions,
        onStateChange: (state: ConnectionState, detail?: Record<string, unknown>) => {
          origOnStateChange?.(state, detail);
          this.handleClientStateChange(state, detail);
        }
      };
      this.client = new CrosslinkClient(clientOpts);
    }

    this.setupVisibilityHandlers();
    this.setupOnlineHandler();
  }

  /**
   * Initialize and start the offline shell. This should be called early
   * in the PWA lifecycle, before attempting any connection.
   */
  async start(): Promise<void> {
    // 1. Auto register service worker in browser environment
    if (this.options.autoRegisterServiceWorker && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register(this.options.serviceWorkerUrl);
      } catch (e) {
        // Non-fatal, service worker might be disabled or served on file://
        console.warn("[OfflineShell] Service worker registration notice:", e);
      }
    }

    // 2. Check if we have a previously paired app
    const apps = this.client.listApps();
    if (apps.length === 0) {
      // No paired apps - require pairing
      this.setState("authentication-required");
      await this.options.onAuthRequired();
      return;
    }

    // 3. We have a paired app - try silent authentication
    await this.attemptSilentAuth(apps[0]);
  }

  /**
   * Attempt silent cryptographic authentication with the paired host.
   * This is the core "trusted device" flow - no user interaction required.
   */
  private async attemptSilentAuth(app: PairedAppRecord): Promise<void> {
    if (this.isAttempting) return;
    this.isAttempting = true;

    if (this.currentState !== "reconnecting") {
      this.setState("connecting");
    }

    try {
      // Attempt connection with stored credentials (challenge-response)
      const rpc = await this.client.connect(app.appId);

      // Success - transition to connected state
      this.isAttempting = false;
      this.cancelTimers();
      this.unmountOfflineUI();
      this.setState("connected");
      await this.options.onConnected(rpc, this.client);
    } catch (err) {
      this.isAttempting = false;
      await this.handleConnectionError(err, app);
    }
  }

  /**
   * Handle connection state changes from underlying ClientLink.
   */
  private handleClientStateChange(state: ConnectionState, detail?: Record<string, unknown>): void {
    if (state === "revoked" || state === "unauthorized") {
      this.unmountOfflineUI();
      this.cancelTimers();
      this.setState("authentication-required", detail);
      this.options.onAuthRequired();
    } else if (state === "offline" && this.currentState === "connected") {
      this.showHostOffline();
    }
  }

  /**
   * Handle connection errors and determine the correct state.
   * Critical: distinguish between "host offline" vs "authentication required / revoked".
   */
  private async handleConnectionError(err: unknown, app: PairedAppRecord): Promise<void> {
    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    const clientState = this.client.state;

    // Terminal auth failures - require re-pairing
    const isAuthFailure =
      msg.includes("revoked") ||
      msg.includes("device_revoked") ||
      msg.includes("device-revoked") ||
      msg.includes("unauthorized") ||
      msg.includes("not paired") ||
      msg.includes("fingerprint") ||
      msg.includes("signature invalid") ||
      msg.includes("challenge nonce") ||
      clientState === "revoked" ||
      clientState === "unauthorized";

    if (isAuthFailure) {
      this.unmountOfflineUI();
      this.cancelTimers();
      this.setState("authentication-failed");
      await this.options.onAuthRequired();
      return;
    }

    // Host offline / unreachable / network error
    this.showHostOffline();
  }

  /**
   * Show the host-offline UI and start periodic reconnection attempts.
   */
  private showHostOffline(): void {
    this.setState("host-offline");
    if (this.options.autoMountOfflineUI) {
      this.mountOfflineUI();
    }
    this.scheduleReconnect();
    this.startReachabilityChecks();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff and jitter.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    // Exponential backoff
    const delay = Math.min(
      this.options.maxRetryDelay,
      this.options.minRetryDelay * Math.pow(1.5, Math.min(this.attemptCount, 8))
    );
    const jitter = delay * (0.8 + Math.random() * 0.4);
    const delaySec = Math.max(1, Math.round(jitter / 1000));

    this.updateOfflineStatus(`Reconnecting in ${delaySec}s…`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.attemptCount++;
      await this.reconnectNow();
    }, jitter);
  }

  /**
   * Immediately trigger a silent reconnection attempt.
   */
  async reconnectNow(): Promise<void> {
    if (this.currentState === "connected" || this.isAttempting) return;

    const apps = this.client.listApps();
    if (apps.length === 0) {
      this.setState("authentication-required");
      await this.options.onAuthRequired();
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setState("reconnecting", { attempt: this.attemptCount });
    this.updateOfflineStatus("Trying to reconnect…");

    await this.attemptSilentAuth(apps[0]);
  }

  /**
   * Start periodic reachability checks while in host-offline state.
   */
  private startReachabilityChecks(): void {
    if (this.reachabilityTimer) return;

    const check = async () => {
      if (this.currentState !== "host-offline" && this.currentState !== "reconnecting") {
        this.cancelReachabilityChecks();
        return;
      }

      const apps = this.client.listApps();
      if (apps.length === 0) return;

      const result = await this.checkHostReachability(apps[0].appId);
      if (result.reachable) {
        this.cancelReachabilityChecks();
        await this.reconnectNow();
      }
    };

    this.reachabilityTimer = setInterval(check, this.options.reachabilityCheckInterval);
  }

  private cancelReachabilityChecks(): void {
    if (this.reachabilityTimer) {
      clearInterval(this.reachabilityTimer);
      this.reachabilityTimer = null;
    }
  }

  /**
   * Check if the host signaling/relay is reachable.
   */
  async checkHostReachability(appId: string): Promise<HostReachabilityResult> {
    const hints = this.getHints(appId);
    if (!hints) {
      return { reachable: false };
    }

    if (hints.signalingUrl) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const fetchFn = (this.options.clientOptions as any)?.fetch ?? globalThis.fetch;
        const res = await fetchFn(`${toHttpUrl(hints.signalingUrl).replace(/\/$/, "")}/apps/${encodeURIComponent(appId)}`, {
          signal: controller.signal,
          cache: "no-store"
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          return {
            reachable: true,
            hostInfo: {
              relay: data.relay,
              lan: data.lan,
              fingerprint: data.fingerprint
            }
          };
        }
      } catch {}
    }

    return { reachable: false };
  }

  private cancelTimers(): void {
    this.cancelReachabilityChecks();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attemptCount = 0;
  }

  private setState(state: OfflineConnectionState, detail?: Record<string, unknown>): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.options.onStateChange(state, detail);
    }
  }

  private getHints(appId: string): { signalingUrl?: string; relay?: any; lan?: any } | null {
    try {
      const hints = (this.client as any).hints?.load?.({}) as Record<string, any>;
      return hints?.[appId] ?? null;
    } catch {
      return null;
    }
  }

  private setupVisibilityHandlers(): void {
    if (typeof document === "undefined") return;
    this.visibilityHandler = () => {
      this.isPageVisible = !document.hidden;
      if (this.isPageVisible && (this.currentState === "host-offline" || this.currentState === "reconnecting")) {
        // Page became visible again - try reconnecting immediately
        this.reconnectNow().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private setupOnlineHandler(): void {
    if (typeof window === "undefined") return;
    this.onlineHandler = () => {
      if (this.currentState === "host-offline" || this.currentState === "reconnecting") {
        // Device regained internet connectivity - try reconnecting immediately
        this.reconnectNow().catch(() => {});
      }
    };
    window.addEventListener("online", this.onlineHandler);
  }

  /**
   * Mount the offline UI into the DOM
   */
  mountOfflineUI(): void {
    if (typeof document === "undefined") return;
    if (!this.offlineElement) {
      const fullConfig = {
        ...DEFAULT_OFFLINE_CONFIG,
        ...this.options.offline
      };
      this.offlineElement = createOfflineUI(fullConfig, () => this.forceReconnect());
    }

    const container = this.options.container ?? document.body;
    if (container && !container.contains(this.offlineElement)) {
      container.appendChild(this.offlineElement);
    }
  }

  /**
   * Unmount the offline UI from the DOM
   */
  unmountOfflineUI(): void {
    if (this.offlineElement && this.offlineElement.parentElement) {
      this.offlineElement.remove();
    }
    this.offlineElement = null;
  }

  /**
   * Update the status text shown in the offline UI
   */
  updateOfflineStatus(text: string): void {
    if (typeof document === "undefined") return;
    const statusEl = document.getElementById("crosslink-offline-status");
    if (statusEl) {
      statusEl.textContent = text;
    }
  }

  /**
   * Get current connection state
   */
  getState(): OfflineConnectionState {
    return this.currentState;
  }

  /**
   * Force a reconnection attempt immediately (e.g. user taps "Retry")
   */
  async forceReconnect(): Promise<void> {
    this.attemptCount = 0;
    await this.reconnectNow();
  }

  /**
   * Clean up resources, event listeners, and timers
   */
  destroy(): void {
    this.cancelTimers();
    this.unmountOfflineUI();
    if (typeof document !== "undefined" && this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (typeof window !== "undefined" && this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
  }

  /**
   * Get the underlying CrosslinkClient
   */
  getClient(): CrosslinkClient {
    return this.client;
  }
}

/**
 * Create the offline shell UI element.
 * Returns a DOM element that can be mounted into the document.
 */
export function createOfflineUI(
  config: OfflineConfig,
  onRetry?: () => void
): HTMLElement {
  const resolved = { ...DEFAULT_OFFLINE_CONFIG, ...config };
  // The application only ever supplies colours and a name; the layout, the
  // mark and the attribution are the same in every Crosslink app, which is why
  // they are built here rather than accepted as markup.
  const brand = resolveCrosslinkTheme({
    appName: resolved.appName,
    appIcon: resolved.icon,
    accentColor: resolved.accentColor || undefined,
    backgroundColor: resolved.bgColor || undefined,
    textColor: resolved.textColor || undefined,
    appearance: resolved.appearance === "auto" ? undefined : resolved.appearance
  });

  const container = document.createElement("div");
  container.id = "crosslink-offline-shell";
  container.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: ${brand.backgroundColor};
    color: ${brand.textColor};
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 24px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    text-align: center;
    box-sizing: border-box;
    overflow: hidden;
  `;

  if (brand.appIcon) {
    const icon = document.createElement("img");
    icon.src = brand.appIcon;
    icon.alt = "";
    icon.style.cssText = "width:56px;height:56px;border-radius:14px;margin-bottom:18px;object-fit:cover";
    container.appendChild(icon);
  }

  const appName = document.createElement("div");
  appName.id = "crosslink-offline-appname";
  appName.textContent = brand.appName;
  appName.style.cssText = `font-size:13px;font-weight:600;letter-spacing:.02em;color:${brand.mutedColor};margin-bottom:16px`;
  container.appendChild(appName);

  const title = document.createElement("h1");
  title.textContent = resolved.title || `${brand.appName} is unavailable`;
  title.style.cssText = `
    font-size: 21px;
    font-weight: 700;
    margin: 0 0 10px 0;
    color: ${brand.textColor};
    letter-spacing: -0.02em;
  `;
  container.appendChild(title);

  const message = document.createElement("p");
  message.style.cssText = `
    color: ${brand.mutedColor};
    font-size: 14px;
    line-height: 1.55;
    max-width: 300px;
    margin: 0 0 28px 0;
    white-space: pre-line;
  `;
  message.textContent =
    resolved.message ||
    `Crosslink isn't currently able to reach the computer running ${brand.appName}.`;
  container.appendChild(message);

  const statusWrap = document.createElement("div");
  statusWrap.style.cssText = `margin-bottom: 24px;`;

  const status = document.createElement("span");
  status.id = "crosslink-offline-status";
  status.style.cssText = `color:${brand.mutedColor};font-size:13px;font-weight:400`;
  status.textContent = "Trying to reconnect…";

  statusWrap.appendChild(status);
  container.appendChild(statusWrap);

  if (onRetry) {
    const retryBtn = document.createElement("button");
    retryBtn.textContent = "Attempt reopening the app";
    retryBtn.style.cssText = `
      background: ${brand.surfaceColor};
      border: 1px solid ${brand.dividerColor};
      color: ${brand.textColor};
      padding: 8px 20px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
    `;
    retryBtn.onclick = () => {
      onRetry();
    };
    container.appendChild(retryBtn);
  }

  const guide = document.createElement("a");
  guide.href = resolved.debuggingUrl;
  guide.target = "_blank";
  guide.rel = "noopener noreferrer";
  guide.textContent = "Still not working? Open the debugging guide";
  guide.style.cssText = `color:${brand.mutedColor};font-size:12px;margin-top:18px;text-underline-offset:3px`;
  container.appendChild(guide);

  // Mark and attribution, unconditionally. When the host is unreachable this
  // screen is the only thing on the phone, so it is also the only place that
  // can say what is trying to reconnect and what is doing the trying.
  const brandFooter = document.createElement("div");
  brandFooter.id = "crosslink-offline-brand";
  brandFooter.style.cssText =
    "position:absolute;left:0;right:0;bottom:calc(24px + env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;gap:8px";
  const logoContainer = document.createElement("div");
  logoContainer.style.cssText = "display:flex;justify-content:center;opacity:.95";
  logoContainer.innerHTML = crosslinkLogoSvg({ width: "132px", color: brand.logoColor });
  const attribution = document.createElement("div");
  attribution.style.cssText = `font-size:11px;color:${brand.attributionColor}`;
  const prefix = document.createElement("span");
  prefix.textContent = `${CROSSLINK_ATTRIBUTION_TEXT} `;
  const link = document.createElement("a");
  link.href = CROSSLINK_REPOSITORY;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = CROSSLINK_ATTRIBUTION_LINK_TEXT;
  link.style.cssText = "color:inherit;font-weight:700;text-underline-offset:2px";
  attribution.append(prefix, link);
  brandFooter.append(logoContainer, attribution);
  container.appendChild(brandFooter);

  return container;
}

/**
 * Update the offline UI status text
 */
export function updateOfflineStatus(text: string): void {
  if (typeof document === "undefined") return;
  const status = document.getElementById("crosslink-offline-status");
  if (status) status.textContent = text;
}

/**
 * Remove the offline UI
 */
export function removeOfflineUI(): void {
  if (typeof document === "undefined") return;
  const shell = document.getElementById("crosslink-offline-shell");
  shell?.remove();
}
