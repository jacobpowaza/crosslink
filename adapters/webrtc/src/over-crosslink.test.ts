/**
 * WebRTC SDP exchange over an existing Crosslink session.
 *
 * `RTCPeerConnection` does not exist under Node, so this uses a fake peer pair
 * that reproduces the parts of the API the adapter touches: offer/answer, ICE
 * gathering, and a DataChannel that carries bytes between the two ends. That
 * is enough to test what the adapter is actually responsible for - the shape
 * of the exchange, its failure handling, and the fact that a device reaching
 * the host over a DataChannel still has to authenticate.
 */
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes, bytesToBase64 } from "@crosslink/protocol";
import {
  CapabilityRegistry,
  ClientLink,
  DeviceGrants,
  DeviceIdentity,
  HostAcceptor,
  HostPairingManager,
  InMemoryHostDeviceStore,
  RpcRouter,
  buildPairingUri,
  createClaim,
  parsePairingUri,
  processChallenge,
  signClaim,
  type CrosslinkSession,
  type CrosslinkTransport,
  type PairedAppRecord
} from "@crosslink/core";
import {
  WEBRTC_OFFER_METHOD,
  exposeWebrtcOffer,
  tryUpgradeToWebrtc,
  webrtcUpgradeCandidate
} from "./over-crosslink.js";

/* ------------------------------------------------------------------ */
/* a fake WebRTC stack                                                 */
/* ------------------------------------------------------------------ */

interface FakeChannel {
  readyState: string;
  binaryType: string;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  peer?: FakeChannel;
}

function makeChannel(): FakeChannel {
  return {
    readyState: "connecting",
    binaryType: "arraybuffer",
    onmessage: null,
    onopen: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (this.readyState !== "open") throw new Error("channel not open");
      const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
      queueMicrotask(() => this.peer?.onmessage?.({ data: bytes.buffer }));
    },
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.onclose?.();
      const peer = this.peer;
      queueMicrotask(() => {
        if (peer && peer.readyState !== "closed") {
          peer.readyState = "closed";
          peer.onclose?.();
        }
      });
    }
  };
}

/**
 * A pair of fake peer connections that find each other through a shared
 * rendezvous keyed by the SDP text the offerer produced.
 */
function makePeerFactories(options: { failGathering?: boolean; noChannel?: boolean } = {}) {
  const pendingBySdp = new Map<string, FakeChannel>();
  let counter = 0;

  const createOfferer = () => {
    let localDescription: { type: string; sdp: string } | null = null;
    let channel: FakeChannel | undefined;
    return {
      iceGatheringState: options.failGathering ? "gathering" : "complete",
      onicegatheringstatechange: null as (() => void) | null,
      ondatachannel: null,
      get localDescription() {
        return localDescription;
      },
      createDataChannel(): FakeChannel {
        channel = makeChannel();
        return channel;
      },
      async createOffer() {
        return { type: "offer" as const, sdp: `v=0 offer ${++counter}` };
      },
      async createAnswer() {
        throw new Error("offerer does not answer");
      },
      async setLocalDescription(d: { type: string; sdp: string }) {
        localDescription = d;
        pendingBySdp.set(d.sdp, channel!);
      },
      async setRemoteDescription() {
        /* the answer carries no state the fake needs */
      },
      close() {
        channel?.close();
      }
    };
  };

  const createAnswerer = () => {
    let localDescription: { type: string; sdp: string } | null = null;
    let ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null;
    let remoteChannel: FakeChannel | undefined;
    return {
      iceGatheringState: "complete",
      onicegatheringstatechange: null as (() => void) | null,
      get localDescription() {
        return localDescription;
      },
      set ondatachannel(cb: ((ev: { channel: FakeChannel }) => void) | null) {
        ondatachannel = cb;
        maybeDeliver();
      },
      get ondatachannel() {
        return ondatachannel;
      },
      createDataChannel(): FakeChannel {
        throw new Error("answerer does not create the channel");
      },
      async createOffer() {
        throw new Error("answerer does not offer");
      },
      async createAnswer() {
        return { type: "answer" as const, sdp: "v=0 answer" };
      },
      async setLocalDescription(d: { type: string; sdp: string }) {
        localDescription = d;
      },
      async setRemoteDescription(d: { type: string; sdp: string }) {
        const offerChannel = pendingBySdp.get(d.sdp);
        if (!offerChannel || options.noChannel) return;
        const local = makeChannel();
        local.peer = offerChannel;
        offerChannel.peer = local;
        remoteChannel = local;
        maybeDeliver();
      },
      close() {
        remoteChannel?.close();
      }
    };

    function maybeDeliver(): void {
      if (!ondatachannel || !remoteChannel) return;
      const channel = remoteChannel;
      const other = channel.peer!;
      queueMicrotask(() => {
        ondatachannel!({ channel });
        // Both ends open once the answer has been applied, as a real
        // DataChannel does after the DTLS handshake.
        channel.readyState = "open";
        other.readyState = "open";
        channel.onopen?.();
        other.onopen?.();
      });
    }
  };

  return { createOfferer, createAnswerer };
}

/* ------------------------------------------------------------------ */
/* host harness                                                        */
/* ------------------------------------------------------------------ */

const APP_ID = "com.example.webrtc";

function makeHost() {
  const identity = DeviceIdentity.create();
  const store = new InMemoryHostDeviceStore();
  const grants = new DeviceGrants();
  const registry = new CapabilityRegistry().registerAll([
    { id: "notes.read", title: "Read notes", risk: "low", defaultGranted: true }
  ]);
  const router = new RpcRouter(() => grants, { ratePerSec: 1000 }, { registry });
  router.expose("notes.list", () => ["alpha"], { capability: "notes.read" });

  const pairing = new HostPairingManager({
    identity,
    appId: APP_ID,
    registry,
    store,
    grants,
    autoApprove: true
  });

  const accepted: string[] = [];
  const acceptTransport = (transport: CrosslinkTransport): void => {
    accepted.push(transport.kind);
    let active: CrosslinkSession | undefined;
    new HostAcceptor(
      transport,
      { identity, appId: APP_ID, lookupDevice: (id) => store.get(id) },
      {
        onMessage: (msg, session) => router.handleMessage(session, msg),
        onSession: (session) => {
          active = session;
        },
        onClose: () => {
          if (active) router.handleSessionClosed(active);
        }
      }
    );
  };

  return { identity, store, grants, registry, router, pairing, acceptTransport, accepted };
}

async function pairAndConnect(
  host: ReturnType<typeof makeHost>
): Promise<{ link: ClientLink; clientIdentity: DeviceIdentity; record: PairedAppRecord }> {
  const clientIdentity = DeviceIdentity.create();
  const session = host.pairing.beginSession();
  const parsed = parsePairingUri(
    buildPairingUri({
      endpoints: [{ kind: "sig", url: "https://signal.test" }],
      code: session.code,
      appId: APP_ID,
      appName: "WebRTC Demo",
      hostPubEdB64: bytesToBase64(host.identity.edPublicKey)
    })
  );
  const psid = host.pairing.resolveCode(parsed.code)!;
  const { claim, state } = createClaim(clientIdentity, parsed, "Phone", ["notes.read"]);
  signClaim(clientIdentity, claim, psid);
  const challenge = await new Promise<Record<string, unknown>>((resolve) => {
    void host.pairing.handleClaim(claim, (f) => resolve(f as Record<string, unknown>));
  });
  const { complete, record } = await processChallenge(
    clientIdentity,
    parsed,
    state,
    challenge,
    () => true
  );
  await new Promise<void>((resolve) => host.pairing.handleComplete(complete, () => resolve()));

  const { createMemoryPair } = await import("@crosslink/core");
  const link = new ClientLink({
    identity: clientIdentity,
    appId: APP_ID,
    hostRecord: () => ({
      ...record,
      pubEdB64: bytesToBase64(host.identity.edPublicKey),
      pubXB64: bytesToBase64(host.identity.xPublicKey)
    }),
    candidates: [
      {
        kind: "crosslink-relayed",
        connect: async () => {
          const [clientSide, hostSide] = createMemoryPair();
          host.acceptTransport(hostSide);
          return clientSide;
        }
      }
    ],
    requestTimeoutMs: 3000
  });
  await link.connect();
  return { link, clientIdentity, record };
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

describe("SDP exchange over a Crosslink session", () => {
  it("upgrades a relayed session to a direct one", async () => {
    const host = makeHost();
    const peers = makePeerFactories();
    exposeWebrtcOffer(host.router, {
      createPeer: () => peers.createAnswerer() as never,
      onTransport: (transport) => host.acceptTransport(transport)
    });

    const { link } = await pairAndConnect(host);
    expect(link.currentState).toBe("crosslink-relayed");

    const upgraded = await link.upgrade(
      webrtcUpgradeCandidate(link, { createPeer: () => peers.createOfferer() as never })
    );

    expect(upgraded).toBe(true);
    expect(link.transportKind).toBe("webrtc-direct");
    expect(await link.call("notes.list")).toEqual(["alpha"]);
    link.close();
  }, 20000);

  it("makes the upgraded device authenticate again over the new pipe", async () => {
    // The DataChannel is a pipe, not a credential: the CLX1 handshake runs
    // over it exactly as it does over the relay.
    const host = makeHost();
    const peers = makePeerFactories();
    exposeWebrtcOffer(host.router, {
      createPeer: () => peers.createAnswerer() as never,
      onTransport: (transport) => host.acceptTransport(transport)
    });

    const { link } = await pairAndConnect(host);
    await link.upgrade(
      webrtcUpgradeCandidate(link, { createPeer: () => peers.createOfferer() as never })
    );

    // The first entry is the in-memory stand-in for the relay; the second is
    // the DataChannel, and both went through the same acceptor.
    expect(host.accepted).toEqual(["memory", "webrtc-direct"]);
    link.close();
  }, 20000);

  it("sends the offer as an ordinary RPC call over the existing session", async () => {
    const host = makeHost();
    const peers = makePeerFactories();
    exposeWebrtcOffer(host.router, {
      createPeer: () => peers.createAnswerer() as never,
      onTransport: (transport) => host.acceptTransport(transport)
    });

    const { link } = await pairAndConnect(host);
    const call = vi.spyOn(link, "call");
    await link.upgrade(
      webrtcUpgradeCandidate(link, { createPeer: () => peers.createOfferer() as never })
    );

    // No side channel, no third party: the SDP travels inside the encrypted,
    // authenticated session the two devices already share.
    expect(call).toHaveBeenCalledWith(
      WEBRTC_OFFER_METHOD,
      expect.objectContaining({ type: "offer" }),
      expect.anything()
    );
    link.close();
  }, 20000);

  it("keeps the relayed session when the upgrade fails", async () => {
    const host = makeHost();
    const peers = makePeerFactories({ noChannel: true });
    exposeWebrtcOffer(host.router, {
      createPeer: () => peers.createAnswerer() as never,
      onTransport: (transport) => host.acceptTransport(transport),
      timeoutMs: 200
    });

    const { link } = await pairAndConnect(host);
    const upgraded = await link.upgrade(
      webrtcUpgradeCandidate(link, {
        createPeer: () => peers.createOfferer() as never,
        timeoutMs: 200
      })
    );

    expect(upgraded).toBe(false);
    expect(link.transportKind).toBe("memory");
    expect(link.currentState).toBe("crosslink-relayed");
    expect(await link.call("notes.list")).toEqual(["alpha"]);
    link.close();
  }, 20000);

  it("tryUpgradeToWebrtc reports failure instead of throwing", async () => {
    const host = makeHost();
    const peers = makePeerFactories({ noChannel: true });
    exposeWebrtcOffer(host.router, {
      createPeer: () => peers.createAnswerer() as never,
      onTransport: (transport) => host.acceptTransport(transport),
      timeoutMs: 200
    });

    const { link } = await pairAndConnect(host);
    const ok = await tryUpgradeToWebrtc(link, {
      createPeer: () => peers.createOfferer() as never,
      timeoutMs: 200
    });

    expect(ok).toBe(false);
    expect(link.connected).toBe(true);
    link.close();
  }, 20000);

  it("is a no-op once already direct", async () => {
    const host = makeHost();
    const peers = makePeerFactories();
    exposeWebrtcOffer(host.router, {
      createPeer: () => peers.createAnswerer() as never,
      onTransport: (transport) => host.acceptTransport(transport)
    });

    const { link } = await pairAndConnect(host);
    expect(await tryUpgradeToWebrtc(link, { createPeer: () => peers.createOfferer() as never })).toBe(
      true
    );
    const createPeer = vi.fn();
    expect(await tryUpgradeToWebrtc(link, { createPeer })).toBe(true);
    expect(createPeer).not.toHaveBeenCalled();
    link.close();
  }, 20000);
});

describe("offer validation", () => {
  function exposeOn(
    capture: { handler?: (input: unknown, ctx: { deviceId: string }) => unknown },
    options: Partial<Parameters<typeof exposeWebrtcOffer>[1]> = {}
  ): void {
    exposeWebrtcOffer(
      {
        expose(_method, handler) {
          capture.handler = handler;
        }
      },
      {
        createPeer: () => makePeerFactories().createAnswerer() as never,
        onTransport: () => {},
        ...options
      }
    );
  }

  it("rejects a payload that is not an SDP offer", async () => {
    const capture: { handler?: (input: unknown, ctx: { deviceId: string }) => unknown } = {};
    exposeOn(capture);

    for (const bad of [null, {}, { type: "answer", sdp: "x" }, { type: "offer" }]) {
      await expect(
        Promise.resolve(capture.handler!(bad, { deviceId: "d" }))
      ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    }
  });

  it("rejects an implausibly large SDP", async () => {
    const capture: { handler?: (input: unknown, ctx: { deviceId: string }) => unknown } = {};
    exposeOn(capture);

    await expect(
      Promise.resolve(
        capture.handler!({ type: "offer", sdp: "v".repeat(100_000) }, { deviceId: "d" })
      )
    ).rejects.toMatchObject({ code: ErrorCodes.PAYLOAD_TOO_LARGE });
  });

  it("registers under a capability when one is configured", () => {
    const expose = vi.fn();
    exposeWebrtcOffer(
      { expose },
      {
        createPeer: () => makePeerFactories().createAnswerer() as never,
        onTransport: () => {},
        capability: "net.upgrade"
      }
    );

    expect(expose).toHaveBeenCalledWith(
      WEBRTC_OFFER_METHOD,
      expect.any(Function),
      expect.objectContaining({ capability: "net.upgrade" })
    );
  });

  it("bounds concurrent half-open negotiations", async () => {
    const capture: { handler?: (input: unknown, ctx: { deviceId: string }) => unknown } = {};
    const stalling = {
      createPeer: () =>
        ({
          iceGatheringState: "complete",
          localDescription: { type: "answer", sdp: "v=0 answer" },
          ondatachannel: null,
          createDataChannel: () => makeChannel(),
          createOffer: async () => ({ type: "offer", sdp: "x" }),
          createAnswer: async () => ({ type: "answer", sdp: "v=0 answer" }),
          setLocalDescription: async () => {},
          setRemoteDescription: async () => {},
          close: () => {}
        }) as never
    };
    exposeOn(capture, { ...stalling, maxPending: 1, timeoutMs: 5000 });

    const offer = { type: "offer" as const, sdp: "v=0 offer" };
    const first = Promise.resolve(capture.handler!(offer, { deviceId: "d" }));
    const second = Promise.resolve(capture.handler!(offer, { deviceId: "d" }));

    await expect(second).rejects.toMatchObject({ code: ErrorCodes.RATE_LIMITED });
    await first;
  });
});
