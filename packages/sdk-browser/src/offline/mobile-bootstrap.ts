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
  parsePairingUri
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
  /** Pairing URI override (defaults to ?pair= query parameter or stored target) */
  pairingUri?: string;
  /** Host endpoint to verify pairing codes via HTTP (fallback/direct path) */
  verifyPairEndpoint?: string;
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
  background: #0f172a;
  color: #f8fafc;
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

/* ── Screen A: Pairing Screen ─────────────────────────── */
.cl-pair-screen {
  gap: 20px;
}
.cl-pair-logo {
  width: 72px;
  height: 72px;
  border-radius: 18px;
  object-fit: cover;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
}
.cl-pair-icon-fallback {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #38bdf8;
}
.cl-pair-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
  color: #f8fafc;
}
.cl-pair-desc {
  font-size: 14px;
  color: #94a3b8;
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
  border: 1px solid #334155;
  background: #1e293b;
  color: #f8fafc;
  font-weight: 700;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.cl-pair-digit:focus {
  border-color: #38bdf8;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
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
  color: #64748b;
  font-size: 12px;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 6px;
  text-decoration: underline;
  transition: color 0.15s;
}
.cl-pair-reset:hover {
  color: #94a3b8;
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
.cl-bootstrap-mark {
  width: min(65vw, 170px);
  height: auto;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.08);
  padding: 10px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
}
.cl-bootstrap-appname {
  font-size: 21px;
  font-weight: 600;
  color: #ffffff;
  margin-top: 18px;
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
  background: rgba(0, 0, 0, 0.88);
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
.cl-sas-modal p { color: #94a3b8; font-size: 13px; margin: 0; }
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
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  font-size: 24px;
  font-weight: 700;
  color: #f8fafc;
  font-variant-numeric: tabular-nums;
}
.cl-sas-caps { color: #94a3b8; font-size: 12px; }
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
.cl-sas-ok { background: #38bdf8; color: #082f49; }
.cl-sas-no { background: #1e293b; color: #f8fafc; border: 1px solid #334155 !important; }
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

    // 4. Evaluate stored trusted device credentials
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

    const params = new URLSearchParams(location.search);
    const pairParam = params.get("pair") || "";
    if (pairParam) {
      this.targetPairingUri = pairParam;
      try { localStorage.setItem("crosslink.pendingPair", pairParam); } catch {}
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
      // 1. Direct host verification endpoint if configured (e.g. /api/verify-pair)
      if (this.options.verifyPairEndpoint || typeof fetch !== "undefined") {
        const endpoint = this.options.verifyPairEndpoint ?? "/api/verify-pair";
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code })
          });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data && data.ok === false) {
              if (errEl) {
                errEl.textContent = "Incorrect pairing code. Please try again.";
                errEl.style.color = "#f87171";
              }
              return;
            }
          }
        } catch {
          // If verify endpoint fails, let signaling pairing attempt proceed
        }
      }

      // 2. Perform cryptographic pairing handshake
      const rawPairUri = this.targetPairingUri || (typeof localStorage !== "undefined" ? localStorage.getItem("crosslink.pendingPair") : null);
      let targetUri = rawPairUri;

      if (!targetUri && typeof location !== "undefined") {
        // Synthesize target pairing URI from current host
        targetUri = `crosslink://pair?v=1&s=${encodeURIComponent(location.origin)}&a=${encodeURIComponent(this.options.appId || "com.crosslink.app")}&n=${encodeURIComponent(this.options.appName || "Crosslink")}&f=0000000000000000`;
      }

      if (targetUri) {
        const caps = this.options.capabilities ?? [];
        await this.client.pairWithCode(targetUri, code, caps);
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem("crosslink.pendingPair");
        }
      }

      // 3. Connect to newly paired app
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

    const iconSrc = this.options.onboarding?.icon || this.options.offline?.icon;
    if (iconSrc) {
      const img = document.createElement("img");
      img.className = "cl-pair-logo";
      img.src = iconSrc;
      img.alt = this.options.appName || "App";
      overlay.appendChild(img);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "cl-pair-icon-fallback";
      fallback.innerHTML = `
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
          <line x1="12" y1="18" x2="12.01" y2="18"/>
        </svg>
      `;
      overlay.appendChild(fallback);
    }

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

    const iconSrc = this.options.onboarding?.icon || this.options.offline?.icon || "./icon-192.png";
    const img = document.createElement("img");
    img.className = "cl-bootstrap-mark";
    img.src = iconSrc;
    img.alt = this.options.appName || "App";
    overlay.appendChild(img);

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
        <path d="M36 4 L 42 8 L 34 16" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
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
