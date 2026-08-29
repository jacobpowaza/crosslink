/**
 * Crosslink Mobile Bootstrap & Lifecycle State Machine
 *
 * Implements the authoritative framework-level onboarding and authorization flow:
 *   1. Host Offline -> Prebuilt Offline Screen (auto-reconnect with backoff)
 *   2. No Valid Credential -> Prebuilt Pairing Screen (9-digit code entry + host validation)
 *   3. First Successful Pairing -> Prebuilt Add to Home Screen Screen (nudge + Continue in Browser)
 *   4. Authorized -> Developer Mobile Application mounted & revealed
 *   5. Revocation -> Device immediately revoked, credentials cleared, returns to Pairing Screen
 *
 * The developer application is never exposed before authorization is established.
 */
import {
  CrosslinkClient,
  type CrosslinkClientOptions,
  type PairingConfirmRequest
} from "../client.js";
import {
  type ConnectionState,
  type RpcClient,
  type PairedAppRecord,
  linkPairingTarget,
  normalPairingTarget,
  parsePairingUri,
  unwrapBootstrapUri,
  BOOTSTRAP_FRAGMENT_KEY
} from "@crosslink/core";
import {
  createOfflineUI,
  DEFAULT_OFFLINE_CONFIG,
  type OfflineConfig,
  type HostReachabilityResult
} from "./offline-shell.js";
import { LocalStorageSecureStorage } from "../storage.js";
import { crosslinkLogoSvg, resolveCrosslinkTheme } from "../ui/branding.js";
import { describeBootstrapEnvironment, type BootstrapEnvironment } from "./environment.js";
import {
  PoweredByCrosslink,
  type PoweredByCrosslinkOptions
} from "../ui/powered-by-crosslink.js";

export const INSTALL_HANDOFF_QUERY_KEY = "crosslink_install";
export const INSTALL_HANDOFF_COOKIE = "crosslink_install";
export const INSTALL_HANDOFF_CONTEXT_COOKIE = "crosslink_install_context";

interface InstallHandoffState {
  handoffId: string;
  targetUri: string;
  expiresAt: number;
  source: "cookie" | "url" | "legacy-link";
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  for (const part of String(document.cookie ?? "").split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeSafely(trimmed.slice(prefix.length));
  }
  return null;
}

function cookieAttributes(maxAge: number): string {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  return `; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}; SameSite=Strict${secure}`;
}

function persistInstallHandoff(handoffId: string, targetUri: string, expiresAt: number): void {
  if (typeof document === "undefined") return;
  const maxAge = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  document.cookie = `${INSTALL_HANDOFF_COOKIE}=${encodeURIComponent(handoffId)}${cookieAttributes(maxAge)}`;
  document.cookie = `${INSTALL_HANDOFF_CONTEXT_COOKIE}=${encodeURIComponent(JSON.stringify({ targetUri, expiresAt }))}${cookieAttributes(maxAge)}`;
}

function clearInstallCookies(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${INSTALL_HANDOFF_COOKIE}=${cookieAttributes(0)}`;
  document.cookie = `${INSTALL_HANDOFF_CONTEXT_COOKIE}=${cookieAttributes(0)}`;
}

export type MobileBootstrapState =
  | "initializing"
  | "offline"
  | "pairing-required"
  | "pairing"
  | "add-to-home-screen"
  | "authorized";

export interface OnboardingConfig {
  appName?: string;
  icon?: string;
  themeColor?: string;
  instructions?: string;
}

export interface MobileBootstrapOptions {
  /** Target DOM container for prebuilt screens. Defaults to document.body */
  container?: HTMLElement;
  /** Application metadata */
  appId?: string;
  appName?: string;
  capabilities?: string[];
  /** Client options or existing client instance */
  client?: CrosslinkClient;
  clientOptions?: CrosslinkClientOptions;
  /** Offline screen branding */
  offline?: OfflineConfig;
  /** Add to home screen onboarding branding */
  onboarding?: OnboardingConfig;
  /** Called ONLY when the device is authorized and connected */
  onAuthorized: (rpc: RpcClient, client: CrosslinkClient) => Promise<void> | void;
  /** Called when authorization is lost (revoked, offline, reset) to hide/unmount developer app */
  onUnauthorized?: () => Promise<void> | void;
  /** Called on state machine transitions */
  onStateChange?: (state: MobileBootstrapState, detail?: Record<string, unknown>) => void;
  /** Service worker options */
  autoRegisterServiceWorker?: boolean;
  serviceWorkerUrl?: string;
  /** Pairing URI override; otherwise read from `#pair=` / `?pair=` or storage. */
  pairingUri?: string;
  /** Styling for the Crosslink attribution footer. */
  poweredBy?: PoweredByCrosslinkOptions;
  /**
   * Called once with what this origin can actually deliver.
   *
   * Lets a host surface the same truth the bootstrap logs — for example that an
   * http LAN origin cannot cache the offline screen — rather than leaving it
   * to be found on a phone.
   */
  onEnvironment?: (environment: BootstrapEnvironment) => void;
}

/** Percent-decodes once, tolerating a payload that was never encoded. */
function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Check if running as a standalone installed PWA */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    (window.navigator as any)?.standalone === true
  );
}

/** Wipe all credentials, pairing tokens, and caches on the phone */
export async function resetDeviceStorage(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    localStorage.clear();
    sessionStorage.clear();
    if (window.indexedDB?.databases) {
      const dbs = await window.indexedDB.databases();
      for (const db of dbs) {
        if (db.name) window.indexedDB.deleteDatabase(db.name);
      }
    } else {
      window.indexedDB?.deleteDatabase("crosslink-secure-storage");
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k);
    }
  } catch (e) {
    console.warn("[Crosslink] Storage reset warning:", e);
  }
}

const BOOTSTRAP_STYLES = `
/* ── Crosslink Mobile Framework Styles ─────────────────── */
.cl-screen-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: #000000;
  color: #ffffff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-align: center;
  overflow-y: auto;
  -webkit-tap-highlight-color: transparent;
}
.cl-screen-overlay * {
  box-sizing: border-box;
}

/* ── Crosslink Logo ────────────────────────────────────── */
.cl-crosslink-logo {
  width: 150px;
  height: auto;
  margin-bottom: 20px;
  display: block;
  opacity: 0.95;
}

/* ── Screen A: Pairing Screen ─────────────────────────── */
.cl-pair-screen {
  background: #000000;
  gap: 20px;
}
.cl-pair-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: #ffffff;
}
.cl-pair-desc {
  font-size: 14px;
  color: #a1a1aa;
  max-width: 290px;
  line-height: 1.5;
  margin: 0;
}
.cl-pair-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  max-width: 260px;
  margin: 8px 0;
}
.cl-pair-digit {
  width: 72px;
  height: 64px;
  font-size: 26px;
  text-align: center;
  border-radius: 14px;
  border: 1px solid #27272a;
  background: #111111;
  color: #ffffff;
  font-weight: 700;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cl-pair-digit:focus {
  border-color: #ffffff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2);
}
.cl-pair-err {
  font-size: 13px;
  color: #f87171;
  min-height: 20px;
  margin: 0;
  line-height: 1.4;
  max-width: 280px;
}
.cl-pair-reset {
  margin-top: 12px;
  background: transparent;
  border: none;
  color: #71717a;
  font-size: 12px;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 6px;
  text-decoration: underline;
  transition: color 0.15s;
}
.cl-pair-reset:hover {
  color: #a1a1aa;
}

/* ── Screen B: Add to Home Screen (Screen B) ─────────────── */
.cl-bootstrap-screen {
  background: #000000;
  justify-content: center;
  position: fixed;
  inset: 0;
  z-index: 100000;
  height: 100dvh;
}
.cl-bootstrap-appname {
  font-size: 21px;
  font-weight: 600;
  color: #ffffff;
  margin-top: 12px;
  letter-spacing: -0.01em;
}
.cl-continue-btn {
  margin-top: 20px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: #ffffff;
  padding: 11px 24px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.cl-continue-btn:hover {
  background: rgba(255, 255, 255, 0.25);
}
.cl-bootstrap-nudge {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(4px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  pointer-events: none;
}
.cl-bootstrap-nudge span {
  font-family: "Caveat", "Segoe Script", "Bradley Hand", cursive, sans-serif;
  font-size: 21px;
  color: #ffffff;
  opacity: 0.92;
  text-align: center;
  max-width: 280px;
  line-height: 1.2;
}
.cl-bootstrap-nudge svg {
  width: 34px;
  height: 52px;
  color: #ffffff;
  opacity: 0.92;
}

/* ── SAS Modal ─────────────────────────────────────────── */
.cl-sas-modal {
  position: fixed;
  inset: 0;
  z-index: 100001;
  background: #000000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
  gap: 14px;
  text-align: center;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, sans-serif;
}
.cl-sas-modal h2 { font-size: 18px; color: #fff; margin: 0; }
.cl-sas-modal p { color: #a1a1aa; font-size: 13px; margin: 0; }
.cl-sas-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  width: 100%;
  max-width: 240px;
  margin: 10px 0;
}
.cl-sas-grid span {
  display: grid;
  place-items: center;
  aspect-ratio: 1.5;
  background: #111111;
  border: 1px solid #27272a;
  border-radius: 10px;
  font-size: 24px;
  font-weight: 700;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
}
.cl-sas-caps { color: #a1a1aa; font-size: 12px; }
.cl-sas-actions { display: flex; gap: 12px; margin-top: 10px; }
.cl-sas-actions button {
  padding: 10px 22px;
  border-radius: 999px;
  border: none;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.cl-sas-ok { background: #ffffff; color: #000000; }
.cl-sas-no { background: #111111; color: #ffffff; border: 1px solid #27272a !important; }
`.trim();

let stylesInjected = false;
export function injectBootstrapStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  const style = document.createElement("style");
  style.id = "crosslink-bootstrap-styles";
  style.textContent = BOOTSTRAP_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

export class CrosslinkMobileBootstrap {
  private client: CrosslinkClient;
  private options: MobileBootstrapOptions;
  private state: MobileBootstrapState = "initializing";
  private currentScreenElement: HTMLElement | null = null;
  private reconnectTimer: any = null;
  private reachabilityTimer: any = null;
  private visibilityHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private isAttempting = false;
  private attemptCount = 0;
  private activeRpc: RpcClient | null = null;
  private targetPairingUri: string | null = null;
  private poweredBy: PoweredByCrosslink | null = null;
  private environment: BootstrapEnvironment | null = null;

  constructor(options: MobileBootstrapOptions) {
    this.options = options;
    injectBootstrapStyles();

    if (options.client) {
      this.client = options.client;
    } else {
      const clientOpts: CrosslinkClientOptions = {
        ...options.clientOptions,
        ...(options.clientOptions?.storage
          ? {}
          : typeof localStorage !== "undefined"
            ? { storage: new LocalStorageSecureStorage(localStorage) }
            : {}),
        deviceName: options.clientOptions?.deviceName ?? "mobile",
        onConfirmPairing: (req) => this.showSasConfirmation(req),
        onStateChange: (state, detail) => this.handleClientStateChange(state, detail)
      };
      this.client = new CrosslinkClient(clientOpts);
    }

    this.setupListeners();
  }

  /**
   * Start the authoritative bootstrap state machine.
   * This is the single entry point controlling what the mobile device sees.
   */
  async start(): Promise<void> {
    // 1. Establish what this origin can actually deliver, and say so once.
    //
    // Registering a worker that the browser will refuse, and then presenting an
    // installable-looking flow, is how a developer ends up discovering on a
    // phone that the offline screen was never cached. The environment is read
    // once here and kept, so every later decision — whether to register, what
    // to tell the user, what `getEnvironment()` reports — agrees.
    this.environment = describeBootstrapEnvironment();
    for (const limitation of this.environment.limitations) {
      console.warn(`[crosslink] ${limitation}`);
    }
    this.options.onEnvironment?.(this.environment);

    if (
      this.options.autoRegisterServiceWorker !== false &&
      this.environment.serviceWorkerAvailable
    ) {
      try {
        await navigator.serviceWorker.register(this.options.serviceWorkerUrl ?? "/sw.js");
      } catch (e) {
        // Non-fatal: pairing and RPC do not depend on the worker, only the
        // cached offline shell does.
        console.warn("[crosslink] service worker registration failed", e);
      }
    }

    // 2. Extract host target info from URL parameters if available
    this.extractPairingUriFromLocation();

    // 3. Check for reset parameter
    if (typeof location !== "undefined") {
      const params = new URLSearchParams(location.search);
      if (params.has("reset") || location.hash.includes("reset")) {
        await resetDeviceStorage();
        if (this.targetPairingUri) {
          try { localStorage.setItem("crosslink.pendingPair", this.targetPairingUri); } catch {}
        }
        location.href = location.pathname;
        return;
      }
    }

    // 4. A newly-installed iOS web app has its own local/IndexedDB context, but
    // iOS 17.2+ copies first-party cookies at installation. Discover the
    // short-lived opaque handoff from that boundary (URL is fallback only),
    // then redeem it with this context's own persistent device identity.
    const installHandoff = await this.discoverInstallHandoff();
    if (this.client.listApps().length === 0 && installHandoff) {
      try {
        console.info("[crosslink/install] redeeming handoff", {
          standalone: isStandalone(),
          source: installHandoff.source
        });
        const uri = linkPairingTarget(installHandoff.targetUri, installHandoff.handoffId);
        await this.client.pairFromQr(uri, this.options.capabilities);
        this.targetPairingUri = installHandoff.targetUri;
        this.clearInstallState();
        console.info("[crosslink/install] linked device created; credentials persisted");
      } catch (err) {
        console.warn("[crosslink/install] handoff unavailable/expired; falling back to normal pairing", {
          error: String((err as Error)?.message ?? err)
        });
        this.targetPairingUri = installHandoff.targetUri;
        this.clearInstallState();
      }
    }

    // 5. Evaluate stored trusted device credentials
    const apps = this.client.listApps();
    if (apps.length === 0) {
      // Untrusted / First-run device -> Require Pairing (Screen A)
      this.transitionTo("pairing-required");
      return;
    }

    // 5. Stored credential exists -> Attempt silent cryptographic authentication
    await this.attemptSilentAuth(apps[0]);
  }

  private extractPairingUriFromLocation(): void {
    if (this.options.pairingUri) {
      this.targetPairingUri = this.options.pairingUri;
      return;
    }
    if (typeof location === "undefined") return;

    // The fragment is preferred and is what the SDK's QR uses: it never leaves
    // the browser, so the pairing code is not written into the bootstrap
    // server's access log. The query form is still accepted for links produced
    // by hand or by older hosts.
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get(BOOTSTRAP_FRAGMENT_KEY);
    const fromQuery = new URLSearchParams(location.search).get(BOOTSTRAP_FRAGMENT_KEY);
    const pairParam = fromHash || fromQuery || "";
    if (pairParam) {
      this.targetPairingUri = unwrapBootstrapUri(decodeSafely(pairParam));
      try { localStorage.setItem("crosslink.pendingPair", this.targetPairingUri); } catch {}
    } else {
      try {
        this.targetPairingUri = localStorage.getItem("crosslink.pendingPair");
      } catch {}
    }
  }

  private async discoverInstallHandoff(): Promise<InstallHandoffState | null> {
    let urlId = "";
    if (typeof location !== "undefined") {
      urlId = new URLSearchParams(location.search).get(INSTALL_HANDOFF_QUERY_KEY) ?? "";
    }
    const cookieId = readCookie(INSTALL_HANDOFF_COOKIE) ?? "";
    const contextRaw = readCookie(INSTALL_HANDOFF_CONTEXT_COOKIE);
    let targetUri = "";
    let expiresAt = 0;
    if (contextRaw) {
      try {
        const context = JSON.parse(contextRaw) as { targetUri?: unknown; expiresAt?: unknown };
        targetUri = typeof context.targetUri === "string" ? normalPairingTarget(context.targetUri) : "";
        expiresAt = typeof context.expiresAt === "number" ? context.expiresAt : 0;
      } catch {}
    }

    const handoffId = cookieId || urlId;
    if (handoffId && targetUri && expiresAt > Date.now()) {
      return {
        handoffId,
        targetUri,
        expiresAt,
        source: cookieId ? "cookie" : "url"
      };
    }

    // Cookie transfer is the modern iOS path. A dynamic manifest/start_url can
    // still recover when cookies are unavailable by resolving the opaque id on
    // the same origin; no permanent device credential is returned here.
    if (urlId && typeof fetch === "function") {
      try {
        const response = await fetch(`/__crosslink/install/${encodeURIComponent(urlId)}`, {
          credentials: "same-origin",
          cache: "no-store"
        });
        if (response.ok) {
          const recovered = await response.json() as { uri?: unknown; expiresAt?: unknown };
          if (typeof recovered.uri === "string" && typeof recovered.expiresAt === "number") {
            return {
              handoffId: urlId,
              targetUri: normalPairingTarget(recovered.uri),
              expiresAt: recovered.expiresAt,
              source: "url"
            };
          }
        }
      } catch {}
    }

    if (handoffId || contextRaw) {
      if (targetUri) this.targetPairingUri = targetUri;
      this.clearInstallState();
    }

    // Backward-compatible recovery of old fragment installs. It is consumed
    // automatically only when it is a syntactically valid link URI; manual
    // pairing below is always given the stripped normal target.
    if (this.targetPairingUri) {
      try {
        const parsed = parsePairingUri(unwrapBootstrapUri(this.targetPairingUri));
        if (parsed.link && parsed.code) {
          return {
            handoffId: parsed.code,
            targetUri: normalPairingTarget(this.targetPairingUri),
            expiresAt: Number.MAX_SAFE_INTEGER,
            source: "legacy-link"
          };
        }
      } catch {}
    }
    return null;
  }

  private clearInstallState(): void {
    clearInstallCookies();
    if (typeof localStorage !== "undefined") localStorage.removeItem("crosslink.pendingPair");
    if (typeof location === "undefined" || typeof history === "undefined") return;
    try {
      const clean = new URL(location.href);
      clean.searchParams.delete(INSTALL_HANDOFF_QUERY_KEY);
      const hashParams = new URLSearchParams(clean.hash.replace(/^#/, ""));
      const pair = hashParams.get(BOOTSTRAP_FRAGMENT_KEY);
      if (pair) {
        try {
          if (parsePairingUri(unwrapBootstrapUri(decodeSafely(pair))).link) {
            hashParams.delete(BOOTSTRAP_FRAGMENT_KEY);
          }
        } catch {}
      }
      clean.hash = hashParams.toString() ? `#${hashParams.toString()}` : "";
      history.replaceState(history.state, "", `${clean.pathname}${clean.search}${clean.hash}`);
    } catch {}
  }

  private getEffectiveAppId(): string {
    if (this.options.appId) return this.options.appId;
    const apps = this.client.listApps();
    if (apps.length > 0) return apps[0].appId;
    if (this.targetPairingUri) {
      try {
        const parsed = parsePairingUri(this.targetPairingUri);
        if (parsed.appId) return parsed.appId;
      } catch {}
    }
    return "default";
  }

  private completedOnboardingApps = new Set<string>();

  private isOnboardingCompleted(appId: string): boolean {
    if (isStandalone()) return true;
    if (this.completedOnboardingApps.has(appId)) return true;
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(`crosslink.onboarding.${appId}`) === "true";
    }
    return false;
  }

  private markOnboardingCompleted(appId: string): void {
    this.completedOnboardingApps.add(appId);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`crosslink.onboarding.${appId}`, "true");
    }
  }

  private clearOnboarding(appId: string): void {
    this.completedOnboardingApps.delete(appId);
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(`crosslink.onboarding.${appId}`);
    }
  }

  /** Prepares the cookie-first Safari -> standalone install boundary. */
  private async prepareDeviceLinkHandoff(): Promise<void> {
    if (isStandalone() || typeof location === "undefined") return;
    try {
      const { handoffId, uri, expiresAt } = await this.client.createDeviceLink();
      const targetUri = normalPairingTarget(uri);
      this.targetPairingUri = targetUri;
      persistInstallHandoff(handoffId, targetUri, expiresAt);

      // Give the install operation a unique manifest URL. Servers that support
      // Crosslink's dynamic manifest fallback copy only this opaque id into
      // start_url; the cookie remains the primary iOS handoff mechanism.
      const manifest = document.querySelector?.('link[rel="manifest"]') as HTMLLinkElement | null;
      if (manifest?.href) {
        const manifestUrl = new URL(manifest.href, location.href);
        manifestUrl.searchParams.set(INSTALL_HANDOFF_QUERY_KEY, handoffId);
        manifestUrl.searchParams.set("v", String(expiresAt));
        manifest.href = manifestUrl.toString();
      }

      if (typeof history !== "undefined") {
        const launch = new URL(location.href);
        launch.searchParams.set(INSTALL_HANDOFF_QUERY_KEY, handoffId);
        launch.hash = "";
        history.replaceState(history.state, "", `${launch.pathname}${launch.search}`);
      }
      console.info("[crosslink/install] handoff prepared", {
        currentPath: location.pathname,
        manifestPath: manifest?.href ? new URL(manifest.href).pathname : null,
        launchHasHandoff: true,
        expiresAt
      });
    } catch (err) {
      console.warn("[crosslink/install] could not prepare handoff", {
        error: String((err as Error)?.message ?? err)
      });
    }
  }

  /**
   * Silent cryptographic authentication with stored credentials.
   */
  private async attemptSilentAuth(app: PairedAppRecord): Promise<void> {
    if (this.isAttempting) return;
    this.isAttempting = true;

    try {
      const rpc = await this.client.connect(app.appId);
      this.activeRpc = rpc;
      this.isAttempting = false;
      this.cancelTimers();

      // Check onboarding state
      if (!this.isOnboardingCompleted(app.appId)) {
        await this.prepareDeviceLinkHandoff();
        this.transitionTo("add-to-home-screen");
      } else {
        this.transitionTo("authorized");
      }
    } catch (err) {
      this.isAttempting = false;
      await this.handleAuthError(err, app);
    }
  }

  private async handleAuthError(err: unknown, app: PairedAppRecord): Promise<void> {
    const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
    const clientState = this.client.state;

    const isAuthFailure =
      msg.includes("revoked") ||
      msg.includes("device_revoked") ||
      msg.includes("device-revoked") ||
      msg.includes("unauthorized") ||
      msg.includes("not paired") ||
      msg.includes("signature invalid") ||
      msg.includes("challenge nonce") ||
      clientState === "revoked" ||
      clientState === "unauthorized";

    if (isAuthFailure) {
      // Stored credential rejected -> Clear and return to Pairing Screen
      this.client.forget(app.appId);
      this.clearOnboarding(app.appId);
      this.transitionTo("pairing-required", { reason: "revoked" });
      return;
    }

    // Host unreachable / network offline
    this.transitionTo("offline");
    this.scheduleReconnect();
  }

  private handleClientStateChange(state: ConnectionState, detail?: Record<string, unknown>): void {
    if (state === "revoked" || state === "unauthorized") {
      const appId = this.getEffectiveAppId();
      this.client.forget(appId);
      this.clearOnboarding(appId);
      this.transitionTo("pairing-required", { reason: "revoked", ...detail });
    } else if (state === "offline" && this.state === "authorized") {
      this.transitionTo("offline");
      this.scheduleReconnect();
    }
  }

  /**
   * Transition state machine to a new state and mount appropriate UI.
   */
  private transitionTo(newState: MobileBootstrapState, detail?: Record<string, unknown>): void {
    this.state = newState;
    this.options.onStateChange?.(newState, detail);

    // Unmount any active screen
    this.unmountCurrentScreen();

    if (newState === "authorized") {
      // Expose & mount developer application!
      let rpc = this.activeRpc;
      if (!rpc) {
        try {
          rpc = this.client.rpc();
        } catch {}
      }
      if (rpc) {
        this.options.onAuthorized(rpc, this.client);
      }
      this.ensurePoweredBy();
      return;
    }

    // Authorization lost or pending -> notify consumer
    this.poweredBy?.destroy();
    this.poweredBy = null;
    this.options.onUnauthorized?.();

    const container = this.options.container ?? (typeof document !== "undefined" ? document.body : null);
    if (!container) return;

    switch (newState) {
      case "pairing-required":
      case "pairing": {
        const pairingEl = this.createPairingScreen((code) => this.handlePairingSubmit(code));
        this.currentScreenElement = pairingEl;
        container.appendChild(pairingEl);
        break;
      }

      case "add-to-home-screen": {
        const appId = this.getEffectiveAppId();
        const bootstrapEl = this.createAddToHomeScreen(() => {
          this.markOnboardingCompleted(appId);
          this.transitionTo("authorized");
        });
        this.currentScreenElement = bootstrapEl;
        container.appendChild(bootstrapEl);
        break;
      }

      case "offline": {
        const offlineConfig = {
          ...DEFAULT_OFFLINE_CONFIG,
          ...this.options.offline,
          appName: this.options.appName || this.options.offline?.appName || "Crosslink"
        };
        const offlineEl = createOfflineUI(offlineConfig, () => this.forceReconnect());
        this.currentScreenElement = offlineEl;
        container.appendChild(offlineEl);
        break;
      }
    }
  }

  private unmountCurrentScreen(): void {
    if (this.currentScreenElement && this.currentScreenElement.parentElement) {
      this.currentScreenElement.remove();
    }
    this.currentScreenElement = null;
  }

  private ensurePoweredBy(): void {
    if (typeof document === "undefined") return;
    if (!this.poweredBy) this.poweredBy = new PoweredByCrosslink(this.options.poweredBy);
    const target = this.options.poweredBy?.target ?? document.body;
    this.poweredBy.mount(target);
  }

  /**
   * Handle user submitting pairing code on Pairing Screen (Screen A).
   */
  private async handlePairingSubmit(code: string): Promise<void> {
    const errEl = document.getElementById("cl-pair-err");
    if (errEl) {
      errEl.textContent = "Verifying pairing code…";
      errEl.style.color = "#38bdf8";
    }

    try {
      // The pairing handshake is the only thing that decides whether a code is
      // right. There is deliberately no "check this code" pre-flight: an
      // unauthenticated endpoint that answers yes-or-no about a live code is a
      // brute-force oracle, and it sits outside every rate limit that protects
      // the real exchange.
      const targetUri =
        this.targetPairingUri ??
        (typeof localStorage !== "undefined" ? localStorage.getItem("crosslink.pendingPair") : null);

      if (!targetUri) {
        // Without a scanned QR there is no host address and no fingerprint to
        // pin, and a code alone cannot supply either.
        throw new Error("scan the QR code on your computer to start pairing");
      }

      const normalTarget = normalPairingTarget(targetUri);
      this.targetPairingUri = normalTarget;
      this.clearInstallState();
      console.info("[crosslink/pairing] falling back to NORMAL pairing");
      await this.client.pairWithCode(normalTarget, code, this.options.capabilities ?? []);
      if (typeof localStorage !== "undefined") localStorage.removeItem("crosslink.pendingPair");

      const apps = this.client.listApps();
      if (apps.length > 0) {
        await this.attemptSilentAuth(apps[0]);
      }
    } catch (err) {
      if (errEl) {
        errEl.textContent = `Pairing failed: ${(err as Error).message || String(err)}`;
        errEl.style.color = "#f87171";
      }
    }
  }

  /**
   * Create prebuilt Pairing Screen UI (Screen A).
   */
  private createPairingScreen(onVerify: (code: string) => void): HTMLElement {
    const overlay = document.createElement("div");
    overlay.id = "crosslink-pairing-screen";
    overlay.className = "cl-screen-overlay cl-pair-screen";

    const logoContainer = document.createElement("div");
    logoContainer.style.cssText = "display:flex;justify-content:center";
    logoContainer.innerHTML = crosslinkLogoSvg({ width: "140px", className: "cl-crosslink-logo" });
    overlay.appendChild(logoContainer);

    const title = document.createElement("h2");
    title.className = "cl-pair-title";
    title.textContent = "Pairing Required";
    overlay.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "cl-pair-desc";
    desc.textContent = "Type the 9-digit pairing code shown on your computer to connect.";
    overlay.appendChild(desc);

    const grid = document.createElement("div");
    grid.className = "cl-pair-grid";

    const inputs: HTMLInputElement[] = [];
    for (let i = 0; i < 9; i++) {
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.maxLength = 1;
      input.className = "cl-pair-digit";
      input.setAttribute("aria-label", `Digit ${i + 1}`);

      input.addEventListener("input", (e) => {
        const val = input.value.replace(/\D/g, "");
        input.value = val ? val[0] : "";
        if (val && i < 8) {
          inputs[i + 1].focus();
        }
        const fullCode = inputs.map((inp) => inp.value.replace(/\D/g, "")).join("");
        if (fullCode.length === 9) {
          onVerify(fullCode);
        }
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !input.value && i > 0) {
          inputs[i - 1].focus();
        }
      });

      input.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = e.clipboardData?.getData("text") || "";
        const digits = text.replace(/\D/g, "").slice(0, 9);
        for (let j = 0; j < digits.length; j++) {
          if (inputs[j]) inputs[j].value = digits[j];
        }
        if (digits.length === 9) {
          onVerify(digits);
        } else if (digits.length > 0 && inputs[digits.length]) {
          inputs[digits.length].focus();
        }
      });

      grid.appendChild(input);
      inputs.push(input);
    }
    overlay.appendChild(grid);

    const err = document.createElement("p");
    err.id = "cl-pair-err";
    err.className = "cl-pair-err";
    overlay.appendChild(err);

    const resetBtn = document.createElement("button");
    resetBtn.className = "cl-pair-reset";
    resetBtn.textContent = "Reset connection data";
    resetBtn.onclick = async () => {
      await resetDeviceStorage();
      location.reload();
    };
    overlay.appendChild(resetBtn);

    // Auto-focus first input
    setTimeout(() => inputs[0]?.focus(), 100);

    return overlay;
  }

  /**
   * Create prebuilt Add to Home Screen UI (Screen B).
   */
  private createAddToHomeScreen(onContinue: () => void): HTMLElement {
    const overlay = document.createElement("div");
    overlay.id = "crosslink-bootstrap-screen";
    overlay.className = "cl-screen-overlay cl-bootstrap-screen";

    const logoContainer = document.createElement("div");
    logoContainer.style.cssText = "display:flex;justify-content:center";
    logoContainer.innerHTML = crosslinkLogoSvg({ width: "170px", className: "cl-crosslink-logo" });
    overlay.appendChild(logoContainer);

    const title = document.createElement("h2");
    title.className = "cl-bootstrap-appname";
    title.textContent = this.options.onboarding?.appName || this.options.appName || "Crosslink";
    overlay.appendChild(title);

    const btn = document.createElement("button");
    btn.className = "cl-continue-btn";
    btn.innerHTML = "Continue in browser &rarr;";
    btn.onclick = () => onContinue();
    overlay.appendChild(btn);

    const nudge = document.createElement("div");
    nudge.className = "cl-bootstrap-nudge";
    nudge.innerHTML = `
      <span>Add to home screen</span>
      <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 5 C 24 16, 24 27, 24 39" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/>
        <path d="M16 31 L 24 40 L 32 31" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
    `;
    overlay.appendChild(nudge);

    return overlay;
  }

  /**
   * Prebuilt SAS Confirmation Modal.
   */
  private showSasConfirmation(req: PairingConfirmRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = document.createElement("div");
      modal.id = "crosslink-sas-modal";
      modal.className = "cl-sas-modal";

      const logoContainer = document.createElement("div");
      logoContainer.style.cssText = "display:flex;justify-content:center;margin-bottom:8px";
      logoContainer.innerHTML = crosslinkLogoSvg({ width: "120px", className: "cl-crosslink-logo" });
      modal.appendChild(logoContainer);

      const title = document.createElement("h2");
      title.textContent = "Verify Security Code";
      modal.appendChild(title);

      const p = document.createElement("p");
      p.textContent = "Confirm the numbers match on your computer:";
      modal.appendChild(p);

      const grid = document.createElement("div");
      grid.className = "cl-sas-grid";
      for (const ch of req.sas.replace(/\s/g, "")) {
        const span = document.createElement("span");
        span.textContent = ch;
        grid.appendChild(span);
      }
      modal.appendChild(grid);

      const caps = document.createElement("p");
      caps.className = "cl-sas-caps";
      caps.textContent = "Capabilities: " + (req.grantedCaps.join(", ") || "(none)");
      modal.appendChild(caps);

      const actions = document.createElement("div");
      actions.className = "cl-sas-actions";

      const okBtn = document.createElement("button");
      okBtn.className = "cl-sas-ok";
      okBtn.textContent = "They match";
      okBtn.onclick = () => {
        modal.remove();
        resolve(true);
      };

      const noBtn = document.createElement("button");
      noBtn.className = "cl-sas-no";
      noBtn.textContent = "Cancel";
      noBtn.onclick = () => {
        modal.remove();
        resolve(false);
      };

      actions.append(okBtn, noBtn);
      modal.appendChild(actions);
      document.body.appendChild(modal);
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * Math.pow(1.5, Math.min(this.attemptCount, 8)));
    const jitter = delay * (0.8 + Math.random() * 0.4);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.attemptCount++;
      await this.forceReconnect();
    }, jitter);
  }

  async forceReconnect(): Promise<void> {
    const apps = this.client.listApps();
    if (apps.length === 0) {
      this.transitionTo("pairing-required");
      return;
    }
    this.client.close();
    await this.attemptSilentAuth(apps[0]);
  }

  private cancelTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reachabilityTimer) {
      clearInterval(this.reachabilityTimer);
      this.reachabilityTimer = null;
    }
    this.attemptCount = 0;
  }

  private setupListeners(): void {
    if (typeof document === "undefined" || typeof window === "undefined") return;

    this.visibilityHandler = () => {
      if (!document.hidden && this.state === "offline") {
        this.forceReconnect().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    this.onlineHandler = () => {
      if (this.state === "offline") {
        this.forceReconnect().catch(() => {});
      }
    };
    window.addEventListener("online", this.onlineHandler);
  }

  /** What this origin permits, once `start()` has probed it. */
  getEnvironment(): BootstrapEnvironment | null {
    return this.environment;
  }

  getState(): MobileBootstrapState {
    return this.state;
  }

  getClient(): CrosslinkClient {
    return this.client;
  }

  destroy(): void {
    this.cancelTimers();
    this.unmountCurrentScreen();
    this.poweredBy?.destroy();
    this.poweredBy = null;
    if (typeof document !== "undefined" && this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    if (typeof window !== "undefined" && this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
    }
  }
}
