<p align="center">
  <img src="https://crosslink.mintlify.site/crosslink.svg" alt="Crosslink" width="400" />
</p>

<h3 align="center">Universal secure app-to-app connectivity.</h3>

<p align="center">
  End-to-end encrypted channels between any app on your computer and any app on your phone.
  <br />
  Paired once by scanning a QR code. Reconnected automatically forever after.
</p>

<p align="center">
  <a href="https://github.com/jacobpowaza/crosslink/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-blue.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node-≥20-green.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/Tests-561-brightgreen.svg" alt="Tests" />
  <img src="https://img.shields.io/badge/Crypto-X25519%20%2B%20ML--KEM--768-9b59b6.svg" alt="Crypto" />
  <a href="https://github.com/jacobpowaza/crosslink/security"><img src="https://img.shields.io/badge/Security-audited%20primitives-orange.svg" alt="Security" /></a>
</p>

---

## What is Crosslink?

Crosslink lets any app on your computer talk to any app on your phone or
browser over an end-to-end-encrypted channel — paired once by scanning a QR
code, then reconnected automatically forever after.

```
┌───────────────┐   LAN / WebRTC / relay    ┌──────────────┐
│  App A (host) │ ◀══ E2E encrypted ══════▶ │ App B (phone)│
│  Node.js SDK  │     CLX1 sessions         │ Browser SDK  │
└───────────────┘                           └──────────────┘
        ▲                ▲      ▲
        └── signaling ────┘      └── relay (dumb pipe) ──┘
```

## Why?

Every app reinvents device pairing: ad-hoc tokens, hand-copied keys, homegrown
crypto, brittle sockets. Crosslink packages the hard parts once:

| Concern | What Crosslink gives you |
| --- | --- |
| **Pairing** | Single-use 9-digit code + QR; SAS verification words; fingerprint pinning |
| **Identity** | One Ed25519 key per installation; revocation lists persisted locally |
| **Crypto** | X25519 + HKDF handshake ("CLX1"), XChaCha20-Poly1305 session frames |
| **Authorization** | Capability grants per device, host-authored policy, per-use consent |
| **RPC** | Typed request/response, streaming progress chunks, event subscriptions |
| **Transports** | Direct WebSocket (same network or a router-mapped public address) → relay → WebRTC DataChannel |
| **Reconnect** | Exponential backoff, offline call queueing, subscription restore |
| **Secrets** | Host seed in the OS keychain; browser seed under a non-extractable WebCrypto key |
| **Observability** | Structured, redacting `Logger` threaded through every layer |
| **Bootstrap** | An installable page served on the host's own port, so one QR covers pairing and the PWA |
| **Remote access** | Router port mapping over NAT-PMP / PCP / UPnP — no account, no tunnel provider, no port forwarding |
| **Scale-out** | Redis-backed signaling, bounded relay quotas, and region-aware fallback |
| **Groups** | Host-mediated star sessions with capability-gated peer introductions |

Services are dumb by design: **signaling never sees keys or plaintext**, and the
relay forwards only opaque ciphertext.

## Install from npm

Install only the package for the environment you are building:

```bash
# Canonical Node.js host, including generated mobile delivery and pairing UI
npm install @crosslink/sdk-node

# Lower-level browser client
npm install @crosslink/sdk-browser

# React bindings (React remains a peer dependency)
npm install @crosslink/react @crosslink/sdk-browser react

# Optional umbrella package with Node.js and browser entry points
npm install @crosslink/sdk
```

The published packages contain compiled runtime files, type declarations,
licenses, and package documentation only. Demo applications, examples, tests,
repository documentation, and local development data are not included.

## Quickstart

The root `demo:*` scripts are convenience aliases for the example workspaces
listed below.

```bash
git clone git@github.com:jacobpowaza/crosslink.git
cd crosslink
npm install

# Terminal A — run a host app. Nothing else to start.
npm run demo:echo      # prints a pairing code + QR

# Terminal B — serve the browser client
npm run demo:pwa       # http://localhost:8090
```

Scan the QR with a phone on the same Wi-Fi, confirm the SAS digits, and start
calling RPC methods over the encrypted channel. There is no service in that
path: the QR carries the host's own address and the whole pairing exchange runs
on the host's socket.

<p align="center">
  <img src="https://crosslink.mintlify.site/assets/pairing/connection-widget-v2.png" alt="Crosslink pairing widget with QR and pairing code" width="760" />
  <br />
  <img src="https://crosslink.mintlify.site/assets/pairing/pairing-code-page.jpg" alt="Crosslink mobile pairing code screen" width="260" />
</p>

### From another network

For the chat app, the most reliable development path is a temporary HTTPS
tunnel. It works across different Wi-Fi networks, cellular data, carrier-grade
NAT, and routers that refuse inbound mappings:

```bash
npm run demo:chat:tunnel
```

The first run asks you to accept Cloudflare's terms before downloading the
`cloudflared` helper. The command prints the public phone URL and puts its HTTPS
page plus matching secure WebSocket endpoint into the pairing QR. The URL is
temporary, so restart the command and re-pair if the tunnel address changes.

For hosts that can accept an inbound router mapping without a tunnel:

```bash
npm run demo:echo -- --remote
```

The host asks your router for an inbound port (NAT-PMP, PCP or UPnP) and adds
the resulting public address to the QR. No ngrok, no Cloudflare, no account, no
manual port forwarding.

Where that is impossible — carrier-grade NAT, a network you do not control — the
host says so instead of quietly handing back a LAN-only QR. Check first:

```bash
npm run check:remote
```

A relay is the fallback for those cases:

```bash
npm run stack          # signaling :8081 + relay :8082
CROSSLINK_SIGNALING_URL=http://127.0.0.1:8081 \
CROSSLINK_RELAY_URL=http://127.0.0.1:8082 \
npm run demo:echo
```

## Canonical application path

```ts
import { createCrosslinkServer } from "@crosslink/sdk-node";
import { consoleLogger } from "@crosslink/core";

const server = createCrosslinkServer({
  application: { id: "com.me.notes", name: "Notes", accentColor: "#f97316" },
  mobile: { entry: "./mobile/index.html" },
  capabilities: [
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true },
    { id: "notes.purge", title: "Delete everything", risk: "high", confirmEachUse: true },
  ],
  permissions: { maxAutoGrantRisk: "low", requireApproval: "high" },
  onConsentRequest: (req) => confirm(`Allow "${req.title}"?`),
  logger: consoleLogger({ level: "info" }),
});

server.expose("notes.get", () => db.getNote(), { capability: "notes.read" });
server.expose("notes.purge", () => db.purge(), { capability: "notes.purge" });
server.declareEvent("notes.changed");

await server.start();
console.log(server.describeMobileDelivery().message);
```

The desktop page mounts Crosslink's self-driving pairing card. With no `source`
option it uses the canonical loopback control surface, and it takes the name,
icon and colours from the `application` block above — the page states nothing
about the app twice:

```js
CrosslinkSDK.createPairingCard({ target: "#crosslink" });
```

The mobile page contains application UI and one callback; Crosslink injects the
SDK, manifest, Service Worker, pairing/onboarding flow, offline shell, endpoint
discovery, and reconnect behavior:

```js
crosslink.onConnected(async (rpc) => {
  render(await rpc.call("notes.get"));
});
```

See the [Quickstart](https://crosslink.mintlify.site/quickstart) for the loopback desktop handler and
complete runnable files.

## Advanced: manual browser client

Use the lower-level client only for a native shell, custom transport, tests, or
another integration where Crosslink cannot serve its canonical mobile
bootstrap. This path assumes responsibility for pairing and lifecycle UI.

```ts
import { createCrosslinkClient } from "@crosslink/sdk-browser";

const client = createCrosslinkClient({
  deviceName: "Pixel 9",
  onStateChange: (state) => console.log(state),
  onConfirmPairing: async ({ sas, grantedCaps }) => {
    return window.confirm(`Match? ${sas} caps=${grantedCaps}`);
  }
});

await client.pairFromQr(uriText, ["notes.read"]);
const rpc = await client.connect();
await rpc.call("notes.get");
rpc.subscribe("notes.changed", rerender);
```

Optionally upgrade to a direct WebRTC DataChannel:

```ts
import { tryUpgradeToWebrtc } from "@crosslink/webrtc-adapter";

await tryUpgradeToWebrtc(client.connection!, {
  createPeer: () => new RTCPeerConnection({ iceServers }),
});
```

## Transport Modes

Crosslink automatically selects the best transport:

| Priority | Transport | When it works | Setup needed |
|---|---|---|---|
| 1 | **LAN WebSocket** | Phone + laptop on same WiFi | None — host binds automatically |
| 2 | **Crosslink relay** | Any network topology | `npm run stack`, or a relay you host |
| 3 | **WebRTC DataChannel** | Post-connection upgrade | WebRTC adapter in browser |

The client SDK tries each in order, falling through on failure. Sessions
survive IP changes via reconnect with exponential backoff.

## Architecture

### Two HTTP surfaces, deliberately separated

Crosslink splits what a host serves in two, because the two halves have opposite
reachability requirements:

| Surface | Bound to | Serves |
| --- | --- | --- |
| **Control** `/__crosslink/*` | loopback only | Mints pairing codes, changes network mode, lists and revokes devices, serves the desktop widget bundle |
| **Bootstrap** | the transport port | The phone-facing page: manifest, Service Worker, icons, browser SDK, install handoff, and your `mobile.entry` |

The control surface mints trust, so it must never answer the network a QR is
scanned on — the handler refuses a non-loopback peer itself rather than trusting
the surrounding server to have bound correctly. The bootstrap surface shares the
transport port so one router mapping covers both the page and the socket it
connects on.

### What the QR encodes

Not the pairing URI. iOS Camera has no handler for a custom scheme and silently
ignores `crosslink://`, so the QR carries an ordinary page URL with the pairing
payload in the *fragment*:

```text
https://<bootstrap origin>/#pair=crosslink%3A%2F%2Fpair%3Fv%3D2%26e%3D…%26c%3D<code>
```

A fragment never reaches a server, so the payload stays out of request lines,
proxies and access logs. The page runs the browser SDK, unwraps `#pair=`, and
pairs with no further round trip. `pairing.bootstrapUrl` points at a published
https origin when you have one — that origin becomes the installed app's
identity and survives the desktop changing address; without one, the host's own
bootstrap origin is used.

### Framework-owned UI

Pairing, onboarding, install, offline and revoked screens are Crosslink's, not
yours. You declare one `application` block on the host and it drives all of
them: the desktop pairing card, the installable manifest, and every mobile
screen. The desktop card draws the Crosslink wordmark; the mobile screens carry
a "Powered by Crosslink" badge mounted by the bootstrap, whose placement,
colour and size you configure through `mobile.attribution`.

### Installation address vs. transport address

The installation address and transport address are separate:

```text
stable HTTPS origin → installed app identity → endpoint discovery
    → current desktop endpoint → authorized secure transport
```

Installing the PWA does not pin it to the LAN IP used during pairing. The
origin owns the Service Worker/cache; Crosslink resolves the desktop's current
route independently. See [Durable Origins](https://crosslink.mintlify.site/client/durable-origin).

```
┌─────────────────────────────────────────────────────────────┐
│                      Desktop App                            │
│  createCrosslinkServer()                                    │
│                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │ LAN Listener │   │ Relay Client │   │ Signaling    │    │
│  │ ws://0.0.0.0 │   │ (mux channel)│   │ (presence)   │    │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘    │
│         │                  │                   │            │
└─────────┼──────────────────┼───────────────────┼────────────┘
          │                  │                   │
          │  (same Wi-Fi)    │  (different       │  (pairing
          │                  │   network)         │   resolution)
          ▼                  ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                      Phone / Browser                        │
│  CrosslinkClient                                            │
│                                                             │
│  Candidates (tried in order):                               │
│    1. LAN direct   → ws://192.168.x.x:port                  │
│    2. Relay        → wss://relay.example.com/channel        │
│                                                             │
│  Upgrade path (after initial connection):                   │
│    relay → WebRTC DataChannel (when direct path available)  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Security

Crosslink uses audited cryptographic primitives from `@noble/curves` and
`@noble/ciphers` — pure JS, identical behavior in every runtime:

| Purpose | Primitive |
| --- | --- |
| Device identity | Ed25519 signing keypair |
| Key agreement | X25519 (ephemeral + static, double-DH) |
| Hybrid key agreement | Optional X25519 + ML-KEM-768 (`preferred` or fail-closed `required`) |
| Session keys | HKDF-SHA256 over authenticated classical and optional PQ secrets |
| Frame encryption | XChaCha20-Poly1305 AEAD, random 24-byte nonces |
| Hashes / fingerprints | SHA-256 |

**Invariants:**

- **Forward secrecy** — fresh ephemeral X25519 per session; past traffic safe
  after key compromise
- **Mutual authentication** — both sides sign transcripts binding every public
  key, nonce, appId, and deviceId
- **Replay resistance** — per-direction monotonic counters in AEAD associated
  data
- **MITM resistance** — QR pins host fingerprint; SAS adds human verification
- **Untrusted services** — signaling sees hashed codes + opaque signed blobs;
  relay sees only ciphertext
- **Revocation** — immediate at enforcement point; live sessions killed, grants
  dropped

See [Security](https://crosslink.mintlify.site/security/overview) and
[Threat model](https://crosslink.mintlify.site/security/threat-model) for the full analysis.

## Packages

| Package | Purpose |
| --- | --- |
| `@crosslink/protocol` | Wire spec, framing, canonical JSON, conformance fixtures |
| `@crosslink/core` | Crypto, CLX1 handshake, sessions, pairing, RPC engine |
| `@crosslink/sdk-node` | `createCrosslinkServer` for Node.js hosts |
| `@crosslink/sdk-browser` | `createCrosslinkClient` for phones and browsers |
| `@crosslink/webrtc-adapter` | DataChannel transport + SDP exchange over existing sessions |
| `@crosslink/signaling` | Presence directory + pairing-code router |
| `@crosslink/relay` | Stateless encrypted-pipe relay for NAT traversal |
| `@crosslink/conformance` | Language-neutral canonical JSON, framing, and negative-case runner |
| `sdks/swift`, `sdks/kotlin`, `sdks/rust` | Native protocol baselines tested against the shared corpus |

## Apps & Examples

| App | What it does |
| --- | --- |
| `apps/chat` | Full chat app — web host + installable mobile client on one port |
| `apps/demo-pwa` | Installable PWA reference client that ships the canonical bootstrap |
| `examples/echo-host` | Minimal host — exposes `echo.ping`, pairs in 20 lines |
| `examples/notes-host` | Notes sync host |
| `examples/todo-host` | Todo app with local + relay modes |
| `examples/webrtc-upgrade` | Relay → direct WebRTC, wired end to end |
| `examples/electron-chat` | Packaged, sandboxed Electron chat host with native pairing approval |
| `examples/react-tsx`, `examples/vanilla` | Minimal client UIs |

## Documentation

The full documentation site lives in `docs/` (Mintlify). Start here:

- [Quickstart](https://crosslink.mintlify.site/quickstart) — a working connection in five minutes
- [Building with Crosslink](https://crosslink.mintlify.site/build/overview) — the developer's path, in order
- [Your first app](https://crosslink.mintlify.site/build/first-app) — host + phone client on one port
- [Capabilities and RPC](https://crosslink.mintlify.site/build/capabilities-and-rpc) — the permission and method surfaces
- [Local development](https://crosslink.mintlify.site/build/local-development) — repo layout, build, tests, examples
- [Production checklist](https://crosslink.mintlify.site/build/production-checklist) — before other people run it
- [Package map](https://crosslink.mintlify.site/reference/packages) — what to import, and what not to
- [Connection modes](https://crosslink.mintlify.site/guides/connection-modes) — the four host network modes
- [Remote access](https://crosslink.mintlify.site/guides/remote-access) — router port mapping, and its real limits
- [Architecture](https://crosslink.mintlify.site/concepts/architecture) — how the pieces fit
- [Pairing](https://crosslink.mintlify.site/concepts/pairing) — the v2 pairing URI and the direct exchange
- [Protocol spec](https://crosslink.mintlify.site/reference/protocol) — bytes on the wire
- [Networking](https://crosslink.mintlify.site/connections/networking) — routes, fallback, firewalls
- [Self-hosting](https://crosslink.mintlify.site/guides/self-hosting) — run your own signaling/relay
- [Security](https://crosslink.mintlify.site/security/overview) — crypto choices and invariants
- [Threat model](https://crosslink.mintlify.site/security/threat-model) — what we defend against, what we don't
- [Scale-out](https://crosslink.mintlify.site/guides/scale-out) — Redis signaling, relay quotas, and regions
- [Group sessions](https://crosslink.mintlify.site/concepts/group-sessions) — host-mediated multi-device sessions
- [Native SDKs and conformance](https://crosslink.mintlify.site/guides/native-sdks) — Swift, Kotlin, Rust, and the corpus
- [Electron example](https://crosslink.mintlify.site/guides/electron) — bundle a hardened desktop host

## Development

```bash
npm test          # 560 tests: unit, both SDKs, full-stack integration
npm run typecheck # strict TS across every workspace
npm run build     # 19 build targets
npm run security:check   # dependency audit + secret/isolation baseline
npm run security:secrets # gitleaks over the history and the working tree
```

Both SDKs are unit-testable without a network. `@crosslink/sdk-browser` ships
`MockSocket`, an in-memory `WsLike` pair, so pairing, RPC dispatch, reconnect
and revocation can be driven against a real `HostPairingManager` and
`HostAcceptor` with every failure produced deliberately.

## Completed milestones

- **M6 Hardening** — OS keychain/Electron `safeStorage` adapters, fail-safe
  approval notifications, bounded pairing creation, and structured redacting logs.
- **M7 Scale-out** — Redis-backed signaling presence and opaque routing,
  relay channel/client/byte/bandwidth quotas, and region-aware fallback.
- **M8 Direct discovery** — authenticated WebRTC adapter end-to-end coverage and
  strict local-only mDNS/DNS-SD discovery candidates.
- **M9 Groups** — bounded star sessions with host-issued, single-use invites and
  capability-gated introductions and delivery.
- **M10 Ecosystem** — positive and negative protocol conformance, Swift/Kotlin/Rust
  protocol SDKs, and transcript-bound hybrid X25519 + ML-KEM-768 exchange.

## Remote access, without a tunnel provider

`networkMode: "remote"` reaches a host from another network with nothing to sign
up for and nothing to configure:

- The router is asked for an inbound port over UPnP, NAT-PMP or PCP
  (`packages/nat-map`), and the mapping is renewed while the host runs and
  released on shutdown.
- A `wan` route is added to the pairing QR **only** when a mapping actually
  succeeded. A private address is never advertised as a public one, and there is
  no silent fall back to LAN when remote was requested — the host reports why it
  could not, including carrier-grade NAT and double NAT.
- The bootstrap page and the transport share one port, so one mapping is enough
  and the installed PWA loads over a route its socket can also use.
- The listen port is remembered across restarts, so a paired phone reconnects
  without a second scan after the desktop app or the machine restarts.

Diagnose any of it with `npm run check:remote`. Details and limits:
[Remote access](https://crosslink.mintlify.site/guides/remote-access).

## License

Apache 2.0 — see [LICENSE](LICENSE).

---

<p align="center">
  <strong>Help support other projects</strong><br />
  <a href="https://venmo.com/u/jacobpowaza">
    <img src="https://img.shields.io/badge/Venmo-%40jacobpowaza-3D95FF?style=for-the-badge&logo=venmo&logoColor=white" alt="Venmo @jacobpowaza" />
  </a>
</p>
