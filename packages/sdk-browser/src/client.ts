import {
  ClientLink,
  DeviceIdentity,
  RpcClient,
  createClaim,
  noopLogger,
  parsePairingUri,
  processChallenge,
  signClaim,
  type ClientAppStore,
  type ConnectionState,
  type Logger,
  type PairedAppRecord,
  type TransportCandidate,
} from "@crosslink/core";
import { bytesToBase64 } from "@crosslink/protocol";
import { unwrapBootstrapUri } from "@crosslink/core";
import {
  tryUpgradeToWebrtc,
  type UpgradeTarget,
} from "@crosslink/webrtc-adapter";
import { MemorySecureStorage, JsonStore, type SecureStorage } from "./storage.js";
import { createSecureStorage } from "./secure-storage.js";
import { SignalingPeer } from "./signaling-peer.js";
import { openWithTimeout, wsTransport, type WsLike } from "./ws.js";

export interface PairingConfirmRequest {
  sas: string;
  hostName: string;
  hostFp16: string;
  grantedCaps: string[];
}

export interface CrosslinkClientOptions {
  storage?: SecureStorage;
  deviceName?: string;
  /** Human confirmation of the SAS + granted capabilities. Defaults to approve. */
  onConfirmPairing?(req: PairingConfirmRequest): boolean | Promise<boolean>;
  onStateChange?(state: ConnectionState, detail?: Record<string, unknown>): void;
  requestTimeoutMs?: number;
  /** Structured log sink. Defaults to a no-op; pass `consoleLogger()` in dev. */
  logger?: Logger;
  /**
   * Shared secret for a private relay that also gates client attach. Most
   * relays do not: knowledge of the 128-bit channel id already gates it, and
   * a browser cannot hold a shared secret safely.
   */
  relayToken?: string;
  /**
   * WebSocket factory, so tests and non-DOM runtimes can inject their own.
   * Defaults to `globalThis.WebSocket`.
   */
  webSocket?: (url: string) => WsLike;
  /** `fetch` override, used for presence lookups. */
  fetch?: typeof fetch;
  /**
   * Max time to wait for a WebSocket (signaling or transport) to open before
   * giving up. A dead relay/signaling host can otherwise leave a socket in
   * `CONNECTING` forever with no `open` or `error` event, which shows up as
   * the client hanging on "connecting". Default 10s.
   */
  dialTimeoutMs?: number;
  /**
   * WebRTC upgrade configuration. When set, the client will automatically
   * try to upgrade a relayed session to a direct WebRTC DataChannel after
   * connecting. The relay remains as a fallback if the upgrade fails.
   *
   * Requires a `createPeer` factory that creates an `RTCPeerConnection`
   * with the desired ICE servers.
   *
   * Example with TURN for CGNAT:
   * ```ts
   * webrtc: {
   *   createPeer: () => new RTCPeerConnection({
   *     iceServers: [
   *       { urls: "stun:stun.l.google.com:19302" },
   *       { urls: "turn:your-turn-server.com", username: "user", credential: "pass" }
   *     ]
   *   })
   * }
   * ```
   */
  webrtc?: {
    /**
     * Factory that creates a new RTCPeerConnection for each upgrade attempt.
     * The factory should include any ICE servers (STUN/TURN) in the config.
     */
    createPeer(): unknown;
    /** Timeout for the SDP exchange. Default 15s. */
    timeoutMs?: number;
  };
  /** Connection preference: controls candidate selection. */
  networkMode?: "auto" | "local-only" | "lan-and-relay";
}

interface StoredHints {
  relay?: { url: string; channel: string };
  lan?: { host: string; port: number };
  signalingUrl?: string;
}

class StorageBackedAppStore implements ClientAppStore {
  private file: JsonStore<{ apps: Record<string, PairedAppRecord> }>;
  constructor(storage: SecureStorage) {
    this.file = new JsonStore(storage, "crosslink.apps");
  }
  private all(): Record<string, PairedAppRecord> {
    return this.file.load({ apps: {} }).apps;
  }
  list(): PairedAppRecord[] {
    return Object.values(this.all());
  }
  get(appId: string): PairedAppRecord | undefined {
    return this.all()[appId];
  }
  upsert(record: PairedAppRecord): void {
    const data = this.file.load({ apps: {} });
    data.apps[record.appId] = record;
    this.file.save(data);
  }
  remove(appId: string): void {
    const data = this.file.load({ apps: {} });
    delete data.apps[appId];
    this.file.save(data);
  }
}

export class CrosslinkClient {
  readonly log: Logger;
  private identity: DeviceIdentity;
  private appStore: StorageBackedAppStore;
  private hints: JsonStore<StoredHints>;
  private link?: ClientLink;
  private readonly storage: SecureStorage;

  constructor(private readonly options: CrosslinkClientOptions = {}) {
    const storage = options.storage ?? new MemorySecureStorage();
    this.storage = storage;
    this.appStore = new StorageBackedAppStore(storage);
    this.hints = new JsonStore(storage, "crosslink.hints");
    this.log = (options.logger ?? noopLogger).child({ component: "crosslink-client" });

    const seedKey = "crosslink.identity.seed";
    const existing = storage.get(seedKey);
    if (existing) {
      this.identity = DeviceIdentity.fromSeed(base64ToBytesLocal(existing));
    } else {
      this.identity = DeviceIdentity.create();
      storage.set(seedKey, bytesToBase64(this.identity.seed));
      this.log.info("client.identity-created", { deviceId: this.identity.deviceId });
    }
  }

  /**
   * Builds a client whose identity and paired-app records are encrypted at
   * rest with a non-extractable WebCrypto key, rather than sitting in
   * `localStorage` in the clear. Prefer this over `new CrosslinkClient()` in
   * browsers; the constructor stays synchronous for embedders that supply
   * their own storage.
   */
  static async create(
    options: Omit<CrosslinkClientOptions, "storage"> & {
      storage?: SecureStorage;
      allowPlaintextFallback?: boolean;
    } = {}
  ): Promise<CrosslinkClient> {
    if (options.storage) return new CrosslinkClient(options as CrosslinkClientOptions);
    const log = options.logger ?? noopLogger;
    const { storage, kind, encrypted } = await createSecureStorage({
      ...(options.allowPlaintextFallback !== undefined
        ? { allowPlaintextFallback: options.allowPlaintextFallback }
        : {}),
      onWriteError: (err, key) => log.error("client.storage-write-failed", { key, error: err })
    });
    if (!encrypted) {
      log.warn("client.storage-not-encrypted", {
        kind,
        detail: "identity seed is stored in the clear; WebCrypto/IndexedDB unavailable"
      });
    } else {
      log.info("client.storage", { kind });
    }
    return new CrosslinkClient({ ...options, storage });
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  listApps(): PairedAppRecord[] {
    return this.appStore.list();
  }

  forget(appId: string): void {
    this.appStore.remove(appId);
    this.link?.close();
    this.link = undefined;
  }

  /**
   * Runs the full pairing flow against a scanned QR / URI: resolve code via
   * signaling, verify pinned fingerprint, verify challenge signature, confirm
   * SAS, persist the paired-app record.
   *
   * Accepts either a raw `crosslink://pair?…` manifest URI or a hosted
   * bootstrap URL (`https://…/…&pair=<manifest>`), because iOS Safari has no
   * handler for the custom scheme — the phone's camera produces the hosted
   * link and this call transparently unwraps it.
   */
  async pairFromQr(text: string, requestedCaps?: string[]): Promise<PairedAppRecord> {
    const manifest = unwrapBootstrapUri(text);
    const uri = parsePairingUri(manifest);
    if (!uri.signalingUrl) throw new Error("pairing URI has no signaling URL (LAN-only pairing not supported by browser client)");
    const wsUrl = `${uri.signalingUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
    const peer = await SignalingPeer.open(() => this.ws(wsUrl), this.options.dialTimeoutMs ?? 10_000);
    try {
      const found = await peer.resolve(uri.code);
      // Primary MITM defense: the QR pins the first 16 hex of the host fingerprint.
      if (!found.app.fingerprint.startsWith(uri.fp16)) {
        this.log.error("client.fingerprint-mismatch", {
          expected: uri.fp16,
          got: found.app.fingerprint.slice(0, 16)
        });
        throw new Error("SECURITY: host fingerprint does not match the scanned code");
      }

      const { claim, state } = createClaim(this.identity, uri, this.options.deviceName ?? "browser", requestedCaps);
      signClaim(this.identity, claim, found.psid);
      peer.sendTo(found.hostConn, JSON.stringify(claim));

      const challengeBlob = await peer.nextBlob(found.hostConn);
      const challenge = JSON.parse(challengeBlob) as Record<string, unknown>;
      if (challenge.kind === "pair_error") {
        throw new Error(`PAIRING_FAILED: ${JSON.stringify(challenge.error ?? {})}`);
      }

      const defaultConfirm = (req: PairingConfirmRequest): boolean => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
          return window.confirm(
            `Confirm pairing with "${req.hostName}"?\n\nSAS: ${req.sas}\nCapabilities: ${req.grantedCaps.join(", ") || "(none)"}`
          );
        }
        return true;
      };
      const confirm = this.options.onConfirmPairing ?? defaultConfirm;

      const { complete, record } = await processChallenge(
        this.identity,
        uri,
        state,
        challenge,
        confirm as never
      );
      peer.sendTo(found.hostConn, JSON.stringify(complete));

      const doneBlob = await peer.nextBlob(found.hostConn);
      const done = JSON.parse(doneBlob) as Record<string, unknown>;
      if (done.kind === "pair_error") {
        throw new Error(`PAIRING_FAILED: ${JSON.stringify(done.error ?? {})}`);
      }

      record.lastConnected = Date.now();
      this.appStore.upsert(record);
      this.log.info("client.paired", {
        appId: record.appId,
        appName: record.appName,
        grantedCaps: record.grantedCaps,
        requestedCaps: requestedCaps ?? null
      });

      const hintsAll = this.hints.load({} as never) as unknown as Record<string, StoredHints>;
      hintsAll[record.appId] = {
        relay: found.app.relay,
        lan: found.app.lan,
        signalingUrl: uri.signalingUrl
      };
      this.hints.save(hintsAll as never);
      return record;
    } finally {
      peer.close();
    }
  }

  /** Connects to a previously paired app; returns the RPC client when online. */
  async connect(appId?: string): Promise<RpcClient> {
    const record = appId ? this.appStore.get(appId) : this.appStore.list()[0];
    if (!record) throw new Error("no paired app" + (appId ? ` for ${appId}` : ""));
    if (this.link && this.link.currentState !== "offline" && this.link.currentState !== "connecting" && this.link.currentState !== "reconnecting") return this.rpc();

    const hintsAll = this.hints.load({} as never) as unknown as Record<string, StoredHints>;
    const hints = hintsAll[record.appId] ?? {};

    // Fresh presence wins over stale stored hints (relay channels are ephemeral).
    let presence: { relay?: StoredHints["relay"]; lan?: StoredHints["lan"] } | null = null;
    if (hints.signalingUrl) {
      const doFetch = this.options.fetch ?? globalThis.fetch;
      try {
        const res = await doFetch(
          `${hints.signalingUrl.replace(/\/$/, "")}/apps/${encodeURIComponent(record.appId)}`
        );
        if (res.ok) {
          presence = (await res.json()) as {
            relay?: StoredHints["relay"];
            lan?: StoredHints["lan"];
          };
          // Presence is the authority on where the host is right now; persist
          // it so a later start still has a usable hint if signaling is down.
          hintsAll[record.appId] = { ...hints, ...presence };
          this.hints.save(hintsAll as never);
        }
      } catch (err) {
        this.log.debug("client.presence-lookup-failed", { appId: record.appId, error: err });
      }
    }
    const relay = presence?.relay ?? hints.relay;
    const lan = presence?.lan ?? hints.lan;

    const candidates: TransportCandidate[] = [];
    // Prefer the LAN/direct path when both devices are on the same Wi-Fi: it
    // is lower latency, keeps traffic off the relay, and works even when the
    // relay is slow. The host's presence advertises `lan` only when it is
    // actually reachable on the local network, so this is safe to try first.
    if (lan && lan.host) {
      candidates.push({
        kind: "lan" as const,
        connect: async () => {
          const { ws: opened, ready } = openWs(`ws://${lan.host}:${lan.port}`, (u) => this.ws(u), this.options.dialTimeoutMs ?? 10_000);
          await ready;
          return wsTransport(opened, "lan");
        }
      });
    }
    if (relay && this.options.networkMode !== "local-only") {
      candidates.push({
        kind: "crosslink-relayed" as const,
        connect: async () => {
          const base = `${relay.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws`;
          const url =
            `${base}?channel=${encodeURIComponent(relay.channel)}&role=c` +
            (this.options.relayToken
              ? `&auth=${encodeURIComponent(this.options.relayToken)}`
              : "");
          const { ws: opened, ready } = openWs(url, (u) => this.ws(u), this.options.dialTimeoutMs ?? 10_000);
          await ready;
          return wsTransport(opened, "crosslink-relayed");
        }
      });
    }
    if (candidates.length === 0) {
      this.log.warn("client.no-candidates", { appId: record.appId });
      throw new Error("no known transport for this app; re-pair or check host is online");
    }
    this.log.debug("client.connecting", {
      appId: record.appId,
      candidates: candidates.map((c) => c.kind)
    });

    this.link?.close();
    const link = new ClientLink({
      identity: this.identity,
      appId: record.appId,
      hostRecord: () => {
        const rec = this.appStore.get(record.appId)!;
        rec.lastConnected = Date.now();
        return rec;
      },
      candidates,
      autoReconnect: true,
      requestTimeoutMs: this.options.requestTimeoutMs,
      onStateChange: this.options.onStateChange,
      logger: this.options.logger
    });
    this.link = link;
    await link.connect();

    // Auto-upgrade to WebRTC if configured and the connection is relayed.
    // The upgrade is best-effort: if it fails, the relayed session continues.
    if (this.options.webrtc) {
      this.tryWebrtcUpgrade(link);
    }

    return link.rpc;
  }

  /**
   * Attempts to upgrade a relayed session to a direct WebRTC DataChannel.
   * Runs asynchronously — the relayed session stays active regardless.
   */
  private async tryWebrtcUpgrade(_link: ClientLink): Promise<void> {
    if (!this.options.webrtc?.createPeer) return;
    try {
      const target = _link as unknown as UpgradeTarget;
      const ok = await tryUpgradeToWebrtc(target, {
        createPeer: this.options.webrtc.createPeer as never,
        timeoutMs: this.options.webrtc.timeoutMs
      });
      if (ok) {
        this.log.info("client.webrtc-upgraded");
      }
    } catch (err) {
      this.log.debug("client.webrtc-upgrade-failed", { error: err });
    }
  }

  rpc(): RpcClient {
    if (!this.link || !this.link.connected) throw new Error("not connected");
    return this.link.rpc;
  }

  /** The live connection, exposed for adapters that upgrade the transport. */
  get connection(): ClientLink | undefined {
    return this.link;
  }

  /**
   * Convenience for the iOS / Add-to-Home-Screen flow: accepts the long
   * `https://…#pair=<uri>` link a phone camera produces, unwraps it, and
   * delegates to `pairFromQr`.
   */
  async pairFromBootstrap(bootstrapUrl: string, requestedCaps?: string[]): Promise<PairedAppRecord> {
    return this.pairFromQr(bootstrapUrl, requestedCaps);
  }

  /** True when the identity seed is encrypted at rest. */
  get storageEncrypted(): boolean {
    return (this.storage as { encrypted?: boolean }).encrypted === true;
  }

  private ws(url: string): WsLike {
    return (this.options.webSocket ?? defaultWebSocket)(url);
  }

  get state(): ConnectionState {
    return this.link?.currentState ?? "offline";
  }
  close(): void {
    this.link?.close();
    this.link = undefined;
  }
}

/* --------------------------- environment glue -------------------------- */

function defaultWebSocket(url: string): WsLike {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket not available in this environment");
  }
  return new (ctor as new (u: string) => unknown)(url) as WsLike;
}

/**
 * Opens a socket and resolves once it is usable, or rejects (and closes the
 * socket) if it hasn't opened within `timeoutMs` — see `openWithTimeout`.
 */
function openWs(
  url: string,
  factory: (u: string) => WsLike,
  timeoutMs: number
): { ws: WsLike; ready: Promise<void> } {
  const ws = factory(url);
  return { ws, ready: openWithTimeout(ws, timeoutMs) };
}

function base64ToBytesLocal(b64: string): Uint8Array {
  const bin = atobSafe(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function atobSafe(b64: string): string {
  if (typeof atob === "function") return atob(b64);
  return Buffer.from(b64, "base64").toString("binary");
}
