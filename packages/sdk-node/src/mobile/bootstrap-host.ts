/**
 * The Crosslink mobile bootstrap surface.
 *
 * A phone that scans a Crosslink QR lands here. Everything it needs before the
 * application's own page can run — the manifest, the service worker, the icon,
 * the browser SDK, the install handoff endpoint — is generated and served by
 * the framework from the application's metadata. The developer supplies one
 * HTML file containing their mobile UI and nothing else.
 *
 * The surface is deliberately state-free with one exception: the install
 * handoff lookup, which is already a possession-of-an-opaque-id check. Pairing
 * codes are minted only on the loopback control surface, so nothing reachable
 * from the phone's network can ask this host to trust a new device.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  renderBootScript,
  type BootPayload,
  type MobileAttributionConfig
} from "./boot-script.js";
import { readBrowserBundle, renderIconPng, renderMarkSvg } from "./assets.js";
import { buildInstallStartUrl } from "../bootstrap.js";

/** Everything the bootstrap needs from the host, without importing the host. */
export interface BootstrapHostView {
  application: {
    id: string;
    name: string;
    shortName?: string;
    icon?: string;
    accentColor?: string;
    backgroundColor?: string;
    textColor?: string;
    appearance?: "light" | "dark" | "auto";
    capabilities: string[];
    offlineTitle?: string;
    offlineMessage?: string;
    display?: "standalone" | "minimal-ui" | "fullscreen";
    icons?: Array<{ src: string; sizes?: string; type?: string }>;
  };
  /** Presentation of the "Powered by Crosslink" badge on the mobile screens. */
  attribution?: MobileAttributionConfig | null;
  mobile: {
    /** Absolute path of the developer's mobile entry HTML. */
    entry: string;
    /** Extra directories served as static assets. */
    assetDirs: string[];
  };
  /** Resolves an opaque install handoff id, or null when it has lapsed. */
  getInstallHandoff(id: string): { uri: string; expiresAt: number } | null;
  /** Origin the phone reached this host on, when the host knows one. */
  bootstrapOrigin(): string | null;
}

const CROSSLINK_PREFIX = "/__crosslink/";
const SERVICE_WORKER_PATH = "/sw.js";
const MANIFEST_PATH = "/manifest.webmanifest";
const DEBUGGING_URL = "https://crosslink.mintlify.site/resources/debugging-mobile-reconnect";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json"
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin"
};

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  cacheControl = "no-cache, no-store, must-revalidate"
): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  res.writeHead(status, { "content-type": contentType, "cache-control": cacheControl });
  res.end(body);
}

/**
 * Whether the browser will treat this request's origin as a secure context.
 *
 * It decides two things at once: whether a service worker can register (so
 * whether the cached offline shell exists at all), and whether the install
 * prompt is available. Getting it wrong in the optimistic direction produces
 * the failure this framework is supposed to prevent — an installed app that
 * shows the browser's own "cannot connect to server" page.
 */
export function isSecureContextRequest(req: http.IncomingMessage): boolean {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const encrypted = Boolean((req.socket as { encrypted?: boolean }).encrypted);
  if (encrypted || forwardedProto === "https") return true;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Escapes a value for interpolation into an HTML attribute. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function iconPath(size: number): string {
  return `${CROSSLINK_PREFIX}icon-${size}.png`;
}

/**
 * The head Crosslink injects into the application's mobile page.
 *
 * These tags are what make an installed home-screen launch behave like an app
 * rather than a Safari tab, and getting one of them wrong is invisible until
 * somebody installs the result on a phone. Generating them from the host's
 * metadata is the point: an application states its name and colours once.
 */
export function renderInjectedHead(view: BootstrapHostView, appIcon: string): string {
  const app = view.application;
  const theme = app.accentColor ?? "#38bdf8";
  const background = app.backgroundColor ?? "#0b1120";
  return [
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
    `<meta name="theme-color" content="${attr(theme)}" />`,
    `<meta name="background-color" content="${attr(background)}" />`,
    `<meta name="mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
    `<meta name="apple-mobile-web-app-title" content="${attr(app.shortName ?? app.name)}" />`,
    `<link rel="manifest" href="${MANIFEST_PATH}" />`,
    `<link rel="apple-touch-icon" href="${attr(appIcon)}" />`,
    `<link rel="icon" href="${attr(appIcon)}" />`
  ].join("\n    ");
}

/**
 * Injects the Crosslink head and scripts into the application's page.
 *
 * Injection rather than a template because the page belongs to the developer:
 * they write ordinary HTML for their application, and Crosslink adds the tags
 * that make it installable and the script that connects it. A page that
 * already declares a manifest or a viewport keeps its own — an application
 * that has gone to the trouble of specifying one means it.
 */
export function injectBootstrap(
  html: string,
  headTags: string,
  bootScriptUrl: string,
  sdkUrl: string
): string {
  let out = html;
  const existing = (pattern: RegExp): boolean => pattern.test(out);

  const tags = headTags
    .split("\n")
    .filter((tag) => {
      if (/name="viewport"/.test(tag) && existing(/<meta[^>]+name=["']viewport["']/i)) return false;
      if (/rel="manifest"/.test(tag) && existing(/<link[^>]+rel=["']manifest["']/i)) return false;
      if (/name="theme-color"/.test(tag) && existing(/<meta[^>]+name=["']theme-color["']/i)) return false;
      return true;
    })
    .join("\n");

  // Both scripts go in the head, in order and without `defer`. The page's own
  // scripts call `crosslink.onConnected(...)`, so the object has to exist
  // before any of them run; the boot script itself waits for DOMContentLoaded
  // before rendering anything, so nothing races the body.
  const headInsert =
    `\n    ${tags.trim()}\n` +
    `    <script src="${sdkUrl}"></script>\n` +
    `    <script src="${bootScriptUrl}"></script>\n  `;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${headInsert}</head>`);
  } else {
    out = `${headInsert}${out}`;
  }
  return out;
}

/** Precache list for the generated worker: the shell, not the application data. */
export function bootstrapPrecacheAssets(): string[] {
  return [
    "/",
    `${CROSSLINK_PREFIX}sdk.js`,
    `${CROSSLINK_PREFIX}boot.js`,
    MANIFEST_PATH,
    iconPath(192),
    iconPath(512),
    `${CROSSLINK_PREFIX}mark.svg`
  ];
}

export interface BootstrapHandlerOptions {
  /** Called for a request the bootstrap surface does not own. */
  fallback?(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>;
  /** Overrides the generated service worker, for tests. */
  serviceWorkerSource?(precache: string[]): string;
}

/**
 * Builds the HTTP handler for the phone-facing bootstrap surface.
 *
 * Mounted on the same port as the Crosslink transport, so the installable page
 * and the socket it opens share an origin and a router mapping.
 */
export function createBootstrapHandler(
  view: BootstrapHostView,
  options: BootstrapHandlerOptions = {}
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const entryDir = path.dirname(path.resolve(view.mobile.entry));
  const roots = [entryDir, ...view.mobile.assetDirs.map((dir) => path.resolve(dir))];

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
    const requested = decodeURIComponent(pathname).replace(/^\/+/, "");
    if (!requested) return false;
    for (const root of roots) {
      const resolved = path.resolve(root, requested);
      // The separator is part of the check: without it a sibling directory
      // whose name merely starts with the root's name would pass.
      if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
      try {
        const info = await stat(resolved);
        if (!info.isFile()) continue;
        const body = await readFile(resolved);
        send(res, 200, MIME[path.extname(resolved)] ?? "application/octet-stream", body);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  function appIconUrl(): string {
    return view.application.icon ?? iconPath(192);
  }

  function manifest(installId?: string): unknown {
    const app = view.application;
    const icons = app.icons ?? [
      { src: appIconUrl(), sizes: "192x192", type: "image/png" },
      { src: app.icon ?? iconPath(512), sizes: "512x512", type: "image/png" }
    ];
    const valid = installId && installId.length >= 24 && installId.length <= 256 ? installId : undefined;
    return {
      name: app.name,
      short_name: app.shortName ?? app.name,
      id: "/",
      start_url: valid ? buildInstallStartUrl("/", valid) : "/",
      scope: "/",
      display: app.display ?? "standalone",
      theme_color: app.accentColor ?? "#38bdf8",
      background_color: app.backgroundColor ?? "#0b1120",
      icons
    };
  }

  function bootPayload(secure: boolean): BootPayload {
    const app = view.application;
    return {
      appId: app.id,
      appName: app.name,
      capabilities: app.capabilities,
      icon: appIconUrl(),
      accentColor: app.accentColor ?? "#38bdf8",
      backgroundColor: app.backgroundColor ?? "#0b1120",
      textColor: app.textColor ?? null,
      appearance: app.appearance ?? "auto",
      serviceWorkerUrl: SERVICE_WORKER_PATH,
      secureContext: secure,
      offlineTitle: app.offlineTitle ?? null,
      offlineMessage: app.offlineMessage ?? null,
      debuggingUrl: DEBUGGING_URL,
      attribution: view.attribution ?? null
    };
  }

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://crosslink.invalid");
    const pathname = url.pathname;

    if (pathname === MANIFEST_PATH) {
      send(
        res,
        200,
        "application/manifest+json",
        JSON.stringify(manifest(url.searchParams.get("crosslink_install") ?? undefined))
      );
      return;
    }

    if (pathname === SERVICE_WORKER_PATH) {
      const precache = bootstrapPrecacheAssets();
      const source = options.serviceWorkerSource
        ? options.serviceWorkerSource(precache)
        : (await import("@crosslink/sdk-browser")).generateServiceWorker({
            version: `${view.application.id}-1`,
            precacheAssets: precache
          });
      // Served from the root so the worker's scope covers the whole origin —
      // an installed app that reopens on a deep path must still be claimed by
      // the worker, or the offline screen never gets a chance to render.
      send(res, 200, "text/javascript; charset=utf-8", source, "no-cache");
      return;
    }

    if (pathname === `${CROSSLINK_PREFIX}sdk.js`) {
      send(res, 200, "text/javascript; charset=utf-8", await readBrowserBundle(), "public, max-age=300");
      return;
    }

    if (pathname === `${CROSSLINK_PREFIX}boot.js`) {
      send(res, 200, "text/javascript; charset=utf-8", renderBootScript(bootPayload(isSecureContextRequest(req))));
      return;
    }

    if (pathname === `${CROSSLINK_PREFIX}mark.svg`) {
      send(
        res,
        200,
        "image/svg+xml",
        renderMarkSvg(view.application.accentColor, view.application.backgroundColor),
        "public, max-age=3600"
      );
      return;
    }

    const iconMatch = pathname.match(/^\/__crosslink\/icon-(\d{2,4})\.png$/);
    if (iconMatch) {
      const size = Math.min(1024, Math.max(16, Number(iconMatch[1])));
      send(res, 200, "image/png", renderIconPng(size, view.application.accentColor ?? "#38bdf8"), "public, max-age=3600");
      return;
    }

    if (pathname.startsWith(`${CROSSLINK_PREFIX}install/`)) {
      const handoffId = decodeURIComponent(pathname.slice(`${CROSSLINK_PREFIX}install/`.length));
      const handoff = view.getInstallHandoff(handoffId);
      send(
        res,
        handoff ? 200 : 404,
        "application/json",
        JSON.stringify(handoff ?? { error: "install handoff unavailable or expired" })
      );
      return;
    }

    if (pathname === `${CROSSLINK_PREFIX}app.json`) {
      send(res, 200, "application/json", JSON.stringify(bootPayload(isSecureContextRequest(req))));
      return;
    }

    // A file request that names a real asset wins over the entry page; anything
    // else is a navigation, including the deep paths an installed app reopens
    // on, and must return the entry rather than a 404.
    if (path.extname(pathname) && (await serveStatic(res, pathname))) return;

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (options.fallback) {
        await options.fallback(req, res);
        return;
      }
      send(res, 405, "text/plain; charset=utf-8", "method not allowed");
      return;
    }

    try {
      const html = await readFile(view.mobile.entry, "utf8");
      const injected = injectBootstrap(
        html,
        renderInjectedHead(view, appIconUrl()),
        `${CROSSLINK_PREFIX}boot.js`,
        `${CROSSLINK_PREFIX}sdk.js`
      );
      send(res, 200, "text/html; charset=utf-8", injected);
    } catch (err) {
      if (options.fallback) {
        await options.fallback(req, res);
        return;
      }
      send(
        res,
        500,
        "text/plain; charset=utf-8",
        `Crosslink could not read the configured mobile entry (${view.mobile.entry}): ${(err as Error).message}`
      );
    }
  };
}
