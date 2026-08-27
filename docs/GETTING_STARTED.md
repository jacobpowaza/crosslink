# Getting started

## 0. Prereqs

Node.js ≥ 20 (22 recommended). From the repo root:

```bash
npm install
npm test          # sanity: everything green out of the box
```

## 0.5. Pick your mode: local-only or server

Crosslink has two operating modes. Pick one before you do anything else —
the choice changes which URLs your host and client point at.

| Mode | When to use it | What runs where |
| --- | --- | --- |
| **Local-only** | Phone and laptop are on the **same WiFi** (or same LAN) | Host on laptop, client on phone. **No services required.** |
| **Server** | Phone and laptop are on **different networks** (different WiFi, cellular vs WiFi, etc.) | Host on laptop, client on phone, **signaling + relay running somewhere both can reach** |

The rest of this guide assumes you know which mode you're in. Skip the
section that doesn't apply.

### If you're local-only

You're done — go to step 1 and skip step 2 entirely. The host will advertise
itself over the LAN and the phone will discover it directly. No signaling,
no relay, no public internet needed.

If the host has more than one network interface (Wi-Fi + wired, two Wi-Fi
radios, a VPN…), pin the address so the phone can actually reach it — see
[`docs/connections/networking.mdx`](connections/networking.mdx#same-network-lan).

### If you're server mode

You need signaling + relay reachable from **both** the laptop running the
host and the phone running the client. The host stays on your laptop — only
the two dumb-pipe services need to be on the network both sides can reach.

Two ways to get there:

**A. Tunnel your laptop (zero infra, ~5 min)** — best for ad-hoc testing:

```bash
# terminal 1
npm run stack                       # signaling :8081, relay :8082

# terminal 2 — one tunnel per service
ngrok tcp 8081                      # copy the wss://… URL it prints
ngrok tcp 8082                      # copy the second wss://… URL
```

Then start your host pointed at the tunnels (the QR code embeds these URLs
automatically, so the phone needs no config):

```bash
CROSSLINK_SIGNALING_URL=<paste-wss-from-ngrok-8081> \
CROSSLINK_RELAY_URL=<paste-wss-from-ngrok-8082> \
npm run demo:echo
```

`cloudflared tunnel --url tcp://localhost:8081` works the same way and
gives you a stable `*.trycloudflare.com` URL per run. Free tier URLs rotate
on restart — fine for development.

**B. Run the services on a small VPS** — the production-shaped setup:

See [`docs/SELF_HOSTING.md`](SELF_HOSTING.md) for the full walk-through.
Short version: `npm run build && npm run stack` behind Caddy/nginx for TLS,
then point the host at the public signaling + relay URLs the same way as
above.

> **Heads-up:** the relay's default behavior is **open** (no token) and the
> signaling directory likewise. That's fine for a laptop tunnel you tear down
> in an hour. For anything that stays up longer than a debug session, set
> `CROSSLINK_SIGNALING_TOKEN` and `CROSSLINK_RELAY_TOKEN` — see the
> "Authentication tokens" section in `SELF_HOSTING.md`.

## 1. Run the local services (local-only and server-mode dev)

```bash
npm run stack     # signaling ws://127.0.0.1:8081 · relay :8082
```

**Local-only users:** leave this off. The host advertises itself over LAN
and the phone reaches it directly — no services needed.

**Server-mode users:** you do need this (or a remote copy — see step 0.5B).
Both services are stateless and restart-safe.

## 2. Build a host

```bash
mkdir my-host && cd my-host && npm init -y
npm install @crosslink/sdk-node
```

`host.mjs`:

```js
import { createCrosslinkServer } from "@crosslink/sdk-node";

const server = createCrosslinkServer({
  application: { id: "com.you.app", name: "Your App", version: "1.0.0" },
  capabilities: [
    { id: "app.control", title: "Control the app", risk: "medium" },
    { id: "app.destroy", title: "Delete everything", risk: "high" }
  ],
  signalingUrl: process.env.CROSSLINK_SIGNALING_URL ?? "http://127.0.0.1:8081",
  relayUrl: "http://127.0.0.1:8082",
  lan: { bind: "loopback" },
  pairing: { approve: async (req) => req.requestedCaps.includes("app.control") }
});

server.expose("app.status", () => ({ ok: true }), { capability: "app.control" });
server.declareEvent("app.tick");

await server.start();
const info = await server.getPairingCode();
console.log("Code:", info.code, "\nURI:", info.uri);

setInterval(() => server.emit("app.tick", { t: Date.now() }), 5000);
```

Run it:

```bash
CROSSLINK_SIGNALING_URL=http://127.0.0.1:8081 node host.mjs
```

Identity persists in `.crosslink-data/com.you.app/` — restart freely.

## 3. Pair a browser client

Serve the demo PWA (already wired for this):

```bash
npm run demo:pwa        # repo root → http://localhost:8090
```

Paste your `crosslink://pair?…` URI, compare the SAS digits with what your
host printed/approved, confirm. The PWA then calls `app.status`, receives
`app.tick` events, and survives reloads (localStorage identity).

## 4. Client API tour

```js
import { createCrosslinkClient } from "@crosslink/sdk-browser";

const client = createCrosslinkClient({
  deviceName: "Pixel 9",
  onStateChange: s => console.log(s),           // connecting → direct|crosslink-relayed → …
  onConfirmPairing: async ({ sas, grantedCaps }) => {
    return window.confirm(`Match? ${sas} caps=${grantedCaps}`);
  }
});

await client.pairFromQr(uriText, ["app.control"]);   // once
const rpc = await client.connect();                  // auto-reconnects forever
await rpc.call("app.status");
rpc.subscribe("app.tick", render);
client.forget("com.you.app");                        // local unpair
```

## 5. Device administration (host)

```ts
server.listDevices();                    // [{deviceId,name,caps,lastSeen,…}]
server.grantedCapabilities(id);          // currently valid caps (expiry applied)
server.setDeviceCaps(id, ["app.control"]);
server.revokeDevice(id);                 // kills live sessions too
server.clearConsent(id);                 // forget remembered per-use answers
server.on?.("deviceConnected", cb);      // typed events via typedOn
```

## 6. Permissions

A client requests whatever capabilities it likes. Deciding what it actually
gets happens in three places, each narrower than the last.

### The registry: what exists

```ts
capabilities: [
  { id: "notes.read",  title: "Read notes",  risk: "low", defaultGranted: true },
  { id: "notes.write", title: "Write notes", risk: "medium" },
  { id: "notes.purge", title: "Delete everything", risk: "high",
    description: "Permanently removes every note",
    confirmEachUse: true },
]
```

`risk` is not decoration — it drives the policy below. `description` is shown
to the user in prompts, so write it for them, not for you.

### The policy: what a device may ever hold

```ts
permissions: {
  allow: ["notes.read", "notes.write", "notes.purge"],  // "*" by default
  deny: [],                    // wins over allow and over any human approval
  maxAutoGrantRisk: "low",     // ceiling for autoApprove; default "low"
  requireApproval: "high",     // always needs a human; default "high"
  grantTtlMs: 30 * 24 * 3600_000,
  maxDevices: 5,
}
```

This runs **before the user is asked anything**, so the prompt only ever shows
capabilities the host was already willing to grant.

Note the default: `autoApprove: true` grants low-risk capabilities only. That
is deliberate — a host left in development mode should not become a blank
cheque. Opt into more explicitly if you mean it.

### The prompt: what the user agrees to

```ts
pairing: {
  approve: async (request) => {
    // request.requestedCaps            — what is on offer after the policy
    // request.requiresExplicitApproval — the subset a human must decide on
    // request.deniedCaps               — what the policy refused, with reasons
    // request.sas                      — compare this with the client's screen
    if (await askUser(request) === "read-only") return ["notes.read"];
    return true;
  }
}
```

Returning an array grants that subset. The result is intersected with what the
policy already permitted, so a prompt can narrow an offer but never widen it.

### Per-use consent: capabilities that are a licence to ask

A capability marked `confirmEachUse` is never a standing permission. Every
invocation of a method requiring it stops here first:

```ts
onConsentRequest: async (request) => {
  // request.title, request.description, request.input, request.deviceId
  const answer = await askUser(request);
  return answer;           // "once" | "session" | "always" | false
}
```

`session` is forgotten when the device disconnects; `always` expires after 24
hours by default; anything else asks again next time. **A host with no
`onConsentRequest` refuses these methods outright** — silence is a refusal, or
`confirmEachUse` would quietly mean nothing.

Clients see `capability_denied`, `grant_expired` or `consent_denied` as
ordinary error codes and can tell the user which happened.

## 7. Logging

Both SDKs take a `Logger`. The default is a no-op — a library should not write
to your stdout uninvited:

```ts
import { consoleLogger } from "@crosslink/core";

createCrosslinkServer({ /* … */ logger: consoleLogger({ level: "debug" }) });
createCrosslinkServer({ /* … */ logger: consoleLogger({ json: true }) });  // NDJSON
```

Records are `{ level, time, event, fields }` with stable dot-separated event
ids, so they are greppable and safe to alert on: `session.opened`,
`link.reconnect-scheduled`, `rpc.denied`, `consent.denied`, `relay.dropped`.
Secret-looking fields are redacted before reaching any sink.

To route into your own stack, implement the four-method interface or use
`createLogger(sink)`:

```ts
import { createLogger } from "@crosslink/core";

const logger = createLogger((record) => pino[record.level](record.fields, record.event));
```

## 8. Storing secrets

The host identity seed goes into the OS keychain automatically — `keytar` if
installed, Electron `safeStorage` if running under Electron, otherwise an
AES-256-GCM file keyed from `CROSSLINK_SECRET_KEY`:

```bash
npm i keytar                            # optional, native
export CROSSLINK_SECRET_KEY="$(openssl rand -hex 32)"   # or this
```

`server.status().secrets` tells you which backend is in use. An existing
plaintext `identity.json` is migrated in on first run, so upgrading keeps
every existing pairing.

In the browser, use `CrosslinkClient.create()` rather than the constructor: it
encrypts the seed under a non-extractable WebCrypto key in IndexedDB and
reports `client.storageEncrypted` so you can tell the user when it had to fall
back.

## 9. Where to go next

- Wire format details: [PROTOCOL](PROTOCOL.md)
- Upgrade a relayed session to direct WebRTC: [examples/webrtc-upgrade](../examples/webrtc-upgrade/README.md)
- Transport strategy: [ARCHITECTURE](ARCHITECTURE.md#transport-strategy)
- Deploy services publicly: [SELF_HOSTING](SELF_HOSTING.md)
- What we defend against: [THREAT_MODEL](THREAT_MODEL.md)
