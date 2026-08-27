# Crosslink Wire Protocol (v1)

Language-neutral specification. The TypeScript implementation in
`packages/protocol` is the reference; `fixtures/messages-v1.json` is the
byte-stable conformance corpus (regenerate with
`npm run gen:fixtures -w @crosslink/protocol`).

## 1. Conventions

- All messages are JSON objects encoded as UTF-8.
- **Canonical JSON**: keys sorted lexicographically at every depth, no
  whitespace (`canonicalJson`). Signatures and hashes are computed over
  canonical form only.
- Stream framing: each JSON message is prefixed with a 4-byte big-endian
  length. Default max frame: 1 MiB (negotiable down, never up).
- Versions are `"MAJOR.MINOR"` strings; this spec is `"1.0"`. Minimum secure
  version for sessions: `"1.0"`.

## 2. Outer frames

Outer frames wrap handshake and encrypted application traffic:

| kind | direction | fields |
| --- | --- | --- |
| `sinit` | client→host | `v`, `app`, `dev`, `sx` (static X25519 pub), `ex` (ephemeral), `nc`, `ts`, `sig` |
| `sack` | host→client | `v`, `eh` (host ephemeral), `nh`, `sig` |
| `srej` | host→client | `code`, `message` |
| `enc` | both | `n` (counter), `ct`, `tag`, `iv` |
| `oping` / `opong` | both | `ts` |
| `bye` | both | `reason?` |

### 2.1 CLX1 handshake transcripts

```
T0 = SHA256(canonical([
  "CLX1", appId, deviceId,
  b64(sx_client), b64(ex_client), b64(nc_client),
  b64(pubEd_host), b64(pubX_host)
]))
T1 = SHA256(canonical([ T0_hex, b64(eh_host), b64(nh_host) ]))
```

`sinit.sig = Ed25519.sign(T0, seed_client)`
`sack.sig = Ed25519.sign(T1, seed_host)`

Key schedule:

```
shared = X25519(ex_client, eh_host) ‖ X25519(sx_client, pubX_host)
okm    = HKDF-SHA256(ikm=shared, salt=nc‖nh, info="crosslink-session-keys-v1", L=64)
kC2H   = okm[0..32]     kH2C = okm[32..64]
```

Static DH binds the session to long-term identities; the ephemeral DH provides
forward secrecy; the client nonce salt prevents host precomputation.

### 2.2 Encrypted frames

Each direction uses its own key. Frame:

```
iv  = 24 random bytes
AD  = "<dir>:<n>"            // dir ∈ {c2h, h2c} of the SENDER; n starts at 1
ct  = XChaCha20-Poly1305(key_dir, iv, AD).encrypt(msg_json)
```

Replayed, reordered, or reflected frames fail authentication (counter in AD) →
session torn down.

## 3. Application messages (inside `enc`)

Common envelope: `v:"1.0"`, `t:<type>`. Optional `i` request id (client
generated), `s` subscription id.

| t | meaning | extra |
| --- | --- | --- |
| `req` | RPC call | `i`, `m` (method), `p?` payload |
| `res` | success reply | `i`, `r?` result |
| `err` | error reply | `i`, `e:{code,message,data?}` |
| `chunk` | stream progress | `i`, `c` payload, `n` sequence |
| `end` | final stream value | `i`, `r?` |
| `evt` | event delivery | `s`, `e`, `p?` |
| `sub` | subscribe | `s`, `e` |
| `unsub` | unsubscribe | `s` |
| `cancel` | cancel in-flight req/stream | `i` |
| `ping` / `pong` | app-level keepalive | `ts` |

Error codes (snake_case): `parse_error`, `invalid_message`, `method_not_found`,
`capability_denied`, `unauthorized`, `device_revoked`, `version_unsupported`,
`rate_limited`, `timeout`, `not_connected`, `internal`.

Method names match `/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/`.

## 4. Pairing

Pairing runs *before* any session exists, over signaling-routed opaque blobs or
any direct channel. Frames are canonical-JSON objects.

### 4.1 URI

```
crosslink://pair?v=1&s=<https signaling url>&c=<9 digits>&a=<appId>&n=<name>&f=<fp16>
```

`fp16` = first 16 hex chars of `SHA-256(utf8("fingerprint") ‖ hostPubEd)`.
This pins the host key; clients MUST refuse mismatches.

### 4.2 Flow

```
client                                host
  │ pair_claim {ps,dev,name,pub_ed,pub_x,nonce,caps_req?,sig} ─▶
  │                                             verify sig over:
  │                                             ["claim",ps,dev,name,pub_ed,pub_x,nonce,caps_req]
  │◀─ pair_challenge {ps,claim_nonce,host_pub_ed,host_pub_x,nonce,granted_caps,sig}
  │ verify host sig + fp pin + claim_nonce echo
  │ human compares SAS (below)
  │ pair_complete {ps,nonce,sig} ──────────────────────────────▶
  │◀─ pair_done {ps,granted_caps,host_pub_ed,host_pub_x,fingerprint}   (or pair_error)
```

Signatures are Ed25519 over `SHA256(canonical([...]))` transcripts keyed by
the strings `"claim"`, `"challenge"`, `"complete"` respectively (see
`pairingTranscriptBytes`). Codes are single-use, TTL ≤ 5 min, stored hashed.

### 4.3 SAS

`SAS = 3 groups of 3 digits from HKDF(info="crosslink-sas-v1", appId,
sorted(clientPubEd, hostPubEd))`. Order-independence lets both devices display
identical digits for out-of-band comparison.

## 5. Signaling ops (JSON over WS)

Client↔server ops: `host_hello{app}`, `hb`, `pair_open{psid,code_hash,ttl_ms}`,
`pair_resolve{code}` → `pair_found{psid,host_conn,app}` | `pair_not_found`,
`pair_payload{to,blob}` → `pair_deliver{from,blob}`, `error{error}`.

Codes travel as `SHA-256(digit-only form)`; blobs are capped at 16 KiB;
presence directory served read-only at `GET /apps[/:appId]`.

## 6. Relay protocol

REST: `POST /channels` → `201 {channel_id, token}` (30/min/IP).
WS `/ws?channel=&role=h&token=` or `role=c`. Server→peer control text frames:
`host_ready`, `peer_up`, `peer_down`; peers may send `{op:"ping"}` only.
Everything else must be binary ciphertext, piped verbatim to the peer.
Limits: 100 msg/s per socket, frame ≤ 256 KiB default, idle sweep 10 min,
channel lifetime 24 h.
