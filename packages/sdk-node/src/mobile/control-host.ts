/**
 * The Crosslink control surface.
 *
 * The desktop pairing widget talks to exactly these routes: mint a session,
 * change the transport mode, list and revoke devices, and stream the events
 * that tell the widget its code went stale. Before this existed each
 * application wrote them itself, which is why every demo had a slightly
 * different `/api/pair`.
 *
 * These routes mint pairing codes and revoke trust, so they must never be
 * reachable from the network a QR is scanned on. The handler enforces that
 * itself rather than trusting the caller to bind correctly: a request whose
 * socket is not loopback is refused, whatever interface the surrounding server
 * happens to be listening on.
 */
import http from "node:http";
import { readBrowserBundle } from "./assets.js";
import type { PairingCodeInfo, PairingNetworkMode, DeviceSummary } from "../server.js";

/** What the control surface needs from a host. */
export interface ControlHostView {
  getPairingCode(ip: string | undefined, mode: PairingNetworkMode): Promise<PairingCodeInfo>;
  setNetworkMode(mode: PairingNetworkMode): Promise<void>;
  listDevices(): DeviceSummary[];
  revokeDevice(deviceId: string): boolean;
  /** Absolute origin the phone should load the bootstrap from, if known. */
  bootstrapOrigin(): string | null;
  /** Human-readable reason remote access produced no public route. */
  remoteNote(): string | null;
  /** Subscribes to host events the widget reacts to. */
  onHostEvent(listener: (event: ControlEvent) => void): () => void;
}

export type ControlEvent =
  | { type: "pairing-invalidated" }
  | { type: "device-connected"; deviceId: string }
  | { type: "device-disconnected"; deviceId: string };

const MODES: PairingNetworkMode[] = ["auto", "local-only", "lan-and-relay", "remote"];

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin"
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * True when the peer is this machine.
 *
 * `::ffff:127.0.0.1` is what a dual-stack listener reports for an IPv4
 * loopback connection, and treating it as remote would refuse the desktop UI
 * on exactly the platforms where it is most common.
 */
export function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    // Bounded so a slow oversized upload cannot grow the host's heap.
    if (body.length > maxBytes) throw new Error("request body too large");
  }
  return body ? JSON.parse(body) : {};
}

/**
 * Maps a host-side failure onto a status the widget can act on.
 *
 * Rate limiting and "no reachable route" are the caller's situation rather
 * than a fault, and the widget renders them differently from a 500.
 */
function statusForError(message: string): number {
  if (/rate limit/i.test(message)) return 429;
  if (/not reachable|no reachable endpoint|remote access/i.test(message)) return 409;
  return 500;
}

export interface ControlHandlerOptions {
  /** Base path. Default `/__crosslink`. */
  basePath?: string;
  /** Called for requests outside the control surface. */
  fallback?(req: http.IncomingMessage, res: http.ServerResponse): void | Promise<void>;
}

/**
 * Builds the HTTP handler backing the desktop pairing widget.
 *
 * Mount it on a loopback-bound server; the widget's default source targets
 * `/__crosslink` on the page's own origin, so an application that mounts this
 * and serves its desktop page from the same server needs no pairing routes of
 * its own.
 */
export function createControlHandler(
  view: ControlHostView,
  options: ControlHandlerOptions = {}
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const base = (options.basePath ?? "/__crosslink").replace(/\/+$/, "");
  let mode: PairingNetworkMode = "auto";

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (!pathname.startsWith(`${base}/`)) {
      if (options.fallback) {
        await options.fallback(req, res);
        return;
      }
      json(res, 404, { error: "not found" });
      return;
    }

    if (!isLoopbackRequest(req)) {
      json(res, 403, {
        error:
          "The Crosslink control surface mints pairing codes and revokes devices, " +
          "so it only answers requests from this machine."
      });
      return;
    }

    const route = pathname.slice(base.length);

    // The desktop page loads the widget from here, so an application that
    // wants the standard pairing screen needs no bundler of its own.
    if (route === "/widget.js" && req.method === "GET") {
      let bundle: string;
      try {
        bundle = await readBrowserBundle();
      } catch (err) {
        // A missing bundle means an unbuilt workspace, and answering with the
        // reason beats a dead socket that looks like a network problem.
        json(res, 500, { error: (err as Error).message });
        return;
      }
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300"
      });
      res.end(bundle);
      return;
    }

    if (route === "/pairing" && req.method === "GET") {
      const requested = url.searchParams.get("mode");
      if (requested && MODES.includes(requested as PairingNetworkMode)) {
        mode = requested as PairingNetworkMode;
        await view.setNetworkMode(mode);
      }
      try {
        const info = await view.getPairingCode(req.socket.remoteAddress, mode);
        const origin = view.bootstrapOrigin();
        json(res, 200, {
          code: info.code,
          expiresAt: info.expiresAt,
          qrSvg: info.qrSvg,
          uri: info.uri,
          bootstrapUrl: info.bootstrapUri ?? (origin ? `${origin}/#pair=${encodeURIComponent(info.uri ?? "")}` : null),
          endpoints: info.endpoints ?? [],
          networkMode: mode,
          remoteNote: view.remoteNote()
        });
      } catch (err) {
        const message = (err as Error).message;
        json(res, statusForError(message), { error: message });
      }
      return;
    }

    if (route === "/network-mode" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { mode?: string };
        if (!body.mode || !MODES.includes(body.mode as PairingNetworkMode)) {
          json(res, 400, { error: `mode must be one of ${MODES.join(", ")}` });
          return;
        }
        mode = body.mode as PairingNetworkMode;
        await view.setNetworkMode(mode);
        json(res, 200, { mode });
      } catch (err) {
        const message = (err as Error).message;
        json(res, statusForError(message), { error: message });
      }
      return;
    }

    if (route === "/devices" && req.method === "GET") {
      json(res, 200, {
        devices: view
          .listDevices()
          .filter((device) => device.revokedAt === undefined)
          .map((device) => ({
            deviceId: device.deviceId,
            name: device.name,
            caps: device.caps,
            firstPaired: device.addedAt,
            lastConnected: device.lastSeen ?? null,
            status:
              device.revokedAt !== undefined
                ? "Revoked"
                : device.lastSeen && Date.now() - device.lastSeen < 300_000
                  ? "Online"
                  : "Offline",
            revokedAt: device.revokedAt ?? null
          }))
      });
      return;
    }

    if (route === "/revoke" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { deviceId?: string };
        const deviceId = String(body.deviceId ?? "").trim();
        if (!deviceId) {
          json(res, 400, { ok: false, error: "deviceId is required" });
          return;
        }
        json(res, 200, { ok: view.revokeDevice(deviceId), deviceId });
      } catch (err) {
        json(res, 400, { ok: false, error: (err as Error).message });
      }
      return;
    }

    if (route === "/events" && req.method === "GET") {
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        // Buffering an event stream defeats it; a proxy in front of a desktop
        // control surface is unusual but harmless to tell.
        "x-accel-buffering": "no"
      });
      res.write(": crosslink control stream\n\n");
      const unsubscribe = view.onHostEvent((event) => {
        const name =
          event.type === "pairing-invalidated"
            ? "crosslink.pairing-invalidated"
            : event.type === "device-connected"
              ? "crosslink.device-connected"
              : "crosslink.device-disconnected";
        const payload = event.type === "pairing-invalidated" ? {} : { deviceId: event.deviceId };
        res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      req.on("close", () => unsubscribe());
      return;
    }

    if (options.fallback) {
      await options.fallback(req, res);
      return;
    }
    json(res, 404, { error: `no Crosslink control route at ${route}` });
  };
}
