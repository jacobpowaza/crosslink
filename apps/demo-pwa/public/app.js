/* Crosslink demo PWA glue. All crypto/transport logic lives in the SDK bundle. */
"use strict";

const { createCrosslinkClient, createPairingCard } = window.CrosslinkSDK;

const $ = (id) => document.getElementById(id);

// Instantiate canonical pairing widget
const pairingCard = createPairingCard({
  target: "#pairCardContainer",
  appName: "Crosslink Notes",
  blurb: "<strong>Connect your phone</strong> to sync notes securely from your computer. The link is end-to-end encrypted &mdash; relays only ever see ciphertext.",
  qr: "./qr.svg",
  onRefresh: async () => {
    pairingCard.update({ qr: `./qr.svg?t=${Date.now()}` });
  }
});
const show = (id) => {
  for (const s of ["screen-pair", "screen-sas", "screen-notes"]) {
    $(s).hidden = s !== id;
  }
};

const vibrate = (pattern) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* haptics are best-effort */
  }
};

let subscribed = false;

// localStorage keeps identity + pairing across reloads (SDK default).
const client = createCrosslinkClient({
  deviceName: navigator.userAgentData?.platform ?? "browser",
  networkMode: localStorage.getItem("crosslink.networkMode") || "auto",
  webrtc: localStorage.getItem("crosslink.webrtc") !== "false" ? {
    createPeer: () => new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    })
  } : undefined,
  onStateChange(state) {
    const pill = $("connState");
    pill.textContent = state;
    const online = state === "direct" || state === "crosslink-relayed" || state === "lan";
    pill.classList.toggle("online", online);
    if (online) {
      subscribeOnce();
      renderNotes();
    }
  },
  onConfirmPairing(req) {
    // SAS screen
    const grid = $("sasGrid");
    grid.replaceChildren();
    for (const ch of req.sas.replace(/\s/g, "")) {
      const span = document.createElement("span");
      span.textContent = ch;
      grid.appendChild(span);
    }
    const list = $("capList");
    list.replaceChildren();
    for (const cap of req.grantedCaps.length ? req.grantedCaps : ["(none)"]) {
      const li = document.createElement("li");
      li.textContent = cap;
      list.appendChild(li);
    }
    show("screen-sas");
    return new Promise((resolve) => {
      $("sasOk").onclick = () => resolve(true);
      $("sasNo").onclick = () => resolve(false);
    });
  }
});

/* ------------------------------- pairing ------------------------------- */

async function pairWith(uri) {
  const status = $("pairStatus");
  const btn = $("pairBtn");
  if (!uri) {
    status.textContent = "Paste a pairing URI or scan the QR code first.";
    status.classList.add("err");
    return;
  }
  btn.disabled = true;
  status.classList.remove("err");
  status.textContent = "Pairing…";
  try {
    await client.pairFromQr(uri, ["notes.read", "notes.write"]);
    vibrate([30, 60, 30]);
    status.textContent = "";
    enterNotes();
  } catch (err) {
    vibrate(120);
    status.textContent = `Pairing failed: ${err.message}`;
    status.classList.add("err");
  } finally {
    btn.disabled = false;
  }
}

$("pairBtn").addEventListener("click", () => pairWith($("uri").value.trim()));

async function enterNotes() {
  show("screen-notes");
  try {
    await client.connect();
  } catch (err) {
    $("eventLog").textContent = `connect failed: ${err.message}`;
  }
}

$("forget").addEventListener("click", async () => {
  const appId = client.listApps()[0]?.appId;
  if (appId) client.forget(appId);
  subscribed = false;
  show("screen-pair");
});

/* --------------------------- QR code scanner --------------------------- */

const scannerSupported =
  "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
let scanStream = null;
let scanTimer = 0;

if (scannerSupported) {
  $("scanBtn").hidden = false;
  $("scanBtn").addEventListener("click", openScanner);
  $("scannerClose").addEventListener("click", closeScanner);
}

async function openScanner() {
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
  } catch {
    $("pairStatus").textContent = "Camera unavailable — paste the URI instead.";
    $("pairStatus").classList.add("err");
    return;
  }
  const video = $("scannerVideo");
  video.srcObject = scanStream;
  await video.play();
  $("scanner").hidden = false;

  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const tick = async () => {
    if (!scanStream) return;
    try {
      const codes = await detector.detect(video);
      const hit = codes.find((c) => c.rawValue?.startsWith("crosslink://pair"));
      if (hit) {
        const uri = hit.rawValue;
        closeScanner();
        $("uri").value = uri;
        pairWith(uri);
        return;
      }
    } catch {
      /* frame not ready — keep scanning */
    }
    scanTimer = window.setTimeout(tick, 250);
  };
  tick();
}

function closeScanner() {
  clearTimeout(scanTimer);
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $("scannerVideo").srcObject = null;
  $("scanner").hidden = true;
}

/* ---------------------------- install prompt --------------------------- */

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();
  deferredInstallPrompt = ev;
  $("installBtn").hidden = false;
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installBtn").hidden = true;
});

/* -------------------------------- notes -------------------------------- */

function fmt(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function subscribeOnce() {
  if (subscribed || !client.rpc) return;
  try {
    client.rpc().subscribe("notes.changed", (payload) => {
      $("eventLog").textContent = `notes.changed @ ${fmt(payload?.at ?? Date.now())}`;
      renderNotes();
    });
    subscribed = true;
  } catch {
    /* not connected yet — retried on next state change */
  }
}

async function renderNotes() {
  if (!client.rpc) return;
  try {
    const notes = await client.rpc().call("notes.list");
    const ul = $("noteList");
    ul.replaceChildren();
    $("emptyState").hidden = notes.length > 0;
    for (const n of notes) {
      const li = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = fmt(n.createdAt);
      const title = document.createElement("b");
      title.textContent = n.title;
      li.append(time, title);
      if (n.body) {
        const body = document.createElement("p");
        body.textContent = n.body;
        li.appendChild(body);
      }
      ul.appendChild(li);
    }
  } catch (err) {
    $("eventLog").textContent = err.message;
  }
}

$("newNote").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const formStatus = $("formStatus");
  formStatus.textContent = "";
  try {
    await client.rpc().call("notes.create", { title: $("title").value, body: $("body").value });
    $("title").value = "";
    $("body").value = "";
    await renderNotes();
  } catch (err) {
    formStatus.textContent = err.message;
  }
});

/* ------------------------------- startup ------------------------------- */

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

/* -------------------------------- settings ------------------------------ */

// Load saved network mode preference
const savedMode = localStorage.getItem("crosslink.networkMode") || "auto";
const savedWebrtc = localStorage.getItem("crosslink.webrtc") !== "false";
applyNetworkMode(savedMode);
applyWebRtc(savedWebrtc);

// Settings panel open/close
$("settingsBtn").addEventListener("click", () => {
  $("settingsPanel").hidden = false;
  refreshDeviceList();
});
$("settingsClose").addEventListener("click", () => {
  $("settingsPanel").hidden = true;
});

// Network mode radio buttons
for (const radio of document.querySelectorAll('input[name="networkMode"]')) {
  if (radio.value === savedMode) radio.checked = true;
  radio.addEventListener("change", (ev) => {
    const mode = ev.target.value;
    localStorage.setItem("crosslink.networkMode", mode);
    applyNetworkMode(mode);
    if (typeof client !== "undefined" && client && client.connection && client.connection.connected) {
      client.close();
      enterNotes().catch(() => {});
    }
  });
}

// WebRTC toggle
const webrtcToggle = $("webrtcToggle");
webrtcToggle.checked = savedWebrtc;
webrtcToggle.addEventListener("change", (ev) => {
  const enabled = ev.target.checked;
  localStorage.setItem("crosslink.webrtc", String(enabled));
  applyWebRtc(enabled);
  if (typeof client !== "undefined" && client && client.connection && client.connection.connected) {
    client.close();
    enterNotes().catch(() => {});
  }
});

function applyNetworkMode(mode) {
  document.documentElement.dataset.networkMode = mode;
  if (typeof client !== "undefined" && client && client.options) {
    client.options.networkMode = mode;
  }
}

function applyWebRtc(enabled) {
  document.documentElement.dataset.webrtc = String(enabled);
  if (typeof client !== "undefined" && client && client.options) {
    if (enabled) {
      client.options.webrtc = {
        createPeer: () => new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        })
      };
    } else {
      client.options.webrtc = undefined;
    }
  }
}

function refreshDeviceList() {
  const list = $("deviceList");
  list.replaceChildren();
  const apps = client.listApps();
  if (apps.length === 0) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "No devices paired yet.";
    list.appendChild(p);
    return;
  }
  for (const app of apps) {
    const item = document.createElement("div");
    item.className = "device-item";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = app.appName || app.appId;
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = `Paired ${new Date(app.addedAt).toLocaleDateString()}`;
    info.append(name, hint);
    const btn = document.createElement("button");
    btn.className = "device-revoke";
    btn.textContent = "Forget";
    btn.addEventListener("click", () => {
      client.forget(app.appId);
      refreshDeviceList();
    });
    item.append(info, btn);
    list.appendChild(item);
  }
}

// Deep link: open with #pair=crosslink://pair?… to prefill + pair in one tap.
function deepLinkUri() {
  const m = /^#pair=(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

if (client.listApps().length > 0) {
  enterNotes();
} else {
  const uri = deepLinkUri();
  if (uri) {
    $("uri").value = uri;
    history.replaceState(null, "", location.pathname);
    pairWith(uri);
  }
  show("screen-pair");
}
