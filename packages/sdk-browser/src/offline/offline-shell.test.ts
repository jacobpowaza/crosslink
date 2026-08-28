/**
 * Offline Shell and Service Worker tests
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  CrosslinkOfflineShell,
  createOfflineUI,
  generateServiceWorker,
  createServiceWorkerConfig,
  CrosslinkMobileBootstrap,
  isStandalone,
  resetDeviceStorage
} from "./index.js";
import {
  CapabilityRegistry,
  DeviceGrants,
  DeviceIdentity,
  DEVICE_LINK_RPC_METHOD,
  HostAcceptor,
  HostPairingManager,
  InMemoryHostDeviceStore,
  RpcRouter,
  buildPairingUri,
  linkPairingTarget,
  parsePairingUri,
  normalPairingTarget,
  type CrosslinkSession
} from "@crosslink/core";
import { bytesToBase64 } from "@crosslink/protocol";
import { CrosslinkClient } from "../client.js";
import { MockSocket } from "../mock-ws.js";
import { MemorySecureStorage } from "../storage.js";
import { wsTransport, type WsLike } from "../ws.js";

// Mock minimal DOM for node testing environment
class MockElement {
  tagName: string;
  id = "";
  className = "";
  textContent = "";
  value = "";
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Function[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get innerHTML(): string {
    let out = this.textContent;
    for (const c of this.children) {
      out += c.innerHTML;
    }
    return out;
  }
  set innerHTML(val: string) {
    this.textContent = val;
  }

  appendChild(el: MockElement) {
    el.parentElement = this;
    this.children.push(el);
    return el;
  }

  append(...els: MockElement[]) {
    for (const el of els) this.appendChild(el);
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }

  querySelector(sel: string): MockElement | null {
    for (const child of this.children) {
      if (sel === "button" && child.tagName === "BUTTON") return child;
      if (sel.startsWith("#") && child.id === sel.slice(1)) return child;
      if (sel.startsWith(".") && child.className.includes(sel.slice(1))) return child;
      const found = child.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(sel: string): MockElement[] {
    const out: MockElement[] = [];
    for (const child of this.children) {
      if (sel.startsWith(".") && child.className.includes(sel.slice(1))) out.push(child);
      out.push(...child.querySelectorAll(sel));
    }
    return out;
  }

  setAttribute(name: string, val: string) {
    this.attributes[name] = val;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  addEventListener(ev: string, fn: Function) {
    this.listeners[ev] = this.listeners[ev] || [];
    this.listeners[ev].push(fn);
  }

  removeEventListener(ev: string, fn: Function) {
    if (this.listeners[ev]) {
      const idx = this.listeners[ev].indexOf(fn);
      if (idx >= 0) this.listeners[ev].splice(idx, 1);
    }
  }

  focus() {}

  contains(el: MockElement): boolean {
    return this.children.includes(el);
  }
}

const windowListeners: Record<string, Function[]> = {};
const docListeners: Record<string, Function[]> = {};

const mockDoc = {
  createElement: (tag: string) => new MockElement(tag),
  getElementById: (id: string) => null,
  head: new MockElement("head"),
  body: new MockElement("body"),
  hidden: false,
  addEventListener: (ev: string, fn: Function) => {
    docListeners[ev] = docListeners[ev] || [];
    docListeners[ev].push(fn);
  },
  removeEventListener: (ev: string, fn: Function) => {
    if (docListeners[ev]) {
      const idx = docListeners[ev].indexOf(fn);
      if (idx >= 0) docListeners[ev].splice(idx, 1);
    }
  }
};

const mockWindow = {
  addEventListener: (ev: string, fn: Function) => {
    windowListeners[ev] = windowListeners[ev] || [];
    windowListeners[ev].push(fn);
  },
  removeEventListener: (ev: string, fn: Function) => {
    if (windowListeners[ev]) {
      const idx = windowListeners[ev].indexOf(fn);
      if (idx >= 0) windowListeners[ev].splice(idx, 1);
    }
  }
};

const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => storageMap.set(k, String(v)),
  removeItem: (k: string) => storageMap.delete(k),
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => Array.from(storageMap.keys())[i] ?? null
};

(globalThis as any).document = mockDoc;
(globalThis as any).window = mockWindow;
(globalThis as any).localStorage = mockLocalStorage;

const SIGNALING_URL = "https://signal.test";
const RELAY_URL = "https://relay.test";
const APP_ID = "com.example.testapp";

function makeHost() {
  const identity = DeviceIdentity.create();
  const store = new InMemoryHostDeviceStore();
  const grants = new DeviceGrants();
  const registry = new CapabilityRegistry().registerAll([
    { id: "test.ping", title: "Ping", risk: "low", defaultGranted: true }
  ]);

  const router = new RpcRouter(() => grants, { ratePerSec: 1000 }, { registry });
  router.expose("test.ping", () => "pong", { capability: "test.ping" });

  const pairing = new HostPairingManager({
    identity,
    appId: APP_ID,
    registry,
    store,
    grants,
    autoApprove: true,
    policy: { maxAutoGrantRisk: "low" }
  });

  router.expose(DEVICE_LINK_RPC_METHOD, (_input, ctx) => {
    const session = pairing.beginLinkSession(ctx.deviceId);
    return {
      handoffId: session.code,
      expiresAt: session.expiresAt,
      uri: buildPairingUri({
        endpoints: [{ kind: "sig", url: SIGNALING_URL }],
        code: session.code,
        appId: APP_ID,
        appName: "TestApp",
        hostPubEdB64: bytesToBase64(identity.edPublicKey),
        link: true
      })
    };
  });

  const accept = (socket: MockSocket): void => {
    let active: CrosslinkSession | undefined;
    new HostAcceptor(
      wsTransport(socket, "crosslink-relayed"),
      { identity, appId: APP_ID, lookupDevice: (id) => store.get(id) },
      {
        onMessage: (msg, session) => router.handleMessage(session, msg),
        onSession: (session) => {
          active = session;
        },
        onClose: () => {
          if (active) router.handleSessionClosed(active);
        }
      }
    );
  };

  return { identity, store, grants, registry, router, pairing, accept };
}

function attachSignaling(serviceSocket: MockSocket, host: ReturnType<typeof makeHost>): void {
  const hostConn = "host-conn-1";
  serviceSocket.addEventListener("message", (ev) => {
    const msg = JSON.parse(String((ev as { data: unknown }).data)) as Record<string, unknown>;
    const reply = (frame: object): void => {
      if (serviceSocket.readyState === 1) serviceSocket.send(JSON.stringify(frame));
    };

    if (msg.op === "pair_resolve") {
      const psid = host.pairing.resolveCode(String(msg.code));
      if (!psid) {
        reply({ op: "pair_not_found" });
        return;
      }
      reply({
        op: "pair_found",
        psid,
        host_conn: hostConn,
        app: {
          appId: APP_ID,
          name: "TestApp",
          fingerprint: host.identity.fingerprint,
          pubEdB64: bytesToBase64(host.identity.edPublicKey),
          pubXB64: bytesToBase64(host.identity.xPublicKey),
          relay: { url: RELAY_URL, channel: "chan-1" }
        }
      });
      return;
    }

    if (msg.op === "pair_payload") {
      const blob = JSON.parse(String(msg.blob)) as Record<string, unknown>;
      const deliver = (frame: object): void =>
        reply({ op: "pair_deliver", from: hostConn, blob: JSON.stringify(frame) });
      if (blob.kind === "pair_claim") {
        void host.pairing.handleClaim(blob, deliver);
      } else if (blob.kind === "pair_complete") {
        try {
          host.pairing.handleComplete(blob, deliver);
        } catch {}
      }
    }
  });
}

function makeHarness() {
  storageMap.clear();
  const host = makeHost();
  const storage = new MemorySecureStorage();
  let failRelay = false;

  const webSocket = (url: string): WsLike => {
    if (url.includes("signal.test")) {
      const [clientEnd, serviceEnd] = MockSocket.pair(url, `${url}#service`);
      attachSignaling(serviceEnd, host);
      return clientEnd;
    }
    if (failRelay) {
      const [sock] = MockSocket.pair(url);
      setTimeout(() => sock.close(1006, "Host offline"), 1);
      return sock;
    }
    const [clientEnd, hostEnd] = MockSocket.pair(url, `${url}#host`);
    queueMicrotask(() => host.accept(hostEnd));
    return clientEnd;
  };

  const fakeFetch = (async () => ({
    ok: true,
    json: async () => ({ relay: { url: RELAY_URL, channel: "chan-1" } })
  })) as unknown as typeof fetch;

  const createClient = (clientStorage: MemorySecureStorage, deviceName = "Test Browser") =>
    new CrosslinkClient({
      storage: clientStorage,
      deviceName,
      onConfirmPairing: () => true,
      requestTimeoutMs: 3000,
      webSocket,
      fetch: fakeFetch,
      dialTimeoutMs: 100
    });
  const client = createClient(storage);

  const session = host.pairing.beginSession();
  const pairingUri = buildPairingUri({
    endpoints: [{ kind: "sig", url: SIGNALING_URL }],
    code: session.code,
    appId: APP_ID,
    appName: "TestApp",
    hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
  });

  return {
    host,
    client,
    storage,
    createClient,
    pairingUri,
    setFailRelay: (val: boolean) => { failRelay = val; }
  };
}

function installWebAppContext(
  url: string,
  standalone: boolean,
  initialCookies: Map<string, string> = new Map()
) {
  const cookies = new Map(initialCookies);
  let current = new URL(url);
  const manifest = new MockElement("link") as MockElement & { href: string };
  manifest.href = new URL("/manifest.webmanifest", current).toString();

  Object.defineProperty(mockDoc, "cookie", {
    configurable: true,
    get: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    set: (raw: string) => {
      const [pair, ...attrs] = raw.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired) cookies.delete(name);
      else cookies.set(name, value);
    }
  });
  (mockDoc as any).querySelector = (selector: string) =>
    selector === 'link[rel="manifest"]' ? manifest : null;

  const locationMock = {
    get href() { return current.toString(); },
    set href(value: string) { current = new URL(value, current); },
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get hash() { return current.hash; },
    set hash(value: string) { current.hash = value; },
    get protocol() { return current.protocol; }
  };
  const historyMock = {
    state: null,
    replaceState(_state: unknown, _title: string, next: string) {
      current = new URL(next, current);
    }
  };
  (mockWindow as any).matchMedia = () => ({ matches: standalone });
  (mockWindow as any).navigator = { standalone };
  (globalThis as any).location = locationMock;
  (globalThis as any).history = historyMock;

  return {
    cookies,
    manifest,
    url: () => current.toString(),
    cleanup() {
      delete (globalThis as any).location;
      delete (globalThis as any).history;
      delete (mockWindow as any).matchMedia;
      delete (mockWindow as any).navigator;
      delete (mockDoc as any).querySelector;
      delete (mockDoc as any).cookie;
    }
  };
}

describe("Service Worker generation", () => {
  it("generates a valid service worker with default config", () => {
    const sw = generateServiceWorker();
    expect(sw).toContain("const CACHE_NAME = \"crosslink-shell-v2.0.0\";");
    expect(sw).toContain("./mobile.html");
    expect(sw).toContain("./bundle.js");
    expect(sw).toContain("isSecuritySensitive");
    expect(sw).toContain("/api/");
    expect(sw).toContain("/pair");
    expect(sw).toContain("/challenge");
    expect(sw).toContain('url.searchParams.has("crosslink_install")');
    expect(sw).toContain('fetch(request, { cache: "no-store" })');
    expect(sw).toContain("const NAVIGATION_TIMEOUT_MS = 4000;");
    expect(sw).toContain("fetchNavigation(request)");
  });

  it("respects custom version and precache assets", () => {
    const sw = generateServiceWorker({
      version: "2.4.0",
      precacheAssets: ["/custom-app.html", "/app.js", "/logo.png"],
      navigationTimeoutMs: 2500
    });
    expect(sw).toContain("const CACHE_NAME = \"crosslink-shell-v2.4.0\";");
    expect(sw).toContain("/custom-app.html");
    expect(sw).toContain("/app.js");
    expect(sw).toContain("/logo.png");
    expect(sw).toContain("const NAVIGATION_TIMEOUT_MS = 2500;");
  });

  it("creates service worker config from PWA config", () => {
    const cfg = createServiceWorkerConfig({
      version: "3.0.0",
      startUrl: "/start.html",
      icons: [{ src: "/icon-custom.png", sizes: "192x192" }]
    });
    expect(cfg.version).toBe("3.0.0");
    expect(cfg.precacheAssets).toContain("/start.html");
    expect(cfg.precacheAssets).toContain("/icon-custom.png");
  });
});

describe("Offline UI creation", () => {
  it("creates an offline UI element with custom branding", () => {
    const onRetry = vi.fn();
    const el = createOfflineUI({
      title: "My Custom App is offline",
      message: "Please open My Custom App on your laptop.",
      appName: "My Custom App",
      icon: "/custom-icon.png",
      themeColor: "#1e293b",
      bgColor: "#0f172a"
    }, onRetry);

    expect(el.id).toBe("crosslink-offline-shell");
    expect(el.innerHTML).toContain("My Custom App is offline");
    expect(el.innerHTML).toContain("Please open My Custom App on your laptop.");

    // Test retry button
    const retryBtn = el.querySelector("button") as any;
    expect(retryBtn).not.toBeNull();
    retryBtn?.onclick?.({} as any);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("CrosslinkOfflineShell", () => {
  it("transitions to authentication-required when no paired apps exist", async () => {
    const onAuthRequired = vi.fn();
    const onConnected = vi.fn();
    const onStateChange = vi.fn();

    const client = new CrosslinkClient({ storage: new MemorySecureStorage() });
    const shell = new CrosslinkOfflineShell({
      client,
      autoRegisterServiceWorker: false,
      autoMountOfflineUI: false,
      onConnected,
      onAuthRequired,
      onStateChange
    });

    await shell.start();

    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(shell.getState()).toBe("authentication-required");
  });

  it("silently authenticates and connects when host is online", async () => {
    const { client, pairingUri } = makeHarness();

    // 1. Initial pairing
    await client.pairFromQr(pairingUri, ["test.ping"]);

    const onConnected = vi.fn();
    const onAuthRequired = vi.fn();

    // 2. Launch offline shell with existing paired client
    const shell = new CrosslinkOfflineShell({
      client,
      autoRegisterServiceWorker: false,
      autoMountOfflineUI: false,
      onConnected,
      onAuthRequired
    });

    await shell.start();

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onAuthRequired).not.toHaveBeenCalled();
    expect(shell.getState()).toBe("connected");

    shell.destroy();
  });

  it("enters host-offline state when host is unreachable without clearing credentials", async () => {
    const { client, pairingUri, setFailRelay } = makeHarness();

    // 1. Initial pairing
    await client.pairFromQr(pairingUri, ["test.ping"]);

    // Set host offline
    setFailRelay(true);

    const onConnected = vi.fn();
    const onAuthRequired = vi.fn();
    const onStateChange = vi.fn();

    const shell = new CrosslinkOfflineShell({
      client,
      autoRegisterServiceWorker: false,
      autoMountOfflineUI: false,
      onConnected,
      onAuthRequired,
      onStateChange,
      minRetryDelay: 100,
      maxRetryDelay: 500
    });

    await shell.start();

    expect(shell.getState()).toBe("host-offline");
    expect(onConnected).not.toHaveBeenCalled();
    expect(onAuthRequired).not.toHaveBeenCalled();

    // Verify stored app credentials remain intact
    expect(client.listApps().length).toBe(1);
    expect(client.listApps()[0].appId).toBe(APP_ID);

    shell.destroy();
  });

  it("automatically recovers and silent-authenticates when host comes back online", async () => {
    const { client, pairingUri, setFailRelay } = makeHarness();

    // 1. Initial pairing
    await client.pairFromQr(pairingUri, ["test.ping"]);

    // 2. Host is offline initially
    setFailRelay(true);

    const onConnected = vi.fn();
    const onAuthRequired = vi.fn();

    const shell = new CrosslinkOfflineShell({
      client,
      autoRegisterServiceWorker: false,
      autoMountOfflineUI: false,
      minRetryDelay: 50,
      maxRetryDelay: 100,
      onConnected,
      onAuthRequired
    });

    await shell.start();
    expect(shell.getState()).toBe("host-offline");
    expect(onConnected).not.toHaveBeenCalled();

    // 3. Host comes back online!
    setFailRelay(false);

    // Trigger reconnect
    await shell.forceReconnect();

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(shell.getState()).toBe("connected");

    shell.destroy();
  });

  it("reconnects on online and visibilitychange events", async () => {
    const { client, pairingUri, setFailRelay } = makeHarness();

    await client.pairFromQr(pairingUri, ["test.ping"]);
    setFailRelay(true);

    const onConnected = vi.fn();
    const onAuthRequired = vi.fn();

    const shell = new CrosslinkOfflineShell({
      client,
      autoRegisterServiceWorker: false,
      autoMountOfflineUI: false,
      onConnected,
      onAuthRequired
    });

    await shell.start();
    expect(shell.getState()).toBe("host-offline");

    // Host comes back
    setFailRelay(false);

    // Simulate window online event
    for (const listener of windowListeners["online"] || []) {
      listener();
    }

    // Wait a tick
    await new Promise(r => setTimeout(r, 50));

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(shell.getState()).toBe("connected");

    shell.destroy();
  });

  it("transitions to authentication-failed when device is revoked", async () => {
    const { host, client, pairingUri } = makeHarness();

    // 1. Initial pairing
    await client.pairFromQr(pairingUri, ["test.ping"]);

    // 2. Revoke the device on host side
    host.store.revoke(client.deviceId, Date.now());

    const onConnected = vi.fn();
    const onAuthRequired = vi.fn();

    const shell = new CrosslinkOfflineShell({
      client,
      autoRegisterServiceWorker: false,
      autoMountOfflineUI: false,
      onConnected,
      onAuthRequired
    });

    await shell.start();

    // Revocation must trigger authentication-failed / auth-required
    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(shell.getState()).toBe("authentication-failed");

    shell.destroy();
  });
});

describe("CrosslinkMobileBootstrap State Machine & Security Flow", () => {
  it("uses persistent browser storage for its default client identity", () => {
    storageMap.clear();
    const first = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      autoRegisterServiceWorker: false,
      onAuthorized: vi.fn()
    });
    const firstId = first.getClient().deviceId;
    first.destroy();

    const reloaded = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      autoRegisterServiceWorker: false,
      onAuthorized: vi.fn()
    });
    expect(reloaded.getClient().deviceId).toBe(firstId);
    reloaded.destroy();
  });

  it("Scenario 1 & 13: Brand-new phone scans QR -> Pairing Screen appears, app is blocked from mounting", async () => {
    const { client, pairingUri } = makeHarness();
    const onAuthorized = vi.fn();
    const onUnauthorized = vi.fn();
    const onStateChange = vi.fn();

    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      appName: "TestApp",
      client,
      pairingUri,
      autoRegisterServiceWorker: false,
      onAuthorized,
      onUnauthorized,
      onStateChange
    });

    await bootstrap.start();

    // 1. Must be in pairing-required state
    expect(bootstrap.getState()).toBe("pairing-required");
    // 2. Developer app must NOT be mounted / authorized
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    bootstrap.destroy();
  });

  it("Scenario 2: Incorrect pairing code -> pairing fails and remains in pairing-required", async () => {
    const { client, pairingUri } = makeHarness();
    const onAuthorized = vi.fn();

    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      appName: "TestApp",
      client,
      pairingUri,
      autoRegisterServiceWorker: false,
      onAuthorized
    });

    await bootstrap.start();

    // Attempt pairing with invalid code
    await expect(client.pairWithCode(pairingUri, "000000000", ["test.ping"])).rejects.toThrow();

    expect(bootstrap.getState()).toBe("pairing-required");
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(client.listApps().length).toBe(0);

    bootstrap.destroy();
  });

  it("Scenario 3, 4, 5: Correct pairing code -> device added to host, enters Add to Home Screen, then mounts app on continue", async () => {
    const { host, client, pairingUri } = makeHarness();
    const onAuthorized = vi.fn();
    const onUnauthorized = vi.fn();
    const stateTransitions: string[] = [];

    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      appName: "TestApp",
      client,
      pairingUri,
      autoRegisterServiceWorker: false,
      onAuthorized,
      onUnauthorized,
      onStateChange: (st) => stateTransitions.push(st)
    });

    await bootstrap.start();
    expect(bootstrap.getState()).toBe("pairing-required");

    // Perform pairing with correct code
    const parsedUri = parsePairingUri(pairingUri);
    await client.pairWithCode(pairingUri, parsedUri.code, ["test.ping"]);

    // Device now stored on host
    expect(host.store.list().length).toBe(1);
    expect(host.store.list()[0].deviceId).toBe(client.deviceId);

    // Trigger state transition after pairing
    await bootstrap.forceReconnect();

    // In non-standalone browser mode without onboarding completed, must show Add to Home Screen
    expect(bootstrap.getState()).toBe("add-to-home-screen");
    expect(onAuthorized).not.toHaveBeenCalled();

    // Now simulate user clicking "Continue in Browser"
    (bootstrap as any).markOnboardingCompleted(APP_ID);
    (bootstrap as any).transitionTo("authorized");

    expect(bootstrap.getState()).toBe("authorized");
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(host.store.list()).toHaveLength(1);

    bootstrap.destroy();
  });

  it("transfers trust from Safari cookies into a storage-isolated standalone identity and survives reload", async () => {
    const h = makeHarness();
    const parsed = parsePairingUri(h.pairingUri);
    await h.client.pairWithCode(h.pairingUri, parsed.code, ["test.ping"]);

    const safari = installWebAppContext(
      `https://app.test/mobile.html#pair=${encodeURIComponent(h.pairingUri)}`,
      false
    );
    const safariBootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      client: h.client,
      autoRegisterServiceWorker: false,
      onAuthorized: vi.fn()
    });
    await safariBootstrap.start();

    expect(safariBootstrap.getState()).toBe("add-to-home-screen");
    expect(safari.cookies.has("crosslink_install")).toBe(true);
    expect(safari.cookies.has("crosslink_install_context")).toBe(true);
    expect(safari.manifest.href).toContain("crosslink_install=");
    expect(safari.url()).toContain("crosslink_install=");
    expect(safari.url()).not.toContain("%3Fl%3D1");
    expect(h.host.store.list()).toHaveLength(1);

    const copiedCookies = new Map(safari.cookies);
    const installId = new URL(safari.url()).searchParams.get("crosslink_install");
    expect(installId).toBeTruthy();
    safariBootstrap.destroy();
    safari.cleanup();

    const standaloneStorage = new MemorySecureStorage();
    const installedClient = h.createClient(standaloneStorage, "Home Screen PWA");
    expect(installedClient.deviceId).not.toBe(h.client.deviceId);
    expect(installedClient.listApps()).toHaveLength(0);

    const standalone = installWebAppContext(
      `https://app.test/mobile.html?crosslink_install=${encodeURIComponent(installId!)}`,
      true,
      copiedCookies
    );
    const onAuthorized = vi.fn();
    const installedBootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      client: installedClient,
      capabilities: ["test.ping"],
      autoRegisterServiceWorker: false,
      onAuthorized
    });
    await installedBootstrap.start();

    expect(installedBootstrap.getState()).toBe("authorized");
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    const installedRecord = h.host.store.get(installedClient.deviceId);
    expect(installedRecord?.linkedFrom).toBe(h.client.deviceId);
    expect(h.host.store.list()).toHaveLength(2);
    expect(standalone.cookies.has("crosslink_install")).toBe(false);
    installedBootstrap.destroy();
    standalone.cleanup();

    // A fresh JS/client instance in the same standalone storage must reconnect
    // as B; it must not need or attempt a second handoff redemption.
    const reloadedClient = h.createClient(standaloneStorage, "Home Screen PWA");
    expect(reloadedClient.deviceId).toBe(installedClient.deviceId);
    const reloadContext = installWebAppContext("https://app.test/mobile.html", true);
    const reloadAuthorized = vi.fn();
    const reloadBootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      client: reloadedClient,
      autoRegisterServiceWorker: false,
      onAuthorized: reloadAuthorized
    });
    await reloadBootstrap.start();
    expect(reloadBootstrap.getState()).toBe("authorized");
    expect(reloadAuthorized).toHaveBeenCalledTimes(1);
    expect(h.host.store.list()).toHaveLength(2);

    h.host.store.revoke(h.client.deviceId, Date.now());
    await reloadBootstrap.forceReconnect();
    expect(h.host.store.get(h.client.deviceId)?.revokedAt).toBeDefined();
    expect(h.host.store.get(reloadedClient.deviceId)?.revokedAt).toBeDefined();
    expect(reloadBootstrap.getState()).toBe("pairing-required");
    reloadBootstrap.destroy();
    reloadContext.cleanup();
  });

  it("recovers from the dedicated install start URL when no Safari cookie is available", async () => {
    const h = makeHarness();
    const parsed = parsePairingUri(h.pairingUri);
    await h.client.pairWithCode(h.pairingUri, parsed.code, ["test.ping"]);
    await h.client.connect(APP_ID);
    const handoff = await h.client.createDeviceLink();

    const standalone = installWebAppContext(
      `https://app.test/mobile.html?crosslink_install=${encodeURIComponent(handoff.handoffId)}`,
      true
    );
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async (input: string | URL | Request) => ({
      ok: String(input).includes("/__crosslink/install/"),
      json: async () => ({ uri: handoff.uri, expiresAt: handoff.expiresAt })
    }));
    const installedClient = h.createClient(new MemorySecureStorage(), "Start URL PWA");
    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      client: installedClient,
      autoRegisterServiceWorker: false,
      onAuthorized: vi.fn()
    });
    await bootstrap.start();

    expect(bootstrap.getState()).toBe("authorized");
    expect(h.host.store.get(installedClient.deviceId)?.linkedFrom).toBe(h.client.deviceId);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/__crosslink/install/"),
      expect.objectContaining({ cache: "no-store", credentials: "same-origin" })
    );

    bootstrap.destroy();
    standalone.cleanup();
    (globalThis as any).fetch = originalFetch;
  });

  it("clears an expired install handoff before fresh normal manual pairing", async () => {
    const h = makeHarness();
    const target = normalPairingTarget(h.pairingUri);
    const invalidId = "expired-install-handoff-token-1234567890";
    const cookies = new Map([
      ["crosslink_install", encodeURIComponent(invalidId)],
      ["crosslink_install_context", encodeURIComponent(JSON.stringify({
        targetUri: target,
        expiresAt: Date.now() - 1
      }))]
    ]);
    const standalone = installWebAppContext(
      `https://app.test/mobile.html?crosslink_install=${invalidId}`,
      true,
      cookies
    );
    const client = h.createClient(new MemorySecureStorage(), "Fallback PWA");
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false }));
    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      client,
      autoRegisterServiceWorker: false,
      onAuthorized: vi.fn()
    });
    await bootstrap.start();
    expect(bootstrap.getState()).toBe("pairing-required");
    expect(standalone.cookies.has("crosslink_install")).toBe(false);
    expect(new URL(standalone.url()).searchParams.has("crosslink_install")).toBe(false);

    const normalSession = h.host.pairing.beginSession();
    await (bootstrap as any).handlePairingSubmit(normalSession.code.replace(/\D/g, ""));
    expect(bootstrap.getState()).toBe("authorized");
    expect(h.host.store.get(client.deviceId)?.linkedFrom).toBeUndefined();

    bootstrap.destroy();
    standalone.cleanup();
    (globalThis as any).fetch = originalFetch;
  });

  it("does not let a stale l=1 URI poison manual 9-digit pairing", async () => {
    const h = makeHarness();
    const stale = linkPairingTarget(h.pairingUri, "stale-install-handoff-token-1234567890");
    const standalone = installWebAppContext("https://app.test/mobile.html", true);
    const client = h.createClient(new MemorySecureStorage(), "Stale Marker PWA");
    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      client,
      pairingUri: stale,
      autoRegisterServiceWorker: false,
      onAuthorized: vi.fn()
    });
    await bootstrap.start();
    expect(bootstrap.getState()).toBe("pairing-required");

    const normalSession = h.host.pairing.beginSession();
    await (bootstrap as any).handlePairingSubmit(normalSession.code.replace(/\D/g, ""));
    expect(bootstrap.getState()).toBe("authorized");
    expect(h.host.store.get(client.deviceId)?.linkedFrom).toBeUndefined();

    bootstrap.destroy();
    standalone.cleanup();
  });

  it("Scenario 6 & 7: Returning trusted device in standalone mode -> skips pairing and onboarding", async () => {
    const { client, pairingUri } = makeHarness();
    const parsedUri = parsePairingUri(pairingUri);

    // Initial pair
    await client.pairWithCode(pairingUri, parsedUri.code, ["test.ping"]);

    // Mark onboarding completed (or standalone mode)
    (localStorage as any).setItem(`crosslink.onboarding.${APP_ID}`, "true");

    const onAuthorized = vi.fn();
    const onUnauthorized = vi.fn();

    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      appName: "TestApp",
      client,
      pairingUri,
      autoRegisterServiceWorker: false,
      onAuthorized,
      onUnauthorized
    });

    await bootstrap.start();

    // Skips pairing screen and onboarding, directly authorizes!
    expect(bootstrap.getState()).toBe("authorized");
    expect(onAuthorized).toHaveBeenCalledTimes(1);

    bootstrap.destroy();
  });

  it("Scenario 9 & 10: Revoked device on host -> credential rejected, returns to Pairing Screen, app hidden", async () => {
    const { host, client, pairingUri } = makeHarness();
    const parsedUri = parsePairingUri(pairingUri);

    await client.pairWithCode(pairingUri, parsedUri.code, ["test.ping"]);
    (localStorage as any).setItem(`crosslink.onboarding.${APP_ID}`, "true");

    const onAuthorized = vi.fn();
    const onUnauthorized = vi.fn();

    const bootstrap = new CrosslinkMobileBootstrap({
      appId: APP_ID,
      appName: "TestApp",
      client,
      pairingUri,
      autoRegisterServiceWorker: false,
      onAuthorized,
      onUnauthorized
    });

    await bootstrap.start();
    expect(bootstrap.getState()).toBe("authorized");
    expect(onAuthorized).toHaveBeenCalledTimes(1);

    // Developer revokes the device on host
    host.store.revoke(client.deviceId, Date.now());

    // Next connection attempt / state change rejects the device
    await bootstrap.forceReconnect();

    // Must transition back to pairing-required, credential deleted, app hidden
    expect(bootstrap.getState()).toBe("pairing-required");
    expect(client.listApps().length).toBe(0);
    expect(onUnauthorized).toHaveBeenCalled();

    bootstrap.destroy();
  });

  it("Scenario 15 & 16: Multiple phones have independent trust, revoking one does not revoke the other", async () => {
    const host = makeHost();
    const storage1 = new MemorySecureStorage();
    const storage2 = new MemorySecureStorage();

    const createClientFor = (storage: MemorySecureStorage, name: string) => {
      const webSocket = (url: string): WsLike => {
        if (url.includes("signal.test")) {
          const [clientEnd, serviceEnd] = MockSocket.pair(url, `${url}#service`);
          attachSignaling(serviceEnd, host);
          return clientEnd;
        }
        const [clientEnd, hostEnd] = MockSocket.pair(url, `${url}#host`);
        queueMicrotask(() => host.accept(hostEnd));
        return clientEnd;
      };
      const fakeFetch = (async () => ({
        ok: true,
        json: async () => ({ relay: { url: RELAY_URL, channel: "chan-1" } })
      })) as unknown as typeof fetch;

      return new CrosslinkClient({
        storage,
        deviceName: name,
        onConfirmPairing: () => true,
        requestTimeoutMs: 3000,
        webSocket,
        fetch: fakeFetch,
        dialTimeoutMs: 100
      });
    };

    const client1 = createClientFor(storage1, "Phone 1");
    const client2 = createClientFor(storage2, "Phone 2");

    // Pair Phone 1
    const session1 = host.pairing.beginSession();
    const uri1 = buildPairingUri({
      endpoints: [{ kind: "sig", url: SIGNALING_URL }],
      code: session1.code,
      appId: APP_ID,
      appName: "TestApp",
      hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
    });
    await client1.pairWithCode(uri1, session1.code, ["test.ping"]);

    // Pair Phone 2
    const session2 = host.pairing.beginSession();
    const uri2 = buildPairingUri({
      endpoints: [{ kind: "sig", url: SIGNALING_URL }],
      code: session2.code,
      appId: APP_ID,
      appName: "TestApp",
      hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
    });
    await client2.pairWithCode(uri2, session2.code, ["test.ping"]);

    // Host has 2 independent trusted devices
    expect(host.store.list().length).toBe(2);
    expect(host.store.get(client1.deviceId)?.revokedAt).toBeUndefined();
    expect(host.store.get(client2.deviceId)?.revokedAt).toBeUndefined();

    // Revoke Phone 1 only
    host.store.revoke(client1.deviceId, Date.now());

    // Phone 1 is revoked
    expect(host.store.get(client1.deviceId)?.revokedAt).toBeDefined();
    // Phone 2 remains trusted and intact!
    expect(host.store.get(client2.deviceId)?.revokedAt).toBeUndefined();

    // Phone 2 connects cleanly
    const rpc2 = await client2.connect(APP_ID);
    const pingRes = await rpc2.call("test.ping");
    expect(pingRes).toBe("pong");
  });
});
