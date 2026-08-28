import {
  crosslinkLogoSvg,
  resolveCrosslinkTheme,
  CROSSLINK_REPOSITORY,
  CROSSLINK_ATTRIBUTION_TEXT,
  CROSSLINK_ATTRIBUTION_LINK_TEXT
} from "./branding.js";

/**
 * The Crosslink attribution badge shown on Crosslink-owned mobile screens.
 *
 * It renders the mark and the wording together and offers no option that
 * removes either: an application chooses colour, size and placement, and the
 * attribution is what is left. Colour defaults come from the shared brand
 * resolver, so the badge lands on the right side of the WCAG contrast floor
 * against whatever background the application configured.
 */
export type PoweredByPlacement =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "inline";

export interface PoweredByCrosslinkOptions {
  /** Container or selector to mount into. Defaults to document.body. */
  target?: HTMLElement | string;
  /** Text before the Crosslink link. */
  text?: string;
  /** Linked product name. */
  linkText?: string;
  /** Optional text after the link. */
  suffix?: string;
  /** CSS color for the attribution. */
  color?: string;
  /** Any CSS font-size value, or a pixel number. */
  size?: string | number;
  /** Screen placement, or `inline` to participate in the target's layout. */
  placement?: PoweredByPlacement;
  /** Distance from the selected screen edges. */
  offset?: string | number;
  /** Optional background behind the attribution. */
  background?: string;
  /** Optional extra class for application-specific styling. */
  className?: string;
  /** Stacking order for fixed placements. */
  zIndex?: number;
  /** Application accent, used to tint the mark. */
  accentColor?: string;
  /** Background the badge sits on, used for the contrast correction. */
  backgroundColor?: string;
  /** Height of the mark. Default scales with `size`. */
  logoWidth?: string | number;
}

function cssLength(value: string | number | undefined, fallback: string): string {
  if (typeof value === "number") return `${value}px`;
  return value || fallback;
}

/**
 * Small reusable attribution shown by Crosslink mobile bootstrap applications.
 * It is also exported for apps that own their lifecycle UI directly.
 */
export class PoweredByCrosslink {
  readonly element: HTMLElement;
  private options: PoweredByCrosslinkOptions;

  constructor(options: PoweredByCrosslinkOptions = {}) {
    this.options = options;
    this.element = document.createElement("div");
    this.render();
    if (options.target) this.mount(options.target);
  }

  mount(target: HTMLElement | string = document.body): this {
    const container = typeof target === "string" ? document.querySelector(target) : target;
    if (!container) throw new Error(`PoweredByCrosslink target not found: ${String(target)}`);
    if (this.element.parentElement !== container) container.appendChild(this.element);
    return this;
  }

  update(options: Partial<PoweredByCrosslinkOptions>): this {
    this.options = { ...this.options, ...options };
    this.render();
    return this;
  }

  destroy(): void {
    this.element.remove();
  }

  private render(): void {
    const placement = this.options.placement ?? "bottom-center";
    const offset = cssLength(this.options.offset, "8px");
    const size = cssLength(this.options.size, "11px");
    const position: string[] = [];

    if (placement !== "inline") {
      position.push("position:fixed", `z-index:${this.options.zIndex ?? 100002}`);
      if (placement.startsWith("top")) position.push(`top:calc(${offset} + env(safe-area-inset-top))`);
      else position.push(`bottom:calc(${offset} + env(safe-area-inset-bottom))`);
      if (placement.endsWith("left")) position.push(`left:${offset}`);
      else if (placement.endsWith("right")) position.push(`right:${offset}`);
      else position.push("left:50%", "transform:translateX(-50%)");
    }

    this.element.className = `cl-powered-by-crosslink${this.options.className ? ` ${this.options.className}` : ""}`;
    this.element.style.cssText = [
      ...position,
      "display:inline-flex",
      "align-items:center",
      "gap:.32em",
      "max-width:calc(100vw - 24px)",
      "padding:4px 7px",
      "border-radius:999px",
      `background:${this.options.background ?? "rgba(0,0,0,.58)"}`,
      `color:${this.options.color ?? "#94a3b8"}`,
      `font:${size}/1.2 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif`,
      "white-space:nowrap",
      "box-sizing:border-box"
    ].join(";");
    this.element.textContent = "";

    const brand = resolveCrosslinkTheme({
      accentColor: this.options.accentColor,
      backgroundColor: this.options.backgroundColor ?? this.options.background
    });

    const prefix = document.createElement("span");
    prefix.textContent = this.options.text ?? CROSSLINK_ATTRIBUTION_TEXT;

    // The linked element is the wordmark itself, so the badge carries the
    // Crosslink identity rather than only its name. The SVG is labelled, which
    // is what keeps the link readable to a screen reader; the text fallback
    // below covers the case where the mark cannot be drawn at all.
    const link = document.createElement("a");
    link.href = CROSSLINK_REPOSITORY;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", CROSSLINK_ATTRIBUTION_LINK_TEXT);
    link.style.cssText = "color:inherit;display:inline-flex;align-items:center;text-decoration:none";
    link.innerHTML = crosslinkLogoSvg({
      width: cssLength(this.options.logoWidth, "58px"),
      color: this.options.accentColor ? brand.logoColor : undefined,
      title: CROSSLINK_ATTRIBUTION_LINK_TEXT
    });

    this.element.append(prefix, link);
    if (this.options.suffix) {
      const suffix = document.createElement("span");
      suffix.textContent = this.options.suffix;
      this.element.appendChild(suffix);
    }
  }
}

export function createPoweredByCrosslink(options: PoweredByCrosslinkOptions = {}): PoweredByCrosslink {
  return new PoweredByCrosslink(options);
}
