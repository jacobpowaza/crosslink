// @vitest-environment jsdom
//
// The Crosslink identity is the one thing an application cannot configure away,
// so these tests assert the two halves of that: the mark and the attribution
// are present on Crosslink-owned surfaces, and the colours an application
// *can* set are corrected when they would make the mark unreadable.
import { describe, it, expect, beforeEach } from "vitest";
import {
  crosslinkLogoSvg,
  resolveCrosslinkTheme,
  contrastRatio,
  parseColor,
  CROSSLINK_LOGO_PATH,
  LOGO_MIN_CONTRAST,
  ATTRIBUTION_MIN_CONTRAST
} from "./branding.js";
import { createPairingCard } from "./pairing-card.js";
import { createPoweredByCrosslink } from "./powered-by-crosslink.js";
import { createOfflineUI } from "../offline/offline-shell.js";

describe("Crosslink branding", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it("renders the mark from one canonical path", () => {
    const svg = crosslinkLogoSvg();
    expect(svg).toContain(CROSSLINK_LOGO_PATH);
    // `currentColor` is what lets a theme tint the mark without a second copy
    // of the artwork existing anywhere.
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>Crosslink</title>");
    expect(svg).toContain("color:#ffffff;");
  });

  it("defaults the shared logo colour to white unless a caller overrides it", () => {
    expect(resolveCrosslinkTheme().logoColor).toBe("#ffffff");
    expect(crosslinkLogoSvg({ color: "#111111" })).toContain("color:#111111;");
  });

  it("keeps the mark legible when an app picks an accent close to its background", () => {
    // Near-black accent on a black background: as configured the mark would be
    // invisible, so the resolver lifts it rather than accepting it.
    const theme = resolveCrosslinkTheme({ accentColor: "#050505", backgroundColor: "#000000" });
    const ratio = contrastRatio(parseColor(theme.logoColor)!, parseColor(theme.backgroundColor)!);
    expect(ratio).toBeGreaterThanOrEqual(LOGO_MIN_CONTRAST);
  });

  it("keeps the attribution legible on light and dark applications", () => {
    for (const background of ["#ffffff", "#000000", "#38bdf8"]) {
      const theme = resolveCrosslinkTheme({ backgroundColor: background });
      const ratio = contrastRatio(
        parseColor(theme.attributionColor)!,
        parseColor(theme.backgroundColor)!
      );
      expect(ratio).toBeGreaterThanOrEqual(ATTRIBUTION_MIN_CONTRAST);
    }
  });

  it("gives different applications different colours and the same identity", () => {
    const a = resolveCrosslinkTheme({ appName: "Notes", accentColor: "#f97316" });
    const b = resolveCrosslinkTheme({ appName: "Chat", accentColor: "#38bdf8" });
    expect(a.accentColor).not.toBe(b.accentColor);
    expect(crosslinkLogoSvg({ color: a.logoColor })).toContain(CROSSLINK_LOGO_PATH);
    expect(crosslinkLogoSvg({ color: b.logoColor })).toContain(CROSSLINK_LOGO_PATH);
  });

  it("keeps the mark on the pairing card whatever an app configures", () => {
    const card = createPairingCard({
      source: false,
      injectStyles: false,
      appName: "Crosslink Notes",
      appIcon: "/notes.png",
      brand: { accentColor: "#f97316", backgroundColor: "#1a1a1a" },
      // An application that tries to pass its own artwork through the theme
      // still gets the Crosslink mark: there is no option that removes it.
      ...({ logo: "<svg id='not-crosslink'></svg>" } as Record<string, unknown>)
    });

    const mark = card.element.querySelector(".cl-pair-logo");
    expect(mark).toBeTruthy();
    expect(mark?.querySelector("path")?.getAttribute("d")).toBe(CROSSLINK_LOGO_PATH);
    expect(card.element.querySelector("#not-crosslink")).toBeNull();

    // The desktop card carries the wordmark itself and no attribution/footer.
    expect(card.element.querySelector('[class*="pair-attribution"]')).toBeNull();
    expect(card.element.querySelector(".cl-crosslink-attribution-footer")).toBeNull();

    // The application's own icon and name sit beside the mark, not instead of it.
    expect(card.element.querySelector(".cl-pair-app-name")?.textContent).toBe("Crosslink Notes");
    card.destroy();
  });

  it("keeps the attribution footer on the offline screen", () => {
    const screen = createOfflineUI({
      appName: "Crosslink Notes",
      accentColor: "#f97316",
      bgColor: "#101014"
    });
    document.body.appendChild(screen);

    const footer = screen.querySelector("#crosslink-offline-brand") as HTMLElement;
    expect(footer?.textContent).toContain("End-to-end encrypted with crosslink");
    expect(footer?.style.position).toBe("");
    expect(footer?.style.borderTop).toBeTruthy();
    // The application is named too — the offline screen is the only thing on
    // the phone when the host is down, so it has to say what is unavailable.
    expect(screen.textContent).toContain("Crosslink Notes");
  });

  it("renders the attribution as a flow footer, not a floating badge", () => {
    const footer = createPoweredByCrosslink({ accentColor: "#f97316", backgroundColor: "#000000" });
    expect(footer.element.querySelector("svg")).toBeNull();
    expect(footer.element.textContent).toContain("End-to-end encrypted with crosslink");
    expect(footer.element.className).toContain("cl-crosslink-attribution-footer");
    expect(footer.element.style.position).toBe("");
    expect(footer.element.style.borderRadius).toBe("");
    footer.destroy();
  });
});
