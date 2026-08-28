interface Device { deviceId: string; name: string; caps: string[]; }
interface Message { id: string; sender: "desktop" | "device"; text: string; at: number; }
interface State {
  connectivity: { reach: string; message: string };
  devices: Device[];
  messages: Message[];
  secretBackend: string;
}
interface CrosslinkBridge {
  getState(): Promise<State>;
  getPairingCode(): Promise<{ code: string; expiresAt: number; qrSvg: string | null }>;
  sendMessage(text: string): Promise<Message>;
  revokeDevice(deviceId: string): Promise<boolean>;
  onState(listener: (state: State) => void): () => void;
  onMessage(listener: (message: Message) => void): () => void;
}

export {};

declare global { interface Window { crosslink: CrosslinkBridge } }

const messages = document.querySelector<HTMLDivElement>("#messages")!;
const form = document.querySelector<HTMLFormElement>("#composer")!;
const input = document.querySelector<HTMLInputElement>("#message")!;
const pairButton = document.querySelector<HTMLButtonElement>("#pair-button")!;
const qr = document.querySelector<HTMLImageElement>("#pair-qr")!;
const pairCode = document.querySelector<HTMLElement>("#pair-code")!;
let state: State;

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

pairButton.addEventListener("click", async () => {
  pairButton.disabled = true;
  try {
    const pairing = await window.crosslink.getPairingCode();
    if (pairing.qrSvg) qr.src = `data:image/svg+xml;base64,${btoa(pairing.qrSvg)}`;
    pairCode.textContent = pairing.code.replace(/(.{3})/g, "$1 ").trim();
    document.querySelector("#pairing")!.classList.add("visible");
  } finally {
    pairButton.disabled = false;
  }
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
void window.crosslink.getState().then(render);
