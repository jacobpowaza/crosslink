# Crosslink Core Architecture — Trusted Pairing + PWA Identity

## Scope
- `packages/core`: host identity, device keypair, pairing handshake, challenge/response, trusted-device records, revocation, session tokens, app/host scoping, manifest generation, storage interfaces.
- `packages/sdk-browser`: framework-independent browser SDK exposing connection state, pairing, auth, transport, reconnect, and message primitives. Optional framework integrations (React, Vue, etc.) are thin bindings over this core.
- `packages/sdk-node`: composable host SDK usable inside existing Node/Electron/desktop apps or standalone.
- `apps/chat`: consumes capabilities; provides its own `application` metadata and mobile UI.

## Architecture Separation

```
Crosslink Protocol / Core
        ↓
Browser SDK (framework-independent primitives)
        ↓
Optional Framework Integration (React / Vue / Svelte / etc.)
        ↓
Developer Application (owns UI, routing, build system)
```

The core browser SDK (`CrosslinkClient`) does not depend on React or any frontend framework. React bindings (`@crosslink/react`) are thin adapters: `CrosslinkProvider` + hooks (`useCrosslink`, `useCrosslinkStatus`, `useCrosslinkMessage`). The same primitives work in vanilla JS, TypeScript, or any framework that can import ESM.

## Trust Boundary
`host fingerprint (ed25519 pub) + appId` — not just a string label. A reinstalled/different host cannot claim the same fingerprint without the matching private key.

## Pairing Flow (First Use)
1. User scans QR → mobile opens bootstrap page.
2. Mobile generates WebCrypto non-exportable Ed25519 + X25519 keypair.
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
4. Server validates device record exists and is not revoked; credential/token is cryptographically valid.
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

## Framework Independence
Crosslink should work regardless of how the developer's frontend is built:
- Vanilla HTML/JS
- TypeScript
- React / React + TSX
- Vite / Next.js
- Vue / Svelte / Solid / other SPAs
- Existing applications with their own build system/router

The developer's framework owns the actual application UI. Crosslink provides the infrastructure underneath it: pairing, authentication, device trust, transport, reconnect, and remote-access architecture.

Crosslink still owns standardized system flows (QR pairing → pairing screen → trusted device storage → PWA bootstrap → offline/reconnect → developer app). These are treated as **Crosslink system routes**, not as the developer's app shell.

## Revocation
- Desktop/host interface: `HostPairingManager.listTrusted()` → show devices with revoke option.
- Revoke: set `revokedAt`, drop grants, invalidate active sessions.
- Mobile detects revocation on next connection attempt (challenge fails) and falls back to pairing.
