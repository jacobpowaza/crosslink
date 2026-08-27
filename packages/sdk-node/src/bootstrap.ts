/**
 * Hosted bootstrap URLs.
 *
 * A raw `crosslink://pair?...` URI is perfect for in-app scanners (the demo
 * PWA reads it directly), but a phone camera on iOS has no handler for a
 * custom scheme — Safari just ignores it. To give the product flow
 *
 *     scan QR → Safari opens a setup page → Add to Home Screen → paired
 *
 * the QR instead points at a plain `https://` URL on the app's bootstrap
 * page, carrying the pairing payload in the fragment so nothing reaches a
 * server that is not already in the scanned URL. The page runs the Crosslink
 * client SDK, reads `#pair=<uri>`, and pairs with zero back-and-forth.
 *
 * The bootstrap page is static and installable (manifest + service worker).
 * Developers host it anywhere static HTTPS is free — GitHub Pages, an S3/Cloud
 * Storage bucket, their own server — and point `pairing.bootstrapUrl` at it.
 *
 * Parsing and unwrapping shared with the browser SDK live in
 * `@crosslink/core` (`unwrapBootstrapUri` / `BOOTSTRAP_FRAGMENT_KEY`); this
 * module only *builds* the hosted link and validates the base URL, which is
 * host-side work.
 */
import { BOOTSTRAP_FRAGMENT_KEY } from "@crosslink/core";

export interface BootstrapOptions {
  /** Base URL of the hosted, installable client page (must be https://). */
  url: string;
}

/** Builds the hosted bootstrap URL for a manifest URI. */
export function buildBootstrapUri(manifestUri: string, url: string): string {
  const base = url.replace(/\/+$/, "");
  const fragment = `${BOOTSTRAP_FRAGMENT_KEY}=${encodeURIComponent(manifestUri)}`;
  return `${base}#${fragment}`;
}

/** Validates a bootstrap base URL before it is baked into a QR code. */
export function assertBootstrapUrl(url: string): string {
  if (!/^https:\/\/[^\s/]+(\/.*)?$/.test(url)) {
    throw new Error(
      `pairing.bootstrapUrl must be an https:// URL where the clientlink PWA is hosted, got: ${url}`
    );
  }
  return url.replace(/\/+$/, "");
}