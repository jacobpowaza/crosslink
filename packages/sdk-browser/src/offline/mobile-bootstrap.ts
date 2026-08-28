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
  bottom: calc(18px + env(safe-area-inset-bottom));
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
  width: 46px;
  height: 46px;
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

  constructor(options: MobileBootstrapOptions) {
    this.options = options;
    injectBootstrapStyles();

    if (options.client) {
      this.client = options.client;
    } else {
      const clientOpts: CrosslinkClientOptions = {
        ...options.clientOptions,
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
    // 1. Register service worker if supported
    if (this.options.autoRegisterServiceWorker !== false && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register(this.options.serviceWorkerUrl ?? "/sw.js");
      } catch (e) {
        // Non-fatal
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

    // 4. Silent device-link continuation: a fresh, storage-isolated launch
    // (e.g. an iOS home-screen install) has no paired-app record of its own,
    // but the URL/pendingPair may carry a link-mode URI minted by the same
    // pairing session when it nudged "add to home screen". Complete it
    // automatically — no code entry, no SAS — before falling back to the
    // normal first-run pairing screen.
    if (this.client.listApps().length === 0 && this.targetPairingUri) {
      try {
        const parsed = parsePairingUri(unwrapBootstrapUri(this.targetPairingUri));
        if (parsed.link) {
          await this.client.pairFromQr(this.targetPairingUri, this.options.capabilities);
          if (typeof localStorage !== "undefined") localStorage.removeItem("crosslink.pendingPair");
        }
      } catch {
        // Token expired/used/unreachable — fall through to the normal flow
        // below, which shows the ordinary pairing screen as a fallback.
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

  /**
   * Mints a device-link continuation URI and stamps it into `location.hash`
   * so that if the user follows the nudge and taps "Add to Home Screen", the
   * icon iOS creates carries it as its launch URL. A fresh standalone launch
   * of that icon has empty (storage-isolated) local data, but reads this
   * fragment and completes the link silently — see `start()` step 4.
   *
   * Best-effort: on failure the nudge screen still lets the user continue in
   * the browser and pair again from there later.
   */
  private async prepareDeviceLinkHandoff(): Promise<void> {
    if (isStandalone() || typeof location === "undefined") return;
    try {
      const { uri } = await this.client.createDeviceLink();
      location.hash = `${BOOTSTRAP_FRAGMENT_KEY}=${encodeURIComponent(uri)}`;
      try { localStorage.setItem("crosslink.pendingPair", uri); } catch {}
    } catch {
      /* the user can still install-then-re-pair manually */
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
      return;
    }

    // Authorization lost or pending -> notify consumer
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
        this.prepareDeviceLinkHandoff();
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

      await this.client.pairWithCode(targetUri, code, this.options.capabilities ?? []);
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
    logoContainer.innerHTML = `
      <svg viewBox="105 363 1060 222" fill="none" xmlns="http://www.w3.org/2000/svg" class="cl-crosslink-logo">
        <path d="M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z" fill="#ffffff" fill-rule="evenodd"/>
      </svg>
    `;
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
    logoContainer.innerHTML = `
      <svg viewBox="105 363 1060 222" fill="none" xmlns="http://www.w3.org/2000/svg" class="cl-crosslink-logo" style="width: 170px;">
        <path d="M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z" fill="#ffffff" fill-rule="evenodd"/>
      </svg>
    `;
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
        <path d="M12 36 C 20 28, 34 12, 40 8" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M31 9 L 40 8 L 35 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
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
      logoContainer.innerHTML = `
        <svg viewBox="105 363 1060 222" fill="none" xmlns="http://www.w3.org/2000/svg" class="cl-crosslink-logo" style="width: 120px; margin-bottom: 8px;">
          <path d="M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z" fill="#ffffff" fill-rule="evenodd"/>
        </svg>
      `;
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

  getState(): MobileBootstrapState {
    return this.state;
  }

  getClient(): CrosslinkClient {
    return this.client;
  }

  destroy(): void {
    this.cancelTimers();
    this.unmountCurrentScreen();
    if (typeof document !== "undefined" && this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    if (typeof window !== "undefined" && this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
    }
  }
}
