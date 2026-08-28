/**
 * Crosslink brand assets and theming primitives — the single source of truth
 * for the Crosslink identity rendered by every Crosslink-owned screen.
 *
 * The mark is an SVG filled with `currentColor`, so it takes the colour of the
 * Crosslink surface around it. That is how an application accent tints the logo
 * without anybody shipping a recoloured copy: `resolveCrosslinkTheme` derives a
 * logo colour from the accent and then lifts it until it clears the WCAG
 * contrast floor for graphical objects against the surface behind it.
 *
 * Nothing here can remove the mark or the attribution. The helpers always
 * return a logo and always return attribution text; only colour, size and
 * placement are configurable.
 */

/** `viewBox` of the Crosslink wordmark. */
export const CROSSLINK_LOGO_VIEWBOX = "105 363 1060 222";

/** Path data of the Crosslink wordmark. Always filled with `currentColor`. */
export const CROSSLINK_LOGO_PATH =
  "M233.73 383.42C254.47 380.94 275.68 386.3 293.3 397.22C298.36 400.36 310.34 407.06 306.92 414.39C305.05 418.41 299.18 424.66 294.5 424.16C290.7 423.75 283.6 416.8 279.92 414.57C271.58 409.53 262.05 406.61 252.45 405.27C210.49 399.39 171.23 433.96 172.83 476.5C174.51 521.08 215.67 550.01 258.38 541.73C267.91 539.88 276.87 535.81 284.85 530.38C288.81 527.68 292.08 522.77 297.47 523.95C299.49 524.39 307.14 531.68 307.85 533.67C308.39 535.19 308.34 536.9 307.92 538.44C307.04 541.58 302.8 544.02 300.34 545.88C285.61 557.02 267.9 563.4 249.5 564.79C194.73 568.93 147.61 523.68 151.02 468.5C152.07 451.5 158.16 436.04 167.48 421.97C173.81 412.42 182.42 403.72 192.26 397.74C205.14 389.9 218.77 385.21 233.73 383.42ZM791.59 387.27C795.36 386.55 802.6 386.03 805.44 389.07C807.56 391.34 807.21 394.63 807.24 397.5C807.3 404.17 807.27 410.83 807.25 417.5C807.15 451.5 807.23 485.5 807.25 519.5C807.26 529.5 807.29 539.5 807.27 549.5C807.26 554.33 807.43 559.18 801.47 559.66C797.97 559.94 791 560.91 788.25 558.23C786.05 556.09 786.66 552.28 786.64 549.5C786.6 542.17 786.66 534.83 786.64 527.5C786.54 494.5 786.59 461.5 786.65 428.5C786.67 418.17 786.7 407.83 786.62 397.5C786.59 393.48 786.61 388.22 791.59 387.27ZM1047.5 490.33C1049.96 490.3 1052.92 490.63 1055.26 489.73C1058.8 488.37 1065.75 479.23 1068.61 476.12C1077.64 466.3 1086.84 456.19 1096.5 447C1100.43 443.26 1119.54 442.69 1123.5 445.8C1123.66 451.35 1115.32 457.13 1111.53 461.04C1099.51 473.43 1087.04 485.6 1075.57 498.5C1077.87 503.34 1082.73 507.17 1086.35 511.17C1095.38 521.13 1104.32 531.19 1113.52 541C1115.75 543.37 1125.96 553.61 1126.66 555.81C1127.01 556.89 1126.75 557.43 1126.8 558.5C1123.25 560.55 1118.53 559.73 1114.5 559.69C1110.76 559.66 1106.1 560.51 1102.63 558.88C1098.64 557 1095.59 552.04 1092.65 548.84C1085.62 541.2 1078.7 533.45 1071.74 525.76C1063.43 516.58 1060.8 509.28 1046.79 512.5C1044.96 522.02 1046.59 534.66 1046.57 544.5C1046.57 548.23 1047.48 553.75 1045.59 557.14C1043.49 560.88 1026.82 562.35 1025.95 554.5C1024.58 542.11 1025.96 527.16 1025.95 514.5C1025.94 486.17 1025.87 457.83 1025.93 429.5C1025.95 418.83 1025.94 408.17 1025.9 397.5C1025.89 393.57 1025.68 388.29 1030.61 387.24C1032.49 386.84 1034.59 387.09 1036.5 387.09C1038.56 387.1 1040.88 386.81 1042.81 387.66C1048.5 390.17 1046.49 406.98 1046.51 412.56C1046.56 430.21 1046.47 447.85 1046.53 465.5C1046.56 473.31 1045.12 482.95 1047.5 490.33ZM844.74 395.34C862.3 390.41 870.21 415.48 853.62 421.22C835.59 427.47 827.09 400.31 844.74 395.34ZM463.67 441.41C471.92 440.68 480.11 442.01 487.94 444.53C494.65 446.69 500.51 450.23 506.18 454.35C510.98 457.84 514.79 462.48 518.32 467.22C546.74 505.4 518.83 560.06 472.5 563.08C464.08 563.63 455.77 562.3 447.8 559.63C440.61 557.23 433.85 553.39 428.12 548.4C387.12 512.7 410.35 446.13 463.67 441.41ZM938.73 441.43C964.07 438.8 988.77 454.5 996.81 478.63C1001.03 491.31 999.84 505.34 999.82 518.5C999.8 528.5 999.67 538.5 999.8 548.5C999.85 552.1 1000.71 557.37 996.66 559.21C994.79 560.06 992.49 559.69 990.5 559.67C987.56 559.65 983.54 560.44 981.08 558.44C978.66 556.48 979.13 553.29 979.15 550.5C979.17 544.5 979.16 538.5 979.16 532.5C979.15 506.82 985.32 474.05 954.7 463.73C950.67 462.38 946.75 461.96 942.5 462.04C938.21 462.13 934.22 463.12 930.27 464.75C909.54 473.31 908.83 490.84 908.83 510.5C908.83 519.5 908.79 528.5 908.78 537.5C908.78 543.14 909.77 549.73 908.6 555.26C907.36 561.17 892.64 561.43 889.51 557.98C887.34 555.6 888.08 551.45 888.05 548.5C887.98 539.83 888.06 531.17 888.07 522.5C888.08 510.07 886.92 496.94 889.34 484.69C894.17 460.27 914.52 443.93 938.73 441.43ZM370.81 444.44C378.29 443.39 385.96 443.92 393.5 443.91C396.8 443.91 400.83 443.49 403.26 446.23C405.44 448.69 404.78 452.49 404.76 455.5C404.75 457.24 404.95 459.11 404.32 460.76C401.95 466.94 387.89 464.88 382.5 464.89C368.82 464.9 356.04 469.36 350.54 483.06C345.38 495.93 347.67 523.81 347.69 538.5C347.7 543.73 349 550.79 347.34 555.78C345.69 560.75 334.22 560.97 330.2 559.33C326.24 557.72 327 552.92 327 549.5C327 540.5 326.98 531.5 327 522.5C327.02 510.28 326.04 497.62 328.16 485.54C331.95 463.92 349.33 447.47 370.81 444.44ZM632.82 448.5C630.99 452.96 625.86 456.37 622.98 460.46C622.01 461.84 620.99 464.11 619.29 464.68C614.01 466.44 601.31 464.28 594.65 465.33C578.59 467.86 566.31 480.49 563.75 496.48C562.92 501.66 563.12 506.77 564.57 511.83C566.29 517.82 569.39 523.27 573.67 527.82C584.18 538.98 597.17 538.99 611.5 539.08C626.5 539.17 640.93 539.33 651.61 527.14C656.22 521.88 659.71 515.44 660.73 508.46C661.28 504.62 660.22 499.75 661.65 496.17C663.77 490.82 677.12 490.22 680.29 494.22C682.78 497.37 681.9 502.8 681.67 506.5C680.91 518.95 675.64 530.73 667.69 540.21C651.84 559.1 633.43 559.88 610.5 559.75C595.85 559.66 582.93 559.16 570.01 551.47C529.05 527.1 536.59 463.2 580.88 447.43C593.12 443.07 605.72 444 618.5 443.95C623.82 443.92 630.4 442.77 632.82 448.5ZM672.17 556.5C672.3 555.53 672.1 554.9 672.51 553.96C673.37 551.95 676.41 550 677.9 548.38C680.43 545.62 682.15 542.33 684.5 539.46C697.35 538.01 711.53 541.69 723.35 534.86C748.05 520.57 750.19 485.59 725.32 470.15C716.44 464.64 706.56 464.92 696.5 464.91C681.72 464.89 667.28 463.66 655.36 473.89C648.93 479.41 644.84 487.35 643.27 495.62C642.39 500.25 644.05 506.55 640.99 510.49C636.17 516.71 623.36 514.7 622.14 506.47C618.6 482.48 637.65 455.23 659.96 447.48C671.89 443.34 684.08 443.97 696.5 443.96C712.53 443.94 727.02 445.31 740.35 455.09C776.51 481.63 768.28 540.25 726.62 556.17C714.11 560.95 700.63 559.64 687.5 559.74C682.23 559.78 675.73 561.11 672.17 556.5ZM843.71 444.37C848.02 443.53 856.53 442.92 858.52 447.96C860.51 453 859.14 467.45 859.13 473.5C859.09 492.83 859.08 512.17 859.13 531.5C859.15 538.17 859.16 544.83 859.1 551.5C859.07 555.16 858.76 558.98 854.37 559.61C850.62 560.16 841.54 561.12 839.26 557.25C836.93 553.29 838.56 539.46 838.55 534.5C838.47 514.17 838.44 493.83 838.52 473.5C838.55 467.55 837.15 452.54 839.22 447.7C839.97 445.93 841.87 444.73 843.71 444.37ZM461.77 462.42C418.77 469.25 416.23 530.16 458.13 541.44C464.19 543.07 470.34 543.03 476.49 541.92C517.97 534.45 519.66 475.76 479.83 463.58C474.06 461.82 467.74 461.46 461.77 462.42Z";

/** Where the attribution link points. */
export const CROSSLINK_REPOSITORY = "https://github.com/jacobpowaza/crosslink";

/** Attribution wording. Not configurable — every Crosslink screen says this. */
export const CROSSLINK_ATTRIBUTION_TEXT = "Powered by";
export const CROSSLINK_ATTRIBUTION_LINK_TEXT = "Crosslink";

/**
 * The whole of what an application may say about how Crosslink-owned screens
 * look. There is intentionally no slot for markup, templates or renderers: an
 * application supplies its name, its icon and a few colours, and Crosslink
 * renders the same pairing, bootstrap, install, offline and revoked screens it
 * renders everywhere else.
 */
export interface CrosslinkTheme {
  /** Application name shown as the screen's title. */
  appName?: string;
  /** URL (or data URI) of the application icon. */
  appIcon?: string;
  /** Application accent, used for actions and to tint the Crosslink mark. */
  accentColor?: string;
  /** Page background behind Crosslink-owned screens. */
  backgroundColor?: string;
  /** Primary text colour. Derived from the background when omitted. */
  textColor?: string;
  /** Forces a palette instead of deriving one from `backgroundColor`. */
  appearance?: "light" | "dark" | "auto";
}

export interface ResolvedCrosslinkTheme {
  appName: string;
  appIcon: string | null;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  mutedColor: string;
  dividerColor: string;
  /** Colour the Crosslink mark is drawn in — accent, lifted for contrast. */
  logoColor: string;
  /** Colour the attribution text is drawn in. */
  attributionColor: string;
  appearance: "light" | "dark";
}

const DEFAULT_ACCENT = "#38bdf8";
const DEFAULT_DARK_BG = "#0b1120";
const DEFAULT_LIGHT_BG = "#ffffff";

/** WCAG 2.1 minimum contrast for a graphical object such as the logo. */
export const LOGO_MIN_CONTRAST = 3;
/** WCAG 2.1 minimum contrast for the attribution, which is small body text. */
export const ATTRIBUTION_MIN_CONTRAST = 4.5;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parses `#rgb`, `#rrggbb`, `#rrggbbaa` and `rgb()/rgba()`.
 *
 * Anything else — a named colour, a gradient, a CSS variable — returns null,
 * and callers fall back to a palette default rather than compute a contrast
 * ratio against a colour they could not read.
 */
export function parseColor(input: string | undefined | null): Rgb | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .slice(0, 3)
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (digits.length < 6) return null;
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16)
    };
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) {
    return {
      r: Math.min(255, Math.max(0, Number(rgb[1]))),
      g: Math.min(255, Math.max(0, Number(rgb[2]))),
      b: Math.min(255, Math.max(0, Number(rgb[3])))
    };
  }
  return null;
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (max). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount
  };
}

/**
 * Moves `color` towards white or black — whichever direction the background is
 * further from — until it clears `minRatio` against that background.
 *
 * An application accent that happens to sit close to its own background would
 * otherwise render the Crosslink mark as a barely visible smudge. Rather than
 * refuse the accent, Crosslink keeps its hue and lifts it, which preserves the
 * brand relationship the application asked for and stays readable.
 */
export function ensureContrast(color: Rgb, background: Rgb, minRatio: number): Rgb {
  if (contrastRatio(color, background) >= minRatio) return color;
  const towards: Rgb =
    relativeLuminance(background) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  let best = color;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(color, towards, step / 20);
    best = candidate;
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return best;
}

/**
 * Resolves the application's branding metadata into the complete token set the
 * Crosslink screens draw with.
 *
 * Every field has a Crosslink default, so an application that configures
 * nothing still gets the standard experience; and every colour that carries
 * brand meaning — the mark, the attribution — is contrast-checked here rather
 * than at each call site.
 */
export function resolveCrosslinkTheme(theme: CrosslinkTheme = {}): ResolvedCrosslinkTheme {
  const requestedBg = parseColor(theme.backgroundColor);
  const appearance: "light" | "dark" =
    theme.appearance === "light" || theme.appearance === "dark"
      ? theme.appearance
      : requestedBg
        ? relativeLuminance(requestedBg) > 0.4
          ? "light"
          : "dark"
        : "dark";

  const background =
    requestedBg ?? parseColor(appearance === "light" ? DEFAULT_LIGHT_BG : DEFAULT_DARK_BG)!;
  const accent = parseColor(theme.accentColor) ?? parseColor(DEFAULT_ACCENT)!;
  const text =
    parseColor(theme.textColor) ??
    (appearance === "light" ? { r: 15, g: 23, b: 42 } : { r: 226, g: 232, b: 240 });

  const surface = mix(background, appearance === "light" ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, 0.06);
  const muted = mix(text, background, 0.42);
  const divider = mix(background, text, 0.18);

  return {
    appName: theme.appName?.trim() || "This app",
    appIcon: theme.appIcon?.trim() || null,
    accentColor: toHex(accent),
    backgroundColor: toHex(background),
    surfaceColor: toHex(surface),
    textColor: toHex(text),
    mutedColor: toHex(muted),
    dividerColor: toHex(divider),
    logoColor: toHex(ensureContrast(accent, background, LOGO_MIN_CONTRAST)),
    attributionColor: toHex(ensureContrast(muted, background, ATTRIBUTION_MIN_CONTRAST)),
    appearance
  };
}

export interface CrosslinkLogoOptions {
  /** CSS width. A number is treated as pixels. Default `140px`. */
  width?: string | number;
  /** Explicit colour. Defaults to `currentColor` so the surface decides. */
  color?: string;
  /** Extra class on the `<svg>`. */
  className?: string;
  /** Extra inline styles appended after the defaults. */
  style?: string;
  /** Accessible name. Default "Crosslink". */
  title?: string;
}

function cssSize(value: string | number | undefined, fallback: string): string {
  if (typeof value === "number") return `${value}px`;
  return value || fallback;
}

/**
 * Renders the Crosslink wordmark as an SVG string.
 *
 * It is `role="img"` with a `<title>` rather than a decorative graphic: on the
 * offline and revoked screens the mark is the only thing naming what is trying
 * to reconnect, so a screen reader has to reach it.
 */
export function crosslinkLogoSvg(options: CrosslinkLogoOptions = {}): string {
  const width = cssSize(options.width, "140px");
  const style = `width:${width};height:auto;display:block;${options.color ? `color:${options.color};` : ""}${options.style ?? ""}`;
  const className = options.className ? ` class="${options.className}"` : "";
  const title = options.title ?? "Crosslink";
  return [
    `<svg viewBox="${CROSSLINK_LOGO_VIEWBOX}" fill="none" xmlns="http://www.w3.org/2000/svg"`,
    ` role="img" aria-label="${title}"${className} style="${style}">`,
    `<title>${title}</title>`,
    `<path d="${CROSSLINK_LOGO_PATH}" fill="currentColor" fill-rule="evenodd"/>`,
    `</svg>`
  ].join("");
}

/** Builds the wordmark as a live DOM node. */
export function createCrosslinkLogo(options: CrosslinkLogoOptions = {}): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "cl-logo-holder";
  holder.style.cssText = "display:inline-flex;align-items:center";
  holder.innerHTML = crosslinkLogoSvg(options);
  return holder;
}
