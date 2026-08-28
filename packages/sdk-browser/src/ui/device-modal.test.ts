// @vitest-environment jsdom
//
// The connected-devices dialog renders values a *paired device* chose: its
// name, its address, its id. The desktop control page is the most privileged
// surface Crosslink has — it mints pairing codes and revokes trust — so a
// device name containing markup must never become markup there.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createPairingCard } from "./pairing-card.js";

const HOSTILE_NAME = '<img src=x onerror="globalThis.__crosslinkXss = true">';
const HOSTILE_ID = '</span><script>globalThis.__crosslinkXss = true</script>';

describe("connected devices dialog", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    delete (globalThis as Record<string, unknown>).__crosslinkXss;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openDialogWith(device: Record<string, unknown>): Promise<HTMLElement> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ devices: [device] })
      })) as unknown as typeof fetch
    );

    const card = createPairingCard({ injectStyles: false, devicesEndpoint: "/devices" });
    document.body.appendChild(card.element);
    // The dialog is opened from the settings popover; drive it the same way.
    const openItem = Array.from(card.element.querySelectorAll(".cl-dropdown-item")).find((el) =>
      el.textContent?.includes("Connected Devices")
    ) as HTMLElement;
    openItem.click();
    await vi.waitFor(() => {
      if (!document.querySelector(".cl-connected-modal")) throw new Error("dialog not open");
    });
    return document.querySelector(".cl-connected-modal") as HTMLElement;
  }

  it("renders a hostile device name as text, not markup", async () => {
    const modal = await openDialogWith({
      deviceId: "abc123",
      name: HOSTILE_NAME,
      ipAddress: "192.168.1.5"
    });

    expect(modal.querySelector("img")).toBeNull();
    expect(modal.querySelector("script")).toBeNull();
    expect((globalThis as Record<string, unknown>).__crosslinkXss).toBeUndefined();
    // The name is still shown — escaped, not dropped.
    expect(modal.querySelector(".cl-device-name")?.textContent).toBe(HOSTILE_NAME);
  });

  it("renders a hostile device id and address as text, not markup", async () => {
    const modal = await openDialogWith({
      deviceId: HOSTILE_ID,
      name: "Phone",
      ipAddress: '"><script>globalThis.__crosslinkXss = true</script>',
      deviceType: "<b>phone</b>",
      location: "<i>home</i>"
    });

    expect(modal.querySelector("script")).toBeNull();
    expect(modal.querySelector("b")).toBeNull();
    expect(modal.querySelector("i")).toBeNull();
    expect((globalThis as Record<string, unknown>).__crosslinkXss).toBeUndefined();
    expect(modal.querySelector(".cl-device-detail")?.textContent).toContain(HOSTILE_ID);
  });
});
