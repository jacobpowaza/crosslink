/* ── Crosslink Todo Client — app.js ── */
(function () {
  "use strict";

  /* ================================================================ */
  /* PWA install gate                                                   */
  /* ================================================================ */

  let deferredPrompt = null;

  // Detect standalone mode (iOS: navigator.standalone, Android: display-mode)
  function isStandalone() {
    if (window.navigator.standalone === true) return true;
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
    // iOS Safari fullscreen in-app browser doesn't set standalone
    return false;
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    const el = document.getElementById(id);
    if (el) el.classList.add("active");
  }
  window.showScreen = showScreen;

  function initInstallGate() {
    if (isStandalone()) {
      showScreen("mode-screen");
      return;
    }

    // Listen for browser install prompt
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      updateInstallStep("browser", true);
    });

    // If already installable but prompt not captured yet, show the guide
    showScreen("install-screen");
  }

  function updateInstallStep(which, done) {
    const el = document.getElementById(`step-${which}`);
    if (el) el.classList.toggle("done", done);
  }

  window.installApp = async function () {
    const btn = document.getElementById("install-btn");
    if (deferredPrompt) {
      btn.textContent = "Installing...";
      btn.disabled = true;
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === "accepted") {
          updateInstallStep("browser", true);
          // After install, wait a moment then proceed
          setTimeout(() => showScreen("mode-screen"), 1500);
        } else {
          btn.textContent = "Add to Home Screen";
          btn.disabled = false;
        }
      } catch {
        btn.textContent = "Add to Home Screen";
        btn.disabled = false;
      }
      deferredPrompt = null;
    } else {
      // No prompt available — show manual instructions
      document.getElementById("manual-instructions").classList.remove("hidden");
      btn.classList.add("hidden");
    }
  };

  window.skipInstall = function () {
    showScreen("mode-screen");
  };

  /* ================================================================ */
  /* Network mode                                                      */
  /* ================================================================ */

  let selectedMode = null; // "local" or "relay"

  window.selectMode = function (mode) {
    selectedMode = mode;
    document.querySelectorAll(".mode-card").forEach((c) => c.classList.remove("selected"));
    document.getElementById(`mode-${mode}`).classList.add("selected");
    document.getElementById("mode-next").disabled = false;
  };

  window.goToPairing = function () {
    if (!selectedMode) return;
    showScreen("pair-screen");
    document.getElementById("pair-hint").textContent =
      selectedMode === "local"
        ? "Make sure you're on the same WiFi network as the host"
        : "Works from any network — cellular, remote, etc.";
  };

  /* ================================================================ */
  /* Offline / server-off screen                                       */
  /* ================================================================ */

  function showOffline(reason) {
    const reasonEl = document.getElementById("offline-reason");
    reasonEl.textContent = reason || "The host is not reachable right now.";
    showScreen("offline-screen");
  }

  window.retryConnection = function () {
    showScreen("pair-screen");
  };

  window.goOfflinePair = function () {
    showScreen("pair-screen");
  };

  /* ================================================================ */
  /* Pairing + connection                                              */
  /* ================================================================ */

  let client = null;
  let rpcClient = null;
  let notifCount = 0;
  window._clientRef = () => client;

  window.pair = async function () {
    const uri = document.getElementById("pair-uri").value.trim();
    const status = document.getElementById("pair-status");
    const btn = document.getElementById("pair-btn");
    if (!uri) {
      status.textContent = "Paste a pairing URI";
      status.className = "status err";
      return;
    }
    btn.disabled = true;
    status.textContent = "Pairing...";
    status.className = "status";

    try {
      const sdk = await import("/node_modules/@crosslink/sdk-browser/dist/index.js");
      const { CrosslinkClient, NotificationHandler } = sdk;

      client = new CrosslinkClient({
        deviceName: "Browser Todo Client",
        onStateChange: (s, detail) => {
          updateConnectionStatus(s, detail);
        },
      });

      await client.pairFromQr(uri, ["todos.read", "todos.write"]);
      status.textContent = "Paired! Connecting...";

      const rpc = await client.connect();
      rpcClient = rpc;

      // Notifications
      const handler = new NotificationHandler({
        autoRequestPermission: true,
        onNotification: (payload) => {
          showToast(payload.title, payload.body);
          notifCount++;
          document.getElementById("notif-badge").textContent = notifCount;
          document.getElementById("notif-badge").classList.remove("hidden");
          addNotifLog(payload.title);
        },
      });
      handler.start(rpc);
      rpc.subscribe("todos.changed", () => loadTodos());

      showScreen("app-screen");
      await loadTodos();
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes("no known transport") || msg.includes("HOST_OFFLINE") || msg.includes("cannot reach")) {
        showOffline("Host is not reachable. Make sure it's running and on the same network (local) or connected to the relay.");
        return;
      }
      status.textContent = `Error: ${msg}`;
      status.className = "status err";
    } finally {
      btn.disabled = false;
    }
  };

  function updateConnectionStatus(state, detail) {
    const el = document.getElementById("conn-status");
    if (!el) return;
    const map = {
      connected: "connected",
      direct: "connected",
      "turn-relayed": "connected",
      "crosslink-relayed": "connected",
      reconnecting: "reconnecting",
      offline: "offline",
      revoked: "offline",
      unauthorized: "offline",
      pairing: "reconnecting",
      connecting: "reconnecting",
      discovering: "reconnecting",
    };
    const cls = map[state] || "offline";
    el.className = `status-pill ${cls}`;
    el.textContent = state;

    // If we went fully offline after being connected, show placeholder
    if (state === "offline" && document.getElementById("app-screen")?.classList.contains("active")) {
      showOffline("Connection lost. The host may have gone offline.");
    }
  }

  /* ================================================================ */
  /* CRUD                                                              */
  /* ================================================================ */

  window.createTodo = async function () {
    const input = document.getElementById("new-todo");
    const title = input.value.trim();
    if (!title || !rpcClient) return;
    try {
      await rpcClient.call("todos.create", { title });
      input.value = "";
      await loadTodos();
    } catch {
      showOffline("Could not reach the host.");
    }
  };

  window.completeTodo = async function (id) {
    try {
      await rpcClient.call("todos.complete", { id });
      await loadTodos();
    } catch {
      showOffline("Could not reach the host.");
    }
  };

  window.deleteTodo = async function (id) {
    try {
      await rpcClient.call("todos.delete", { id });
      await loadTodos();
    } catch {
      showOffline("Could not reach the host.");
    }
  };

  async function loadTodos() {
    if (!rpcClient) return;
    try {
      const todos = await rpcClient.call("todos.list");
      const list = document.getElementById("todo-list");
      list.innerHTML = "";
      for (const t of todos) {
        const li = document.createElement("li");
        li.className = "todo-item" + (t.done ? " done" : "");
        li.innerHTML = `
          <span class="todo-title">${esc(t.title)}</span>
          ${t.done ? "" : `<button class="todo-btn" onclick="completeTodo('${t.id}')">Done</button>`}
          <button class="todo-btn del" onclick="deleteTodo('${t.id}')">x</button>
        `;
        list.appendChild(li);
      }
    } catch {
      /* not connected */
    }
  }

  /* ================================================================ */
  /* Notifications                                                     */
  /* ================================================================ */

  function showToast(title, body) {
    const t = document.getElementById("toast");
    t.querySelector(".toast-title").textContent = title;
    t.querySelector(".toast-body").textContent = body;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 4000);

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, { body });
      setTimeout(() => n.close(), 5000);
    }
  }

  function addNotifLog(title) {
    const log = document.getElementById("notif-log");
    if (log.textContent === "No notifications yet") log.textContent = "";
    const entry = document.createElement("div");
    entry.className = "notif-entry";
    entry.innerHTML = `<span class="notif-time">${new Date().toLocaleTimeString()}</span>${esc(title)}`;
    log.prepend(entry);
  }

  /* ================================================================ */
  /* Utilities                                                         */
  /* ================================================================ */

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ================================================================ */
  /* Init                                                              */
  /* ================================================================ */

  // Register service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // Check if already paired (persisted in localStorage)
  function hasExistingPairing() {
    try {
      const raw = localStorage.getItem("crosslink.apps");
      if (!raw) return false;
      const data = JSON.parse(raw);
      return Object.keys(data.apps || {}).length > 0;
    } catch {
      return false;
    }
  }

  // Boot: start at install gate, or skip if standalone + paired
  if (isStandalone() && hasExistingPairing()) {
    // Already installed and paired — go straight to app
    showScreen("app-screen");
    // Auto-connect in background
    (async () => {
      try {
        const sdk = await import("/node_modules/@crosslink/sdk-browser/dist/index.js");
        client = new sdk.CrosslinkClient({
          deviceName: "Browser Todo Client",
          onStateChange: (s, d) => updateConnectionStatus(s, d),
        });
        const rpc = await client.connect();
        rpcClient = rpc;
        const handler = new sdk.NotificationHandler({
          autoRequestPermission: true,
          onNotification: (p) => {
            showToast(p.title, p.body);
            notifCount++;
            document.getElementById("notif-badge").textContent = notifCount;
            document.getElementById("notif-badge").classList.remove("hidden");
            addNotifLog(p.title);
          },
        });
        handler.start(rpc);
        rpc.subscribe("todos.changed", () => loadTodos());
        await loadTodos();
      } catch {
        showOffline("Could not reconnect to host.");
      }
    })();
  } else if (isStandalone()) {
    // Installed but not paired
    showScreen("mode-screen");
  } else {
    // Not installed
    initInstallGate();
  }
})();
