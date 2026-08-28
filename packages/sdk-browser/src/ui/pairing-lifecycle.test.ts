// @vitest-environment jsdom
//
// The session loop every application used to write beside the pairing card:
// mint, render, replace before expiry, re-mint when a device redeems the code,
// apply a connection-mode change, and recover from a host that is still coming
// up. It lives in the card now, so it is tested once here instead of being
// re-implemented per demo.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPairingCard } from "./pairing-card.js";
import type { PairingSource, PairingSourceEvent } from "./pairing-source.js";

function session(overrides: Record<string, unknown> = {}) {
  return {
    code: "123456789",
    expiresAt: Date.now() + 300_000,
    qrSvg: "<svg id='qr'></svg>",
    endpoints: [{ kind: "lan" as const, url: "ws://192.168.1.5:8787" }],
    networkMode: "auto" as const,
    ...overrides
  };
}

function stubSource(overrides: Partial<PairingSource> = {}) {
  let emit: ((event: PairingSourceEvent) => void) | null = null;
  const source: PairingSource = {
    getSession: vi.fn(async () => session()),
    setNetworkMode: vi.fn(async () => {}),
    subscribe: (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    ...overrides
  };
  return { source, fire: (event: PairingSourceEvent) => emit?.(event) };
}

describe("pairing card session lifecycle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints and renders a session with no application code", async () => {
    const { source } = stubSource();
    const card = createPairingCard({ injectStyles: false, source });
    await vi.waitFor(() => {
      if (card.element.querySelectorAll(".cl-pill").length !== 9) throw new Error("no code yet");
    });

    expect(source.getSession).toHaveBeenCalledTimes(1);
    expect(card.element.querySelector("#qr")).toBeTruthy();
    expect(
      Array.from(card.element.querySelectorAll(".cl-pair-code-pills .cl-pill"))
        .map((el) => el.textContent)
        .join("")
    ).toBe("123456789");
    card.destroy();
  });

  it("replaces the code before it expires", async () => {
    const { source } = stubSource({
      getSession: vi.fn(async () => session({ expiresAt: Date.now() + 30_000 }))
    });
    const card = createPairingCard({ injectStyles: false, source, refreshLeadSeconds: 15 });
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(1));

    // Lead time is 15s on a 30s code, so the replacement is due at ~15s. A card
    // that let the code lapse would hand the next person to scan it a failure.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(source.getSession).toHaveBeenCalledTimes(2);
    card.destroy();
  });

  it("mints a fresh code when the host says one was redeemed", async () => {
    const { source, fire } = stubSource();
    const card = createPairingCard({ injectStyles: false, source });
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(1));

    fire({ type: "invalidate" });
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(2));
    card.destroy();
  });

  it("reports connected devices in the status line", async () => {
    const { source, fire } = stubSource();
    const card = createPairingCard({ injectStyles: false, source });
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(1));

    expect(card.element.querySelector(".cl-pair-status")?.textContent).toBe(
      "Waiting for a device to scan"
    );
    fire({ type: "connected", deviceId: "phone-1" });
    expect(card.element.querySelector(".cl-pair-status")?.textContent).toBe("Device connected");
    fire({ type: "disconnected", deviceId: "phone-1" });
    expect(card.element.querySelector(".cl-pair-status")?.textContent).toBe(
      "Waiting for a device to scan"
    );
    card.destroy();
  });

  it("applies a connection-mode change and re-mints on the new mode", async () => {
    const { source } = stubSource();
    const card = createPairingCard({ injectStyles: false, source });
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(1));

    card.setNetworkMode("local-only");
    await vi.waitFor(() => expect(source.setNetworkMode).toHaveBeenCalledWith("local-only"));
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(2));
    expect(source.getSession).toHaveBeenLastCalledWith("local-only");
    card.destroy();
  });

  it("shows the host's reason for a failure, then recovers on its own", async () => {
    const failure = Object.assign(new Error("pairing code rate limit exceeded"), {
      code: "CL-P429"
    });
    const getSession = vi
      .fn<PairingSource["getSession"]>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(session());
    const { source } = stubSource({ getSession });
    const card = createPairingCard({ injectStyles: false, source });

    await vi.waitFor(() => {
      if (!card.element.querySelector(".cl-error-code")) throw new Error("no error yet");
    });
    expect(card.element.querySelector(".cl-error-code")?.textContent).toBe("CL-P429");

    // A host still starting up answers within a few hundred ms; the card retries
    // rather than leaving the user with a dead panel and a refresh button.
    await vi.advanceTimersByTimeAsync(5_500);
    await vi.waitFor(() => {
      if (card.element.querySelectorAll(".cl-pill").length !== 9) throw new Error("no code yet");
    });
    card.destroy();
  });

  it("stops minting once destroyed", async () => {
    const { source } = stubSource({
      getSession: vi.fn(async () => session({ expiresAt: Date.now() + 20_000 }))
    });
    const card = createPairingCard({ injectStyles: false, source, refreshLeadSeconds: 15 });
    await vi.waitFor(() => expect(source.getSession).toHaveBeenCalledTimes(1));

    card.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.getSession).toHaveBeenCalledTimes(1);
  });
});
