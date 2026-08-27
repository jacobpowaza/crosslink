# Crosslink Core Architecture — Trusted Pairing + PWA Identity

## Scope
- `packages/core`: host identity, device keypair, pairing handshake, challenge/response, trusted-device records, revocation, session tokens, app/host scoping, manifest generation, storage interfaces.
- `packages/sdk-browser`: secure storage with non-exportable WebCrypto keypair.
- `packages/sdk-node`: host-side server integration (manifest endpoint, pairing endpoint, session validation).
- `apps/chat`: consumes capabilities; provides its own `application` metadata and mobile UI. Does NOT implement pairing/security.
- Mobile onboarding (`mobile.html`): reusable Crosslink layer branded dynamically from server-generated config/manifest.

## Trust Boundary
`host fingerprint (ed25519 pub) + appId` — not just a string label. A reinstalled/different host cannot claim the same fingerprint without the matching private key.

## Pairing Flow (First Use)
1. User scans QR → mobile opens bootstrap page.
2. Mobile generates WebCrypto non-exportable Ed25519 + X25519 keypair (`crypto.subtle.generateKey`).
3. Pairing claim sends `pub_ed`, `pub_x`, `deviceId`, signed claim.
4. Host verifies claim signature with client's `pub_ed`.
5. Host creates pairing session; sends SAS + challenge nonce signed with host identity.
6. User confirms SAS on mobile.
7. Mobile completes pairing; host stores `TrustedDeviceRecord` (`deviceId`, `pubEd`, `pubX`, `caps`, `addedAt`) scoped to `appId` + host fingerprint.
8. Mobile receives session token (short-lived) + trusted-device confirmation.

## Persistent Trust (Future Connections)
1. Mobile opens from Home Screen (standalone PWA) or browser.
2. Mobile reads `trusted-device` record from secure storage.
3. Mobile includes device identity + auth credential in every API/WebSocket request.
4. Server validates:
   - Device record exists and is not revoked.
   - Credential/token is cryptographically valid (challenge/response or session token).
5. If valid: issue/session continues, skip pairing.
6. If invalid/revoked/expired: fall back to pairing flow.

## Cryptographic Details
- Phone keypair: `crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"])` for Ed25519-style, or native Ed25519 via WebCrypto `Ed25519` where supported. Fallback to P-256 ECDSA for broader browser support with deterministic key derivation.
- Host identity: existing `DeviceIdentity` (seed → ed25519 + x25519).
- Challenge: server sends random 32-byte nonce. Phone signs with private key. Server verifies against stored `pubEd`. Only then issues session.
- Session token: short-lived JWT-like signed token (`host_fp + device_id + app_id + exp`) using host identity signing key.

## PWA Identity
- `createCrosslinkServer({ application: { id, name, version, pwaConfig: { shortName, icons:[...], themeColor, bgColor } } })`
- Server serves `/manifest.webmanifest` dynamically generated from config.
- Server serves `/api/config` with branding metadata.
- Mobile bootstrap (`#bootstrap`) reads config dynamically and updates title, meta tags, icon references.
- When installed (standalone), `body.pre-install` is removed; real app takes over with developer branding.

## Revocation
- Desktop/host interface: `HostPairingManager.listTrusted()` → show devices with revoke option.
- Revoke: set `revokedAt`, drop grants, invalidate active sessions.
- Mobile detects revocation on next connection attempt (challenge fails) and falls back to pairing.
