/**
 * Canonical reusable Crosslink Pairing Widget (CrosslinkConnect).
 *
 * Provides a standardized, brand-consistent 3-column pairing card:
 * [ App Logo & Blurb ] | [ Scan QR ] | [ Pairing Code Pills ]
 *
 * Includes a Settings Cog with 3 connection modes:
 *   1. Open LAN + Relay (Remote) with security info knob & hyperlink
 *   2. Local network only (for local Wi-Fi subnet only)
 *   3. ngrok setup (with setup tooltip/guide)
 *
 * Fully customizable via options and CSS custom properties:
 *   --cl-bg, --cl-fg, --cl-muted, --cl-divider, --cl-pill, --cl-pill-text, --cl-radius
 */

export interface PairingCardTheme {
  bg?: string;
  fg?: string;
  muted?: string;
  divider?: string;
  pill?: string;
  pillText?: string;
  radius?: string;
}

export type NetworkMode = "local" | "ngrok" | "open-lan" | "cloudflare" | "local-only" | "open-lan-remote" | "open-lan-cloudflared";

export interface PairingCardOptions {
  /** Target DOM container element or selector to mount into */
  target?: HTMLElement | string;
  /** Application or framework name (e.g. "Crosslink Notes", "Crosslink Chat") */
  appName?: string;
  /** Informational blurb describing security and app pairing */
  blurb?: string;
  /** URL or inline SVG for the logo. Defaults to Crosslink mark */
  logo?: string;
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
  /** ngrok guide hyperlink */
  ngrokGuideUrl?: string;
  /** Cloudflare guide hyperlink */
  cloudflareGuideUrl?: string;
  /** Custom theme color overrides */
  theme?: PairingCardTheme;
  /** Whether to inject default CSS styles into document head. Default true */
  injectStyles?: boolean;
}

export interface PairingCardState {
  code?: string | null;
  qr?: string | null;
  expiresAt?: number | string | null;
  error?: string | null;
  loading?: boolean;
  networkMode?: NetworkMode;
}

const DEFAULT_CROSSLINK_SVG = `
<svg viewBox="105 363 1060 222" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z" fill="currentColor" fill-rule="evenodd"/>
</svg>
`.trim();

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
  gap: 28px;
  box-sizing: border-box;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  text-align: left;
}
.cl-pair-card * {
  box-sizing: border-box;
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
  background: #0b1329;
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
  margin-bottom: 14px;
  color: var(--cl-fg);
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
.cl-pair-code-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
  min-height: 44px;
  align-items: center;
}
.cl-pair-code-pills .cl-pill {
  background: var(--cl-pill);
  color: var(--cl-pill-text);
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  border-radius: 999px;
  padding: 12px 6px;
  min-width: 32px;
  text-align: center;
  display: inline-block;
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
  private currentMode: NetworkMode;
  private expiryTimer: any = null;

  constructor(options: PairingCardOptions = {}) {
    this.options = options;
    this.currentMode = options.networkMode || "local";

    if (options.injectStyles !== false) {
      injectPairingCardStyles();
    }

    this.element = document.createElement("div");
    this.element.className = "cl-pair-card";

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
    this.renderLogo(options.logo);

    this.blurbEl = document.createElement("p");
    this.blurbEl.className = "cl-pair-blurb";
    this.blurbEl.innerHTML =
      options.blurb ??
      `<strong>Connect your phone</strong> to sync securely with this app. The link is end-to-end encrypted &mdash; relays only ever see ciphertext.`;

    this.refreshBtn = document.createElement("button");
    this.refreshBtn.className = "cl-pair-refresh";
    this.refreshBtn.textContent = "Refresh code";
    this.refreshBtn.addEventListener("click", () => this.handleRefresh());

    left.appendChild(this.logoEl);
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

    right.appendChild(codeLabel);
    right.appendChild(this.codePillsEl);
    right.appendChild(this.hintEl);

    // Assemble Card
    this.element.appendChild(cogBtn);
    this.element.appendChild(this.settingsPopover);
    this.element.appendChild(left);
    this.element.appendChild(div1);
    this.element.appendChild(center);
    this.element.appendChild(div2);
    this.element.appendChild(right);

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
  }

  private normalizeMode(mode: string): "local" | "ngrok" | "open-lan" | "cloudflare" {
    if (mode === "local" || mode === "local-only") return "local";
    if (mode === "ngrok") return "ngrok";
    if (mode === "open-lan" || mode === "open-lan-remote" || mode === "remote") return "open-lan";
    if (mode === "cloudflare" || mode === "open-lan-cloudflared" || mode === "cloudflared") return "cloudflare";
    return "local";
  }

  private createSettingsPopover(): HTMLElement {
    const pop = document.createElement("div");
    pop.className = "cl-settings-dropdown";
    pop.hidden = true;

    const cfUrl = this.options.cloudflareGuideUrl || "https://crosslink.dev/docs/connection-modes#cloudflared";
    const secUrl = this.options.securityGuideUrl || "https://crosslink.dev/docs/connection-modes#remote";
    const lanUrl = this.options.lanGuideUrl || "https://crosslink.dev/docs/connection-modes#local";
    const ngrokUrl = this.options.ngrokGuideUrl || "https://crosslink.dev/docs/connection-modes#ngrok";
    const norm = this.normalizeMode(this.currentMode);

    pop.innerHTML = `
      <div class="cl-dropdown-header">Connection Mode</div>
      
      <!-- Option 1: Local (Default) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="local" ${norm === "local" ? "checked" : ""}>
          <span>Local</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">ℹ</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Direct peer connection on your local Wi-Fi or LAN subnet. Zero internet dependency.<br>
            <strong>Security:</strong> Direct local link with XChaCha20-Poly1305 E2E encryption.
            <a href="${lanUrl}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Option 2: ngrok -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="ngrok" ${norm === "ngrok" ? "checked" : ""}>
          <span>ngrok</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">ℹ</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Routes traffic through your personal ngrok tunnel with custom auth tokens and domains.<br>
            <strong>Security:</strong> TLS tunnel edge with Crosslink E2E ciphertext encryption.
            <a href="${ngrokUrl}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Option 3: Open Lan (Remote) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="open-lan" ${norm === "open-lan" ? "checked" : ""}>
          <span>Open Lan (Remote)</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">ℹ</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> Uses your public WAN IP with automatic router port mapping (UPnP / NAT-PMP / PCP). If no mapping exists, falls back to LAN. Only displays a public QR after verifying reachability.<br>
            <strong>Security:</strong> End-to-end encrypted (XChaCha20-Poly1305). Only ciphertext travels over public internet.
            <a href="${secUrl}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>

      <!-- Option 4: Open Lan (Cloudflared) -->
      <label class="cl-dropdown-item">
        <div class="cl-dropdown-label">
          <input type="radio" name="cl-net-mode" value="cloudflare" ${norm === "cloudflare" ? "checked" : ""}>
          <span>Open Lan (Cloudflared)</span>
        </div>
        <div class="cl-info-knob-wrap">
          <button type="button" class="cl-info-knob" aria-label="Info">ℹ</button>
          <div class="cl-dropdown-tooltip">
            <strong>How it works:</strong> 0-cost Cloudflare Quick Tunnel. Skips "Add to Home Screen" — scan and chat immediately in mobile browser.<br>
            <strong>Security:</strong> Cloudflare TLS edge termination with Crosslink E2E ciphertext security.
            <a href="${cfUrl}" target="_blank" rel="noopener noreferrer">Documentation &rarr;</a>
          </div>
        </div>
      </label>
    `;

    const radios = pop.querySelectorAll('input[name="cl-net-mode"]');
    radios.forEach((r: any) => {
      r.addEventListener("change", (e: any) => {
        const mode = e.target.value as NetworkMode;
        this.setNetworkMode(mode);
      });
    });

    return pop;
  }

  toggleSettings(open?: boolean): void {
    const isHidden = this.settingsPopover.hidden;
    const shouldOpen = open !== undefined ? open : isHidden;
    this.settingsPopover.hidden = !shouldOpen;
  }

  setNetworkMode(mode: NetworkMode): void {
    this.currentMode = mode;
    const norm = this.normalizeMode(mode);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("crosslink.networkMode", mode);
      }
    } catch {}

    const radio = this.settingsPopover.querySelector(`input[value="${norm}"]`) as HTMLInputElement | null;
    if (radio) radio.checked = true;

    if (this.options.onNetworkModeChange) {
      this.options.onNetworkModeChange(mode);
    }
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
      this.qrWrapEl.innerHTML = '<span class="cl-qr-placeholder">Generating&hellip;</span>';
      this.refreshBtn.disabled = true;
    } else {
      this.refreshBtn.disabled = false;
    }

    if (state.networkMode) {
      this.setNetworkMode(state.networkMode);
    }

    if (state.error) {
      this.qrWrapEl.innerHTML = `<span class="cl-qr-placeholder cl-error">${state.error}</span>`;
      this.codePillsEl.replaceChildren();
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

  private renderLogo(logo?: string) {
    this.logoEl.replaceChildren();
    if (!logo) {
      this.logoEl.innerHTML = DEFAULT_CROSSLINK_SVG;
      const svg = this.logoEl.querySelector("svg");
      if (svg) svg.classList.add("cl-pair-logo");
    } else if (logo.trim().startsWith("<svg")) {
      this.logoEl.innerHTML = logo;
      const svg = this.logoEl.querySelector("svg");
      if (svg) svg.classList.add("cl-pair-logo");
    } else {
      const img = document.createElement("img");
      img.src = logo;
      img.alt = "Crosslink";
      img.className = "cl-pair-logo";
      this.logoEl.appendChild(img);
    }
  }

  private renderQr(qr?: string | null) {
    this.qrWrapEl.replaceChildren();
    if (!qr) {
      const placeholder = document.createElement("span");
      placeholder.className = "cl-qr-placeholder";
      placeholder.textContent = "Generating…";
      this.qrWrapEl.appendChild(placeholder);
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

  destroy(): void {
    clearInterval(this.expiryTimer);
    this.element.remove();
  }
}

/** Convenience factory for creating a pairing card */
export function createPairingCard(options: PairingCardOptions = {}): PairingCard {
  return new PairingCard(options);
}
