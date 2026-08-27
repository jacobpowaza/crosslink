# Security

## Cryptographic choices

All primitives come from `@noble/*` — audited, constant-time pure-JS
implementations. No custom crypto.

| Purpose | Primitive |
| --- | --- |
| Long-term identity | Ed25519 (one seed per installation) |
| Key agreement | X25519, static + ephemeral (double-DH) |
| KDF | HKDF-SHA256, domain-separated infos per purpose |
| Session encryption | XChaCha20-Poly1305, random 24-byte nonces |
| Hashes / fingerprints | SHA-256 |
| Randomness | `crypto.randomBytes` / WebCrypto-backed noble utils |

## Invariants

1. **Forward secrecy** — every session mixes a fresh ephemeral X25519 into the
   key schedule; later key compromise cannot decrypt past traffic.
2. **Mutual authentication** — both signatures cover transcripts binding every
   public key, nonce, appId and deviceId. Host verifies against its stored
   device record (key continuity), never against wire-supplied keys.
3. **Replay/reflection resistance** — per-direction counters live in AEAD
   associated data; duplicates, reorders and cross-direction reflection are
   fatal to the session.
4. **Channel binding** — transcripts include appId, so a device paired with
   app A holds keys useless against app B on the same machine (tested).
5. **MITM resistance** — QR pins `fp16(host pubkey)`; challenge signature must
   verify under that pinned identity before any SAS prompt. SAS digit
   comparison adds defense-in-depth when QR integrity is doubted.
6. **Least privilege** — capabilities gate every method call, checked live per
   request; revocation drops grants and kills active sessions immediately.
   Grants may carry a TTL, evaluated on every check rather than swept on a
   timer, so a stalled event loop cannot widen a device's authority past the
   moment it was supposed to lapse.
7. **Untrusted services** — signaling sees only hashed codes + opaque signed
   blobs; relay sees only ciphertext. Compromising either cannot forge,
   decrypt, or substitute identities (only DoS).
8. **Single-use pairing codes** — consumed on completion, TTL-bounded, stored
   hashed server-side.

## Permissions

Capabilities answer "what may this device ask for". Two further layers answer
the questions capabilities alone leave open.

### Host-authored policy

A client requests whatever capabilities it likes. Without a policy, the only
thing between that request and a grant is a human pressing "y" on a list the
client wrote. `PermissionPolicy` is the host-authored filter that request
passes through **before any human sees it**:

```ts
permissions: {
  allow: ["files.read", "files.write"],  // hard allowlist ("*" by default)
  deny: ["files.purge"],                 // wins over allow and over any approval
  maxAutoGrantRisk: "low",               // ceiling for autoApprove; default "low"
  requireApproval: "high",               // always needs a human; default "high"
  grantTtlMs: 30 * 24 * 3600_000,        // grants lapse and must be renewed
  maxCapabilitiesPerDevice: 8,
  maxDevices: 5,
}
```

Two properties hold by construction:

- **`autoApprove` cannot hand out anything above `maxAutoGrantRisk`**, which
  defaults to `low`. A host left in development mode does not silently grant
  write access, and never grants a capability marked for explicit approval.
- **The approval prompt can narrow an offer, never widen it.** Returning an
  array from the `approve` hook grants that subset; the result is intersected
  with what the policy already permitted, so a mis-implemented prompt cannot
  exceed the policy.

The hook receives the full picture — the capabilities on offer, which of them
the policy insists a human decide on, and what was refused with reasons — so
the user is shown what was trimmed rather than a list they cannot audit.

### Per-use consent

Some capabilities should never become a standing permission. Marking one
`confirmEachUse` makes the grant a licence to *ask*:

```ts
{ id: "shell.exec", title: "Run a command", risk: "high", confirmEachUse: true }
```

Every invocation of a method requiring it routes through the host's
`onConsentRequest` hook, which sees the device, the method and the actual
request payload, and answers `once` / `session` / `always` / no. Session-scoped
answers are dropped when the device disconnects; all answers are dropped when
it is revoked. Concurrent calls collapse into a single prompt.

**Silence denies.** A host with no `onConsentRequest` configured refuses such
methods outright with `consent_denied`, and an unanswered prompt times out to
a refusal. Any other default would quietly weaken `confirmEachUse` into a
no-op — the failure mode where a feature appears to be protecting something
and is not.

## Data at rest

### Host

The identity seed is the thing that makes a host *that* host: any process that
reads it can impersonate the application to every paired device. It is stored
in the operating system's credential store, with backends tried in order:

1. **`keytar`** — libsecret / macOS Keychain / Windows Credential Vault.
2. **Electron `safeStorage`** — the same vaults, via Electron's binding.
3. **AES-256-GCM file** — key scrypt-stretched from `CROSSLINK_SECRET_KEY`, or
   from machine-bound material when no passphrase is set.
4. **Plaintext mode-600 JSON** — never selected automatically unless the
   embedder passes `allowPlaintextFallback: true`.

Backends are probed with a real round-trip rather than trusted to load:
`keytar` imports cleanly on a headless Linux box with no secret service
running and then fails on every call. `status().secrets` reports which one is
in use.

An existing plaintext `identity.json` is migrated in on first run — the seed
is copied into the store, verified by reading it back, and only then is the
plaintext file removed. A failed migration leaves the original in place: an
upgrade must never leave the host unable to recover its own identity, which
would orphan every paired device.

Device records (`devices.json`) remain plain JSON at mode `600`. They contain
public keys and grant lists — no secrets — and are deliberately left readable
so an operator can inspect and audit them.

### Browser client

`CrosslinkClient.create()` encrypts every stored value with AES-256-GCM under
a key generated **non-extractable** and held as a live `CryptoKey` in
IndexedDB. The browser will use that key on the page's behalf but will never
serialize it back to script: `exportKey` on it rejects.

This removes the copy-and-leave attack — stolen ciphertext is useless off the
origin — but it is not a vault. A script running on the origin can still ask
the key to decrypt. The honest summary is that it is meaningfully stronger
than a seed sitting in `localStorage` as a plain string, and it does not
defend against code execution on the origin.

Where IndexedDB or WebCrypto are unavailable (private-mode Safari, insecure
origins) the client falls back to `localStorage` and reports
`storageEncrypted === false`, so the application can say so rather than
assuming a protection it does not have.

## Observability

Both SDKs emit structured logs (`Logger`, default no-op). The base logger
redacts secret-looking fields — `token`, `seed`, `authorization`, `*_key`,
`password`, `credential` and friends — at every nesting level before a record
reaches any sink, and summarizes byte arrays as `[bytes N]` rather than
printing them. Application handlers and embedder-supplied bindings are covered
by the same pass, since those are where an accidental secret is most likely to
enter.

## Reporting

See SECURITY policy in the repository root (SECURITY.md contact placeholder
pre-1.0); please open a private security advisory rather than a public issue.
