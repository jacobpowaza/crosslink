import {
  resolveCrosslinkTheme,
  CROSSLINK_REPOSITORY,
  CROSSLINK_ATTRIBUTION_TEXT,
  CROSSLINK_ATTRIBUTION_LINK_TEXT
} from "./branding.js";

/**
 * The Crosslink attribution footer shown on Crosslink-owned mobile screens.
 *
 * It participates in normal layout flow. It is not a floating badge, overlay,
 * capsule or reserved layer: applications get a quiet full-width footer with a
 * separator, centered text, and the shared Crosslink attribution wording.
 * Colour defaults come from the shared brand resolver, so the footer lands on
 * the right side of the WCAG contrast floor against whatever background the
 * application configured.
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
  /** @deprecated The attribution is always rendered as a normal flow footer. */
  placement?: PoweredByPlacement;
  /** Footer block padding. */
  offset?: string | number;
  /** Optional footer background. */
  background?: string;
  /** Optional extra class for application-specific styling. */
  className?: string;
  /** @deprecated The attribution no longer uses fixed positioning. */
  zIndex?: number;
  /** Application accent, used to tint the mark. */
  accentColor?: string;
  /** Background the footer sits on, used for the contrast correction. */
  backgroundColor?: string;
  /** @deprecated The footer is text-only. */
  logoWidth?: string | number;
}

function cssLength(value: string | number | undefined, fallback: string): string {
  if (typeof value === "number") return `${value}px`;
  return value || fallback;
}

/**
 * Small reusable attribution footer shown by Crosslink mobile bootstrap applications.
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
    const offset = cssLength(this.options.offset, "10px");
    const size = cssLength(this.options.size, "11px");
    const brand = resolveCrosslinkTheme({
      accentColor: this.options.accentColor,
      backgroundColor: this.options.backgroundColor ?? this.options.background
    });

    this.element.className = `cl-crosslink-attribution-footer${this.options.className ? ` ${this.options.className}` : ""}`;
    this.element.style.cssText = [
      "width:100%",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "gap:.35em",
      "flex-shrink:0",
      `padding:${offset} 16px`,
      "border-top:1px solid rgba(148,163,184,.24)",
      `background:${this.options.background ?? "transparent"}`,
      `color:${this.options.color ?? brand.attributionColor}`,
      `font:${size}/1.2 system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif`,
      "text-align:center",
      "white-space:normal",
      "box-sizing:border-box"
    ].join(";");
    this.element.textContent = "";

    const prefix = document.createElement("span");
    prefix.textContent = `${this.options.text ?? CROSSLINK_ATTRIBUTION_TEXT} `;

    const link = document.createElement("a");
    link.href = CROSSLINK_REPOSITORY;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", CROSSLINK_ATTRIBUTION_LINK_TEXT);
    link.style.cssText = "color:inherit;font-weight:600;text-decoration:none";
    link.textContent = this.options.linkText ?? CROSSLINK_ATTRIBUTION_LINK_TEXT;

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
