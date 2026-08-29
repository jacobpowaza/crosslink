// @vitest-environment jsdom
//
// A real DOM rather than a hand-written stub: these components render SVG and
// set innerHTML, and a stub that stores innerHTML as a string cannot answer the
// question these tests exist to ask — whether the Crosslink mark is actually in
// the tree.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PairingCard, createPairingCard, normalizeNetworkMode } from "./pairing-card.js";
import { createPoweredByCrosslink } from "./powered-by-crosslink.js";

describe("PairingCard UI Component", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it("creates a pairing card and renders DOM structure", () => {
    const card = createPairingCard({
      source: false,
      appName: "Crosslink Notes",
      blurb: "<strong>Connect your phone</strong> to sync notes.",
      code: "123456789",
      qr: "<svg><rect width='100' height='100'/></svg>",
      expiresAt: "expires in 2 minutes",
      injectStyles: false,
    });

    expect(card.element).toBeTruthy();
    expect(card.element.className).toContain("cl-pair-card");

    const blurb = card.element.querySelector(".cl-pair-blurb");
    expect(blurb?.innerHTML).toContain("Connect your phone");

    const pills = card.element.querySelectorAll(".cl-pill");
    expect(pills.length).toBe(9);
    expect(pills[0].textContent).toBe("1");
    expect(pills[8].textContent).toBe("9");

    card.destroy();
  });

  it("ships useful default text on a black card", () => {
    const card = createPairingCard({ source: false, injectStyles: false });

    expect(card.element.querySelector(".cl-pair-blurb")?.textContent).toContain("Connect another device");
    expect(card.element.style.getPropertyValue("--cl-bg")).toBe("#000000");

    card.destroy();
  });

  it("updates state with new code, QR, and loading status", () => {
    const card = new PairingCard({ source: false, injectStyles: false });

    card.update({ loading: true });
    expect(card.element.querySelector(".cl-qr-skeleton")).toBeTruthy();

    card.update({
      qr: "<svg id='fresh-qr'></svg>",
      code: "987654321",
      expiresAt: "expires in 2 minutes",
      loading: false,
    });

    expect(card.element.querySelector(".cl-qr-wrap")?.innerHTML).toContain("fresh-qr");
    const pills = card.element.querySelectorAll(".cl-pill");
    expect(pills.length).toBe(9);
    expect(pills[0].textContent).toBe("9");

    card.destroy();
  });

  it("handles error states gracefully", () => {
    const card = new PairingCard({ source: false, injectStyles: false });
    card.update({ error: "Failed to connect to signaling server", errorCode: "CL-P503" });

    expect(card.element.querySelector(".cl-error-code")?.textContent).toBe("CL-P503");
    const details = card.element.querySelector(".cl-error-details-btn") as any;
    expect(details?.textContent).toBe("View details");
    expect(card.element.querySelectorAll(".cl-pill").length).toBe(0);
    details.click();
    const modal = (document.body as any).querySelector(".cl-error-modal");
    expect(modal).toBeTruthy();
    expect(modal.querySelector("p")?.textContent).toBe("Failed to connect to signaling server");

    card.destroy();
  });

  it("renders skeletons whenever a pairing code is absent or loading", () => {
    const card = new PairingCard({ source: false, injectStyles: false });
    expect(card.element.querySelectorAll(".cl-pill").length).toBe(9);
    expect(card.element.querySelector(".cl-qr-skeleton")).toBeTruthy();

    card.update({ loading: true });
    expect(card.element.querySelectorAll(".cl-pill").length).toBe(9);
    expect(card.element.querySelector(".cl-qr-skeleton")).toBeTruthy();
    card.destroy();
  });

  it("creates a reusable, customizable Crosslink attribution", () => {
    const badge = createPoweredByCrosslink({
      color: "#abcdef",
      size: 13,
      placement: "top-right",
      text: "Built with",
    });
    expect(badge.element.className).toContain("cl-powered-by-crosslink");
    // jsdom normalises hex colours to rgb() when reading back cssText.
    expect(badge.element.style.color).toBe("rgb(171, 205, 239)");
    expect(badge.element.style.cssText).toContain("13px");
    const link = badge.element.querySelector("a") as any;
    expect(link.href).toBe("https://github.com/jacobpowaza/crosslink");
    // The link *is* the wordmark, so the accessible name comes from the SVG.
    expect(link.getAttribute("aria-label")).toBe("Crosslink");
    expect(link.querySelector("svg")).toBeTruthy();
    badge.destroy();
  });

  it("applies custom theme variables", () => {
    const card = new PairingCard({
      source: false,
      injectStyles: false,
      theme: {
        bg: "#112233",
        fg: "#ffffff",
        pill: "#445566",
        border: "2px solid #778899",
        radius: "16px",
      },
    });

    expect(card.element.style.getPropertyValue("--cl-bg")).toBe("#112233");
    expect(card.element.style.getPropertyValue("--cl-fg")).toBe("#ffffff");
    expect(card.element.style.getPropertyValue("--cl-pill")).toBe("#445566");
    expect(card.element.style.getPropertyValue("--cl-border")).toBe("2px solid #778899");
    expect(card.element.style.getPropertyValue("--cl-radius")).toBe("16px");

    card.setBrand({ backgroundColor: "#abcdef" });
    expect(card.element.style.getPropertyValue("--cl-bg")).toBe("#112233");
    expect(card.element.style.getPropertyValue("--cl-border")).toBe("2px solid #778899");

    card.destroy();
  });

  it("triggers onRefresh callback when refresh button is clicked", async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const card = new PairingCard({ source: false, onRefresh: refreshSpy, injectStyles: false });

    const btn = card.element.querySelector(".cl-pair-refresh") as any;
    expect(btn).toBeTruthy();

    btn.click();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    card.destroy();
  });

  it("toggles settings dropdown when cog button is clicked", () => {
    const card = new PairingCard({ source: false, injectStyles: false });
    const cog = card.element.querySelector(".cl-cog-btn") as any;
    expect(cog).toBeTruthy();

    const dropdown = card.element.querySelector(".cl-settings-dropdown") as any;
    expect(dropdown.hidden).toBe(true);
    expect(dropdown.innerHTML).toContain("https://crosslink.mintlify.site/guides/connection-modes");

    cog.click();
    expect(dropdown.hidden).toBe(false);

    cog.click();
    expect(dropdown.hidden).toBe(true);

    card.destroy();
  });

  it("switches network mode and invokes onNetworkModeChange callback", () => {
    const modeSpy = vi.fn();
    const card = new PairingCard({
      source: false,
      networkMode: "remote",
      onNetworkModeChange: modeSpy,
      injectStyles: false,
    });

    expect(card.getNetworkMode()).toBe("remote");

    card.setNetworkMode("local-only");
    expect(card.getNetworkMode()).toBe("local-only");
    expect(modeSpy).toHaveBeenCalledWith("local-only");

    card.setNetworkMode("lan-and-relay");
    expect(card.getNetworkMode()).toBe("lan-and-relay");
    expect(modeSpy).toHaveBeenCalledWith("lan-and-relay");

    card.destroy();
  });

  it("syncs a server-reported mode without treating it as another user change", () => {
    const modeSpy = vi.fn();
    const card = new PairingCard({
      source: false,
      networkMode: "auto",
      onNetworkModeChange: modeSpy,
      injectStyles: false,
    });

    card.update({ networkMode: "remote" });

    expect(card.getNetworkMode()).toBe("remote");
    expect(modeSpy).not.toHaveBeenCalled();
    card.destroy();
  });

  it("folds a mode name persisted by an older build onto a current one", () => {
    // An upgraded app finds "open-lan-remote" or "ngrok" in localStorage; the
    // card must start on a mode that still exists rather than on nothing.
    expect(normalizeNetworkMode("open-lan-remote")).toBe("remote");
    expect(normalizeNetworkMode("local")).toBe("local-only");
    expect(normalizeNetworkMode("ngrok")).toBe("auto");
    expect(normalizeNetworkMode(undefined)).toBe("auto");

    const card = new PairingCard({ source: false, networkMode: "open-lan-remote" as never, injectStyles: false });
    expect(card.getNetworkMode()).toBe("remote");
    card.destroy();
  });

  it("names the routes the current QR advertises, and says nothing more", () => {
    const card = new PairingCard({ source: false, injectStyles: false });
    card.update({
      endpoints: [
        { kind: "lan", url: "ws://192.168.1.50:8100" },
        { kind: "wan", url: "ws://203.0.113.7:8100" },
      ],
    });
    const summary = card.element.querySelector(".cl-route-summary") as HTMLElement;
    const text = () => Array.from(summary.children).map((c) => c.textContent).join(" ");
    expect(summary.hidden).toBe(false);
    expect(text()).toContain("this network");
    expect(text()).toContain("the internet, directly");

    // Remote asked for and refused: no wan route, and the reason is shown.
    card.update({
      endpoints: [{ kind: "lan", url: "ws://192.168.1.50:8100" }],
      remoteNote: "the router refused a port mapping",
    });
    expect(text()).not.toContain("the internet, directly");
    expect(text()).toContain("the router refused a port mapping");
    card.destroy();
  });
});
