/**
 * Browser half of the WebRTC upgrade example.
 *
 * The only Crosslink-specific parts are marked below; everything else is DOM
 * plumbing. The shape to copy is:
 *
 *   const client = await CrosslinkClient.create({ ... });   // encrypted at rest
 *   await client.pairFromQr(uri, requestedCaps);            // fingerprint-pinned
 *   const rpc = await client.connect();                     // relay or LAN
 *   await tryUpgradeToWebrtc(client.connection!, { createPeer });  // then direct
 *
 * The upgrade is deliberately not automatic: a relayed connection is a working
 * connection, and moving off it is an optimisation the application decides to
 * take, not something the SDK does behind its back.
 */
import { CrosslinkClient, consoleLogger } from "@crosslink/sdk-browser";
import { tryUpgradeToWebrtc } from "@crosslink/webrtc-adapter";

const REQUESTED_CAPS = ["files.read", "shell.exec"];

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const ui = {
  uri: $<HTMLInputElement>("uri"),
  cmd: $<HTMLInputElement>("cmd"),
  pair: $<HTMLButtonElement>("pair"),
  connect: $<HTMLButtonElement>("connect"),
  upgrade: $<HTMLButtonElement>("upgrade"),
  disconnect: $<HTMLButtonElement>("disconnect"),
  list: $<HTMLButtonElement>("list"),
  info: $<HTMLButtonElement>("info"),
  run: $<HTMLButtonElement>("run"),
  log: $<HTMLPreElement>("log"),
  state: $<HTMLElement>("badge-state"),
  transport: $<HTMLElement>("badge-transport"),
  storage: $<HTMLElement>("badge-storage")
};

function log(message: string, detail?: unknown): void {
  const line = detail === undefined ? message : `${message} ${JSON.stringify(detail)}`;
  ui.log.textContent = `${new Date().toLocaleTimeString()}  ${line}\n${ui.log.textContent}`.slice(
    0,
    20_000
  );
}

/* ------------------------------------------------------------------ */
/* Crosslink                                                           */
/* ------------------------------------------------------------------ */

// `create` (rather than the plain constructor) puts the identity seed and the
// paired-app records behind a non-extractable WebCrypto key in IndexedDB.
const client = await CrosslinkClient.create({
  deviceName: navigator.userAgent.includes("Mobile") ? "Phone" : "Laptop",
  logger: consoleLogger({ level: "debug" }),
  requestTimeoutMs: 20_000,
  onStateChange: (state, detail) => {
    ui.state.textContent = state;
    ui.state.className = `badge ${state === "offline" || state === "revoked" ? "warn" : "on"}`;
    ui.transport.textContent = String(detail?.transport ?? client.connection?.transportKind ?? "—");
    refreshButtons();
    log(`state: ${state}`, detail);
  },
  onConfirmPairing: (request) =>
    window.confirm(
      [
        `Pair with "${request.hostName}"?`,
        "",
        `Confirm this code matches the host screen: ${request.sas}`,
        `Capabilities granted: ${request.grantedCaps.join(", ") || "(none)"}`
      ].join("\n")
    )
});

ui.storage.textContent = `storage: ${client.storageEncrypted ? "encrypted" : "plaintext"}`;
ui.storage.className = `badge ${client.storageEncrypted ? "on" : "warn"}`;

const paired = client.listApps();
if (paired.length > 0) {
  log(`already paired with ${paired[0].appName}`, { caps: paired[0].grantedCaps });
}

function refreshButtons(): void {
  const hasApp = client.listApps().length > 0;
  const online = client.state !== "offline" && client.state !== "revoked";
  const direct = client.connection?.transportKind === "webrtc-direct";

  ui.connect.disabled = !hasApp || online;
  ui.disconnect.disabled = !online;
  ui.upgrade.disabled = !online || direct;
  for (const button of [ui.list, ui.info, ui.run]) button.disabled = !online;
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

ui.pair.addEventListener("click", async () => {
  const uri = ui.uri.value.trim();
  if (!uri) return log("paste the pairing URI from the host terminal first");
  ui.pair.disabled = true;
  try {
    const record = await client.pairFromQr(uri, REQUESTED_CAPS);
    log(`paired with ${record.appName}`, { granted: record.grantedCaps });
    // The host policy may have granted less than was asked for; that is the
    // policy working, not an error.
    const trimmed = REQUESTED_CAPS.filter((c) => !record.grantedCaps.includes(c));
    if (trimmed.length > 0) log("host declined some capabilities", { trimmed });
  } catch (err) {
    log(`pairing failed: ${(err as Error).message}`);
  } finally {
    ui.pair.disabled = false;
    refreshButtons();
  }
});

ui.connect.addEventListener("click", async () => {
  try {
    await client.connect();
    log(`connected over ${client.connection?.transportKind}`);
  } catch (err) {
    log(`connect failed: ${(err as Error).message}`);
  }
  refreshButtons();
});

ui.upgrade.addEventListener("click", async () => {
  const link = client.connection;
  if (!link) return;
  ui.upgrade.disabled = true;
  log("negotiating a direct connection over the current session…");

  // The one Crosslink-specific line: the SDP exchange rides the session that
  // is already established, so there is no second signaling path to secure.
  const upgraded = await tryUpgradeToWebrtc(link, {
    createPeer: () => new RTCPeerConnection({ iceServers: ICE_SERVERS }) as never,
    timeoutMs: 15_000
  });

  log(
    upgraded
      ? "upgraded — traffic is now peer-to-peer, the relay is idle"
      : "no direct path available; still connected through the relay"
  );
  refreshButtons();
});

ui.disconnect.addEventListener("click", () => {
  client.close();
  log("disconnected");
  refreshButtons();
});

ui.list.addEventListener("click", () => call("files.list"));
ui.info.addEventListener("click", () => call("link.info"));
ui.run.addEventListener("click", () => call("shell.run", { cmd: ui.cmd.value }));

async function call(method: string, input?: unknown): Promise<void> {
  try {
    log(`→ ${method}`, input);
    const result = await client.rpc().call(method, input);
    log(`← ${method}`, result);
  } catch (err) {
    const error = err as { code?: string; message: string };
    // consent_denied means a human on the host said no. That is a normal
    // outcome for a confirmEachUse capability, not a malfunction.
    log(`✗ ${method}: ${error.code ?? "error"} — ${error.message}`);
  }
}

refreshButtons();
log("ready — paste a pairing URI to begin");
