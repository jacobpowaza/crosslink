// Crosslink serving the mobile bootstrap is the piece that removes the manifest,
// the service worker, the icons, the SDK bundle and the install route from every
// application. These tests assert the developer's page comes back installable
// without the developer having written any of that.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createBootstrapHandler,
  injectBootstrap,
  renderInjectedHead,
  isSecureContextRequest,
  type BootstrapHostView
} from "./bootstrap-host.js";
import { writeStaticBootstrap } from "./static-bootstrap.js";

const DEVELOPER_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Notes</title>
</head>
<body>
  <div id="app">Notes</div>
  <script>window.__ranDeveloperScript = true;</script>
</body>
</html>
`;

let dir: string;
let server: http.Server;
let origin: string;

const view = (): BootstrapHostView => ({
  application: {
    id: "com.example.notes",
    name: "Example Notes",
    shortName: "Notes",
    accentColor: "#f97316",
    backgroundColor: "#101014",
    capabilities: ["notes.read", "notes.write"]
  },
  mobile: { entry: path.join(dir, "mobile.html"), assetDirs: [] },
  getInstallHandoff: (id) =>
    id === "a".repeat(32) ? { uri: "crosslink://pair?x=1", expiresAt: 123 } : null,
  bootstrapOrigin: () => origin
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "crosslink-bootstrap-"));
  await writeFile(path.join(dir, "mobile.html"), DEVELOPER_PAGE);
  await writeFile(path.join(dir, "styles.css"), "body { color: red }");

  const handler = createBootstrapHandler(view());
  server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500);
      res.end("handler failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function get(pathname: string): Promise<{ status: number; body: string; type: string }> {
  const res = await fetch(`${origin}${pathname}`);
  return {
    status: res.status,
    body: await res.text(),
    type: res.headers.get("content-type") ?? ""
  };
}

describe("Crosslink-served mobile bootstrap", () => {
  it("returns the developer's page with the installable head injected", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);

    // The developer's own markup survives untouched.
    expect(body).toContain('<div id="app">Notes</div>');
    expect(body).toContain("window.__ranDeveloperScript");

    // …and everything a phone needs around it is added.
    expect(body).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(body).toContain('name="apple-mobile-web-app-capable"');
    expect(body).toContain('content="Notes"');
    expect(body).toContain('<script src="/__crosslink/sdk.js"></script>');
    expect(body).toContain('<script src="/__crosslink/boot.js"></script>');
  });

  it("puts both Crosslink scripts before the page's own", async () => {
    const { body } = await get("/");
    // The page calls `crosslink.onConnected(...)`, so the object has to exist
    // before any of the developer's scripts run.
    expect(body.indexOf("/__crosslink/boot.js")).toBeLessThan(
      body.indexOf("window.__ranDeveloperScript")
    );
  });

  it("generates a manifest from the application metadata alone", async () => {
    const { status, body, type } = await get("/manifest.webmanifest");
    expect(status).toBe(200);
    expect(type).toContain("application/manifest+json");
    const manifest = JSON.parse(body);
    expect(manifest.name).toBe("Example Notes");
    expect(manifest.short_name).toBe("Notes");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toBe("#f97316");
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  it("serves a root-scoped service worker that precaches the shell", async () => {
    const { status, body, type } = await get("/sw.js");
    expect(status).toBe(200);
    expect(type).toContain("javascript");
    // Root scope matters: an installed app reopening on a deep path must still
    // be claimed by the worker, or the offline screen never gets to render.
    expect(body).toContain("PRECACHE_ASSETS");
    expect(body).toContain("/__crosslink/sdk.js");
  });

  it("serves the browser SDK so the application needs no bundler", async () => {
    const { status, body } = await get("/__crosslink/sdk.js");
    expect(status).toBe(200);
    expect(body).toContain("CrosslinkSDK");
    expect(body.length).toBeGreaterThan(1000);
  });

  it("serves a boot script carrying the application's own metadata", async () => {
    const { status, body } = await get("/__crosslink/boot.js");
    expect(status).toBe(200);
    expect(body).toContain("com.example.notes");
    expect(body).toContain("CrosslinkMobileBootstrap");
    expect(body).toContain("notes.write");
    // Loopback is a secure context, so the worker is registered here.
    expect(body).toContain('"secureContext":true');
  });

  it("generates an icon when the application supplies none", async () => {
    const res = await fetch(`${origin}/__crosslink/icon-192.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("resolves a live install handoff and refuses an unknown one", async () => {
    const ok = await get(`/__crosslink/install/${"a".repeat(32)}`);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).uri).toBe("crosslink://pair?x=1");

    const missing = await get(`/__crosslink/install/${"b".repeat(32)}`);
    expect(missing.status).toBe(404);
  });

  it("serves assets beside the entry and falls back to the entry for deep paths", async () => {
    const asset = await get("/styles.css");
    expect(asset.status).toBe(200);
    expect(asset.body).toContain("color: red");

    // An installed app can reopen on any path within scope.
    const deep = await get("/notes/42");
    expect(deep.status).toBe(200);
    expect(deep.body).toContain('<div id="app">Notes</div>');
  });

  it("refuses a path that escapes the entry's directory", async () => {
    const escaped = await get("/../../package.json");
    expect(escaped.body).not.toContain('"name"');
  });
});

describe("injection is conservative about what the page already declares", () => {
  it("does not add a second viewport or manifest when the page has its own", () => {
    const page = `<html><head><meta name="viewport" content="width=500" /><link rel="manifest" href="/mine.json" /></head><body></body></html>`;
    const out = injectBootstrap(page, renderInjectedHead(view(), "/icon.png"), "/boot.js", "/sdk.js");
    expect(out.match(/name="viewport"/g)).toHaveLength(1);
    expect(out).toContain('content="width=500"');
    expect(out.match(/rel="manifest"/g)).toHaveLength(1);
    expect(out).toContain("/mine.json");
  });
});

describe("secure-context detection", () => {
  const request = (headers: Record<string, string>, encrypted = false): http.IncomingMessage =>
    ({ headers, socket: { encrypted } }) as unknown as http.IncomingMessage;

  it("treats loopback and https as secure", () => {
    expect(isSecureContextRequest(request({ host: "localhost:8787" }))).toBe(true);
    expect(isSecureContextRequest(request({ host: "127.0.0.1:8787" }))).toBe(true);
    expect(isSecureContextRequest(request({ host: "example.com" }, true))).toBe(true);
    expect(isSecureContextRequest(request({ host: "example.com", "x-forwarded-proto": "https" }))).toBe(true);
  });

  it("treats a plain-http LAN address as insecure", () => {
    // This is the case that silently breaks the offline shell, so it must not
    // be reported optimistically.
    expect(isSecureContextRequest(request({ host: "192.168.1.83:8787" }))).toBe(false);
  });
});

describe("static bootstrap for a durable origin", () => {
  it("emits a self-contained, relatively-linked site", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "crosslink-static-"));
    try {
      const result = await writeStaticBootstrap({
        outDir,
        entry: path.join(dir, "mobile.html"),
        application: {
          id: "com.example.notes",
          name: "Example Notes",
          accentColor: "#f97316",
          capabilities: ["notes.read"]
        }
      });

      const files = await readdir(outDir);
      for (const required of [
        "index.html",
        "sw.js",
        "manifest.webmanifest",
        "crosslink-sdk.js",
        "crosslink-boot.js",
        "icon-192.png",
        // GitHub Pages runs Jekyll by default and would otherwise mangle the site.
        ".nojekyll"
      ]) {
        expect(files).toContain(required);
      }
      expect(result.files).toContain("index.html");

      const index = await readFile(path.join(outDir, "index.html"), "utf8");
      // Relative throughout: a project site is served from /<repo>/, and
      // absolute paths would 404 there only after publishing.
      expect(index).toContain('href="./manifest.webmanifest"');
      expect(index).toContain('src="./crosslink-sdk.js"');
      expect(index).toContain('<div id="app">Notes</div>');

      const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.webmanifest"), "utf8"));
      expect(manifest.start_url).toBe("./");
      expect(manifest.scope).toBe("./");

      const boot = await readFile(path.join(outDir, "crosslink-boot.js"), "utf8");
      expect(boot).toContain('"secureContext":true');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
