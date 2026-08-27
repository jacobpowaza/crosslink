# Threat model

Actors and what they can realistically do, followed by the verdict for each.

## Adversaries

### 1. Network attacker (Wi-Fi ISP, LAN snooper, MITM without QR tampering)
Can observe, drop, replay, and reorder all traffic.
**Defeated.** All payloads are AEAD-encrypted; handshake transcripts are
signed; replay/reorder is fatal; MITM without the host's private key fails
signature checks before any secret moves.

### 2. Malicious or compromised signaling service
Sees presence metadata, hashed codes, opaque blobs. May route claims to a
fake host or drop messages.
**Defeated for integrity/confidentiality**: fingerprint pinning + signature
verification reject impostor hosts regardless of what signaling does.
**Capable of DoS only** (dropping pairing traffic).

### 3. Malicious relay
Sees ciphertext volume/timing/channel ids.
**Defeated for content.** Capable of traffic analysis and DoS only. Channels
are random 128-bit ids, short-lived, and multiplexed across a host's devices —
so the relay additionally learns *how many* devices a host is talking to and
can correlate their streams. That is metadata it could infer from timing
anyway; it still cannot read a byte.

A relay run by a third party can also be starved: a self-hosted deployment
should set `CROSSLINK_RELAY_TOKEN` so only its own hosts can allocate
channels. Clients are not required to hold that token — the 128-bit channel id
already gates client attach, and a browser cannot keep a shared secret.

### 4. Malicious client attempting overreach
A paired phone app tries methods it wasn't granted, connects to a different
host app on the same machine, or asks for far more at pairing time than it
needs, hoping the user waves it through.
**Defeated.** The capability check runs per request server-side; appId binding
in the transcript makes cross-app key reuse useless.

The over-asking case is handled before the user is involved: the host's
`PermissionPolicy` filters the request first, so only what the host is willing
to grant at all reaches the prompt, and the prompt can narrow that further but
never widen it. `autoApprove` is capped at low risk by default, so a host left
in development mode does not become a blank cheque. Capabilities marked
`confirmEachUse` are not a standing permission at all — every invocation stops
at a prompt, and a host with no prompt configured refuses them outright.

Grants may also carry a TTL, so a device that was trusted once does not stay
trusted indefinitely without a human re-confirming.

### 4a. A device upgraded onto a new transport
A paired device negotiates a WebRTC DataChannel and connects over it.
**Defeated.** A transport carries no authority. Every inbound transport —
LAN socket, relay stream, DataChannel — goes through the same acceptor and the
full CLX1 handshake, so "I negotiated a channel with you" never becomes "I am
authorized". The SDP exchange itself runs inside an already-authenticated
session and is capability-gateable like any other method.

### 5. Stolen device
Attacker holds a paired phone, or a copy of its browser profile.
**Partially mitigated.** With `CrosslinkClient.create()`, the identity seed is
encrypted under a non-extractable WebCrypto key held in IndexedDB, so copying
the profile off the device yields ciphertext and no key — the
copy-and-leave attack fails. An attacker in possession of the unlocked device
can still use the key in place, because the browser will decrypt for any
script on the origin.

Revocation remains the real answer: it is one command on the host, kills
active sessions immediately and blocks reconnection. Detection is the
operator's job (`deviceConnected` events are emitted to the host app), and a
`grantTtlMs` policy bounds how long a stolen device stays useful even
unnoticed. Future: passkey-bound identity, attestation.

### 6. Local malware on either machine
Reads memory/disks, can exfiltrate keys.
**Out of scope** — equivalent to full host compromise. Crosslink narrows the
blast radius in two ways: per-app identities mean compromising one app does
not yield keys for others, and the host seed lives in the OS keychain rather
than a mode-600 file, so a process reading the app's data directory does not
get it. Neither defends against malware running as the same user with the
keychain unlocked.

### 7. QR tampering (printed code swapped)
Attacker substitutes their own URI.
**Detected.** Scanned fingerprint won't match the host that answers, or the
SAS comparison fails visibly. Human SAS comparison is the final arbiter when
QR channels are untrusted end-to-end.

## Explicit non-goals

- Anonymity from services (relay/signaling learn IP addresses by design).
- Post-quantum confidentiality (tracked on the roadmap as a hybrid KEX option).
- Protection against a compromised endpoint reading its own screen/memory.
- Spam-proofing public relays beyond rate limits/quotas and an optional shared
  token.
- Preventing a host application from misusing its own permission model: the
  policy constrains what *clients* can obtain, not what the host code does
  with the capabilities it defines.
