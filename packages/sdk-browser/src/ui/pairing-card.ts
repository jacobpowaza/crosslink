/**
 * Canonical reusable Crosslink Pairing Widget (CrosslinkConnect).
 *
 * Provides a standardized, brand-consistent 3-column pairing card:
 * [ App Logo & Blurb ] | [ Scan QR ] | [ Pairing Code Pills ]
 *
 * The settings cog exposes the host's own `networkMode` values and nothing
 * else. There is deliberately no tunnel-provider setup here: Crosslink needs no
 * ngrok token, no Cloudflare account, and no port forwarding, so a UI that asks
 * for them would be advertising configuration the framework does not require.
 *
 * The card also shows which routes the current QR actually advertises, because
 * "remote" either produced a public endpoint or it did not — the widget never
 * implies reachability the host has not confirmed.
 *
 * Fully customizable via options and CSS custom properties:
 *   --cl-bg, --cl-fg, --cl-muted, --cl-divider, --cl-pill, --cl-pill-text, --cl-radius
 */

import {
  createHttpPairingSource,
  type PairingSession,
  type PairingSource,
  type PairingSourceEvent
} from "./pairing-source.js";
import {
  crosslinkLogoSvg,
  resolveCrosslinkTheme,
  CROSSLINK_REPOSITORY,
  CROSSLINK_ATTRIBUTION_TEXT,
  CROSSLINK_ATTRIBUTION_LINK_TEXT,
  type CrosslinkTheme,
  type ResolvedCrosslinkTheme
} from "./branding.js";

export interface PairingCardTheme {
  bg?: string;
  fg?: string;
  muted?: string;
  divider?: string;
  pill?: string;
  pillText?: string;
  radius?: string;
}

/**
 * The host's network mode. These are the same four values `createCrosslinkServer`
 * accepts, so what the user picks here can be handed straight back to the host.
 */
export type NetworkMode = "auto" | "local-only" | "lan-and-relay" | "remote";

/** Endpoint kinds as advertised in a v2 pairing URI. */
export interface PairingCardEndpoint {
  kind: "lan" | "wan" | "sig" | "relay" | "tunnel";
  url: string;
}

export interface PairingCardOptions {
  /** Target DOM container element or selector to mount into */
  target?: HTMLElement | string;
  /** Application or framework name (e.g. "Crosslink Notes", "Crosslink Chat") */
  appName?: string;
  /** Informational blurb describing security and app pairing */
  blurb?: string;
  /**
   * URL or inline SVG of the *application's* icon, shown beside the app name.
   *
   * It never replaces the Crosslink mark: the card renders both, so a paired
   * device sees which application it is joining and which framework is
   * securing the connection.
   */
  appIcon?: string;
  /**
   * Application branding — name, icon, and colours. These are the only visual
   * knobs the card exposes; there is no renderer or markup slot, because every
   * Crosslink application is meant to present the same pairing experience.
   */
  brand?: CrosslinkTheme;
  /** Initial pairing code (e.g. "938472910") */
  code?: string;
  /** Initial QR code SVG string or image URL */
  qr?: string;
  /** Expiration timestamp (epoch ms) or descriptive string */
  expiresAt?: number | string;
  /** Callback triggered when the user clicks 'Refresh code' */
  onRefresh?: () => void | Promise<void>;
  /** Callback triggered when connection network mode changes */
  onNetworkModeChange?: (mode: NetworkMode) => void | Promise<void>;
  /** Current active network mode */
  networkMode?: NetworkMode;
  /** Security doc hyperlink for Open LAN info knob */
  securityGuideUrl?: string;
  /** LAN only guide hyperlink */
  lanGuideUrl?: string;
  /** Remote-access guide hyperlink */
  remoteGuideUrl?: string;
  /** Custom theme color overrides */
  theme?: PairingCardTheme;
  /** Endpoint URL to fetch paired device info. Default: /api/devices */
  devicesEndpoint?: string;
  /** Endpoint URL to revoke device access. Default: /api/revoke */
  revokeEndpoint?: string;
  /**
   * Where the self-driving card gets pairing sessions.
   *
   * Omit this option for the canonical Crosslink system endpoints at
   * `/__crosslink` on the page's own origin. `true` is retained as a legacy
   * alias for that default; a string names a different base path; an object is
   * a custom transport for a host the page cannot reach over HTTP. With any of them the
   * card mints its own pairing session, renders the QR and code, replaces the
   * code before it expires, mints a fresh one when a device redeems the old
   * one, and applies connection-mode changes — the loop every application used
   * to write beside it.
   *
   * Set `false` to keep the card controlled: `update()` is then the only way
   * state changes, which is what a host that already owns its own pairing loop
   * wants. This explicit opt-out keeps the ordinary integration zero-config.
   */
  source?: false | true | string | PairingSource;
  /** Seconds of headroom before expiry at which a new code is minted. Default 15. */
  refreshLeadSeconds?: number;
  /** Called after the card mints a session. Self-driving mode only. */
  onSession?: (session: PairingSession) => void;
  /** Called when a paired device connects. Self-driving mode only. */
  onDeviceConnected?: (deviceId?: string) => void;
  /** Called after the card renders a minting failure. Self-driving mode only. */
  onError?: (error: Error) => void;
  /** Initial connection status line shown under the pairing code. */
  status?: string;
  /** Whether to inject default CSS styles into document head. Default true */
  injectStyles?: boolean;
}

export interface PairingCardState {
  code?: string | null;
  qr?: string | null;
  expiresAt?: number | string | null;
  error?: string | null;
  /** Short stable identifier rendered in the QR slot (for example `CL-P409`). */
  errorCode?: string | null;
  loading?: boolean;
  networkMode?: NetworkMode;
  /** Routes the current QR advertises, straight from `PairingCodeInfo.endpoints`. */
  endpoints?: PairingCardEndpoint[] | null;
  /** Host-side note about remote access, e.g. why no `wan` endpoint exists. */
  remoteNote?: string | null;
  /** Connection status line, e.g. "Waiting for a device to scan". */
  status?: string | null;
  /** True once a paired device is connected; the status line turns positive. */
  connected?: boolean;
}


const PAIRING_CARD_STYLES = `
.cl-pair-card {
  --cl-bg: #000000;
  --cl-fg: #ffffff;
  --cl-muted: #9a9a9a;
  --cl-divider: #2a2a2a;
  --cl-pill: #e7e7ea;
  --cl-pill-text: #0a0a0a;
  --cl-radius: 28px;
  --cl-accent: #38bdf8;
  position: relative;
  background: var(--cl-bg);
  color: var(--cl-fg);
  border-radius: var(--cl-radius);
  padding: 28px 32px;
  margin: 20px 0;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: 1.1fr auto 1fr auto 1fr;
  align-items: center;
  gap: 28px 28px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  text-align: left;
}
.cl-pair-card * {
  box-sizing: border-box;
}

/* ── Route summary in the settings popover ──────────── */
.cl-route-summary {
  border-top: 1px solid var(--cl-divider);
  margin-top: 6px;
  padding: 8px 12px 4px;
  color: var(--cl-muted);
  font-size: 12px;
  line-height: 1.45;
}
.cl-route-summary p {
  margin: 0 0 4px;
}

/* ── Cog Button ─────────────────────────────────────── */
.cl-cog-btn {
  position: absolute;
  top: 14px;
  right: 16px;
  background: transparent;
  border: none;
  color: var(--cl-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
  z-index: 20;
}
.cl-cog-btn:hover {
  color: var(--cl-fg);
  background: rgba(255, 255, 255, 0.1);
}
.cl-cog-btn svg {
  width: 17px;
  height: 17px;
  display: block;
}

/* ── Small Dropdown Menu ─────────────────────────────── */
.cl-settings-dropdown {
  position: absolute;
  top: 44px;
  right: 14px;
  width: 300px;
  background: var(--cl-bg);
  border: 1px solid var(--cl-divider);
  border-radius: 12px;
  padding: 8px;
  z-index: 30;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.08);
  animation: clDropdownFade 0.12s ease-out;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cl-settings-dropdown[hidden] {
  display: none;
}
@keyframes clDropdownFade {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.cl-dropdown-header {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cl-muted);
  padding: 6px 8px 4px 8px;
}
.cl-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--cl-fg);
  transition: background 0.12s;
  position: relative;
  user-select: none;
}
.cl-dropdown-item:hover {
  background: rgba(255, 255, 255, 0.08);
}
.cl-dropdown-label {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}
.cl-dropdown-label input[type="radio"] {
  accent-color: var(--cl-accent);
  cursor: pointer;
  margin: 0;
}
.cl-info-knob-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cl-info-knob {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: var(--cl-muted);
  font-size: 11px;
  font-weight: 700;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s, color 0.15s;
}
.cl-info-knob:hover,
.cl-info-knob:focus {
  background: var(--cl-accent);
  color: #082f49;
}
/* Tooltip on hover / focus */
.cl-dropdown-tooltip {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  width: 250px;
  background: #020617;
  border: 1px solid var(--cl-divider);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.45;
  color: #cbd5e1;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-2px);
  transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
  z-index: 50;
}
.cl-info-knob-wrap:hover .cl-dropdown-tooltip,
.cl-info-knob-wrap:focus-within .cl-dropdown-tooltip {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
}
.cl-dropdown-tooltip a {
  color: var(--cl-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  display: inline-block;
  margin-top: 6px;
}

/* ── Columns ────────────────────────────────────────── */
.cl-pair-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.cl-pair-logo {
  height: 24px;
  width: auto;
  max-width: 140px;
  display: block;
  /* Contrast-corrected in resolveCrosslinkTheme; currentColor carries it
     into the SVG path so one variable tints the whole mark. */
  color: var(--cl-logo, var(--cl-fg));
}
.cl-pair-logo-wrap {
  margin-bottom: 10px;
}
.cl-pair-app {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.cl-pair-app[hidden] {
  display: none;
}
.cl-pair-app-icon {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  object-fit: cover;
  display: block;
  flex-shrink: 0;
}
.cl-pair-app-icon svg {
  width: 20px;
  height: 20px;
  display: block;
}
.cl-pair-app-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--cl-fg);
  letter-spacing: -0.01em;
}
.cl-pair-status {
  font-size: 11px;
  color: var(--cl-muted);
  margin: 8px 0 0 0;
  text-align: center;
  min-height: 14px;
}
.cl-pair-status[hidden] {
  display: none;
}
.cl-pair-status-on {
  color: #4ade80;
  font-weight: 600;
}
.cl-pair-attribution {
  grid-column: 1 / -1;
  border-top: 1px solid var(--cl-divider);
  padding-top: 12px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--cl-attribution, var(--cl-muted));
  text-align: center;
}
.cl-pair-attribution a {
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.cl-pair-blurb {
  font-size: 13px;
  line-height: 1.55;
  color: var(--cl-muted);
  max-width: 32ch;
  margin: 0;
}
.cl-pair-blurb strong {
  color: var(--cl-fg);
  font-weight: 600;
}
.cl-pair-refresh {
  appearance: none;
  background: none;
  border: none;
  color: var(--cl-muted);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  padding: 0;
  margin-top: 14px;
  transition: color 0.15s;
}
.cl-pair-refresh:hover {
  color: var(--cl-fg);
}
.cl-pair-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.cl-pair-divider {
  width: 1px;
  align-self: stretch;
  background: var(--cl-divider);
}
.cl-pair-label {
  font-size: 12px;
  font-weight: 700;
  text-transform: none;
  color: var(--cl-fg);
  margin: 0 0 14px 0;
  text-align: center;
}
.cl-pair-center,
.cl-pair-right {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.cl-qr-wrap {
  background: #ffffff;
  border-radius: 16px;
  padding: 12px;
  min-width: 176px;
  min-height: 176px;
  width: 176px;
  height: 176px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.cl-qr-wrap svg {
  width: 152px;
  height: 152px;
  display: block;
}
.cl-qr-wrap img {
  width: 152px;
  height: 152px;
  display: block;
  border-radius: 8px;
}
.cl-qr-placeholder {
  color: #6b6b6b;
  font-size: 12px;
  text-align: center;
  max-width: 140px;
  line-height: 1.4;
}
.cl-qr-placeholder.cl-error {
  color: #f87171;
}
.cl-error-code {
  color: #991b1b;
  font: 700 18px/1.2 "SF Mono", "Fira Code", monospace;
  letter-spacing: 0.04em;
}
.cl-error-details-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: #334155;
  cursor: pointer;
  font: 600 11px/1.2 inherit;
  padding: 6px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.cl-skeleton {
  position: relative;
  overflow: hidden;
  background: #e2e8f0;
}
.cl-skeleton::after {
  content: "";
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,.8), transparent);
  animation: clSkeletonSweep 1.35s ease-in-out infinite;
}
.cl-qr-skeleton {
  width: 132px;
  height: 132px;
  border-radius: 10px;
}
.cl-pill.cl-pill-skeleton {
  min-width: 44px;
  height: 52px;
  padding: 0;
}
@keyframes clSkeletonSweep {
  100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .cl-skeleton::after { animation: none; }
}
.cl-pair-code-pills {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  max-width: 200px;
  justify-content: center;
  min-height: 44px;
  align-items: center;
}
.cl-pair-code-pills .cl-pill {
  background: var(--cl-pill);
  color: var(--cl-pill-text);
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 24px;
  font-weight: 700;
  line-height: 1;
  border-radius: 12px;
  padding: 14px 8px;
  min-width: 44px;
  text-align: center;
  display: block;
}
.cl-pair-hint {
  font-size: 11px;
  color: var(--cl-muted);
  margin: 12px 0 0 0;
  text-align: center;
}
@media (max-width: 860px) {
  .cl-pair-card {
    grid-template-columns: 1fr;
    text-align: center;
    padding: 20px 24px;
    gap: 20px;
  }
  .cl-pair-left {
    align-items: center;
  }
  .cl-pair-card .cl-pair-divider {
    width: 100%;
    height: 1px;
  }
  .cl-pair-logo {
    margin-left: auto;
    margin-right: auto;
  }
  .cl-pair-blurb {
    max-width: none;
  }
}

/* ── Connected Devices Modal ────────────────────────── */
.cl-connected-modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.75);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clDropdownFade 0.15s ease-out;
}
.cl-error-modal {
  max-width: 480px;
}
.cl-error-modal code {
  color: #fca5a5;
  font-size: 12px;
}
.cl-error-modal p {
  color: #cbd5e1;
  font-size: 13px;
  line-height: 1.55;
  margin: 0;
  overflow-wrap: anywhere;
}
.cl-connected-modal {
  background: #0a0a0a;
  border: 1px solid var(--cl-divider);
  border-radius: 20px;
  width: 92vw;
  max-width: 640px;
  max-height: 85vh;
  padding: 24px 28px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.06);
  overflow-y: auto;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--cl-fg);
}
.cl-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  gap: 16px;
}
.cl-modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.cl-modal-header button {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--cl-divider);
  border-radius: 10px;
  color: var(--cl-fg);
  font-size: 20px;
  line-height: 1;
  padding: 4px 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.cl-modal-header button:hover {
  background: rgba(255, 255, 255, 0.15);
}
.cl-modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cl-modal-error {
  color: #f87171;
  font-size: 12px;
  padding: 8px 0;
}
.cl-device-card {
  background: #121212;
  border: 1px solid var(--cl-divider);
  border-radius: 14px;
  padding: 16px 18px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.cl-device-info {
  flex: 1;
  min-width: 0;
}
.cl-device-name {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 4px;
  letter-spacing: -0.01em;
}
.cl-device-meta {
  font-size: 11px;
  color: var(--cl-muted);
  margin-bottom: 8px;
  text-transform: capitalize;
}
.cl-device-detail {
  font-size: 11px;
  line-height: 1.5;
  color: #c4c4c4;
}
.cl-device-detail strong {
  color: var(--cl-muted);
  font-weight: 600;
}
.cl-device-actions {
  flex-shrink: 0;
}
.cl-revoke-btn {
  background: #1a1a2e;
  border: 1px solid #2a2a3a;
  color: #e7e7ea;
  border-radius: 8px;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.cl-revoke-btn:hover {
  background: #7f1d1d;
  border-color: #f87171;
  color: #f87171;
}
`.trim();

let stylesInjected = false;
export function injectPairingCardStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  const styleEl = document.createElement("style");
  styleEl.id = "crosslink-pairing-card-styles";
  styleEl.textContent = PAIRING_CARD_STYLES;
  document.head.appendChild(styleEl);
  stylesInjected = true;
}

export class PairingCard {
  readonly element: HTMLElement;
  private options: PairingCardOptions;
  private logoEl: HTMLElement;
  private blurbEl: HTMLElement;
  private refreshBtn: HTMLButtonElement;
  private qrWrapEl: HTMLElement;
  private codePillsEl: HTMLElement;
  private hintEl: HTMLElement;
  private settingsPopover: HTMLElement;
  private routeSummaryEl!: HTMLElement;
  private appRowEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private brand: ResolvedCrosslinkTheme;
  private currentMode: NetworkMode;
  private expiryTimer: any = null;
  private source: PairingSource | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeSource: (() => void) | null = null;
  private destroyed = false;
  private inFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private connectedDevices = new Set<string>();

  constructor(options: PairingCardOptions = {}) {
    this.options = options;
    this.brand = resolveCrosslinkTheme({
      appName: options.appName,
      appIcon: options.appIcon,
      ...options.brand
    });
    this.currentMode = normalizeNetworkMode(options.networkMode);

    if (options.injectStyles !== false) {
      injectPairingCardStyles();
    }

    this.element = document.createElement("div");
    this.element.className = "cl-pair-card";

    this.applyBrand();
    this.applyTheme(options.theme);

    // Settings Cog Button
    const cogBtn = document.createElement("button");
    cogBtn.className = "cl-cog-btn";
    cogBtn.title = "Connection Settings";
    cogBtn.setAttribute("aria-label", "Connection Settings");
    cogBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    `;
    cogBtn.addEventListener("click", () => this.toggleSettings());

    // Settings Popover Panel
    this.settingsPopover = this.createSettingsPopover();

    // Left Column
    const left = document.createElement("div");
    left.className = "cl-pair-left";

    this.logoEl = document.createElement("div");
    this.logoEl.className = "cl-pair-logo-wrap";
    this.renderBrandMark();

    // Which application is being joined, beneath the framework that secures it.
    this.appRowEl = document.createElement("div");
    this.appRowEl.className = "cl-pair-app";
    this.renderAppRow();

    this.blurbEl = document.createElement("p");
    this.blurbEl.className = "cl-pair-blurb";
    this.blurbEl.innerHTML =
      options.blurb ??
      `<strong>Connect another device</strong> with Crosslink. The framework authenticates trusted devices and protects application data end to end across supported transports.`;

    this.refreshBtn = document.createElement("button");
    this.refreshBtn.className = "cl-pair-refresh";
    this.refreshBtn.textContent = "Refresh code";
    this.refreshBtn.addEventListener("click", () => this.handleRefresh());

    left.appendChild(this.logoEl);
    left.appendChild(this.appRowEl);
    left.appendChild(this.blurbEl);
    left.appendChild(this.refreshBtn);

    // Divider 1
    const div1 = document.createElement("div");
    div1.className = "cl-pair-divider";

    // Center Column (QR Code)
    const center = document.createElement("div");
    center.className = "cl-pair-center";
    const qrLabel = document.createElement("h3");
    qrLabel.className = "cl-pair-label";
    qrLabel.textContent = "Scan this on your device";

    this.qrWrapEl = document.createElement("div");
    this.qrWrapEl.className = "cl-qr-wrap";
    this.renderQr(options.qr);

    center.appendChild(qrLabel);
    center.appendChild(this.qrWrapEl);

    // Divider 2
    const div2 = document.createElement("div");
    div2.className = "cl-pair-divider";

    // Right Column (Pairing Code)
    const right = document.createElement("div");
    right.className = "cl-pair-right";
    const codeLabel = document.createElement("h3");
    codeLabel.className = "cl-pair-label";
    codeLabel.textContent = "Pairing Code";

    this.codePillsEl = document.createElement("div");
    this.codePillsEl.className = "cl-pair-code-pills";
    this.renderCode(options.code);

    this.hintEl = document.createElement("p");
    this.hintEl.className = "cl-pair-hint";
    this.renderExpiry(options.expiresAt);

    this.statusEl = document.createElement("p");
    this.statusEl.className = "cl-pair-status";
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.renderStatus(options.status ?? null, false);

    right.appendChild(codeLabel);
    right.appendChild(this.codePillsEl);
    right.appendChild(this.hintEl);
    right.appendChild(this.statusEl);

    // Assemble Card
    this.element.appendChild(cogBtn);
    this.element.appendChild(this.settingsPopover);
    this.element.appendChild(left);
    this.element.appendChild(div1);
    this.element.appendChild(center);
    this.element.appendChild(div2);
    this.element.appendChild(right);
    this.element.appendChild(this.createAttribution());

    // Auto mount if target provided
    if (options.target) {
      this.mount(options.target);
    }

    // Dismiss dropdown on outside click
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("click", (e: any) => {
        if (!this.element.contains(e.target)) {
          this.toggleSettings(false);
        }
      });
    }

    if (options.source !== false) this.attachSource(options.source ?? true);
  }

  /* ------------------- self-driving session lifecycle ------------------ */

  /**
   * Connects the card to a session source and starts the loop.
   *
   * Called from the constructor when `options.source` is set. Split out so a
   * card built before its transport exists — an Electron renderer waiting for
   * a preload bridge, say — can start driving later without a second class.
   */
  attachSource(source: true | string | PairingSource): void {
    this.source =
      typeof source === "object" ? source : createHttpPairingSource(source === true ? undefined : source);
    this.options.devicesEndpoint ??= this.source.devicesEndpoint;
    this.options.revokeEndpoint ??= this.source.revokeEndpoint;
    this.unsubscribeSource =
      this.source.subscribe?.((event) => this.handleSourceEvent(event)) ?? null;
    void this.refresh();
  }

  /**
   * Mints a fresh pairing session and renders it.
   *
   * Concurrent calls collapse onto the one in flight. The expiry timer, the
   * refresh button and a host-side invalidation can all fire inside the same
   * second, and three codes minted back to back would invalidate two of them
   * before anybody could finish scanning.
   *
   * Collapsing cannot simply drop the extra calls, though. A request that
   * arrives mid-flight may be the one that matters — the host reporting that a
   * device just redeemed the code being minted — so it is remembered and run
   * once the current mint settles, leaving the card showing a live code rather
   * than one that is already spent.
   */
  async refresh(): Promise<void> {
    if (!this.source) {
      await this.handleRefresh();
      return;
    }
    if (this.destroyed) return;
    if (this.inFlight) {
      this.refreshQueued = true;
      return this.inFlight;
    }
    this.inFlight = this.mintSession().finally(() => {
      this.inFlight = null;
      if (this.refreshQueued && !this.destroyed) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    return this.inFlight;
  }

  private async mintSession(): Promise<void> {
    const source = this.source;
    if (!source) return;
    this.clearRefreshTimer();
    this.update({ loading: true, error: null });
    try {
      const session = await source.getSession(this.currentMode);
      if (this.destroyed) return;
      if (session.networkMode) this.currentMode = normalizeNetworkMode(session.networkMode);
      this.update({
        loading: false,
        error: null,
        qr: session.qrSvg ?? null,
        code: session.code,
        expiresAt: session.expiresAt,
        networkMode: this.currentMode,
        endpoints: session.endpoints ?? null,
        remoteNote: session.remoteNote ?? null,
        status: this.sessionStatusText(),
        connected: this.connectedDevices.size > 0
      });
      this.scheduleSessionRefresh(session.expiresAt);
      this.options.onSession?.(session);
    } catch (err) {
      if (this.destroyed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.update({
        loading: false,
        error: error.message || "Crosslink could not create a pairing code.",
        errorCode: (error as Error & { code?: string }).code ?? "CL-P001"
      });
      this.options.onError?.(error);
      // A host still starting up answers for a few hundred milliseconds. A short
      // fixed retry turns that into a card that fills itself in, rather than one
      // the user has to click to recover.
      this.refreshTimer = setTimeout(() => void this.refresh(), 5_000);
    }
  }

  private sessionStatusText(): string {
    const count = this.connectedDevices.size;
    if (count === 0) return "Waiting for a device to scan";
    return count === 1 ? "Device connected" : `${count} devices connected`;
  }

  private scheduleSessionRefresh(expiresAt: number): void {
    this.clearRefreshTimer();
    const lead = (this.options.refreshLeadSeconds ?? 15) * 1000;
    // Never under a second: a host handing out an already-expired code would
    // otherwise spin this into a mint loop.
    const delay = Math.max(1_000, expiresAt - Date.now() - lead);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private handleSourceEvent(event: PairingSourceEvent): void {
    if (this.destroyed) return;
    switch (event.type) {
      case "invalidate":
        void this.refresh();
        break;
      case "connected":
        this.connectedDevices.add(event.deviceId ?? "device");
        this.update({ status: this.sessionStatusText(), connected: true });
        this.options.onDeviceConnected?.(event.deviceId);
        break;
      case "disconnected":
        this.connectedDevices.delete(event.deviceId ?? "device");
        this.update({
          status: this.sessionStatusText(),
          connected: this.connectedDevices.size > 0
        });
        break;
    }
  }

  private normalizeMode(mode: string): NetworkMode {
    return normalizeNetworkMode(mode);
  }

  private createSettingsPopover(): HTMLElement {
    const pop = document.createElement("div");
    pop.className = "cl-settings-dropdown";
    pop.hidden = true;

    const remoteUrl = this.options.remoteGuideUrl || "https://crosslink.mintlify.site/guides/remote-access";
    const secUrl = this.options.securityGuideUrl || "https://crosslink.mintlify.site/security/overview";
    const lanUrl = this.options.lanGuideUrl || "https://crosslink.mintlify.site/guides/connection-modes";
    const norm = this.normalizeMode(this.currentMode);

    pop.innerHTML = `
      <div class="cl-dropdown-header">Connection Mode</div>

      <!-- Automatic (default) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="auto" ${norm === "auto" ? "checked" : ""}>
          <span>Automatic</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">&#8505;</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> The pairing payload carries every available route, and the connecting device picks the first one that answers &mdash; local first, then other confirmed routes.<br>
            <strong>Security:</strong> Crosslink authenticates devices and encrypts application data end to end whichever route wins.
            <a href="${lanUrl}" target="_blank" rel="noopener noreferrer">Mintlify docs &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Same network only -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="local-only" ${norm === "local-only" ? "checked" : ""}>
          <span>Same network only</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">&#8505;</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Direct connection on the current Wi-Fi or LAN. No remote transport is advertised.<br>
            <strong>Security:</strong> The same Crosslink authentication and end-to-end encryption apply on the local link.
            <a href="${lanUrl}" target="_blank" rel="noopener noreferrer">Mintlify docs &rarr;</a>
          </div>
        </div>
      </label>

      <!-- LAN + relay -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="lan-and-relay" ${norm === "lan-and-relay" ? "checked" : ""}>
          <span>Same network + relay</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">&#8505;</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Adds a configured relay so another device can reach the host when a direct local route is unavailable.<br>
            <strong>Security:</strong> Crosslink encrypts application data before it reaches the relay and authenticates it at the destination.
            <a href="${secUrl}" target="_blank" rel="noopener noreferrer">Mintlify docs &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Remote -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="remote" ${norm === "remote" ? "checked" : ""}>
          <span>Reachable from anywhere</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">&#8505;</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Advertises a confirmed internet route, such as a router mapping or configured tunnel. If none is available, Crosslink reports that instead of claiming remote reachability.<br>
            <strong>Security:</strong> The framework keeps device authentication and end-to-end encryption in place on the public route.
            <a href="${remoteUrl}" target="_blank" rel="noopener noreferrer">Mintlify docs &rarr;</a>
          </div>
        </div>
      </label>
    `;

    // Built as an element rather than markup because `update()` rewrites it.
    this.routeSummaryEl = document.createElement("div");
    this.routeSummaryEl.className = "cl-route-summary";
    this.routeSummaryEl.hidden = true;
    pop.appendChild(this.routeSummaryEl);

    const radios = pop.querySelectorAll('input[name="cl-net-mode"]');
    radios.forEach((r: any) => {
      r.addEventListener("change", (e: any) => {
        this.setNetworkMode(normalizeNetworkMode(e.target.value));
      });
    });

    // Connected Devices option
    const devicesHeader = document.createElement("div");
    devicesHeader.className = "cl-dropdown-header";
    devicesHeader.style.marginTop = "4px";
    devicesHeader.textContent = "Devices";
    pop.appendChild(devicesHeader);

    const devicesItem = document.createElement("label");
    devicesItem.className = "cl-dropdown-item";
    devicesItem.innerHTML = `
      <div class="cl-dropdown-label">
        <span>Connected Devices</span>
      </div>
    `;
    devicesItem.addEventListener("click", () => this.openConnectedDevicesModal());
    pop.appendChild(devicesItem);

    return pop;
  }

  toggleSettings(open?: boolean): void {
    const isHidden = this.settingsPopover.hidden;
    const shouldOpen = open !== undefined ? open : isHidden;
    this.settingsPopover.hidden = !shouldOpen;
  }

  setNetworkMode(mode: NetworkMode): void {
    const norm = this.normalizeMode(mode);
    this.currentMode = norm;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("crosslink.networkMode", norm);
      }
    } catch {}

    const radio = this.settingsPopover.querySelector(`input[value="${norm}"]`) as HTMLInputElement | null;
    if (radio) radio.checked = true;

    if (this.source) {
      void this.applyNetworkMode(norm);
      return;
    }
    if (this.options.onNetworkModeChange) {
      this.options.onNetworkModeChange(norm);
    }
  }

  private async applyNetworkMode(mode: NetworkMode): Promise<void> {
    try {
      await this.source?.setNetworkMode?.(mode);
      await this.options.onNetworkModeChange?.(mode);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.update({
        loading: false,
        error: error.message,
        errorCode: (error as Error & { code?: string }).code ?? "CL-P001"
      });
      this.options.onError?.(error);
      return;
    }
    await this.refresh();
  }

  getNetworkMode(): NetworkMode {
    return this.currentMode;
  }

  mount(target: HTMLElement | string): this {
    const container = typeof target === "string" ? document.querySelector(target) : target;
    if (!container) throw new Error(`PairingCard target element not found: ${String(target)}`);
    container.appendChild(this.element);
    return this;
  }

  update(state: PairingCardState): this {
    if (state.loading) {
      this.renderLoading();
      this.refreshBtn.disabled = true;
    } else {
      this.refreshBtn.disabled = false;
    }

    if (state.networkMode) {
      this.syncNetworkMode(normalizeNetworkMode(state.networkMode));
    }

    if (state.status !== undefined || state.connected !== undefined) {
      this.renderStatus(state.status ?? null, state.connected === true);
    }

    if (state.endpoints !== undefined || state.remoteNote !== undefined) {
      this.renderRoutes(state.endpoints ?? null, state.remoteNote ?? null);
    }

    if (state.error) {
      this.renderError(state.errorCode || "CL-P001", state.error);
      this.hintEl.textContent = "";
      return this;
    }

    if (state.qr !== undefined) {
      this.renderQr(state.qr);
    }

    if (state.code !== undefined) {
      this.renderCode(state.code);
    }

    if (state.expiresAt !== undefined) {
      this.renderExpiry(state.expiresAt);
    }

    return this;
  }

  applyTheme(theme?: PairingCardTheme): this {
    if (!theme) return this;
    const style = this.element.style;
    if (theme.bg) style.setProperty("--cl-bg", theme.bg);
    if (theme.fg) style.setProperty("--cl-fg", theme.fg);
    if (theme.muted) style.setProperty("--cl-muted", theme.muted);
    if (theme.divider) style.setProperty("--cl-divider", theme.divider);
    if (theme.pill) style.setProperty("--cl-pill", theme.pill);
    if (theme.pillText) style.setProperty("--cl-pill-text", theme.pillText);
    if (theme.radius) style.setProperty("--cl-radius", theme.radius);
    return this;
  }

  setBlurb(html: string): this {
    this.blurbEl.innerHTML = html;
    return this;
  }

  private syncNetworkMode(mode: NetworkMode): void {
    this.currentMode = mode;
    const radio = this.settingsPopover.querySelector(`input[value="${mode}"]`) as HTMLInputElement | null;
    if (radio) radio.checked = true;
  }

  /**
   * Draws the Crosslink mark. It takes no argument on purpose: the mark is the
   * one element of this card an application cannot swap out, so there is no
   * code path here that renders something else in its place.
   */
  private renderBrandMark(): void {
    this.logoEl.replaceChildren();
    this.logoEl.innerHTML = crosslinkLogoSvg({ className: "cl-pair-logo", width: "140px" });
  }

  /** The application's own icon and name, beside the framework mark. */
  private renderAppRow(): void {
    this.appRowEl.replaceChildren();
    const icon = this.brand.appIcon;
    if (icon) {
      if (icon.trim().startsWith("<svg")) {
        const holder = document.createElement("span");
        holder.className = "cl-pair-app-icon";
        holder.innerHTML = icon;
        this.appRowEl.appendChild(holder);
      } else {
        const img = document.createElement("img");
        img.className = "cl-pair-app-icon";
        img.src = icon;
        img.alt = "";
        this.appRowEl.appendChild(img);
      }
    }
    const name = document.createElement("span");
    name.className = "cl-pair-app-name";
    name.textContent = this.brand.appName;
    this.appRowEl.appendChild(name);
    this.appRowEl.hidden = !icon && this.brand.appName === "This app";
  }

  /**
   * The Crosslink attribution.
   *
   * Built and appended by the constructor with no option guarding it: an
   * application configures colours, and the line stays.
   */
  private createAttribution(): HTMLElement {
    const row = document.createElement("div");
    row.className = "cl-pair-attribution";
    const prefix = document.createElement("span");
    prefix.textContent = `${CROSSLINK_ATTRIBUTION_TEXT} `;
    const link = document.createElement("a");
    link.href = CROSSLINK_REPOSITORY;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = CROSSLINK_ATTRIBUTION_LINK_TEXT;
    row.append(prefix, link);
    return row;
  }

  private renderStatus(status: string | null, connected: boolean): void {
    this.statusEl.textContent = status ?? "";
    this.statusEl.hidden = !status;
    this.statusEl.classList.toggle("cl-pair-status-on", connected);
  }

  /**
   * Applies the application palette to the card's CSS variables.
   *
   * The mark inherits `--cl-logo`, which `resolveCrosslinkTheme` has already
   * lifted to clear the WCAG contrast floor against the card background — so an
   * accent that would have rendered the logo unreadable is corrected here
   * rather than accepted as configured.
   */
  private applyBrand(): void {
    const style = this.element.style;
    style.setProperty("--cl-bg", this.brand.backgroundColor);
    style.setProperty("--cl-fg", this.brand.textColor);
    style.setProperty("--cl-muted", this.brand.mutedColor);
    style.setProperty("--cl-divider", this.brand.dividerColor);
    style.setProperty("--cl-accent", this.brand.accentColor);
    style.setProperty("--cl-logo", this.brand.logoColor);
    style.setProperty("--cl-attribution", this.brand.attributionColor);
  }

  /** Re-themes a mounted card; the mark and attribution are unaffected. */
  setBrand(brand: CrosslinkTheme): this {
    this.brand = resolveCrosslinkTheme({ ...this.options.brand, ...brand });
    this.applyBrand();
    this.renderAppRow();
    return this;
  }

  /** The palette actually in use, after contrast correction. */
  getBrand(): ResolvedCrosslinkTheme {
    return this.brand;
  }

  private renderQr(qr?: string | null) {
    this.qrWrapEl.replaceChildren();
    if (!qr) {
      this.renderQrSkeleton();
      return;
    }

    if (qr.trim().startsWith("<svg")) {
      this.qrWrapEl.innerHTML = qr;
    } else {
      const img = document.createElement("img");
      img.src = qr;
      img.alt = "Scan to pair";
      this.qrWrapEl.appendChild(img);
    }
  }

  private renderCode(code?: string | null) {
    this.codePillsEl.replaceChildren();
    if (!code) {
      this.renderCodeSkeleton();
      return;
    }
    const cleanDigits = String(code).replace(/\D/g, "");
    for (const ch of cleanDigits) {
      const span = document.createElement("span");
      span.className = "cl-pill";
      span.textContent = ch;
      this.codePillsEl.appendChild(span);
    }
  }

  private renderLoading(): void {
    this.renderQrSkeleton();
    this.renderCodeSkeleton();
    this.hintEl.textContent = "Generating a secure pairing code…";
  }

  private renderQrSkeleton(): void {
    this.qrWrapEl.replaceChildren();
    const skeleton = document.createElement("span");
    skeleton.className = "cl-skeleton cl-qr-skeleton";
    skeleton.setAttribute("aria-label", "Generating QR code");
    this.qrWrapEl.appendChild(skeleton);
  }

  private renderCodeSkeleton(): void {
    this.codePillsEl.replaceChildren();
    for (let index = 0; index < 9; index++) {
      const skeleton = document.createElement("span");
      skeleton.className = "cl-pill cl-pill-skeleton cl-skeleton";
      skeleton.setAttribute("aria-hidden", "true");
      this.codePillsEl.appendChild(skeleton);
    }
  }

  private renderError(code: string, message: string): void {
    this.qrWrapEl.replaceChildren();
    this.codePillsEl.replaceChildren();

    const shortCode = String(code).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12) || "CL-P001";
    const wrap = document.createElement("div");
    wrap.className = "cl-qr-placeholder cl-error";
    const codeEl = document.createElement("div");
    codeEl.className = "cl-error-code";
    codeEl.textContent = shortCode;
    const details = document.createElement("button");
    details.type = "button";
    details.className = "cl-error-details-btn";
    details.textContent = "View details";
    details.addEventListener("click", () => this.openErrorModal(shortCode, message));
    wrap.append(codeEl, details);
    this.qrWrapEl.appendChild(wrap);
  }

  private openErrorModal(code: string, message: string): void {
    const backdrop = document.createElement("div");
    backdrop.className = "cl-connected-modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "cl-connected-modal cl-error-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "cl-modal-header";
    const title = document.createElement("h3");
    title.textContent = "Pairing error";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close error details");
    close.innerHTML = "&times;";
    close.addEventListener("click", () => backdrop.remove());
    header.append(title, close);

    const body = document.createElement("div");
    body.className = "cl-modal-body";
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    const messageEl = document.createElement("p");
    messageEl.textContent = message;
    body.append(codeEl, messageEl);
    modal.append(header, body);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    close.focus();
  }

  private renderExpiry(expiresAt?: number | string | null) {
    clearInterval(this.expiryTimer);
    if (!expiresAt) {
      this.hintEl.textContent = "";
      return;
    }

    if (typeof expiresAt === "string") {
      this.hintEl.textContent = expiresAt;
      return;
    }

    const updateCountdown = () => {
      const remainingSec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      if (remainingSec <= 0) {
        this.hintEl.textContent = "code expired — click refresh";
        clearInterval(this.expiryTimer);
      } else {
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;
        this.hintEl.textContent =
          mins > 0 ? `expires in ${mins}m ${secs}s` : `expires in ${secs}s`;
      }
    };

    updateCountdown();
    this.expiryTimer = setInterval(updateCountdown, 1000);
  }

  /**
   * Shows the routes the current QR advertises.
   *
   * Naming them is the honest version of a connectivity indicator: if the host
   * asked for remote access and the router said no, there is simply no `wan`
   * route in the list, and the note says why.
   */
  private renderRoutes(endpoints: PairingCardEndpoint[] | null, note: string | null): void {
    const el = this.routeSummaryEl;

    const labels: Record<PairingCardEndpoint["kind"], string> = {
      lan: "this network",
      wan: "the internet, directly",
      sig: "a signaling service",
      relay: "a relay service",
      tunnel: "a provider tunnel"
    };

    el.replaceChildren();
    const lines: string[] = [];
    if (endpoints && endpoints.length > 0) {
      lines.push(`Reachable over: ${endpoints.map((e) => labels[e.kind] ?? e.kind).join(", ")}.`);
    } else if (endpoints) {
      lines.push("This host currently advertises no route.");
    }
    if (note) lines.push(note);

    el.hidden = lines.length === 0;
    for (const line of lines) {
      const p = document.createElement("p");
      p.textContent = line;
      el.appendChild(p);
    }
  }

  private async handleRefresh() {
    if (this.options.onRefresh) {
      this.refreshBtn.disabled = true;
      try {
        await this.options.onRefresh();
      } finally {
        this.refreshBtn.disabled = false;
      }
    }
  }

  private async openConnectedDevicesModal(): Promise<void> {
    const endpoint = this.options.devicesEndpoint || "/api/devices";
    try {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`Failed to fetch devices: ${res.status}`);
      const data = await res.json();
      const devices: Array<{ deviceId: string; name: string; deviceType?: string; location?: string; ipAddress?: string; lastConnected?: number; firstPaired?: number; status?: string; trusted?: boolean; caps?: string[]; revokedAt?: number | null }> = (data.devices || data || []).filter((device: { revokedAt?: number | null }) => typeof device.revokedAt !== "number");
      this.renderConnectedDevicesModal(devices);
    } catch (err: any) {
      this.renderConnectedDevicesModal([], String(err?.message || err));
    }
  }

  private renderConnectedDevicesModal(devices: Array<any>, errorMsg?: string): void {
    // Remove existing modal if present
    const existingBackdrop = document.querySelector(".cl-connected-modal-backdrop");
    if (existingBackdrop) existingBackdrop.remove();

    // Create backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "cl-connected-modal-backdrop";
    backdrop.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:100;display:flex;align-items:center;justify-content:center;animation:clDropdownFade 0.15s ease-out;";

    // Create modal
    const modal = document.createElement("div");
    modal.className = "cl-connected-modal";
    
    // Modal header
    const header = document.createElement("div");
    header.className = "cl-modal-header";
    const title = document.createElement("h3");
    title.textContent = "Connected Devices";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", () => backdrop.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Modal body
    const body = document.createElement("div");
    body.className = "cl-modal-body";

    if (errorMsg) {
      const errorEl = document.createElement("div");
      errorEl.className = "cl-modal-error";
      errorEl.textContent = errorMsg;
      body.appendChild(errorEl);
    }

    if (devices.length === 0 && !errorMsg) {
      const emptyEl = document.createElement("p");
      emptyEl.style.cssText = "color:var(--cl-muted);text-align:center;padding:20px 0;";
      emptyEl.textContent = "No paired devices found.";
      body.appendChild(emptyEl);
    } else {
      for (const dev of devices) {
        const card = document.createElement("div");
        card.className = "cl-device-card";

        const statusText = dev.status || (dev.revokedAt ? "Revoked" : dev.lastConnected ? (Date.now() - dev.lastConnected < 300000 ? "Online" : "Offline") : "Unknown");
        const statusColor = statusText === "Online" ? "#4ade80" : statusText === "Revoked" ? "#f87171" : "#9a9a9a";
        const trustedText = dev.revokedAt ? "Not trusted" : "Trusted";
        const firstPaired = dev.firstPaired ? new Date(dev.firstPaired).toLocaleString() : "Unknown";
        const lastConnected = dev.lastConnected ? new Date(dev.lastConnected).toLocaleString() : "Never";

        const info = document.createElement("div");
        info.className = "cl-device-info";

        const name = document.createElement("div");
        name.className = "cl-device-name";
        name.textContent = dev.name || "Unnamed Device";

        const meta = document.createElement("div");
        meta.className = "cl-device-meta";
        meta.textContent = [dev.deviceType, dev.location].filter(Boolean).join(" \u2022 ");

        // Built as nodes rather than interpolated markup: every value below is
        // a device-supplied name or address, and one of them containing a tag
        // would otherwise execute in the desktop control page.
        const detail = document.createElement("div");
        detail.className = "cl-device-detail";
        const rows: Array<[string, string, string?]> = [
          ["Device ID", String(dev.deviceId ?? "")],
          ["IP", dev.ipAddress || "Not available"],
          ["First paired", firstPaired],
          ["Last connected", lastConnected],
          ["Status", statusText, statusColor],
          ["Trusted", trustedText]
        ];
        for (const [label, value, color] of rows) {
          const line = document.createElement("div");
          const strong = document.createElement("strong");
          strong.textContent = `${label}: `;
          const val = document.createElement("span");
          val.textContent = value;
          if (color) val.style.cssText = `color:${color};font-weight:600;`;
          line.append(strong, val);
          detail.appendChild(line);
        }

        info.appendChild(name);
        info.appendChild(meta);
        info.appendChild(detail);

        const actions = document.createElement("div");
        actions.className = "cl-device-actions";
        
        const revokeBtn = document.createElement("button");
        revokeBtn.className = "cl-revoke-btn";
        revokeBtn.textContent = "Revoke Access";
        revokeBtn.addEventListener("click", async () => {
          revokeBtn.disabled = true;
          revokeBtn.textContent = "Revoking...";
          try {
            const revokeEndpoint = this.options.revokeEndpoint || "/api/revoke";
            const res = await fetch(revokeEndpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ deviceId: dev.deviceId })
            });
            const result = await res.json().catch(() => null) as { ok?: boolean } | null;
            if (!res.ok || result?.ok !== true) throw new Error("Revoke failed");
            card.remove();
          } catch (e: any) {
            revokeBtn.textContent = "Failed";
            revokeBtn.style.background = "#7f1d1d";
          }
        });
        actions.appendChild(revokeBtn);

        card.appendChild(info);
        card.appendChild(actions);
        body.appendChild(card);
      }
    }

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Close on backdrop click
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
      }
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.refreshQueued = false;
    clearInterval(this.expiryTimer);
    this.clearRefreshTimer();
    this.unsubscribeSource?.();
    this.unsubscribeSource = null;
    this.element.remove();
  }
}

/**
 * Maps whatever a host reports into one of the four supported modes.
 *
 * Older builds persisted names like `open-lan-remote` and `ngrok` in
 * localStorage; those are folded onto their nearest current meaning so an
 * upgraded app does not start with a broken selection.
 */
export function normalizeNetworkMode(mode: string | undefined | null): NetworkMode {
  switch (mode) {
    case "local":
    case "local-only":
      return "local-only";
    case "lan-and-relay":
    case "relay":
      return "lan-and-relay";
    case "remote":
    case "open-lan":
    case "open-lan-remote":
      return "remote";
    // ngrok/cloudflared were provider tunnels, which are now an opt-in host
    // configuration rather than a mode the user picks in the browser.
    case "ngrok":
    case "cloudflare":
    case "cloudflared":
    case "open-lan-cloudflared":
      return "auto";
    default:
      return "auto";
  }
}

/** Convenience factory for creating a pairing card */
export function createPairingCard(options: PairingCardOptions = {}): PairingCard {
  return new PairingCard(options);
}
