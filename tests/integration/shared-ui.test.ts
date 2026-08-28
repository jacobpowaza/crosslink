/**
 * Crosslink-owned UI must exist once.
 *
 * The failure this guards against is not hypothetical: before the pairing card
 * and the mobile bootstrap were consumable end to end, each demo grew its own
 * pairing screen, its own service worker and its own copy of the Crosslink
 * wordmark — and one of those copies had a corrupted path, so the mark rendered
 * differently depending on which screen you were looking at.
 *
 * These assertions are structural on purpose. A behavioural test can prove one
 * application works; only counting implementations proves the *second* one is
 * consuming the first rather than reimplementing it.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Tracked files only.
 *
 * Generated bundles contain the framework's own code by construction — a demo's
 * `bundle.js` embeds the SDK, wordmark and all — so counting them would flag
 * every application as carrying a copy. Asking git which files are actually
 * maintained is the same question this test means to ask.
 */
function trackedFiles(...dirs: string[]): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...dirs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return out.split("\0").filter(Boolean);
}

/** Everything a developer would plausibly write an application in. */
function applicationSources(): string[] {
  return trackedFiles("apps", "examples").filter((file) => /\.(ts|tsx|js|mjs|html)$/.test(file));
}

async function read(relative: string): Promise<string> {
  return readFile(path.join(repoRoot, relative), "utf8");
}

describe("Crosslink-owned UI is implemented once", () => {
  it("keeps the wordmark path in exactly one source file", async () => {
    const sources = trackedFiles("packages").filter(
      (f) => /\.(ts|tsx|js|mjs|html|svg)$/.test(f) && !f.endsWith(".test.ts")
    );
    const carriers: string[] = [];
    for (const file of sources) {
      if ((await read(file)).includes("M233.73 383.42")) carriers.push(file);
    }
    expect(carriers).toEqual(["packages/sdk-browser/src/ui/branding.ts"]);
  });

  it("has no application shipping its own copy of the wordmark", async () => {
    const offenders: string[] = [];
    for (const file of applicationSources()) {
      if ((await read(file)).includes("M233.73 383.42")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("has no application hand-writing a service worker or manifest", async () => {
    // Crosslink generates and serves both; a demo carrying its own is a demo
    // teaching developers to maintain framework internals.
    const offenders = trackedFiles("apps", "examples").filter((f) =>
      /(^|\/)(sw|service-worker)\.js$|\.webmanifest$/.test(f)
    );
    expect(offenders).toEqual([]);
  });

  it("has no application constructing pairing UI of its own", async () => {
    // QR generation, pairing-code markup and pairing URL construction all live
    // in the framework. An application reaching for a QR library is the signal
    // that it has started rebuilding the pairing card.
    const offenders: string[] = [];
    for (const file of applicationSources()) {
      const source = await read(file);
      if (/\bfrom "qrcode"|require\("qrcode"\)/.test(source)) offenders.push(file);
    }
    // The terminal-only hosts print a QR to a TTY, which is not the pairing
    // card and has no browser to render one in.
    expect(offenders.every((f) => f.includes("examples/"))).toBe(true);
    expect(offenders.some((f) => f.startsWith("apps/"))).toBe(false);
  });

  it("has two applications consuming the same pairing and bootstrap APIs", async () => {
    const usesCard: string[] = [];
    const usesBootstrap: string[] = [];
    for (const relative of applicationSources()) {
      const source = await read(relative);
      if (/createPairingCard\s*\(/.test(source)) usesCard.push(relative);
      // The generated boot script constructs the bootstrap; an application
      // consumes it through the `crosslink` object that script publishes.
      if (/crosslink\.onConnected\s*\(/.test(source)) usesBootstrap.push(relative);
    }
    expect(usesCard.length).toBeGreaterThanOrEqual(1);
    expect(usesBootstrap.length).toBeGreaterThanOrEqual(2);

    // And none of them contains the implementation they are consuming.
    for (const relative of [...usesCard, ...usesBootstrap]) {
      const source = await read(relative);
      expect(source).not.toContain("cl-pair-code-pills");
      expect(source).not.toContain("crosslink-offline-shell");
      expect(source).not.toContain("navigator.serviceWorker.register");
    }
  });
});
