/**
 * Where a pairing card gets its pairing sessions.
 *
 * `PairingCard` is the canonical Crosslink pairing UI and stays that. This
 * module is the other half of the same story: the thing that asks the host for
 * a session, so the card can drive itself instead of every application writing
 * the same fetch-and-refresh loop beside it.
 *
 * The default source talks to the control surface `createCrosslinkServer`
 * exposes, so an application that changes nothing gets the whole flow from
 * `createPairingCard({ target })`. A host the page cannot reach
 * over HTTP — an Electron renderer behind a preload bridge — supplies its own
 * object instead. The source decides where a session comes from, never what
 * the pairing screen looks like.
 */
import type { NetworkMode, PairingCardEndpoint } from "./pairing-card.js";

/** A pairing session as the host describes it. */
export interface PairingSession {
  /** The nine-digit code shown on screen. */
  code: string;
  /** Epoch ms after which the code stops working. */
  expiresAt: number;
  /** Pre-rendered QR, produced host-side from the bootstrap URL. */
  qrSvg?: string | null;
  /** URL the QR encodes, for the "open on this device" fallback. */
  bootstrapUrl?: string | null;
  /** Raw `crosslink://pair?…` URI, when the host advertises one. */
  uri?: string | null;
  /** Routes this session advertises. */
  endpoints?: PairingCardEndpoint[] | null;
  /** Mode the host actually applied, which may differ from the request. */
  networkMode?: NetworkMode;
  /** Why remote access produced no public route, when it did not. */
  remoteNote?: string | null;
}

/** How a pairing card reaches the host. */
export interface PairingSource {
  /** Mints (or returns) the current pairing session. */
  getSession(mode?: NetworkMode): Promise<PairingSession>;
  /** Applies a network-mode change before the next session is minted. */
  setNetworkMode?(mode: NetworkMode): Promise<void>;
  /**
   * Notifies the card that the displayed session is stale — a device
   * redeemed the code, or one was revoked. Returns an unsubscribe function.
   */
  subscribe?(listener: (event: PairingSourceEvent) => void): () => void;
  /** Endpoint the connected-devices dialog reads. */
  devicesEndpoint?: string;
  /** Endpoint the devices dialog posts revocations to. */
  revokeEndpoint?: string;
}

export type PairingSourceEvent =
  | { type: "invalidate" }
  | { type: "connected"; deviceId?: string }
  | { type: "disconnected"; deviceId?: string };

const MODE_STORAGE_KEY = "crosslink.networkMode";
const DEFAULT_BASE_PATH = "/__crosslink";

/** Paths the built-in control surface serves, relative to its base path. */
export const CONTROL_ROUTES = {
  pairing: "/pairing",
  networkMode: "/network-mode",
  devices: "/devices",
  revoke: "/revoke",
  events: "/events"
} as const;

function joinPath(base: string, route: string): string {
  return `${base.replace(/\/+$/, "")}${route}`;
}

/**
 * Reads an error body without assuming it is JSON.
 *
 * The control surface answers with `{ error }`, but a proxy in front of it may
 * answer with HTML, and showing "Unexpected token <" instead of the status is
 * exactly the kind of error message that sends a developer looking in the
 * wrong place.
 */
async function describeFailure(res: Response): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let message = raw.trim();
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) message = parsed.error;
  } catch {
    /* not JSON; the raw text is the best description available */
  }
  const error = new Error(message || `Request failed with status ${res.status}`);
  (error as Error & { code?: string }).code = `CL-P${res.status}`;
  return error;
}

/**
 * The default source: the HTTP control surface `createCrosslinkServer` exposes.
 *
 * It is bound to a base path rather than an origin because that surface is
 * loopback-only by design — it mints pairing codes and revokes devices, so it
 * must not be reachable from the network the QR is scanned on.
 */
export function createHttpPairingSource(basePath: string = DEFAULT_BASE_PATH): PairingSource {
  const base = basePath.replace(/\/+$/, "");
  return {
    devicesEndpoint: joinPath(base, CONTROL_ROUTES.devices),
    revokeEndpoint: joinPath(base, CONTROL_ROUTES.revoke),

    async getSession(mode?: NetworkMode): Promise<PairingSession> {
      const url = new URL(joinPath(base, CONTROL_ROUTES.pairing), location.href);
      if (mode) url.searchParams.set("mode", mode);
      const res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!res.ok) throw await describeFailure(res);
      return (await res.json()) as PairingSession;
    },

    async setNetworkMode(mode: NetworkMode): Promise<void> {
      const res = await fetch(joinPath(base, CONTROL_ROUTES.networkMode), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode })
      });
      if (!res.ok) throw await describeFailure(res);
    },

    subscribe(listener): () => void {
      if (typeof EventSource === "undefined") return () => {};
      const stream = new EventSource(joinPath(base, CONTROL_ROUTES.events));
      const invalidate = (): void => listener({ type: "invalidate" });
      const connected = (event: MessageEvent): void => {
        let deviceId: string | undefined;
        try {
          deviceId = (JSON.parse(event.data) as { deviceId?: string }).deviceId;
        } catch {
          /* an event without a body still means a device connected */
        }
        listener({ type: "connected", deviceId });
      };
      const disconnected = (event: MessageEvent): void => {
        let deviceId: string | undefined;
        try {
          deviceId = (JSON.parse(event.data) as { deviceId?: string }).deviceId;
        } catch {
          /* as above */
        }
        listener({ type: "disconnected", deviceId });
      };
      stream.addEventListener("crosslink.pairing-invalidated", invalidate);
      stream.addEventListener("crosslink.device-connected", connected as EventListener);
      stream.addEventListener("crosslink.device-disconnected", disconnected as EventListener);
      return () => stream.close();
    }
  };
}
