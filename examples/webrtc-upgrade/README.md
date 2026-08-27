# WebRTC upgrade

Pair from any network over the relay, then move the live connection onto a
direct peer-to-peer DataChannel — negotiating it **over the Crosslink session
that is already established**.

This is the example that makes `@crosslink/webrtc-adapter` concrete. The
adapter's low-level primitives take an `exchange` callback and leave the
question of how an offer reaches the other side unanswered; here it is
answered the obvious way, by sending the offer down the encrypted,
authenticated, capability-gated session the two devices already share.

## Why upgrade at all

A relayed connection works everywhere and costs a round trip through someone
else's server on every message. A direct connection is faster and cheaper but
only exists when the network allows it. So the relay is the floor, not a
stepping stone: the upgrade is attempted, and if it fails **nothing happens**
— the relayed session carries on and the user sees no interruption.

## What the exchange looks like

```
client                          relay                          host
  |                               |                              |
  |------ paired session (CLX1 over relay, already up) ----------|
  |                                                              |
  |  RPC: crosslink.webrtc.offer { type: "offer", sdp }  ------->|
  |<-----------------------  { type: "answer", sdp }             |
  |                                                              |
  |============ DataChannel opens (direct, no relay) ============|
  |                                                              |
  |------ CLX1 handshake AGAIN, over the DataChannel ----------->|
  |<----------------------------------------- session accepted   |
  |                                                              |
  |  old relayed session closes; relay goes idle                 |
```

Two things are worth pausing on:

**The SDP never touches a third party.** It is an ordinary RPC payload inside
an established session. No separate signaling channel exists to stand up,
authenticate, rate-limit or keep alive.

**The DataChannel is a pipe, not a credential.** A device that reaches the
host over WebRTC runs the full CLX1 handshake over the new transport and
proves its identity exactly as it did over the relay. `acceptExternalTransport`
is what makes that automatic — there is no path by which "I negotiated a
DataChannel with you" becomes "I am authorized".

## Running it

```bash
# 1. infrastructure (signaling :8081, relay :8082)
npm run stack

# 2. the host
CROSSLINK_SIGNALING_URL=http://127.0.0.1:8081 \
CROSSLINK_RELAY_URL=http://127.0.0.1:8082 \
node examples/webrtc-upgrade/src/host.ts

# 3. the client, in another terminal
npm run serve -w @crosslink/example-webrtc-upgrade
# then open http://127.0.0.1:8090
```

Paste the pairing URI the host prints, approve on both ends, connect, then
press **Upgrade to direct**.

### WebRTC in Node

Node has no built-in `RTCPeerConnection`. Install one:

```bash
npm i @roamhq/wrtc          # or
npm i node-datachannel
```

Without it the host still runs and still serves clients over the relay; it
simply does not register the upgrade endpoint. That is the intended
degradation — the example prints which state it is in at startup.

## The permission model, doing real work

The host declares three capabilities, and they behave differently on purpose:

| capability   | risk   | behaviour |
|--------------|--------|-----------|
| `files.read` | low    | granted at pairing, then used freely |
| `files.write`| medium | requires an explicit approval, never auto-granted |
| `shell.exec` | high   | `confirmEachUse` — **every single call** stops at a prompt on the host terminal |

`shell.exec` is the interesting one. Being granted it does not let a device
run anything; it lets the device *ask*. Each `shell.run` call blocks in the
host's `onConsentRequest` hook until a human answers `once` / `session` /
`always` / no, and a refusal returns `consent_denied` to the client. Type
`consent` at the host prompt to forget every remembered answer.

The host also sets a policy that is applied *before* any human sees anything:

```ts
permissions: {
  allow: ["files.read", "files.write", "shell.exec"],
  maxAutoGrantRisk: "low",
  requireApproval: "high",
  maxDevices: 5,
  grantTtlMs: 30 * 24 * 3600_000
}
```

A client may request whatever it likes. Only what survives this policy is ever
offered to the user, and the approval prompt can narrow that further — press
`r` at the pairing prompt to grant read-only regardless of what was asked for.
Nothing can widen it.

## The code to copy

Host:

```ts
import { exposeWebrtcOffer } from "@crosslink/webrtc-adapter";

exposeWebrtcOffer(server, {
  createPeer: () => new RTCPeerConnection({ iceServers }),
  onTransport: (transport) => server.acceptExternalTransport(transport)
});
```

Client:

```ts
import { tryUpgradeToWebrtc } from "@crosslink/webrtc-adapter";

const rpc = await client.connect();            // relay or LAN, whichever worked
await tryUpgradeToWebrtc(client.connection!, {
  createPeer: () => new RTCPeerConnection({ iceServers })
});                                            // returns false if it can't
```

That is the whole integration.
