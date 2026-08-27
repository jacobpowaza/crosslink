# Roadmap

## Shipped (this slice)

- [x] Canonical-JSON wire protocol v1.0 with conformance fixtures
- [x] CLX1 double-DH handshake, XChaCha20 session frames, replay protection
- [x] QR pairing: single-use codes, fingerprint pinning, SAS confirmation
- [x] Capability grants with live re-checks + instant revocation
- [x] RPC: request/response, streaming progress, events, timeouts, rate limits
- [x] Transports: memory, LAN websocket, crosslink relay; auto-fallback client
- [x] Reconnect with backoff, offline queueing (idempotent), subscription restore
- [x] Signaling + relay services (stateless, self-hostable)
- [x] Node & browser SDKs, echo/notes examples, demo PWA
- [x] Full-stack integration tests (60 tests)
- [x] Hosted bootstrap QR: scan with iPhone → Safari opens → Add to Home Screen
- [x] LAN-first transport preference (direct before relay)
- [x] Host connectivity status (local-only / relayed / offline) with user-facing messages
- [x] Bootstrap URL unwrapping in browser SDK (pairFromBootstrap)
- [x] Networking architecture decision document (docs/NETWORKING.md)

## Next up

### M6 — Hardening
- OS keychain storage adapters (`safeStorage`, Keychain, DPAPI)
- Pairing approval push flow (host-initiated confirmations)
- Rate-limit tuning + abuse metrics endpoints
- Structured logging/diagnostics across SDKs

### M7 — Scale-out services
- Redis-backed signaling registry + `pair_payload` fanout
- Relay quotas/auth tokens for private deployments
- Multi-region relay selection by RTT

### M8 — Richer transports
- WebRTC adapter end-to-end tests + SDP exchange over existing sessions
- LAN mDNS/DNS-SD discovery (zero-config local connect without signaling)

### M9 — Group sessions
- Star topology: host fans out to N devices (already multi-device capable)
- Mesh option via capability-gated peer introductions

### M10 — Ecosystem
- Protocol conformance suite as a standalone package (other languages target it)
- Swift/Kotlin client SDKs; Rust host SDK
- Hybrid PQ key exchange (X25519+ML-KEM) behind version negotiation
- Encrypted-at-rest storage option using platform keystores
