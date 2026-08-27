# Architecture

## Layering

```
apps / examples
──────────────────────────────────────────────
sdk-browser (client DX)        sdk-node (host DX)
──────────────────────────────────────────────
                 core engine
   pairing · CLX1 handshake · session cipher
   capabilities · RpcRouter/RpcClient · ClientLink
──────────────────────────────────────────────
              protocol (wire spec)
 canonical JSON · frames · error codes · limits
──────────────────────────────────────────────
transports: memory · lan(ws) · crosslink-relayed(ws) · webrtc-direct(dc)
──────────────────────────────────────────────
services: signaling (presence/pairing router) · relay (opaque pipe)
```

**Dependency rule:** everything points down. `protocol` has zero deps;
`core` depends only on protocol + audited noble crypto; SDKs compose core;
services share nothing but the wire format.

## Trust model placement

- The **QR code pins the host fingerprint** (`f=` param, first 16 hex of
  SHA-256 over the host Ed25519 public key). The client refuses any host whose
  key doesn't match — this is the anti-MITM anchor.
- The **host stores per-device records** (`devices.json`): identity keys,
  granted capabilities, revocation timestamp. Handshakes verify signatures
  against the *stored* key, never a key from the wire.
- **Capabilities are re-checked on every RPC**, so a grant change applies to
  live sessions immediately.

## Session lifecycle

1. `sinit` (client) — version list, ephemeral X25519 key, nonce, appId,
   deviceId, signature over transcript T0.
2. Host validates version floor, looks up the device record, verifies sig,
   computes static+ephemeral DH, derives traffic keys via HKDF.
3. `sack` (host) — its ephemeral key + nonce + signature over T1.
4. Both sides derive identical `kC2H`/`kH2C`; every later frame is
   `{kind:"enc"}` wrapping one AEAD-sealed application message with
   monotonically increasing counters as associated data.
5. Liveness via `oping/opong`; orderly teardown via `bye`.

See [PROTOCOL](PROTOCOL.md) for exact fields and transcripts.

## Transport strategy

`ClientLink` iterates `TransportCandidate`s in priority order:

1. **LAN** (`ws://<lan-ip>:port`) when presence advertises it — lowest latency.
2. **Relay channel** — works everywhere, adds one network hop of latency.
3. **WebRTC direct** — best throughput for large payloads; SDP exchanged over
   an existing channel by the embedder.

Failed candidates fall through; established sessions survive IP changes via
reconnect-with-backoff plus offline call queueing (`idempotent` methods replay).

The host accepts inbound connections through one `HostAcceptor` per transport:
LAN websocket connections map 1:1, while a single relay channel websocket
synthesizes one transport per attached client (`peer_up`/`peer_down`).

## Services

### Signaling
In-memory maps: `appId → host connection` and per-host pairing sessions keyed
by `psid` with `SHA-256(code)` hashes. Clients resolve a code to a host and
then exchange opaque `pair_*` blobs through the server (`pair_payload` routing,
16 KB cap). Presence is exposed read-only at `GET /apps[/:appId]`.

### Relay
`POST /channels` mints `{channel_id, token}`; the host authenticates its WS
with the token, clients join with only the random channel id. Binary frames
are piped 1:1 between the two ends with rate/size/idle/lifetime limits. The
relay cannot decrypt, authenticate users, or correlate channels across relays.

## Storage layout (hosts)

```
.crosslink-data/<appId>/
  identity.json   # Ed25519 seed (mode 600)
  devices.json    # trusted-device records incl. caps + revocation
```

Browser clients keep identity + paired-app records under injectable
`SecureStorage` (localStorage by default).
