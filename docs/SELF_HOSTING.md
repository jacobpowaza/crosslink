# Self-hosting

Crosslink's services are tiny stateless Node processes. You can run them
anywhere TLS terminates.

**Not sure you need to self-host?** If your phone and laptop are on the same
WiFi, you don't — see [Getting started](GETTING_STARTED.md) for the
local-only path. This doc is for the cross-network case.

## Local stack (default)

Crosslink runs entirely locally by default. Both services bind to loopback
and are closed by default (per-machine dev tokens in `.crosslink-data/`):

```bash
npm run build        # produces services/*/dist/cli.js
npm run stack        # signaling :8081, relay :8082 (loopback only)
```

## Cross-network testing

For a phone on a different WiFi, you have two options:

### Option A: LAN only (no tunnel needed)

If the phone and laptop are on the same WiFi, skip the tunnel entirely:

```bash
npm run stack
node host.mjs   # QR encodes ws://<lan-ip>:<port>; scan and go
```

### Option B: Tunnel your local stack (for private deployments)

```bash
# terminal 1 — the services
npm run stack                                     # signaling :8081, relay :8082

# terminal 2 — one tunnel per service (separate process each)
ngrok tcp 8081                                    # copy the wss://… URL
ngrok tcp 8082                                    # second wss://… URL
```

Then start your host pointed at the public URLs:

```bash
CROSSLINK_SIGNALING_URL=<wss-from-ngrok-8081> \
CROSSLINK_RELAY_URL=<wss-from-ngrok-8082> \
node host.mjs
```

The pairing QR embeds the signaling URL, so the phone needs no config —
scan and go.

`cloudflared` works the same way:

```bash
cloudflared tunnel --url tcp://localhost:8081
cloudflared tunnel --url tcp://localhost:8082
```

Each prints a `*.trycloudflare.com` URL.

> Free-tier tunnel URLs rotate every time you restart the tunnel process.
> That's fine for a development session — relaunch the host, rescan the QR.
> For anything persistent, deploy on a real box (next section).

## Hosted bootstrap (iOS Add to Home Screen)

To deliver the "scan QR → Safari opens → Add to Home Screen → paired" flow,
configure a bootstrap URL pointing at a static page hosting the Crosslink
browser SDK:

```ts
createCrosslinkServer({
  application: { id: "com.example.app", name: "My App" },
  pairing: {
    bootstrapUrl: "https://my-pwa.netlify.app",
  },
});
```

The QR then encodes an `https://` link (not a `crosslink://` scheme), so
scanning it with an iPhone opens Safari. The PWA reads `#pair=<uri>` and
pairs automatically. The bootstrap page can be hosted anywhere static HTTPS
is free — GitHub Pages, Netlify, S3, your own server.

## Production deployment

### Requirements

- Node ≥ 20 behind a reverse proxy with **TLS** (Caddy/nginx/traefik). WSS is
  mandatory in production: pairing blobs and presence travel over it.
- No database required; both services are memory-only and restart-safe.
- WebSocket upgrade support on:
  - `GET /ws` (signaling)
  - `GET /ws?channel=…` (relay)

## Authentication tokens

By default both services are **open**: anyone who learns the URL can register
a host on your signaling directory or allocate a channel on your relay. That
is fine for a public directory and wrong for a private deployment, so both
accept a shared secret.

```bash
export CROSSLINK_SIGNALING_TOKEN="$(openssl rand -hex 32)"
export CROSSLINK_RELAY_TOKEN="$(openssl rand -hex 32)"
```

Hosts present it as `Authorization: Bearer <token>` on the websocket upgrade
(and on `POST /channels` for the relay). Prefer the environment variable over
the `--auth-token` flag: an argv token is visible to every process on the box.

**Clients are deliberately not required to present a token.** A browser cannot
hold a shared secret — anything shipped to it is public — and the security
that matters is already elsewhere: the 128-bit channel id gates client attach
on the relay, the pairing code gates code resolution on signaling, and neither
service can read a byte of application traffic in any case. The relay does
accept an optional `clientAuthToken` for fully-private deployments where every
client is a trusted first-party process.

`GET /health` reports which posture each service is in:

```json
{ "ok": true, "service": "crosslink-relay", "auth": "required" }
```

A host pointed at a token-protected relay without the token fails to start
with a message naming the variable, rather than silently falling back to
LAN-only reachability.

### Signaling

```bash
PORT=8081 CROSSLINK_SIGNALING_TOKEN=… node services/signaling/dist/cli.js
```

Flags: `--port`, `--host`, `--auth-token` (prefer the env var).

Endpoints:

| Route | Purpose |
| --- | --- |
| `WS /ws` | host + client connections (`host_hello`, `pair_*`) |
| `GET /health` | liveness |
| `GET /apps`, `GET /apps/:appId` | read-only presence directory |

Hardening notes:

- Presence entries are self-declared; clients verify fingerprints anyway, but
  consider restricting `/apps` to authenticated callers if appId enumeration
  matters to you.
- Horizontal scale requires a shared registry for `{appId → host conn}` and
  code→psid lookups (Redis) plus sticky routing for `pair_payload`. Single-box
  covers small/medium fleets today.

### Relay

```bash
PORT=8082 CROSSLINK_RELAY_TOKEN=… node services/relay/dist/cli.js
```

Flags: `--port`, `--host`, `--auth-token`, `--client-auth-token` (prefer the
env vars `CROSSLINK_RELAY_TOKEN` / `CROSSLINK_RELAY_CLIENT_TOKEN`).

Endpoints: `POST /channels`, `WS /ws?channel&role[&token][&auth][&mux]`,
`GET /health`, `GET /stats`.

Tuning via env-equivalent options when embedding programmatically:
`maxFrameBytes` (256 KiB default), `ratePerSec` (100), `idleTimeoutMs` (10 min),
`maxChannelLifeMs` (24 h), `maxClientsPerChannel` (8, or
`CROSSLINK_RELAY_MAX_CLIENTS`), `channelsPerMinutePerIp` (30).

#### Channel multiplexing

A host advertises one relay channel, but a person may have several paired
devices off-network at once — a phone on cellular and a laptop on hotel
wi-fi. A host that connects with `mux=1` gets a multiplexed channel: each
attached client is assigned a stream id, and host-side binary frames carry a
4-byte big-endian stream prefix that the relay strips on the way out and
re-applies on the way in.

Client framing is untouched, so clients need no knowledge of any of this, and
a host that connects without `mux=1` keeps the original one-client-at-a-time
behaviour. `@crosslink/sdk-node` always opts in.

Without multiplexing, the second device to dial a host is refused with
`channel-busy` — which looks, from the user's side, exactly like the feature
not working.

The relay holds no keys and no PII beyond ephemeral channel ids; logs should be
configured accordingly by the operator.

### Reverse proxy example (Caddy)

```
signal.example.com {
  reverse_proxy /ws* 127.0.0.1:8081
  reverse_proxy *     127.0.0.1:8081
}
relay.example.com {
  reverse_proxy /ws*  127.0.0.1:8082
  reverse_proxy *     127.0.0.1:8082
}
```

### Pointing apps at your stack

Hosts:

```bash
CROSSLINK_SIGNALING_URL=https://signal.example.com \
CROSSLINK_RELAY_URL=https://relay.example.com \
CROSSLINK_SIGNALING_TOKEN=…  \
CROSSLINK_RELAY_TOKEN=…      \
node host.mjs
```

Or in code:

```ts
createCrosslinkServer({
  application: { id: "com.example.app", name: "My App" },
  signalingUrl: "https://signal.example.com",
  relayUrl: "https://relay.example.com",
  signalingToken: process.env.CROSSLINK_SIGNALING_TOKEN,
  relayToken: process.env.CROSSLINK_RELAY_TOKEN,
});
```

Pairing URIs embed the signaling URL automatically, so clients need zero
configuration — scan and go.

## Capacity rules of thumb

- Signaling: one connection per online host app + transient client pairings;
  thousands of hosts per core are realistic.
- Relay: cost scales with ciphertext bytes relayed (one hop). Size like a
  TURN-lite service; enforce quotas at your edge if exposing publicly.
- Relay bandwidth is the cost that grows with usage, so it is worth reducing:
  clients that can reach the host directly should upgrade off the relay onto
  a WebRTC DataChannel. See `examples/webrtc-upgrade` — the SDP exchange runs
  over the relayed session itself, so no extra signaling infrastructure is
  involved.

## Operational visibility

Both SDKs emit structured logs through a pluggable `Logger`. The default is a
no-op, so a library never writes to your stdout uninvited; pass one in to see
what is happening:

```ts
import { consoleLogger } from "@crosslink/core";

createCrosslinkServer({
  /* … */
  logger: consoleLogger({ level: "debug", json: true }),  // NDJSON for shippers
});
```

Events are stable dot-separated ids with flat field bags —
`session.opened`, `link.reconnect-scheduled`, `rpc.denied`, `relay.dropped`,
`consent.denied`, `permission.policy.evaluated`, `secrets.backend` — so they
are greppable and safe to alert on. Secret-looking fields (`token`, `seed`,
`authorization`, `*_key`, …) are redacted before they reach any sink, at every
nesting level.
