import http from "node:http";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import type { CrosslinkTransport } from "@crosslink/core";

export interface LanListener {
  port: number;
  /** best-guess LAN address for QR-less manual entry */
  address?: string;
  url(): string;
  close(): Promise<void>;
}

export interface LanListenerOptions {
  port?: number;
  bind?: "loopback" | "all";
  /** Address to advertise for LAN pairing. Overrides interface auto-detection;
   *  see {@link resolveLanHost}. */
  host?: string;
  maxPayloadBytes?: number;
  onConnection(transport: CrosslinkTransport): void;
}

export function firstLanAddress(): string | undefined {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return undefined;
}

/**
 * Picks the address advertised to phones/tablets for LAN pairing.
 *
 * Auto-detection (`firstLanAddress`) just grabs the first non-internal IPv4
 * interface, which is wrong on any machine with more than one active network
 * (e.g. Wi-Fi + a wired adapter, or two Wi-Fi radios) - the guessed address
 * may not be reachable from a device on the *other* network. `explicit` (a
 * `lan.host` config value) and `CROSSLINK_LAN_HOST` let the app - or whoever
 * is running it - pin the exact address to advertise instead.
 */
export function resolveLanHost(explicit?: string): string | undefined {
  return explicit ?? process.env.CROSSLINK_LAN_HOST ?? firstLanAddress();
}

export function startLanListener(options: LanListenerOptions): Promise<LanListener> {
  const bind = options.bind ?? "loopback";
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "crosslink-lan" }));
    });
    server.on("error", reject);

    const wss = new WebSocketServer({ server, maxPayload: options.maxPayloadBytes ?? 8 * 1024 * 1024 });
    wss.on("connection", (ws, req) => {
      options.onConnection(
        // lazy import avoids cycle; inline adapter here instead
        adaptServerSocket(ws, req.socket.remoteAddress)
      );
    });

    const host = bind === "all" ? "0.0.0.0" : "127.0.0.1";
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (options.port ?? 0);
      const lanAddr = bind === "all" ? resolveLanHost(options.host) : undefined;
      resolve({
        port,
        address: lanAddr,
        url: () => (lanAddr ? `ws://${lanAddr}:${port}` : `ws://127.0.0.1:${port}`),
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => server.close(() => resolveClose()));
          })
      });
    });
  });
}

function adaptServerSocket(ws: WebSocket, remoteAddress?: string): CrosslinkTransport {
  let dataHandler: ((data: Uint8Array) => void) | undefined;
  let closeHandler: ((reason?: unknown) => void) | undefined;
  let closed = false;
  ws.on("message", (raw: WebSocket.RawData) => {
    if (closed) return;
    const buf = Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer);
    dataHandler?.(new Uint8Array(buf));
  });
  ws.on("close", () => {
    if (closed) return;
    closed = true;
    closeHandler?.("lan-closed");
  });
  ws.on("error", () => {
    if (closed) return;
    closed = true;
    closeHandler?.("lan-error");
  });
  return {
    kind: "lan",
    remoteAddress,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    send(bytes) {
      if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("lan transport closed"));
      return new Promise((resolve, reject) => {
        ws.send(Buffer.from(bytes), { binary: true }, (err) => (err ? reject(err) : resolve()));
      });
    },
    close(reason) {
      if (closed) return;
      try {
        ws.close(1000, typeof reason === "string" ? reason.slice(0, 100) : undefined);
      } catch {
        /* noop */
      }
    }
  };
}
