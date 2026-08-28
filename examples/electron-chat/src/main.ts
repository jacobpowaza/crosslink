import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, session } from "electron";
import {
  createCrosslinkServer,
  type CrosslinkServer,
  type PairingCodeInfo,
} from "@crosslink/sdk-node";

interface ChatMessage {
  id: string;
  sender: "desktop" | "device";
  text: string;
  at: number;
}

const APP_ID = "com.crosslink.example.electron-chat";
const MAX_MESSAGE_CHARS = 2_000;
const messages: ChatMessage[] = [];
let mainWindow: BrowserWindow | null = null;
let host: CrosslinkServer;
let currentPairing: PairingCodeInfo | null = null;
const RENDERER_URL = "crosslink-app://bundle/index.html";

protocol.registerSchemesAsPrivileged([
  { scheme: "crosslink-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function requiredHttpsUrl(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error(`${name} must use https://`);
  return parsed.toString().replace(/\/$/, "");
}

function sanitizeText(value: unknown): string {
  if (typeof value !== "string") throw new Error("message must be a string");
  const text = value.trim();
  if (!text || text.length > MAX_MESSAGE_CHARS) {
    throw new Error(`message must contain 1-${MAX_MESSAGE_CHARS} characters`);
  }
  return text;
}

function addMessage(sender: ChatMessage["sender"], value: unknown): ChatMessage {
  const message = { id: crypto.randomUUID(), sender, text: sanitizeText(value), at: Date.now() };
  messages.push(message);
  if (messages.length > 1_000) messages.splice(0, messages.length - 1_000);
  mainWindow?.webContents.send("crosslink:message", message);
  return message;
}

async function startCrosslink(): Promise<void> {
  const signalingUrl = requiredHttpsUrl("CROSSLINK_SIGNALING_URL");
  const relayUrl = requiredHttpsUrl("CROSSLINK_RELAY_URL");
  const configuredMode = process.env.CROSSLINK_NETWORK_MODE;
  const networkMode = configuredMode === "remote" || configuredMode === "lan-and-relay" ||
    configuredMode === "local-only" || configuredMode === "auto"
    ? configuredMode
    : signalingUrl && relayUrl ? "lan-and-relay" : "auto";

  host = createCrosslinkServer({
    application: { id: APP_ID, name: "Crosslink Electron Chat", version: app.getVersion() },
    capabilities: [
      { id: "chat.send", title: "Send chat messages", risk: "low" },
      { id: "chat.read", title: "Read chat history", risk: "low" },
    ],
    storageDir: path.join(app.getPath("userData"), "crosslink"),
    signalingUrl,
    relayUrl,
    signalingToken: process.env.CROSSLINK_SIGNALING_TOKEN,
    relayToken: process.env.CROSSLINK_RELAY_TOKEN,
    networkMode,
    lan: { enabled: true, bind: "all" },
    remote: { enabled: networkMode === "remote" },
    security: {
      hybridPq: "preferred",
      maxDevices: 12,
      maxActivePairingSessions: 2,
      pairingRateLimitMs: 5_000,
    },
    pairing: {
      ttlMs: 180_000,
      autoApprove: false,
      notifyApprovalRequest(request) {
        if (Notification.isSupported()) {
          new Notification({
            title: "Crosslink pairing request",
            body: `${request.deviceName} is waiting for approval. Code: ${request.sas}`,
          }).show();
        }
      },
      async approve(request) {
        const options: Electron.MessageBoxOptions = {
          type: "question",
          buttons: ["Deny", "Approve"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: "Approve Crosslink device",
          message: `Pair ${request.deviceName}?`,
          detail: `Verify code ${request.sas}.\n\nRequested access:\n${request.requestedCaps.join("\n") || "None"}`,
        };
        const result = mainWindow
          ? await dialog.showMessageBox(mainWindow, options)
          : await dialog.showMessageBox(options);
        return result.response === 1;
      },
    },
  });

  host
    .expose("chat.send", (input) => {
      const { text } = (input ?? {}) as { text?: unknown };
      return { ok: true, message: addMessage("device", text) };
    }, {
      capability: "chat.send",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string", minLen: 1, maxLen: MAX_MESSAGE_CHARS } },
      },
    })
    .expose("chat.history", () => ({ messages: [...messages] }), { capability: "chat.read" })
    .declareEvent("chat.new_message", { capability: "chat.read" });

  host.on("devicePaired", () => {
    currentPairing = null;
    publishState();
  });
  host.on("deviceConnected", publishState);
  host.on("deviceDisconnected", publishState);
  host.on("deviceRevoked", publishState);
  host.on("connectivity", publishState);
  await host.start();
}

function publicState() {
  return {
    connectivity: host.getConnectivity(),
    devices: host.listDevices().filter((device) => device.revokedAt === undefined),
    messages: [...messages],
    secretBackend: (host.status().secrets as { backend?: string } | null)?.backend ?? "unknown",
  };
}

function publishState(): void {
  if (host && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("crosslink:state", publicState());
  }
}

function installIpc(): void {
  const trust = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.senderFrame?.url !== RENDERER_URL) throw new Error("untrusted IPC sender");
  };
  ipcMain.handle("crosslink:state", (event) => { trust(event); return publicState(); });
  ipcMain.handle("crosslink:pair", async (event) => {
    trust(event);
    if (!currentPairing || currentPairing.expiresAt <= Date.now() + 10_000) {
      currentPairing = await host.getPairingCode("electron-renderer");
    }
    return {
      code: currentPairing.code,
      expiresAt: currentPairing.expiresAt,
      qrSvg: currentPairing.qrSvg,
    };
  });
  ipcMain.handle("crosslink:send", (event, text: unknown) => {
    trust(event);
    const message = addMessage("desktop", text);
    host.emit("chat.new_message", message);
    return message;
  });
  ipcMain.handle("crosslink:revoke", (event, deviceId: unknown) => {
    trust(event);
    if (typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(deviceId)) {
      throw new Error("invalid device id");
    }
    return host.revokeDevice(deviceId);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1_080,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  await mainWindow.loadURL(RENDERER_URL);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.on("web-contents-created", (_event, contents) => {
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
});

app.whenReady().then(async () => {
  protocol.handle("crosslink-app", (request) => {
    const requested = new URL(request.url);
    const asset = requested.pathname.slice(1) || "index.html";
    if (requested.host !== "bundle" || !["index.html", "styles.css", "renderer.global.js"].includes(asset)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(path.join(__dirname, asset)).toString());
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"],
      },
    });
  });
  await startCrosslink();
  installIpc();
  await createWindow();
}).catch((error) => {
  dialog.showErrorBox("Crosslink failed to start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { if (host) void host.stop(); });
