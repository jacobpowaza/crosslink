import React, { useState, useCallback } from "react";
import { CrosslinkProvider, useCrosslink, useCrosslinkStatus } from "@crosslink/react";
import type { CrosslinkClientOptions } from "@crosslink/sdk-browser";

function PairButton() {
  const { client, status } = useCrosslink();
  const [uri, setUri] = useState("");

  const handlePair = useCallback(async () => {
    try {
      await client.pairFromQr(uri || prompt("Enter pairing URI:") || "");
      alert("Paired!");
    } catch (e: any) {
      alert("Pairing failed: " + (e?.message ?? String(e)));
    }
  }, [client, uri]);

  return (
    <div>
      <input
        type="text"
        placeholder="Pairing URI or code..."
        value={uri}
        onChange={(e) => setUri(e.target.value)}
      />
      <button onClick={handlePair}>Pair</button>
    </div>
  );
}

function StatusDisplay() {
  const status = useCrosslinkStatus();
  return <p>Status: <strong>{status}</strong></p>;
}

function AppContent() {
  const { client, status, rpc } = useCrosslink();
  const [message, setMessage] = useState("");

  const sendHello = useCallback(async () => {
    if (!rpc) {
      setMessage("Not connected yet.");
      return;
    }
    try {
      // Example call — real host must expose this method
      const result = await rpc.call("hello.ping", { message: "hello" });
      setMessage("Response: " + JSON.stringify(result));
    } catch (e: any) {
      setMessage("Call failed: " + (e?.message ?? String(e)));
    }
  }, [rpc]);

  return (
    <div style={{ padding: 24 }}>
      <h1>Crosslink — React + TypeScript</h1>
      <StatusDisplay />
      <PairButton />
      <button
        disabled={status !== "direct" && status !== "crosslink-relayed" && status !== "lan"}
        onClick={sendHello}
      >
        Send "hello"
      </button>
      <pre>{message}</pre>
    </div>
  );
}

const options: CrosslinkClientOptions = {
  deviceName: "react-browser",
  onStateChange(state) {
    console.log("Crosslink state:", state);
  },
  onConfirmPairing(req) {
    return confirm(`Confirm pairing with ${req.hostName}? SAS: ${req.sas}`);
  },
};

export default function App() {
  return (
    <CrosslinkProvider options={options}>
      <AppContent />
    </CrosslinkProvider>
  );
}
