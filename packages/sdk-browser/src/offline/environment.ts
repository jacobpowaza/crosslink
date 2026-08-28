/**
 * What this browser origin actually permits.
 *
 * Crosslink's mobile promise — pair once, add to home screen, launch later and
 * see a Crosslink reconnect screen instead of the browser's error page —
 * depends on browser capabilities that are gated on the *origin*, not on the
 * framework. A page served from `http://192.168.1.110:8787` gets none of them:
 *
 *  - `navigator.serviceWorker.register` rejects outside a secure context, so
 *    there is no cached shell and an offline launch shows the browser's own
 *    "cannot connect to server" page.
 *  - `crypto.subtle` is undefined outside a secure context, so device keys
 *    cannot be wrapped in a non-extractable WebCrypto key and fall back to
 *    plaintext at rest.
 *  - Chromium's install prompt requires https.
 *
 * And the inverse trade-off is just as real: from an https origin the browser
 * refuses `ws://` entirely, so the LAN shortcut that makes Crosslink fast is
 * unavailable to exactly the origins that can install.
 *
 * This module reports those facts rather than hiding them. Everything above is
 * a browser rule; no amount of framework code changes it, so the honest thing
 * is to name which parts of the experience a given origin can deliver.
 */

export interface BootstrapEnvironment {
  /** Origin of the page, or null when not running in a browser. */
  origin: string | null;
  /** `window.isSecureContext`. The gate on nearly everything below. */
  secureContext: boolean;
  /** A service worker can be registered, so an offline shell can be cached. */
  serviceWorkerAvailable: boolean;
  /** `crypto.subtle` exists, so device keys can be non-extractable. */
  webCryptoAvailable: boolean;
  /** The page is already running as an installed app. */
  standalone: boolean;
  /** An install to the home screen will behave like an app, not a bookmark. */
  installable: boolean;
  /** Insecure `ws://` endpoints are unusable from this origin. */
  insecureTransportBlocked: boolean;
  /** One plain sentence per capability this origin cannot provide. */
  limitations: string[];
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  const displayMode =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || displayMode;
}

/**
 * Describes the current origin's capabilities.
 *
 * Safe to call anywhere: outside a browser every capability reads false and
 * `origin` is null, which is the correct answer for a Node or native client
 * rather than a reason to throw.
 */
export function describeBootstrapEnvironment(): BootstrapEnvironment {
  if (typeof window === "undefined" || typeof location === "undefined") {
    return {
      origin: null,
      secureContext: false,
      serviceWorkerAvailable: false,
      webCryptoAvailable: typeof crypto !== "undefined" && Boolean(crypto.subtle),
      standalone: false,
      installable: false,
      insecureTransportBlocked: false,
      limitations: []
    };
  }

  const origin = location.origin && location.origin !== "null" ? location.origin : null;
  const secureContext = window.isSecureContext === true;
  const serviceWorkerAvailable =
    secureContext && typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const webCryptoAvailable = typeof crypto !== "undefined" && Boolean(crypto.subtle);
  const insecureTransportBlocked = location.protocol === "https:";

  const limitations: string[] = [];
  if (!secureContext) {
    limitations.push(
      `${origin ?? "This origin"} is not a secure context, so the browser will not register a ` +
        "service worker: this device can pair and use the app, but it cannot cache Crosslink's " +
        "offline screen and an installed launch will show the browser's own error page when the " +
        "host is unreachable."
    );
  }
  if (!webCryptoAvailable) {
    limitations.push(
      "Web Crypto is unavailable on this origin, so this device's Crosslink identity is stored " +
        "without encryption at rest. Anything with access to this browser profile can read it."
    );
  }
  if (insecureTransportBlocked) {
    limitations.push(
      "This page is served over https, so the browser blocks insecure ws:// routes as mixed " +
        "content. The host must advertise a wss:// route — a relay or a tunnel — for this " +
        "install to reach it."
    );
  }

  return {
    origin,
    secureContext,
    serviceWorkerAvailable,
    webCryptoAvailable,
    standalone: isStandaloneDisplay(),
    installable: secureContext && serviceWorkerAvailable,
    insecureTransportBlocked,
    limitations
  };
}
