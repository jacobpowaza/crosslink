# Networking Architecture

**Status:** Design decision, implemented.

Crosslink must let a desktop app and an iPhone communicate securely without
either party paying for hosting, managing domains, understanding networking, or
running any infrastructure. This document surveys every realistic approach,
weighs them against Crosslink's constraints, and describes the hybrid
architecture we ship.

---

## 1. The hard constraint

Two devices behind separate NATs cannot establish a direct TCP connection
without help from a third party that at least one side can reach at a stable
address. This is physics, not a product decision. The question is **who** pays
the small cost of that third party, not whether it exists.

Our constraint: the developer pays $0, the end user pays $0, no accounts are
created, and no one installs or configures networking software. That rules out
"the developer runs their own server" but allows "the framework provides a
thin, free, anonymous public service" — the same model PeerJS, GitHub Pages,
Cloudflare Tunnel (free tier), and dozens of OSS tools already use.

---

## 2. Candidate approaches compared

| Approach | Reliability | NAT/CGNAT | iPhone PWA | Cost | Infra burden | Security model | Verdict |
|---|---|---|---|---|---|---|---|
| **ngrok / Cloudflare Tunnel** | High (tunnel) | Any NAT (cloud relay) | Needs public URL (works) | $0 free tier, but needs account + domain for CF | Dev installs/configures binary | Tunnel sees HTTP, not E2E payload | Not zero-friction; dev must learn tunnel concepts |
| **mDNS / LAN direct** | LAN only | N/A | iOS supports Bonjour/mDNS | $0 | None | Local only | ✅ Use when available |
| **WebRTC P2P (STUN only)** | Moderate | Cone NAT yes; symmetric NAT fails; no TURN fallback | iOS Safari 17.4+ DataChannels work | $0 STUN | Dev manages ICE/signaling | E2E, excellent | Good fallback but incomplete without TURN |
| **WebRTC + TURN relay** | High | CGNAT yes | iOS Safari 17.4+ | TURN bandwidth costs | Self-hosted TURN = infra; public TURN = trust | E2E | Requires a TURN server to be hosted or trusted |
| **Cloudflare Tunnel / ngrok auto-provisioned** | High | Any NAT | HTTPS URL works | $0 free tier | SDK spawns cloudflared/ngrok binary | Tunnel sees plaintext | Better than manual, but binary + account still required |
| **Reverse SSH tunnel** | High | Any NAT | Needs HTTPS endpoint | $0 (if SSH access exists) | Dev manages SSH | SSH hop sees traffic | Requires SSH access; not zero-config |
| **UPnP / NAT-PMP / PCP** | Low–moderate | Only open/cone NATs, no CGNAT, many routers block it | N/A (browser can't use) | $0 | None | Requires direct socket access | Unavailable in browsers; unreliable on home routers |
| **STUN-only (no TURN, no relay)** | Low | Fails on ~50% of NATs | N/A | $0 | None | E2E | Incomplete alone |
| **Frameworks with hosted signaling (PeerJS model)** | High (varies) | Depends on relay | HTTPS URL works | $0 (public broker) | None | Broker sees metadata, not payload | ⭐ Closest to what we want |
| **GitHub Pages / static hosting for bootstrap** | High | N/A | HTTPS + installable PWA | $0 | Dev pushes static files | No server state | ✅ Good for the bootstrap/client side |

---

## 3. Chosen architecture: the crosslink hybrid

After analysis, no single approach satisfies every constraint. The correct
architecture is a **transport-first, hybrid stack** with automatic fallback and
a thin, anonymous public bootstrap:

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
│                      iPhone PWA                             │
│  CrosslinkClient                                            │
│                                                             │
│  Candidates (tried in order):                               │
│    1. LAN direct   → ws://192.168.x.x:port                  │
│    2. Relay        → wss://relay.crosslink.app/channel      │
│                                                             │
│  Upgrade path (after initial connection):                   │
│    relay → WebRTC DataChannel (when direct path available)  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 3.1 Transport precedence

The client tries transports in this order, automatically, with no user choice:

| Priority | Transport | When it works | How it gets there |
|---|---|---|---|
| 1 | **LAN WebSocket** | Desktop and phone share the same Wi-Fi | Host binds `ws://0.0.0.0:port`; phone connects directly |
| 2 | **Crosslink relay** | Any network topology (fallback) | Host dials out to the relay service; phone dials the same channel |
| 3 | **WebRTC DataChannel** | Post-connection upgrade | SDP exchange happens over whatever transport is already connected; moves data off the relay |

This order is **automatic** — the client SDK picks the best available.

### 3.2 Hosted bootstrap (iOS Add to Home Screen)

A raw `crosslink://pair?…` URI has no handler on iOS — the phone camera
ignores it. To deliver the "scan QR → Safari opens → Add to Home Screen →
paired in one tap" flow, the QR instead encodes a plain `https://` URL:

```
https://your-app.netlify.app/#pair=crosslink%3A%2F%2Fpair%3Fv%3D1%26s%3D...
```

The host app configures `pairing.bootstrapUrl` once, pointing at a static page
that hosts the Crosslink browser SDK. The QR is then this HTTPS link. The flow:

1. iPhone scans QR → Safari opens
2. PWA reads `#pair=<uri>` → calls `client.pairFromQr()`
3. SAS confirmation
4. User taps "Add to Home Screen"
5. The app is installed; future opens reconnect automatically

The bootstrap page is **static** — it can live on GitHub Pages, Netlify, S3,
or any free static host. It never receives secrets; the E2E handshake runs
entirely client-side.

### 3.3 Local dev services

For development, Crosslink ships with local signaling and relay services:

```bash
npm run stack   # signaling :8081, relay :8082 (loopback only, closed by dev tokens)
```

For cross-network access, two options:

1. **Tunnel your local stack** — use ngrok or Cloudflare Tunnel to expose
   the local services to the internet (see [TUNNELING.md](TUNNELING.md))
2. **Deploy on a VPS** — run the services behind a reverse proxy with TLS
   (see [SELF_HOSTING.md](SELF_HOSTING.md))

### 3.4 Fallback hierarchy (automatic)

```
                    ┌───────────────┐
                    │  pairFromQr() │
                    └───────┬───────┘
                            │
              ┌─────────────▼─────────────┐
              │   Resolve code via        │
              │   signaling service       │
              │   (finds host + relay     │
              │    channel + LAN hint)    │
              └─────────────┬─────────────┘
                            │
              ┌─────────────▼─────────────┐
              │   Try candidate 1: LAN    │
              │   (ws://host-ip:port)     │
              └─────┬───────────────┬─────┘
                success              fail
                    │                │
                    ▼                ▼
              ┌─────────┐    ┌──────────────────┐
              │ Done!    │    │ Try candidate 2:  │
              │ direct   │    │ relay (wss://…/   │
              └─────────┘    │ channel)          │
                              └─────┬────────────┘
                                success   fail
                                    │        │
                                    ▼        ▼
                              ┌───────┐  ┌────────┐
                              │ Done! │  │ OFFLINE│
                              │ relay │  │ retry  │
                              └───────┘  └────────┘
```

After initial connection, the client may **upgrade** from relay to WebRTC if a
direct path becomes available. This reduces relay bandwidth and improves
latency.

---

## 4. Pairing protocol

The QR code is a **pairing mechanism**, not just a URL. The protocol is:

### 4.1 QR content

The QR encodes either:
- A raw manifest URI: `crosslink://pair?v=1&s=<signaling>&c=<code>&a=<appId>&n=<name>&f=<fp16>`
- A hosted bootstrap URL: `https://bootstrap-host/#pair=<encoded manifest>`

Both carry the same data; the second just has an HTTPS wrapper.

### 4.2 Pairing flow (signaling path)

1. **Host** calls `getPairingCode()`:
   - Generates a single-use, 120-second code
   - Registers the code hash on the signaling service
   - Builds the manifest URI (includes signaling URL, code, host fingerprint)
   - Optionally wraps it in a bootstrap HTTPS link

2. **Phone** scans the QR:
   - Unwraps the bootstrap URL if needed
   - Connects to the signaling service (found in the URI)
   - Resolves the code → gets host's public keys + relay channel

3. **Mutual authentication** (3-message exchange over signaling):
   - Phone sends `pair_claim`: device ID, public keys, name, nonce, Ed25519
     signature over the transcript, requested capabilities
   - Host verifies signature, evaluates policy, generates SAS, sends
     `pair_challenge`: host public keys, challenge nonce, granted capabilities,
     host signature
   - Phone verifies host fingerprint (pinned in QR), verifies host signature,
     confirms SAS match, sends `pair_complete`: phone signature over the
     challenge
   - Host verifies phone signature, persists `TrustedDeviceRecord`

4. **Single-use enforcement**: the code is marked used immediately after
   `pair_complete`; the session cannot be replayed.

### 4.3 Security properties

| Property | Mechanism |
|---|---|
| **MITM prevention** | Fingerprint pinning (host Ed25519 key baked into QR) + SAS human verification |
| **Replay prevention** | Single-use codes + 120-second TTL + nonce echo + transcript binding |
| **Forward secrecy** | Fresh ephemeral X25519 keys per session; session keys derived via HKDF |
| **Frame encryption** | XChaCha20-Poly1305 AEAD with monotonic counter in AD |
| **Revocation** | Immediate at enforcement point; host closes session + grants dropped |
| **Channel security** | 128-bit random channel IDs; relay cannot decrypt (opaque pipe) |
| **No bearer tokens** | Device authentication is per-session cryptographic; no persistent tokens for clients |

### 4.4 Post-pairing reconnection

After pairing, the phone stores a `PairedAppRecord` containing:
- Host Ed25519 + X25519 public keys (for pinning)
- Host Ed25519 fingerprint (for identity verification)
- Granted capabilities
- Connection hints (relay URL + channel, LAN host + port)

On subsequent connections:
1. Phone queries signaling for fresh presence (updated relay channel)
2. Falls back to stored hints if signaling is down
3. Tries LAN-first, then relay
4. Each connection runs a fresh CLX1 handshake (new ephemeral keys)
5. Host re-checks revocation state before accepting

No static bearer token is ever exchanged during reconnection.

---

## 5. Connection states (user-facing)

Both SDKs expose a `ConnectionState` that maps directly to UI copy:

| State | What the user sees | Technical meaning |
|---|---|---|
| `offline` | "Disconnected" | No active session |
| `connecting` | "Connecting…" | Transport dial in progress |
| `direct` | "Connected (local)" | LAN WebSocket |
| `crosslink-relayed` | "Connected (relayed)" | Crosslink relay pipe |
| `reconnecting` | "Reconnecting… (attempt N)" | Backoff + retry after transport drop |
| `unauthorized` | "Access denied" | Handshake rejected (not paired) |
| `revoked` | "This device was removed" | Host revoked pairing |
| `protocol-incompatible` | "App needs updating" | Version mismatch |

The host side surfaces `connectivity` events with a single-line summary:

- `"Phones can reach you from anywhere."` — relay is connected
- `"Reachable on your Wi-Fi only; add signaling/relay to reach phones elsewhere."` — LAN only
- `"No inbound path yet — paired phones can't reach you right now."` — offline

---

## 6. What Crosslink handles for the developer

The developer writes:

```ts
const crosslink = new Crosslink();
crosslink.start();
crosslink.on("message", (msg) => { /* ... */ });
```

Crosslink internally handles:

| Concern | Implementation |
|---|---|
| Server startup | LAN WebSocket + relay channel + signaling presence |
| Certificates / TLS | WSS over public internet; self-signed on LAN |
| NAT traversal | Host dials out to relay (no port forwarding) |
| QR generation | Pairing URI + optional bootstrap HTTPS link |
| Pairing | Single-use code + fingerprint pinning + SAS |
| Transport selection | LAN-first → relay → WebRTC upgrade |
| Reconnection | Exponential backoff + relay channel re-allocation |
| Authentication | CLX1 handshake (X25519 + Ed25519) per session |
| Mobile bootstrap | Hosted PWA reads `#pair=<uri>` from QR fragment |
| Pairing Widget UI | Standardized 3-column card + Settings Cog with 3 connection modes |
| State management | Connection states + connectivity events |
| Revocation | Immediate enforcement; session closed + grants dropped |
| Encryption | XChaCha20-Poly1305 session frames; relay sees only ciphertext |

---

## 6.1 Pairing Widget & Connection Modes (Settings Cog)

The canonical Crosslink Pairing Card (`PairingCard` / `createPairingCard`) includes a settings cog (⚙️) that allows users and developers to switch between 3 connection modes at runtime:

1. **Open LAN + Relay (Remote)** *(Default)*:
   - Enables global remote access outside the local Wi-Fi.
   - Includes an **Info Knob (ℹ️)** detailing security: End-to-end encrypted with XChaCha20-Poly1305, Ed25519 host key pinning, single-use codes (120s expiry), and human-verified SAS digits.
   - Hyperlink: [`Security Guide`](https://crosslink.dev/docs/security)
2. **Local Network Only**:
   - Disables relay and public signaling.
   - Restricts traffic to the local Wi-Fi subnet over direct LAN WebSockets.
   - Hyperlink: [`LAN Setup Guide`](https://crosslink.dev/docs/lan-only)
3. **ngrok Setup**:
   - Optional tunneling mode for developers using custom ngrok domains or auth tokens.
   - Hyperlink: [`ngrok Guide`](https://crosslink.dev/docs/ngrok)

---

## 7. What remains as roadmap work

### 7.1 WebRTC DataChannel upgrade (active)

The WebRTC adapter (`@crosslink/webrtc-adapter`) exists but requires wiring
into the automatic upgrade path. Once active, the client will attempt WebRTC
after initial connection, moving traffic off the relay when a direct path is
available. This is the single biggest improvement to relay bandwidth costs.

### 7.2 TURN fallback (behind relay)

For CGNAT and symmetric NAT where WebRTC STUN fails, a TURN server is
required. The current relay serves as the fallback; a dedicated TURN endpoint
would be more efficient but costs bandwidth. Future: Cloudflare TURN (free tier)
or self-hosted coturn.

### 7.3 Group sessions

The star topology is already multi-device capable. Future: peer introductions
via capability-gated signaling.

### 7.4 Auto-provisioned tunnel fallback

If the public relay is unavailable (regulatory, network policy), the SDK could
offer a one-click "provision a tunnel via cloudflared" path. This requires
Cloudflare's free tier account (the framework, not the developer, would hold
it). Low priority.

---

## 8. Deployment model

### 8.1 Open-source developer (default)

```bash
npm install @crosslink/sdk-node
npm run stack                            # start local signaling + relay
CROSSLINK_SIGNALING_URL=http://127.0.0.1:8081 \
CROSSLINK_RELAY_URL=http://127.0.0.1:8082 \
node my-app.mjs
# Prints QR, phone scans (same WiFi), works.
```

### 8.2 Self-hosted / private relay

```bash
CROSSLINK_SIGNALING_URL=https://signal.mycompany.com \
CROSSLINK_RELAY_URL=https://relay.mycompany.com \
CROSSLINK_SIGNALING_TOKEN=abc123 \
CROSSLINK_RELAY_TOKEN=def456 \
node my-app.mjs
```

### 8.3 LAN-only (no internet)

```bash
# Just don't set signaling/relay URLs
node my-app.mjs
# QR encodes ws://<lan-ip>:<port>; works on same Wi-Fi
```

---

## 9. Threat model summary

Crosslink's networking architecture defends against:

- **Man-in-the-middle** during pairing: fingerprint pinning + SAS verification
- **Replay attacks**: single-use codes, 120s TTL, nonce echo, transcript binding
- **Eavesdropping**: E2E XChaCha20-Poly1305; relay/signaling see only ciphertext
- **Stale channel access**: relay channels expire after 24h; host re-allocates and
  re-publishes presence
- **Revoked device access**: host closes session immediately; grants dropped;
  next handshake rejected
- **Malformed input**: deterministic rejection with size limits, rate limits,
  frame size caps
- **Shared-secret leakage**: no persistent bearer tokens for clients; device
  authentication is per-session cryptographic

See [THREAT_MODEL.md](THREAT_MODEL.md) for the full analysis.
