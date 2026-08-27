# Tunneling Guide

When your phone and laptop are on **different networks** (different WiFi,
cellular vs WiFi, hotel vs home), the host can't be reached directly. You
need to expose the local signaling and relay services to the internet.

Two free options: **ngrok** (TCP tunnels) or **Cloudflare Tunnel** (HTTPS
URLs). Both work — pick whichever you already have installed.

## When do you need a tunnel?

| Scenario | Tunnel needed? |
|---|---|
| Phone + laptop on same WiFi | No — LAN works directly |
| Phone on cellular, laptop on home WiFi | Yes |
| Phone on different WiFi (e.g. coffee shop) | Yes |
| Laptop behind corporate firewall | Yes |
| Deployed on a VPS with public IP | No — use the VPS directly |

## Option A: ngrok

### Install

```bash
# macOS
brew install ngrok

# Or download from https://ngrok.com/download
# Free account required for TCP tunnels (ngrok v3+)
ngrok config add-authtoken <your-token>
```

### Expose signaling + relay

You need **two separate ngrok processes** — one per service:

```bash
# terminal 1 — the Crosslink stack
npm run stack    # signaling :8081, relay :8082

# terminal 2 — tunnel signaling
ngrok tcp 8081
# → prints something like: Forwarding  tcp://0.tcp.ngrok.io:12345:8081

# terminal 3 — tunnel relay
ngrok tcp 8082
# → prints something like: Forwarding  tcp://0.tcp.ngrok.io:12346:8082
```

Copy the `wss://` URLs from each tunnel output.

### Start your host

```bash
CROSSLINK_SIGNALING_URL=wss://0.tcp.ngrok.io:12345 \
CROSSLINK_RELAY_URL=wss://0.tcp.ngrok.io:12346 \
npm run demo:echo
```

The QR code embeds these URLs automatically — the phone needs no config.
Scan the QR, confirm the SAS digits, and you're connected.

### Using the chat app with ngrok

```bash
CROSSLINK_SIGNALING_URL=wss://0.tcp.ngrok.io:12345 \
CROSSLINK_RELAY_URL=wss://0.tcp.ngrok.io:12346 \
npm run demo:chat
```

Or use the built-in tunnel mode (the chat app can spawn ngrok for you):

```bash
npm run demo:chat
# Then on the web UI, click "Show QR" and select "ngrok" mode
```

### ngrok security considerations

| Concern | Reality |
|---|---|
| **What ngrok sees** | Raw TCP bytes. Since Crosslink frames are encrypted end-to-end (XChaCha20-Poly1305), ngrok sees ciphertext — it cannot read your messages. |
| **Authentication** | Free tier: anyone with the tunnel URL can reach your services. Paid tier: IP allowlists + OAuth. For dev, this is fine — the CLX1 handshake rejects unpaired devices. |
| **Rate limiting** | Free tier has connection limits. For heavy use, the paid plan ($8/mo) lifts most caps. |
| **URL rotation** | Free tier URLs change on restart. You must re-scan the QR after restarting ngrok. Paid tier gets stable domains. |
| **Alternatives** | `cloudflared` (next section) gives free stable `*.trycloudflare.com` URLs. |

### Troubleshooting

- **"connection refused"**: Make sure `npm run stack` is running before ngrok.
- **"channel not found"**: The relay tunnel URL changed — restart the host
  with the new URL.
- **Slow connection**: ngrok's free tier routes through their US servers.
  Paid tiers offer regional routing.

## Option B: Cloudflare Tunnel

### Install

```bash
# macOS
brew install cloudflared

# Or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

Cloudflare Tunnel is **free** and doesn't require an account for quick tunnels.
It also gives you a stable `*.trycloudflare.com` URL per run.

### Expose signaling + relay

```bash
# terminal 1 — the Crosslink stack
npm run stack

# terminal 2 — tunnel signaling
cloudflared tunnel --url tcp://localhost:8081
# → prints: https://abc-xyz.trycloudflare.com

# terminal 3 — tunnel relay
cloudflared tunnel --url tcp://localhost:8082
# → prints: https://def-uvw.trycloudflare.com
```

Convert the HTTPS URLs to WSS for the host:

```bash
CROSSLINK_SIGNALING_URL=wss://abc-xyz.trycloudflare.com \
CROSSLINK_RELAY_URL=wss://def-uvw.trycloudflare.com \
npm run demo:echo
```

### Cloudflare security considerations

| Concern | Reality |
|---|---|
| **What Cloudflare sees** | Raw TCP bytes → ciphertext. Same as ngrok — E2E encryption means the tunnel operator cannot read your data. |
| **Stability** | Free-tier URLs rotate on restart. For stable URLs, connect a Cloudflare account (free) and use named tunnels. |
| **Rate limiting** | Quick tunnels have soft limits. Named tunnels with a Cloudflare account have higher quotas. |
| **Account required?** | No — `cloudflared tunnel --url` works without any account or token. |

## Option C: Self-hosted VPS (production)

For permanent deployments, run the services on a VPS with a public IP.
No tunnel needed — the VPS *is* the public endpoint.

```bash
# On your VPS (e.g. $5/month DigitalOcean droplet)
git clone <your-repo> && cd crosslink
npm install && npm run build

# Set tokens
export CROSSLINK_SIGNALING_TOKEN="$(openssl rand -hex 32)"
export CROSSLINK_RELAY_TOKEN="$(openssl rand -hex 32)"

# Start behind Caddy/nginx for TLS
npm run stack
```

Caddy config for automatic TLS:

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

Then point your host:

```bash
CROSSLINK_SIGNALING_URL=wss://signal.example.com \
CROSSLINK_RELAY_URL=wss://relay.example.com \
CROSSLINK_SIGNALING_TOKEN=<your-token> \
CROSSLINK_RELAY_TOKEN=<your-token> \
node host.mjs
```

See [SELF_HOSTING.md](SELF_HOSTING.md) for the full deployment guide.

## Comparing the options

| | ngrok | Cloudflare Tunnel | VPS |
|---|---|---|---|
| **Cost** | Free (limited) / $8/mo | Free | $5+/mo |
| **Setup time** | 2 minutes | 2 minutes | 30 minutes |
| **Stable URLs** | Paid only | Account required | Always |
| **Account needed** | Yes (free) | No (quick) / Yes (named) | No |
| **Best for** | Quick dev testing | Quick dev testing | Production |
| **E2E encrypted** | Yes (tunnel sees ciphertext) | Yes | Yes (services see only ciphertext) |

## Security summary

All three options maintain Crosslink's security guarantees:

1. **End-to-end encryption** — the tunnel (ngrok/Cloudflare/VPS) sees only
   encrypted Crosslink frames. It cannot read messages, keys, or pairing data.
2. **Device authentication** — the CLX1 handshake requires an Ed25519 signature
   from a paired device. Even if someone discovers your tunnel URL, they can't
   connect without a paired device's private key.
3. **Rate limiting** — both local dev services and VPS deployments have rate
   limits on channel creation and connection attempts.
4. **Dev tokens** — local services are closed by default (per-machine dev
   tokens in `.crosslink-data/`). Only processes on your machine can create
   relay channels or register as hosts.

The weakest link in any tunnel setup is the tunnel URL itself — treat it
like a password during development. In production with a VPS, use auth
tokens to close the perimeter.
