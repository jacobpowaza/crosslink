import { describe, it, expect, vi, beforeEach } from "vitest";
import { PairingCard, createPairingCard, normalizeNetworkMode } from "./pairing-card.js";

// Mock minimal document & HTMLElement for node test environment
class MockClassList {
  private classes = new Set<string>();
  add(c: string) { this.classes.add(c); }
  remove(c: string) { this.classes.delete(c); }
  toggle(c: string, force?: boolean) {
    if (force === true) this.classes.add(c);
    else if (force === false) this.classes.delete(c);
    else if (this.classes.has(c)) this.classes.delete(c);
    else this.classes.add(c);
  }
  contains(c: string) { return this.classes.has(c); }
}

class MockElement {
  tagName: string;
  className = "";
  innerHTML = "";
  textContent = "";
  children: MockElement[] = [];
  classList = new MockClassList();
  style: { setProperty(k: string, v: string): void; getPropertyValue(k: string): string; [k: string]: any } = {
    setProperty: (k: string, v: string) => { (this.style as any)[k] = v; },
    getPropertyValue: (k: string) => (this.style as any)[k] ?? "",
  };
  disabled = false;
  hidden = false;
  title = "";
  private attributes: Record<string, string> = {};
  private listeners: Record<string, Function[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  appendChild(el: MockElement) {
    this.children.push(el);
    return el;
  }

  replaceChildren(...els: MockElement[]) {
    this.children = [...els];
    this.innerHTML = "";
  }

  addEventListener(event: string, fn: Function) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(fn);
  }

  click() {
    for (const fn of this.listeners["click"] || []) fn();
  }

  querySelector(sel: string): MockElement | null {
    const match = (el: MockElement): boolean => {
      if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
      if (sel.startsWith("#")) return el.getAttribute("id") === sel.slice(1);
      if (sel.includes("[")) {
        const m = sel.match(/^(\w*)\[([^=]+)="?([^"\]]+)"?\]$/);
        if (m) {
          const [, tag, attr, val] = m;
          if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
          return el.getAttribute(attr) === val;
        }
      }
      return el.tagName.toLowerCase() === sel.toLowerCase();
    };

    const find = (el: MockElement): MockElement | null => {
      if (match(el)) return el;
      for (const c of el.children) {
        const res = find(c);
        if (res) return res;
      }
      return null;
    };
    return find(this);
  }

  querySelectorAll(sel: string): MockElement[] {
    const results: MockElement[] = [];
    const match = (el: MockElement): boolean => {
      if (sel.includes(".cl-pill")) return el.className.includes("cl-pill");
      if (sel.includes('input[name="cl-net-mode"]')) {
        return el.tagName.toLowerCase() === "input" && el.getAttribute("name") === "cl-net-mode";
      }
      return false;
    };
    const find = (el: MockElement) => {
      if (match(el)) results.push(el);
      for (const c of el.children) find(c);
    };
    find(this);
    return results;
  }

  remove() {
    this.children = [];
  }
}

describe("PairingCard UI Component", () => {
  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => new MockElement(tag),
      querySelector: () => null,
      head: { appendChild: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  it("creates a pairing card and renders DOM structure", () => {
    const card = createPairingCard({
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

  it("updates state with new code, QR, and loading status", () => {
    const card = new PairingCard({ injectStyles: false });

    card.update({ loading: true });
    expect(card.element.querySelector(".cl-qr-wrap")?.innerHTML).toContain("Generating");

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
    const card = new PairingCard({ injectStyles: false });
    card.update({ error: "Failed to connect to signaling server" });

    expect(card.element.querySelector(".cl-qr-wrap")?.innerHTML).toContain("Failed to connect");
    expect(card.element.querySelectorAll(".cl-pill").length).toBe(0);

    card.destroy();
  });

  it("applies custom theme variables", () => {
    const card = new PairingCard({
      injectStyles: false,
      theme: {
        bg: "#112233",
        fg: "#ffffff",
        pill: "#445566",
        radius: "16px",
      },
    });

    expect(card.element.style.getPropertyValue("--cl-bg")).toBe("#112233");
    expect(card.element.style.getPropertyValue("--cl-fg")).toBe("#ffffff");
    expect(card.element.style.getPropertyValue("--cl-pill")).toBe("#445566");
    expect(card.element.style.getPropertyValue("--cl-radius")).toBe("16px");

    card.destroy();
  });

  it("triggers onRefresh callback when refresh button is clicked", async () => {
    const refreshSpy = vi.fn().mockResolvedValue(undefined);
    const card = new PairingCard({ onRefresh: refreshSpy, injectStyles: false });

    const btn = card.element.querySelector(".cl-pair-refresh") as any;
    expect(btn).toBeTruthy();

    btn.click();
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    card.destroy();
  });

  it("toggles settings dropdown when cog button is clicked", () => {
    const card = new PairingCard({ injectStyles: false });
    const cog = card.element.querySelector(".cl-cog-btn") as any;
    expect(cog).toBeTruthy();

    const dropdown = card.element.querySelector(".cl-settings-dropdown") as any;
    expect(dropdown.hidden).toBe(true);

    cog.click();
    expect(dropdown.hidden).toBe(false);

    cog.click();
    expect(dropdown.hidden).toBe(true);

    card.destroy();
  });

  it("switches network mode and invokes onNetworkModeChange callback", () => {
    const modeSpy = vi.fn();
    const card = new PairingCard({
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

  it("folds a mode name persisted by an older build onto a current one", () => {
    // An upgraded app finds "open-lan-remote" or "ngrok" in localStorage; the
    // card must start on a mode that still exists rather than on nothing.
    expect(normalizeNetworkMode("open-lan-remote")).toBe("remote");
    expect(normalizeNetworkMode("local")).toBe("local-only");
    expect(normalizeNetworkMode("ngrok")).toBe("auto");
    expect(normalizeNetworkMode(undefined)).toBe("auto");

    const card = new PairingCard({ networkMode: "open-lan-remote" as never, injectStyles: false });
    expect(card.getNetworkMode()).toBe("remote");
    card.destroy();
  });

  it("names the routes the current QR advertises, and says nothing more", () => {
    const card = new PairingCard({ injectStyles: false });
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
