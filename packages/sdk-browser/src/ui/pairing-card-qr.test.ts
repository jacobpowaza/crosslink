// @vitest-environment jsdom
//
// The widget half of the QR regression: a host can hand the card a perfectly
// good bootstrap URL and the card can still put something else on screen. So
// these tests read the QR back out of the mounted DOM and decode it, rather
// than trusting that whatever was passed to `update()` was drawn.
import { describe, it, expect, beforeEach } from "vitest";
import QRCode from "qrcode";
import { PairingCard } from "./pairing-card.js";
import type { PairingSession, PairingSource } from "./pairing-source.js";
import { decodeQrSvg } from "../../../../tests/helpers/decode-qr-svg.js";

const BOOTSTRAP_URL =
  "https://desktop.example.test/#pair=" +
  encodeURIComponent(
    "crosslink://pair?v=2&e=lan~ws://192.168.1.25:8787,tunnel~wss://desktop.example.test" +
      "&c=123456789&a=com.example.chat&n=Example+Chat&f=820134f790fced7e"
  );

/** A host that answers exactly as the control surface does. */
function sourceFor(session: Partial<PairingSession>): PairingSource & { calls: number } {
  return {
    calls: 0,
    async getSession(): Promise<PairingSession> {
      (this as { calls: number }).calls += 1;
      return {
        code: "123 456 789",
        expiresAt: Date.now() + 300_000,
        ...session
      } as PairingSession;
    }
  };
}

async function mountedCard(session: Partial<PairingSession>): Promise<PairingCard> {
  const card = new PairingCard({ source: sourceFor(session), injectStyles: false });
  await card.refresh();
  return card;
}

/** Waits for the mint the constructor started. */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("pairing card QR rendering", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it("renders the host's QR so it decodes back to the bootstrap URL", async () => {
    const qrSvg = await QRCode.toString(BOOTSTRAP_URL, { type: "svg", margin: 1 });
    const card = await mountedCard({ qrSvg, bootstrapUrl: BOOTSTRAP_URL });

    const rendered = card.element.querySelector(".cl-qr-wrap svg");
    expect(rendered).toBeTruthy();
    expect(decodeQrSvg(rendered!.outerHTML)).toBe(BOOTSTRAP_URL);

    card.destroy();
  });

  it("does not substitute the pairing code or an error code for the QR", async () => {
    const qrSvg = await QRCode.toString(BOOTSTRAP_URL, { type: "svg", margin: 1 });
    const card = await mountedCard({ qrSvg, bootstrapUrl: BOOTSTRAP_URL });

    const decoded = decodeQrSvg(card.element.querySelector(".cl-qr-wrap svg")!.outerHTML);
    expect(decoded).not.toBe("123456789");
    expect(decoded).not.toMatch(/^CL-P\d+$/);
    expect(card.element.querySelector(".cl-error-code")).toBeNull();
    expect(new URL(decoded).protocol).toBe("https:");

    card.destroy();
  });

  it("shows a code placeholder instead of a QR only when the host fails", async () => {
    const card = new PairingCard({
      source: {
        async getSession(): Promise<PairingSession> {
          throw Object.assign(new Error("no reachable route"), { code: "CL-P409" });
        }
      },
      injectStyles: false
    });
    await card.refresh();

    expect(card.element.querySelector(".cl-error-code")?.textContent).toBe("CL-P409");
    expect(card.element.querySelector(".cl-qr-wrap svg")).toBeNull();

    card.destroy();
  });

  it("replaces both the QR and the code when the session is refreshed", async () => {
    const first = await QRCode.toString(BOOTSTRAP_URL, { type: "svg", margin: 1 });
    const secondUrl = BOOTSTRAP_URL.replace("123456789", "987654321");
    const second = await QRCode.toString(secondUrl, { type: "svg", margin: 1 });

    let call = 0;
    const card = new PairingCard({
      source: {
        async getSession(): Promise<PairingSession> {
          call += 1;
          return call === 1
            ? { code: "123 456 789", expiresAt: Date.now() + 300_000, qrSvg: first }
            : { code: "987 654 321", expiresAt: Date.now() + 300_000, qrSvg: second };
        }
      },
      injectStyles: false
    });

    // The card mints once as soon as it has a source, so the first session is
    // already on screen before anything asks for another.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decodeQrSvg(card.element.querySelector(".cl-qr-wrap svg")!.outerHTML)).toBe(BOOTSTRAP_URL);

    await card.refresh();
    expect(decodeQrSvg(card.element.querySelector(".cl-qr-wrap svg")!.outerHTML)).toBe(secondUrl);
    expect(
      Array.from(card.element.querySelectorAll(".cl-pair-code-pills .cl-pill"))
        .map((pill) => pill.textContent)
        .join("")
    ).toBe("987654321");

    card.destroy();
  });
});

describe("pairing card layout", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it("puts the application identity above the scan label, and only there", () => {
    const card = new PairingCard({
      source: false,
      injectStyles: false,
      appName: "Example Chat",
      appIcon: "/icon-192.png"
    });

    const center = card.element.querySelector(".cl-pair-center")!;
    const appRow = center.querySelector(".cl-pair-app");
    expect(appRow).toBeTruthy();
    expect(appRow?.textContent).toContain("Example Chat");

    // Above the label, not beside the QR or below it.
    const children = Array.from(center.children);
    expect(children.indexOf(appRow!)).toBeLessThan(
      children.indexOf(center.querySelector(".cl-pair-label")!)
    );

    // The left column stays Crosslink's own explanation; the app name appears once.
    expect(card.element.querySelector(".cl-pair-left .cl-pair-app")).toBeNull();
    expect(card.element.querySelectorAll(".cl-pair-app-name").length).toBe(1);

    card.destroy();
  });

  it("draws the Crosslink wordmark in the card's foreground, not the app accent", () => {
    const card = new PairingCard({
      source: false,
      injectStyles: false,
      brand: { accentColor: "#38bdf8", backgroundColor: "#000000" }
    });

    const logo = card.element.querySelector(".cl-pair-logo");
    expect(logo).toBeTruthy();
    expect(card.element.style.getPropertyValue("--cl-logo")).toBe(
      card.element.style.getPropertyValue("--cl-fg")
    );
    expect(card.element.style.getPropertyValue("--cl-logo")).not.toBe("#38bdf8");

    card.destroy();
  });

  it("carries no attribution line, only the wordmark", () => {
    const card = new PairingCard({ source: false, injectStyles: true });

    // The badge is the mobile screens' job (`PoweredByCrosslink`, mounted by
    // the bootstrap). On the desktop card the wordmark is the attribution, and
    // a second line under the columns only crowded it.
    expect(card.element.querySelector(".cl-pair-attribution")).toBeNull();
    expect(card.element.querySelector(".cl-pair-logo")).toBeTruthy();

    const styles = Array.from(document.head.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(styles).not.toContain(".cl-pair-attribution");

    card.destroy();
  });
});

describe("pairing card, driven by the host", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
  });

  it("takes its application identity from the host instead of page options", async () => {
    const card = await mountedCard({
      application: {
        id: "com.example.chat",
        name: "Example Chat",
        icon: "/icon-192.png",
        accentColor: "#f97316",
        backgroundColor: "#101014"
      }
    });

    expect(card.element.querySelector(".cl-pair-app-name")?.textContent).toBe("Example Chat");
    expect(card.element.querySelector(".cl-pair-app img")?.getAttribute("src")).toBe("/icon-192.png");
    expect(card.element.style.getPropertyValue("--cl-accent")).toBe("#f97316");

    card.destroy();
  });

  it("lets an explicit option win over the host's metadata", async () => {
    const card = new PairingCard({
      source: sourceFor({ application: { name: "Example Chat", accentColor: "#f97316" } }),
      injectStyles: false,
      appName: "Pair with the desk"
    });
    await settled();

    expect(card.element.querySelector(".cl-pair-app-name")?.textContent).toBe("Pair with the desk");
    // Only the name was overridden; the accent still comes from the host.
    expect(card.element.style.getPropertyValue("--cl-accent")).toBe("#f97316");

    card.destroy();
  });

  it("mints a new session when the refresh button is clicked", async () => {
    let call = 0;
    const card = new PairingCard({
      source: {
        async getSession(): Promise<PairingSession> {
          call += 1;
          return { code: `00000000${call}`, expiresAt: Date.now() + 300_000 };
        }
      },
      injectStyles: false
    });
    await settled();
    expect(call).toBe(1);

    // The button used to call `options.onRefresh` only, which a self-driving
    // card never sets — clicking it did nothing at all.
    (card.element.querySelector(".cl-pair-refresh") as HTMLButtonElement).click();
    await settled();

    expect(call).toBe(2);
    expect(
      Array.from(card.element.querySelectorAll(".cl-pair-code-pills .cl-pill"))
        .map((pill) => pill.textContent)
        .join("")
    ).toBe("000000002");

    card.destroy();
  });

  it("shows a spinner while a settings change is being applied", async () => {
    let release: (() => void) | null = null;
    const card = new PairingCard({
      source: {
        async getSession(): Promise<PairingSession> {
          return { code: "123456789", expiresAt: Date.now() + 300_000 };
        },
        setNetworkMode(): Promise<void> {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      injectStyles: false
    });
    await settled();

    const pending = card.element.querySelector(".cl-mode-pending") as HTMLElement;
    const popover = card.element.querySelector(".cl-settings-dropdown") as HTMLElement;
    expect(pending.hidden).toBe(true);

    card.setNetworkMode("remote");
    await settled();

    // A mode change is a round trip to the host; until it answers the popover
    // says so and refuses a second change.
    expect(pending.hidden).toBe(false);
    expect(pending.textContent).toContain("Applying");
    expect(popover.getAttribute("data-pending")).toBe("true");
    expect(
      Array.from(popover.querySelectorAll<HTMLInputElement>('input[name="cl-net-mode"]')).every(
        (radio) => radio.disabled
      )
    ).toBe(true);

    release!();
    await settled();
    await settled();

    expect(pending.hidden).toBe(true);
    expect(popover.hasAttribute("data-pending")).toBe(false);
    expect(
      Array.from(popover.querySelectorAll<HTMLInputElement>('input[name="cl-net-mode"]')).some(
        (radio) => radio.disabled
      )
    ).toBe(false);

    card.destroy();
  });

  it("marks the refresh button busy while a session is in flight", async () => {
    const card = new PairingCard({ source: false, injectStyles: false });
    const button = card.element.querySelector(".cl-pair-refresh") as HTMLButtonElement;

    card.update({ loading: true });
    expect(button.getAttribute("data-busy")).toBe("true");
    expect(button.disabled).toBe(true);

    card.update({ loading: false });
    expect(button.hasAttribute("data-busy")).toBe(false);

    card.destroy();
  });
});
