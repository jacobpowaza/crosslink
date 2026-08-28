/**
 * Emits Crosslink's mobile bootstrap as a static site.
 *
 * This exists because of a browser rule that no amount of framework code can
 * work around. An installed Crosslink app needs a *durable* origin:
 *
 *  - the service worker, its cache and the offline screen belong to an origin,
 *    and an origin is only secure over https (or loopback);
 *  - the origin is also the installed app's identity, so pinning it to today's
 *    LAN address means the install breaks when the DHCP lease changes, and
 *    breaks again the moment the phone leaves the network.
 *
 * A host's own LAN address fails both tests. So the durable origin is a static
 * site the developer publishes once — GitHub Pages, Codeberg Pages, any free
 * static host: no domain to buy, no certificate to obtain, no server to run,
 * and nothing to keep online, because the page is only a shell. Point
 * `pairing.bootstrapUrl` at it and every QR the host mints leads there.
 *
 * The desktop host is then something the shell *resolves*, not something the
 * origin encodes: the pairing payload arrives in the URL fragment, the trusted
 * device identity lives in the origin's storage, and reconnection re-discovers
 * whatever address the host has today.
 *
 * The trade-off that comes with it is real and is documented rather than
 * hidden: from an https origin the browser refuses `ws://`, so a published
 * bootstrap reaches the host over `wss://` routes only — a relay or a tunnel.
 * `describeMobileDelivery()` on the host reports which of these applies.
 */
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { generateServiceWorker } from "@crosslink/sdk-browser";
import {
  renderBootScript,
  type BootPayload,
  type MobileAttributionConfig
} from "./boot-script.js";
import { readBrowserBundle, renderIconPng, renderMarkSvg } from "./assets.js";

export interface StaticBootstrapOptions {
  /** Directory to write into. Created if missing. */
  outDir: string;
  application: {
    id: string;
    name: string;
    shortName?: string;
    icon?: string;
    accentColor?: string;
    backgroundColor?: string;
    textColor?: string;
    appearance?: "light" | "dark" | "auto";
    capabilities?: string[];
    offlineTitle?: string;
    offlineMessage?: string;
    display?: "standalone" | "minimal-ui" | "fullscreen";
  };
  /**
   * The developer's mobile HTML. Its body is served as the application, exactly
   * as the host serves it; omit it to emit a shell that only pairs and hands
   * off to a page hosted elsewhere.
   */
  entry?: string;
  /** Local files copied in beside the entry, e.g. icons and stylesheets. */
  assets?: string[];
  /** Presentation of the "Powered by Crosslink" badge on the mobile screens. */
  attribution?: MobileAttributionConfig | null;
}

export interface StaticBootstrapResult {
  outDir: string;
  files: string[];
}

const DEBUGGING_URL = "https://crosslink.mintlify.site/resources/debugging-mobile-reconnect";

/** Assets the worker precaches so an offline launch has a shell to render. */
export const STATIC_PRECACHE = [
  "./",
  "./index.html",
  "./crosslink-sdk.js",
  "./crosslink-boot.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./crosslink-mark.svg"
];

const GENERATED_FILE_NAMES = new Set([
  "index.html",
  "crosslink-sdk.js",
  "crosslink-boot.js",
  "manifest.webmanifest",
  "sw.js",
  "crosslink-mark.svg",
  "icon-192.png",
  "icon-512.png",
  ".nojekyll"
]);

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The shell used when the developer supplies no entry of their own.
 *
 * It renders nothing itself: `CrosslinkMobileBootstrap` owns every screen from
 * first pair through offline, and this document only gives it a body to draw
 * into. That is the point — the static site is Crosslink's, and the
 * application's UI is whatever the developer's entry contributes.
 */
function defaultEntryHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeAttribute(appName)}</title>
</head>
<body>
  <!-- Crosslink renders pairing, install, offline and reconnect screens here. -->
</body>
</html>
`;
}

/** Head tags that make the published shell installable. */
function headTags(options: StaticBootstrapOptions): string {
  const app = options.application;
  return [
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
    `<meta name="theme-color" content="${escapeAttribute(app.accentColor ?? "#38bdf8")}" />`,
    `<meta name="mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />`,
    `<meta name="apple-mobile-web-app-title" content="${escapeAttribute(app.shortName ?? app.name)}" />`,
    `<link rel="manifest" href="./manifest.webmanifest" />`,
    `<link rel="apple-touch-icon" href="./icon-192.png" />`,
    `<link rel="icon" href="./icon-192.png" />`
  ].join("\n    ");
}

function injectStatic(html: string, tags: string): string {
  const insert =
    `\n    ${tags}\n` +
    `    <script src="./crosslink-sdk.js"></script>\n` +
    `    <script src="./crosslink-boot.js"></script>\n  `;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${insert}</head>`);
  return `${insert}${html}`;
}

/**
 * Writes the publishable bootstrap.
 *
 * Relative URLs throughout, because a GitHub Pages project site is served from
 * `/<repo>/` rather than the domain root: absolute paths would 404 there, and
 * that failure appears only after publishing.
 */
export async function writeStaticBootstrap(
  options: StaticBootstrapOptions
): Promise<StaticBootstrapResult> {
  const app = options.application;
  const outDir = path.resolve(options.outDir);
  const assetOutputs = (options.assets ?? []).map((asset) => ({ asset, name: path.basename(asset) }));
  const copied = new Set<string>();
  for (const { asset, name } of assetOutputs) {
    if (GENERATED_FILE_NAMES.has(name)) {
      throw new Error(`static bootstrap asset ${JSON.stringify(asset)} would overwrite generated ${name}`);
    }
    if (copied.has(name)) {
      throw new Error(`static bootstrap assets contain duplicate output name ${name}`);
    }
    copied.add(name);
  }
  await mkdir(outDir, { recursive: true });

  const payload: BootPayload = {
    appId: app.id,
    appName: app.name,
    capabilities: app.capabilities ?? [],
    icon: "./icon-192.png",
    accentColor: app.accentColor ?? "#38bdf8",
    backgroundColor: app.backgroundColor ?? "#0b1120",
    textColor: app.textColor ?? null,
    appearance: app.appearance ?? "auto",
    serviceWorkerUrl: "./sw.js",
    // This is the intended deployment capability. The emitted boot script also
    // checks `window.isSecureContext` at runtime, so copying the directory to a
    // plain-HTTP host cannot make an optimistic Service Worker claim.
    secureContext: true,
    offlineTitle: app.offlineTitle ?? null,
    offlineMessage: app.offlineMessage ?? null,
    debuggingUrl: DEBUGGING_URL,
    attribution: options.attribution ?? null
  };

  const entryHtml = options.entry
    ? await readFile(options.entry, "utf8")
    : defaultEntryHtml(app.name);

  const manifest = {
    name: app.name,
    short_name: app.shortName ?? app.name,
    id: "./",
    start_url: "./",
    scope: "./",
    display: app.display ?? "standalone",
    theme_color: app.accentColor ?? "#38bdf8",
    background_color: app.backgroundColor ?? "#0b1120",
    icons: [
      { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "./icon-512.png", sizes: "512x512", type: "image/png" }
    ]
  };

  const written: string[] = [];
  const write = async (name: string, contents: string | Buffer): Promise<void> => {
    await writeFile(path.join(outDir, name), contents);
    written.push(name);
  };

  await write("index.html", injectStatic(entryHtml, headTags(options)));
  await write("crosslink-sdk.js", await readBrowserBundle());
  await write("crosslink-boot.js", renderBootScript(payload));
  await write("manifest.webmanifest", JSON.stringify(manifest, null, 2));
  await write(
    "sw.js",
    generateServiceWorker({
      version: `${app.id}-static-1`,
      precacheAssets: [
        ...STATIC_PRECACHE,
        ...assetOutputs.map(({ name }) => `./${name}`)
      ]
    })
  );
  await write("crosslink-mark.svg", renderMarkSvg(app.accentColor, app.backgroundColor));
  await write("icon-192.png", renderIconPng(192, app.accentColor ?? "#38bdf8"));
  await write("icon-512.png", renderIconPng(512, app.accentColor ?? "#38bdf8"));
  // GitHub Pages runs Jekyll by default, which drops files and directories
  // beginning with an underscore and can rewrite others. Publishing a service
  // worker without this produces a site that is subtly not what was emitted.
  await write(".nojekyll", "");

  for (const { asset, name } of assetOutputs) {
    await copyFile(asset, path.join(outDir, name));
    written.push(name);
  }

  return { outDir, files: written };
}
