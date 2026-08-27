/**
 * Offline Shell and Service Worker tests
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  CrosslinkOfflineShell,
  createOfflineUI,
  generateServiceWorker,
  createServiceWorkerConfig
} from "./index.js";
import {
  CapabilityRegistry,
  DeviceGrants,
  DeviceIdentity,
  HostAcceptor,
  HostPairingManager,
  InMemoryHostDeviceStore,
  RpcRouter,
  buildPairingUri,
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
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  style: Record<string, string> = {};
  onclick: (() => void) | null = null;

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
      const found = child.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

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

(globalThis as any).document = mockDoc;
(globalThis as any).window = mockWindow;

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

  const client = new CrosslinkClient({
    storage,
    deviceName: "Test Browser",
    onConfirmPairing: () => true,
    requestTimeoutMs: 3000,
    webSocket,
    fetch: fakeFetch,
    dialTimeoutMs: 100
  });

  const session = host.pairing.beginSession();
  const pairingUri = buildPairingUri({
    signalingUrl: SIGNALING_URL,
    code: session.code,
    appId: APP_ID,
    appName: "TestApp",
    hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
  });

  return {
    host,
    client,
    storage,
    pairingUri,
    setFailRelay: (val: boolean) => { failRelay = val; }
  };
}

describe("Service Worker generation", () => {
  it("generates a valid service worker with default config", () => {
    const sw = generateServiceWorker();
    expect(sw).toContain("const CACHE_NAME = \"crosslink-shell-v1.0.0\";");
    expect(sw).toContain("./mobile.html");
    expect(sw).toContain("./bundle.js");
    expect(sw).toContain("isSecuritySensitive");
    expect(sw).toContain("/api/");
    expect(sw).toContain("/pair");
    expect(sw).toContain("/challenge");
  });

  it("respects custom version and precache assets", () => {
    const sw = generateServiceWorker({
      version: "2.4.0",
      precacheAssets: ["/custom-app.html", "/app.js", "/logo.png"]
    });
    expect(sw).toContain("const CACHE_NAME = \"crosslink-shell-v2.4.0\";");
    expect(sw).toContain("/custom-app.html");
    expect(sw).toContain("/app.js");
    expect(sw).toContain("/logo.png");
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
