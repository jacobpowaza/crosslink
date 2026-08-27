# Crosslink — Implementation Plan

Status: **v1 plan, M1–M5 vertical slice implemented in this repository.**

## 1. Current architecture

Greenfield repository (empty directory). No existing code to reuse; everything below is new.

## 2. Package and service boundaries

```
packages/protocol    @crosslink/protocol   language-neutral wire format: envelopes, framing,
                                           versioning, error codes, canonical JSON, fixtures
packages/core        @crosslink/core       transport-agnostic engine: identity & crypto, session
                                           handshake + E2E cipher, capabilities, RPC router/client,
                                           pairing state machines, connection managers
packages/sdk-node    @crosslink/sdk-node   Node host SDK (@crosslink/sdk "server" entry):
                                           createCrosslinkServer(), QR pairing, device store,
                                           LAN WebSocket + outbound relay transports
packages/sdk-browser @crosslink/sdk-browser Browser/PWA client SDK ("browser" entry):
                                           createCrosslinkClient(), QR parse/pair, reconnect,
                                           connection states
packages/sdk         @crosslink/sdk        umbrella re-export of the two entries above
services/signaling   @crosslink/signaling  tiny presence + pairing-code routing service
services/relay       @crosslink/relay      dumb encrypted-pipe fallback relay
adapters/webrtc      @crosslink/webrtc     transport adapter interface + roadmap stub (M3+)
apps/demo-pwa        installable PWA reference client
examples/*           echo-host CLI, notes host, cross-language fixture consumer docs
docs/*               protocol spec, security model, threat model, architecture, guides
```

Rules enforced by lint/import direction:

* `protocol` depends on nothing.
* `core` depends only on `protocol` + crypto libs.
* SDKs depend on `core`; services depend on `protocol`; examples/apps depend on SDKs.
* Nothing may import from an app or example.

## 3. Language-neutral protocol design

* Control messages are JSON objects (UTF‑8), one per transport frame.
* Transports carry opaque frames; WS uses its own framing; stream transports use
  a documented 4-byte big-endian length prefix (`encodeFrame` / `FrameDecoder`)
  with a hard maximum frame size (default 4 MiB).
* Every message carries `v` (protocol version `"1.0"`), `t` (message type),
  request id `i`, optional timestamp.
* Message types: `hello hello_ok req res err chunk end evt sub unsub cancel ping pong bye`.
* Binary payloads: `{ "$b": true, c?: mime, d: base64 }` (`BinaryRef`) in v1;
  a compact binary header format is specified in PROTOCOL.md §7 for v2 negotiation.
* Canonical JSON (recursively key-sorted) is used whenever bytes must be stable:
  hashing transcripts, signatures, fixtures.
* Version negotiation: hello carries supported versions; highest mutual match wins;
  mismatch → close with `VERSION_UNSUPPORTED`. Minimum secure floor — no downgrade below it.
* All limits explicit: max frame, max inflight requests, rate limits, TTLs.

## 4–6. SDK strategy, networking, security architecture

Crypto uses audited primitives from `@noble/curves`, `@noble/hashes`, `@noble/ciphers`
(pure JS, identical behavior in every JS runtime):

| Concern            | Primitive                                        |
|--------------------|--------------------------------------------------|
| Device identity    | Ed25519 signing keypair                          |
| Key agreement      | X25519 (ephemeral + static, static derived from identity seed via HKDF) |
| Session keys       | HKDF-SHA256 over (ephemeral DH ‖ static DH) with transcript-bound salt |
| Frame protection   | XChaCha20-Poly1305 AEAD, random 24-byte nonce, monotonic counter in AD, strict ordering (replay = fatal) |
| Pairing auth       | Ed25519 signatures over canonical transcripts + Short Authentication String (SAS) displayed on both devices |

Transport preference: `local/LAN → WebRTC direct (adapter) → TURN → Crosslink relay`.
The relay is a dumb pipe: it forwards opaque ciphertext frames between a channel's
host and client sockets and can never decrypt. Signaling sees only routing metadata
and opaque signed blobs.

## 7. Identity model

One Ed25519 seed per *application installation* (per appId) on a machine — multiple
apps on one computer never share identity. Derived: ed25519 priv, x25519 priv
(`hkdf(seed,"x25519")`), deviceId = `cd1_<sha256(pubEd)[0..16]>`,
fingerprint = full sha256 hex of the identity public key. Hosts persist
`identity.json` (0600); browsers get an injectable `SecureStorage` (localStorage
default, OS-keychain path documented for wrappers).

## 8. Pairing flow

1. Host `getPairingCode()` → single-use code (TTL 120 s) + QR URI
   `crosslink://pair?v=1&s=<signaling>&c=<code>&a=<appId>&n=<name>&f=<fp16>`.
2. Client resolves code via signaling (`pair_resolve`); signaling hashes the code
   (`sha256`) to find the listening host socket and routes opaque blobs both ways.
3. Client → `PairClaim{devId, pubEd, pubX, name, nonceC, sig}`; host verifies
   signature, session live/single-use; computes SAS = digits from
   HKDF(hostPub‖clientPub‖appId). Host shows SAS + device name for approval
   (auto-approve flag for dev).
4. Host → `PairChallenge{pubEd, pubX, nonceH, sig}`; client verifies sig, checks
   fingerprint against QR, shows SAS for confirmation.
5. Client → `PairComplete{sig}`; host persists `TrustedDeviceRecord`
   {deviceId, keys, caps, addedAt}; replies `PairDone{relay?, lan?}`.
6. Client immediately opens a real transport and performs the encrypted-session
   handshake (below). Replay blocked by: single-use codes, short TTL, nonce echo,
   transcript binding, and SAS verification.

## 9. Session establishment (every connect, including reconnects)

Client sends `SessionInit{devId, appIdTarget, ephX, nonceC, ts, sig}`;
host replies `SessionAccept{ephX, nonceH, sig}`. Both derive
`kC‖kH = HKDF(X25519(eph,eph) ‖ X25519(static,static), salt=nonceC‖nonceH)`.
Signatures cover the canonical transcript incl. channel id → no cross-app replay.
Host then checks trusted-device record, revocation state, protocol version.
Fresh ephemerals each time ⇒ forward secrecy per session, no bearer token exists.

## 10–12. Transports, signaling, relay

* `CrosslinkTransport` interface (send/close/onData/onClose/kind).
* LAN mode: host binds a WS listener (127.0.0.1 default; opt-in 0.0.0.0 for LAN).
* Relay mode: host dials out to relay (no port forwarding ever), registers channel
  via REST (signed), advertises `{url, ch}` through signaling presence.
* Signaling ops: `host_hello pair_open pair_resolve pair_route pair_payload
  apps_query hb`. Stateless-ish in-memory maps; horizontal scale path documented.
* Relay: REST `POST /channels` (signed), WS roles `h`/`c` per channel; frame-size,
  rate, idle, lifetime limits; metrics without content.

## 13. Capabilities

Catalog declared by the developer: `{id,title,description,risk,defaultGranted,…}`.
Every exposed method declares required capabilities; enforcement happens on the
host for **every** request (including previously paired devices). Grants are
per-device, revocable independently and instantly (checked per request; revoked
devices also fail the next handshake and any in-flight traffic).

## 14. Reconnection

States exactly as the product spec (`offline … protocol-incompatible`). Reconnect =
new transport + fresh session handshake + revocation re-check. Only requests marked
`idempotent` are queued while offline and flushed after re-authentication.

## 15. Threat model summary (full doc in SECURITY/THREAT_MODEL)

Signaling/relay untrusted; device/app IDs grant nothing alone; QR replays useless;
MITM caught by fingerprint/SAS; revocation immediate at enforcement point;
malformed/oversized input rejected deterministically; residual risks listed honestly.

## 16. Testing strategy

Unit tests per layer (framing, versioning, crypto vectors, SAS known-answer,
cipher replay rejection, capability matrix, RPC streaming/cancellation/validation,
pairing expiry/reuse/bad-signature). Integration tests boot real signaling + relay
in-process and drive the full journey: pair → connect → call → stream → subscribe →
revoke → access denied → reconnect fails. Multi-client and multi-app isolation tests.

## 17. Milestone mapping (this repo)

* **M1 done** — protocol, typed RPC, capabilities, identities, memory transport, fixtures.
* **M2 done** — ephemeral pairing, QR, persistent trusted devices, fingerprints(SAS), revocation.
* **M3 partial** — signaling + presence shipped; WebRTC adapter interface scaffolded (direct P2P data-channel transport lands next milestone).
* **M4 done** — reconnect, heartbeats, presence, offline queueing, session re-auth.
* **M5 done** — relay fallback + self-host compose; TURN config pass-through ready.
* **M6 started** — protocol spec + fixtures + cross-language guide; second-language SDK next.
* **M7+** — see ROADMAP.md.
