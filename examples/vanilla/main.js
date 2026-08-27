/**
 * Vanilla JavaScript example for Crosslink.
 * Uses the framework-independent core SDK directly.
 */
import { createCrosslinkClient } from "@crosslink/sdk-browser";

const log = (msg) => {
  document.getElementById("log").textContent += msg + "\n";
};

const client = createCrosslinkClient({
  deviceName: "vanilla-browser",
  onStateChange(state, detail) {
    document.getElementById("status").textContent = state;
    log(`State: ${state}`);
  },
  onConfirmPairing(req) {
    log(`Pair with ${req.hostName}? SAS: ${req.sas}`);
    return confirm(`Confirm pairing? SAS: ${req.sas}`);
  },
});

document.getElementById("pairBtn").addEventListener("click", async () => {
  const uri = prompt("Enter pairing URI or paste crosslink://pair?...:");
  if (!uri) return;
  try {
    await client.pairFromQr(uri);
    log("Paired successfully.");
  } catch (e) {
    log("Pairing failed: " + e.message);
  }
});

document.getElementById("connectBtn").addEventListener("click", async () => {
  try {
    const rpc = await client.connect();
    log("Connected! RPC available.");
    if (rpc && typeof rpc.subscribe === "function") {
      rpc.subscribe("test.event", (payload) => {
        log("Event received: " + JSON.stringify(payload));
      });
    }
  } catch (e) {
    log("Connection failed: " + e.message);
  }
});
