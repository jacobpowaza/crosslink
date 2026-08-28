/**
 * Crosslink in React + TSX.
 *
 * The whole integration is `<CrosslinkProvider>` plus hooks: no pairing code,
 * no transport selection, no reconnect handling. Paste the pairing URI from the
 * desktop app's QR (or scan it with the phone camera, which opens the same
 * bootstrap page) and the rest is the developer's own UI.
 */
import { useCallback, useState } from "react";
import {
  CrosslinkProvider,
  useCrosslink,
  useCrosslinkCall,
  useCrosslinkEvent,
  useCrosslinkState
} from "@crosslink/react";

function ConnectionBadge(): JSX.Element {
  const state = useCrosslinkState();
  return (
    <p>
      Status: <strong>{state}</strong>
    </p>
  );
}

function PairForm(): JSX.Element {
  const { client, connected } = useCrosslink();
  const [uri, setUri] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pair = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await client.pairFromQr(uri.trim());
      await client.connect();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [client, uri]);

  if (connected) return <p>Paired and connected.</p>;

  return (
    <div>
      <input
        type="text"
        placeholder="crosslink://pair?…"
        value={uri}
        onChange={(e) => setUri(e.target.value)}
        style={{ width: 420 }}
      />
      <button onClick={() => void pair()} disabled={busy || uri.trim().length === 0}>
        {busy ? "Pairing…" : "Pair"}
      </button>
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
    </div>
  );
}

function Chat(): JSX.Element {
  const { connected } = useCrosslink();
  const { call, pending, error } = useCrosslinkCall<{ ok: boolean }>();
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<string[]>([]);

  // Resubscribes by itself after a reconnect.
  useCrosslinkEvent<{ sender: string; text: string }>("chat.new_message", (msg) => {
    setLog((prev) => [...prev, `${msg.sender}: ${msg.text}`]);
  });

  return (
    <div>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!connected} />
      <button
        disabled={!connected || pending || draft.length === 0}
        onClick={() => {
          void call("chat.send", { text: draft }).then(() => setDraft(""));
        }}
      >
        Send
      </button>
      {error ? <p style={{ color: "crimson" }}>{error.message}</p> : null}
      <ul>
        {log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <CrosslinkProvider options={{ deviceName: "React example" }}>
      <div style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Crosslink — React + TypeScript</h1>
        <ConnectionBadge />
        <PairForm />
        <Chat />
      </div>
    </CrosslinkProvider>
  );
}
