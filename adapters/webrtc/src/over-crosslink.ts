/**
 * SDP exchange over an existing Crosslink session.
 *
 * The transport primitives in `./index.js` deliberately know nothing about
 * signaling: they take an `exchange` callback and leave the question of how an
 * offer reaches the other side to the embedder. This module answers that
 * question the obvious way - by sending the offer down a Crosslink session the
 * two devices already share.
 *
 * That makes the exchange inherit everything the session already provides:
 * it is end-to-end encrypted, it is authenticated to a specific paired device,
 * and it is capability-gated like any other method. No third party sees the
 * SDP, and no separate signaling channel has to be stood up, authenticated or
 * kept alive.
 *
 * The shape is:
 *
 *   1. Client and host are connected over whatever worked first - typically
 *      the relay, which is reliable but pays for every byte in latency.
 *   2. The client calls `crosslink.webrtc.offer` over that session with its
 *      SDP offer. The host answers with its SDP answer.
 *   3. Both sides now hold a DataChannel. The client asks its `ClientLink` to
 *      upgrade onto it, which runs a fresh CLX1 handshake over the channel and
 *      swaps transports only once that succeeds.
 *   4. If any of this fails, nothing happens: the relayed session carries on.
 *
 * The relayed session is the fallback, not a stepping stone to be torn down
 * optimistically.
 */
import type { CrosslinkTransport, TransportCandidate } from "@crosslink/core";
import { dataChannelTransport } from "./index.js";

/** The default method name for the SDP exchange. */
export const WEBRTC_OFFER_METHOD = "crosslink.webrtc.offer";

/** Minimal session description, matching the browser's shape. */
export interface SdpLike {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp: string;
}

interface PeerConnectionLike {
  createDataChannel(label: string, opts?: { ordered?: boolean }): DataChannelLike;
  createOffer(): Promise<SdpLike>;
  createAnswer(): Promise<SdpLike>;
  setLocalDescription(d: SdpLike): Promise<void>;
  setRemoteDescription(d: SdpLike): Promise<void>;
  close(): void;
  localDescription?: SdpLike | null;
  iceGatheringState?: string;
  onicegatheringstatechange?: (() => void) | null;
  ondatachannel?: ((ev: { channel: DataChannelLike }) => void) | null;
}

interface DataChannelLike {
  readyState: string;
  binaryType: string;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** SDP payloads are large-ish text; refuse anything implausible outright. */
const MAX_SDP_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const CHANNEL_LABEL = "crosslink";

/* ------------------------------------------------------------------ */
/* host side                                                           */
/* ------------------------------------------------------------------ */

export interface WebrtcHostOptions {
  /** e.g. `() => new RTCPeerConnection({ iceServers })`. */
  createPeer(): PeerConnectionLike;
  /**
   * Called with the DataChannel transport once it opens. Feed it to the same
   * place your LAN and relay transports go - `CrosslinkServer` does this for
   * you via `enableWebrtcUpgrades`.
   */
  onTransport(transport: CrosslinkTransport, deviceId: string): void;
  /**
   * Capability required to request an upgrade. Defaults to undefined (any
   * paired device may). Set one if you want the upgrade itself gated.
   */
  capability?: string;
  /** Method name; override only if it collides with your own namespace. */
  method?: string;
  timeoutMs?: number;
  /** Maximum concurrent half-open peer connections, to bound memory. */
  maxPending?: number;
}

/** The subset of a host server this module needs, so it can be unit-tested. */
export interface ExposeTarget {
  expose(
    method: string,
    handler: (input: unknown, ctx: { deviceId: string }) => unknown,
    options?: { capability?: string; timeoutMs?: number }
  ): unknown;
}

/**
 * Registers the host half of the exchange: an RPC method that accepts an SDP
 * offer from an authenticated device and returns the answer.
 *
 * The resulting DataChannel is handed to `onTransport`, which must run the
 * normal `HostAcceptor` handshake over it - the WebRTC channel is just a pipe
 * and carries no authority of its own. A device that reaches the host over
 * WebRTC still proves its identity exactly as it does over the relay.
 */
export function exposeWebrtcOffer(target: ExposeTarget, options: WebrtcHostOptions): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxPending = options.maxPending ?? 8;
  let pending = 0;

  target.expose(
    options.method ?? WEBRTC_OFFER_METHOD,
    async (input, ctx) => {
      const offer = readSdp(input, "offer");
      if (pending >= maxPending) {
        throw Object.assign(new Error("too many pending WebRTC upgrades"), {
          code: "rate_limited"
        });
      }
      pending += 1;

      const pc = options.createPeer();
      let settled = false;
      try {
        // The channel is created by the offerer, so we wait to be handed one.
        const channelPromise = new Promise<DataChannelLike>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("no datachannel arrived")),
            timeoutMs
          );
          pc.ondatachannel = (ev) => {
            clearTimeout(timer);
            resolve(ev.channel);
          };
        });

        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());
        await gatherSettled(pc, timeoutMs);

        const answerSdp = pc.localDescription?.sdp;
        if (!answerSdp) throw new Error("no local description after createAnswer");

        // Hand the transport over out-of-band: the RPC reply must go back over
        // the *existing* session, and the client needs the answer before its
        // channel can open at all.
        void channelPromise
          .then(async (channel) => {
            await waitOpen(channel, timeoutMs);
            settled = true;
            options.onTransport(dataChannelTransport(channel), ctx.deviceId);
          })
          .catch(() => {
            if (!settled) pc.close();
          });

        return { type: "answer", sdp: answerSdp } satisfies SdpLike;
      } catch (err) {
        pc.close();
        throw err;
      } finally {
        pending -= 1;
      }
    },
    {
      ...(options.capability ? { capability: options.capability } : {}),
      timeoutMs: timeoutMs + 1_000
    }
  );
}

/* ------------------------------------------------------------------ */
/* client side                                                         */
/* ------------------------------------------------------------------ */

export interface WebrtcClientOptions {
  createPeer(): PeerConnectionLike;
  method?: string;
  timeoutMs?: number;
  label?: string;
}

/** The subset of a client link this module needs. */
export interface CallTarget {
  call<T>(method: string, input?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

/**
 * Builds a transport candidate that negotiates a DataChannel by exchanging SDP
 * over `link` - i.e. over the Crosslink session that is already up.
 *
 * Pass the result to `ClientLink.upgrade()`, not to the initial candidate
 * list: it can only work once a session exists to carry the offer.
 */
export function webrtcUpgradeCandidate(
  link: CallTarget,
  options: WebrtcClientOptions
): TransportCandidate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    kind: "webrtc-direct",
    connect: async () => {
      const pc = options.createPeer();
      try {
        const channel = pc.createDataChannel(options.label ?? CHANNEL_LABEL, { ordered: true });
        const opened = waitOpen(channel, timeoutMs);

        await pc.setLocalDescription(await pc.createOffer());
        await gatherSettled(pc, timeoutMs);
        const offerSdp = pc.localDescription?.sdp;
        if (!offerSdp) throw new Error("no local description after createOffer");

        const answer = await link.call<SdpLike>(
          options.method ?? WEBRTC_OFFER_METHOD,
          { type: "offer", sdp: offerSdp } satisfies SdpLike,
          { timeoutMs }
        );
        await pc.setRemoteDescription(readSdp(answer, "answer"));
        await opened;
        return dataChannelTransport(channel);
      } catch (err) {
        pc.close();
        throw err;
      }
    }
  };
}

export interface UpgradeTarget extends CallTarget {
  upgrade(candidate: TransportCandidate): Promise<boolean>;
  readonly transportKind?: string;
}

/**
 * Convenience wrapper: try to move `link` onto a direct WebRTC connection,
 * returning whether it worked. Never throws - a failed upgrade leaves the
 * existing (relayed or LAN) session running, which is the whole point.
 */
export async function tryUpgradeToWebrtc(
  link: UpgradeTarget,
  options: WebrtcClientOptions
): Promise<boolean> {
  if (link.transportKind === "webrtc-direct") return true;
  try {
    return await link.upgrade(webrtcUpgradeCandidate(link, options));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Validates an untrusted SDP payload before it reaches the WebRTC stack. */
function readSdp(input: unknown, expected: "offer" | "answer"): SdpLike {
  const value = input as Partial<SdpLike> | null | undefined;
  if (!value || typeof value.sdp !== "string" || value.type !== expected) {
    throw Object.assign(new Error(`expected an SDP ${expected}`), {
      code: "validation_failed"
    });
  }
  if (value.sdp.length > MAX_SDP_BYTES) {
    throw Object.assign(new Error("SDP too large"), { code: "payload_too_large" });
  }
  return { type: expected, sdp: value.sdp };
}

function waitOpen(dc: DataChannelLike, timeoutMs: number): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("datachannel open timeout")), timeoutMs);
    dc.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    dc.onerror = () => {
      clearTimeout(timer);
      reject(new Error("datachannel error"));
    };
  });
}

/**
 * Waits for ICE gathering to finish so the SDP carries its candidates inline.
 * Trickle ICE would be faster, but it needs a bidirectional signaling channel
 * for the life of the negotiation; a single request/response over an existing
 * session is a far simpler thing to reason about, and the extra second only
 * ever costs a connection that was already working over the relay.
 */
function gatherSettled(pc: PeerConnectionLike, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      pc.onicegatheringstatechange = null;
      resolve();
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    // Safety valve: without a reachable STUN server some platforms never
    // report "complete", and host candidates alone are enough on a LAN.
    setTimeout(done, Math.min(2_000, timeoutMs));
  });
}
