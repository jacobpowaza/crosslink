import WebSocket from "ws";
import type { ConnectionKind, CrosslinkTransport } from "@crosslink/core";

const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/**
 * Adapts a `ws` socket (client or server side) into a CrosslinkTransport.
 * Applies coarse backpressure: sends wait while the socket's buffer exceeds
 * BACKPRESSURE_BYTES so a slow phone link cannot balloon host memory.
 */
export function createWsTransport(
  ws: WebSocket,
  kind: ConnectionKind
): CrosslinkTransport & { raw: WebSocket } {
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
    closeHandler?.("ws-closed");
  });
  ws.on("error", () => {
    if (closed) return;
    closed = true;
    closeHandler?.("ws-error");
  });

  const drain = async (): Promise<void> => {
    while (
      !closed &&
      ws.readyState === WebSocket.OPEN &&
      ws.bufferedAmount > BACKPRESSURE_BYTES
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  return {
    kind,
    raw: ws,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    async send(bytes) {
      await drain();
      if (closed || ws.readyState !== WebSocket.OPEN) {
        throw new Error("transport closed");
      }
      await new Promise<void>((resolve, reject) => {
        ws.send(Buffer.from(bytes), { binary: true }, (err) => (err ? reject(err) : resolve()));
      });
    },
    close(reason) {
      if (closed) return;
      try {
        ws.close(1000, typeof reason === "string" ? reason.slice(0, 100) : undefined);
      } catch {
        /* already closing */
      }
    }
  };
}
