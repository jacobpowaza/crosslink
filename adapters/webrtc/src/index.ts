/**
 * WebRTC direct transport (DataChannel).
 *
 * Crosslink frames travel over a single reliable/ordered DataChannel. SDP
 * exchange happens OUT of band: the embedder supplies an `exchange` callback
 * (e.g. over an existing Crosslink session, QR, or push notification) - this
 * module never talks to signaling services itself.
 *
 * For the common case - upgrading an existing relayed session to a direct one
 * by exchanging SDP over that very session - use `./over-crosslink.js`, which
 * wires the callback for you.
 */
import type { ConnectionKind, CrosslinkTransport, TransportCandidate } from "@crosslink/core";

type RTCPC = {
  createDataChannel(label: string, opts?: { ordered?: boolean }): RTCDC & Record<string, unknown>;
  createOffer(): Promise<RTCSdpLike>;
  createAnswer(): Promise<RTCSdpLike>;
  setLocalDescription(d: RTCSdpLike): Promise<void>;
  setRemoteDescription(d: RTCSdpLike): Promise<void>;
  close(): void;
  connectionState?: string;
  onconnectionstatechange?: (() => void) | null;
};
type RTCDC = {
  readyState: string;
  binaryType: string;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};
interface RTCSdpLike {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp: string;
}

export interface WebRtcDeps {
  /** e.g. (cfg) => new RTCPeerConnection({ iceServers }) */
  createPeer(): RTCPC;
}

/** Wraps one side of an established DataChannel as a CrosslinkTransport. */
export function dataChannelTransport(
  dc: RTCDC,
  kind: ConnectionKind = "webrtc-direct"
): CrosslinkTransport {
  let dataHandler: ((d: Uint8Array) => void) | undefined;
  let closeHandler: ((reason?: unknown) => void) | undefined;
  let closed = false;

  dc.binaryType = "arraybuffer";
  dc.onmessage = async (ev) => {
    if (closed) return;
    const data = ev.data as ArrayBuffer | Uint8Array;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    dataHandler?.(bytes);
  };
  const die = () => {
    if (closed) return;
    closed = true;
    closeHandler?.("dc-closed");
  };
  dc.onclose = die;
  dc.onerror = die;

  return {
    kind,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    async send(bytes) {
      if (closed || dc.readyState !== "open") throw new Error("datachannel closed");
      dc.send(bytes);
    },
    close(reason) {
      if (closed) return;
      try {
        dc.close();
      } catch {
        /* noop */
      }
      closed = true;
      closeHandler?.(typeof reason === "string" ? reason : "closed");
    }
  };
}

export interface WebrtcOffererOptions {
  label?: string;
  timeoutMs?: number;
}

/** Candidate for the side that PRODUCES the offer. */
export function webrtcOfferCandidate(
  deps: WebRtcDeps,
  exchange: (offer: RTCSdpLike) => Promise<RTCSdpLike>,
  options: WebrtcOffererOptions = {}
): TransportCandidate {
  return {
    kind: "webrtc-direct",
    connect: async () => {
      const pc = deps.createPeer() as unknown as RTCPC;
      const channel = pc.createDataChannel(options.label ?? "crosslink", { ordered: true });
      const opened = waitOpen(channel, options.timeoutMs ?? 10_000);
      await pc.setLocalDescription(await pc.createOffer());
      // ICE gathering is trickle-free here: wait a tick for candidates.
      await gatherSettled(pc);
      const answer = await exchange({
        type: "offer",
        sdp: (pc as unknown as { localDescription: RTCSdpLike }).localDescription.sdp
      });
      await pc.setRemoteDescription(answer);
      await opened;
      return dataChannelTransport(channel);
    }
  };
}

/** Candidate for the side that ANSWERS. */
export function webrtcAnswerCandidate(
  deps: WebRtcDeps,
  acceptOffer: () => Promise<RTCSdpLike>,
  publishAnswer: (answer: RTCSdpLike) => Promise<void>,
  options: WebrtcOffererOptions = {}
): TransportCandidate {
  return {
    kind: "webrtc-direct",
    connect: async () => {
      const pc = deps.createPeer() as unknown as RTCPC;
      const offer = await acceptOffer();
      await pc.setRemoteDescription(offer);
      const channelPromise = new Promise<RTCDC>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("no datachannel")), options.timeoutMs ?? 10_000);
        (pc as unknown as { ondatachannel?: (ev: { channel: RTCDC }) => void }).ondatachannel = (
          ev
        ) => {
          clearTimeout(t);
          resolve(ev.channel);
        };
      });
      await pc.setLocalDescription(await pc.createAnswer());
      await gatherSettled(pc);
      await publishAnswer({
        type: "answer",
        sdp: (pc as unknown as { localDescription: RTCSdpLike }).localDescription.sdp
      });
      const channel = await channelPromise;
      await waitOpen(channel, options.timeoutMs ?? 10_000);
      return dataChannelTransport(channel);
    }
  };
}

function waitOpen(dc: RTCDC, timeoutMs: number): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("datachannel open timeout")), timeoutMs);
    dc.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    const prevError = dc.onerror;
    dc.onerror = () => {
      clearTimeout(timer);
      reject(new Error("datachannel error"));
      prevError?.();
    };
  });
}

/** Non-trickle helper: resolves once ICE gathering completes or settles. */
function gatherSettled(pc: RTCPC): Promise<void> {
  const anyPc = pc as unknown as {
    iceGatheringState?: string;
    onicegatheringstatechange?: (() => void) | null;
  };
  if (anyPc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    anyPc.onicegatheringstatechange = () => {
      if (anyPc.iceGatheringState === "complete") {
        anyPc.onicegatheringstatechange = null;
        done();
      }
    };
    // Safety valve: some platforms never reach complete without STUN.
    setTimeout(done, 1_500);
  });
}

export {
  exposeWebrtcOffer,
  webrtcUpgradeCandidate,
  tryUpgradeToWebrtc,
  WEBRTC_OFFER_METHOD,
  type SdpLike,
  type CallTarget,
  type ExposeTarget,
  type UpgradeTarget,
  type WebrtcClientOptions,
  type WebrtcHostOptions
} from "./over-crosslink.js";
