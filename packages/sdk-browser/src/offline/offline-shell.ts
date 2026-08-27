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
  title: "Host is unavailable",
  message: "This app can't reach your computer right now.\n\nOpen the desktop app to reconnect automatically.",
  icon: "",
  appName: "Crosslink",
  themeColor: "#0f172a",
  bgColor: "#0f172a"
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
        const res = await fetchFn(`${hints.signalingUrl.replace(/\/$/, "")}/apps/${encodeURIComponent(appId)}`, {
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
  config: Required<OfflineConfig>,
  onRetry?: () => void
): HTMLElement {
  const container = document.createElement("div");
  container.id = "crosslink-offline-shell";
  container.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: ${config.bgColor || "#0f172a"};
    color: #f8fafc;
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

  if (config.icon) {
    const img = document.createElement("img");
    img.src = config.icon;
    img.alt = config.appName || "App Icon";
    img.style.cssText = `
      width: 72px;
      height: 72px;
      border-radius: 18px;
      margin-bottom: 20px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
      object-fit: cover;
    `;
    container.appendChild(img);
  } else {
    const iconPlaceholder = document.createElement("div");
    iconPlaceholder.style.cssText = `
      width: 64px;
      height: 64px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 20px;
    `;
    iconPlaceholder.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.8;">
        <path d="M1 1l22 22"></path>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
        <line x1="12" y1="20" x2="12.01" y2="20"></line>
      </svg>
    `;
    container.appendChild(iconPlaceholder);
  }

  const title = document.createElement("h1");
  title.textContent = config.title || `${config.appName} is unavailable`;
  title.style.cssText = `
    font-size: 21px;
    font-weight: 700;
    margin: 0 0 10px 0;
    color: #f8fafc;
    letter-spacing: -0.02em;
  `;
  container.appendChild(title);

  const message = document.createElement("p");
  message.style.cssText = `
    color: #94a3b8;
    font-size: 14px;
    line-height: 1.55;
    max-width: 300px;
    margin: 0 0 28px 0;
    white-space: pre-line;
  `;
  message.textContent = config.message || `Open ${config.appName} on your computer to reconnect.`;
  container.appendChild(message);

  const statusWrap = document.createElement("div");
  statusWrap.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 24px;
    padding: 6px 14px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 9999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  `;

  const spinner = document.createElement("div");
  spinner.style.cssText = `
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #38bdf8;
    box-shadow: 0 0 8px #38bdf8;
    animation: clPulse 1.5s ease-in-out infinite;
  `;

  const status = document.createElement("span");
  status.id = "crosslink-offline-status";
  status.style.cssText = `
    color: #38bdf8;
    font-size: 13px;
    font-weight: 500;
  `;
  status.textContent = "Trying to reconnect…";

  statusWrap.appendChild(spinner);
  statusWrap.appendChild(status);
  container.appendChild(statusWrap);

  if (onRetry) {
    const retryBtn = document.createElement("button");
    retryBtn.textContent = "Retry Now";
    retryBtn.style.cssText = `
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      padding: 8px 20px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s ease;
    `;
    retryBtn.onmouseenter = () => { retryBtn.style.background = "rgba(255, 255, 255, 0.18)"; };
    retryBtn.onmouseleave = () => { retryBtn.style.background = "rgba(255, 255, 255, 0.1)"; };
    retryBtn.onclick = () => {
      onRetry();
    };
    container.appendChild(retryBtn);
  }

  // Inject keyframe animation if not present
  if (typeof document !== "undefined" && !document.getElementById("crosslink-offline-styles")) {
    const style = document.createElement("style");
    style.id = "crosslink-offline-styles";
    style.textContent = `
      @keyframes clPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(0.85); }
      }
    `;
    document.head.appendChild(style);
  }

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