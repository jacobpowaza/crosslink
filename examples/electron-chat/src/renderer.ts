import {
  createPairingCard,
  type NetworkMode,
  type PairingSession,
  type PairingSourceEvent,
} from "@crosslink/sdk-browser";

interface Device { deviceId: string; name: string; caps: string[]; }
interface Message { id: string; sender: "desktop" | "device"; text: string; at: number; }
interface State {
  connectivity: { reach: string; message: string };
  devices: Device[];
  messages: Message[];
  secretBackend: string;
  background: { supported: boolean; enabled: boolean; openAtLogin: boolean; status: string };
}
interface CrosslinkBridge {
  getState(): Promise<State>;
  getPairingSession(mode?: NetworkMode): Promise<PairingSession>;
  setNetworkMode(mode: NetworkMode): Promise<void>;
  sendMessage(text: string): Promise<Message>;
  revokeDevice(deviceId: string): Promise<boolean>;
  setBackgroundEnabled(enabled: boolean): Promise<State["background"]>;
  onState(listener: (state: State) => void): () => void;
  onMessage(listener: (message: Message) => void): () => void;
  onPairingEvent(listener: (event: PairingSourceEvent) => void): () => void;
}

export {};

declare global { interface Window { crosslink: CrosslinkBridge } }

const messages = document.querySelector<HTMLDivElement>("#messages")!;
const form = document.querySelector<HTMLFormElement>("#composer")!;
const input = document.querySelector<HTMLInputElement>("#message")!;
let state: State;
const settingsButton = document.querySelector<HTMLButtonElement>("#settings-button")!;
const settingsMenu = document.querySelector<HTMLDivElement>("#settings-menu")!;
const backgroundToggle = document.querySelector<HTMLInputElement>("#background-toggle")!;
const backgroundStatus = document.querySelector<HTMLParagraphElement>("#background-status")!;

function renderMessage(message: Message): void {
  if (document.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
  const row = document.createElement("article");
  row.className = `message ${message.sender}`;
  row.dataset.messageId = message.id;
  const body = document.createElement("p");
  body.textContent = message.text;
  const time = document.createElement("time");
  time.dateTime = new Date(message.at).toISOString();
  time.textContent = new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  row.append(body, time);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
}

function render(next: State): void {
  state = next;
  document.querySelector("#reach")!.textContent = next.connectivity.message;
  document.querySelector("#vault")!.textContent = `Secrets: ${next.secretBackend}`;
  document.querySelector("#device-count")!.textContent = `${next.devices.length} trusted`;
  backgroundToggle.checked = next.background.enabled;
  backgroundToggle.disabled = !next.background.supported;
  backgroundStatus.textContent = !next.background.supported
    ? "Start at login is currently available on macOS and Windows."
    : next.background.status === "requires-approval"
      ? "Allow Crosslink in your system's Login Items settings to finish enabling it."
      : next.background.enabled
        ? "Crosslink will start at login and stay active when this window closes."
        : "Crosslink stops when the app closes.";
  const devices = document.querySelector<HTMLDivElement>("#devices")!;
  devices.replaceChildren();
  for (const device of next.devices) {
    const row = document.createElement("div");
    row.className = "device";
    const label = document.createElement("span");
    label.textContent = device.name;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      await window.crosslink.revokeDevice(device.deviceId);
      render(await window.crosslink.getState());
    });
    row.append(label, revoke);
    devices.append(row);
  }
  for (const message of next.messages) renderMessage(message);
}

settingsButton.addEventListener("click", () => {
  const open = settingsMenu.hidden;
  settingsMenu.hidden = !open;
  settingsButton.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (!settingsMenu.hidden && !settingsMenu.contains(event.target as Node) && event.target !== settingsButton) {
    settingsMenu.hidden = true;
    settingsButton.setAttribute("aria-expanded", "false");
  }
});
backgroundToggle.addEventListener("change", async () => {
  backgroundToggle.disabled = true;
  try {
    const background = await window.crosslink.setBackgroundEnabled(backgroundToggle.checked);
    render({ ...state, background });
  } catch (error) {
    backgroundToggle.checked = state.background.enabled;
    backgroundStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    backgroundToggle.disabled = !state.background.supported;
  }
});

const pairingCard = createPairingCard({
  target: "#crosslink-pairing",
  appName: "Crosslink Electron Chat",
  brand: { accentColor: "#818cf8", backgroundColor: "#111113", appearance: "dark" },
  source: {
    getSession: (mode) => window.crosslink.getPairingSession(mode),
    setNetworkMode: (mode) => window.crosslink.setNetworkMode(mode),
    subscribe: (listener) => window.crosslink.onPairingEvent(listener),
  },
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value;
  input.value = "";
  try { await window.crosslink.sendMessage(text); }
  catch (error) { input.setCustomValidity(error instanceof Error ? error.message : String(error)); input.reportValidity(); }
});
input.addEventListener("input", () => input.setCustomValidity(""));

window.crosslink.onState(render);
window.crosslink.onMessage(renderMessage);
window.addEventListener("beforeunload", () => pairingCard.destroy(), { once: true });
void window.crosslink.getState().then(render);
