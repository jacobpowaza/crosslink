import type { ConnectionKind, CrosslinkTransport } from "@crosslink/core";

/**
 * Structural subset implemented by both the DOM WebSocket and the `ws`
 * package, so the same adapter runs in browsers and under Node.
 */
export interface WsLike {
  readyState: number;
  send(data: unknown): unknown;
  close(code?: number, reason?: string): unknown;
  removeEventListener?(type: string, cb: (ev?: unknown) => void): unknown;
  addEventListener(
    type: "open" | "close" | "error",
    cb: (ev?: unknown) => void
  ): unknown;
  addEventListener(
    type: "message",
    cb: (ev: { data: unknown }) => void
  ): unknown;
  binaryType?: string;
}

/**
 * Converts a websocket payload to bytes, synchronously wherever the data is
 * already in memory.
 *
 * The synchronous path matters for ordering: a host that sends a rejection and
 * closes in the same tick would otherwise have its close event overtake the
 * frame it just sent, and the client would treat a definitive "you are
 * revoked" as a transient drop and retry forever. Only `Blob` genuinely needs
 * to be awaited, and only browsers configured for `binaryType: "blob"`
 * produce one.
 */
function toBytes(data: unknown): Uint8Array | Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  // Text frames are never Crosslink protocol data: the wire is binary-only,
  // and a relay's JSON control frames share this socket. Rejecting them here
  // keeps `peer_up` out of the handshake.
  if (typeof data === "string") throw new Error("unexpected text frame");
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buf) => new Uint8Array(buf));
  }
  throw new Error("unsupported websocket message type");
}

/**
 * Resolves once `ws` opens; rejects and closes the socket if it doesn't open
 * within `timeoutMs`. Without this a browser can leave a WebSocket in
 * `CONNECTING` indefinitely (e.g. a relay behind a firewall that drops
 * packets rather than refusing the connection), which otherwise never fires
 * `open` or `error` and leaves the caller stuck in "connecting" forever.
 */
export function openWithTimeout(ws: WsLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      reject(new Error(`connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener?.("error", onError as never);
      resolve();
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("connection failed"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

/** Wraps any WsLike socket as a CrosslinkTransport (binary frames only). */
export function wsTransport(ws: WsLike, kind: ConnectionKind): CrosslinkTransport {
  // Prefer ArrayBuffer delivery so frames can be dispatched synchronously.
  try {
    ws.binaryType = "arraybuffer";
  } catch {
    /* some implementations expose it read-only; the Blob path still works */
  }
  let dataHandler: ((d: Uint8Array) => void) | undefined;
  let closeHandler: ((reason?: unknown) => void) | undefined;
  let closed = false;

  ws.addEventListener("message", (ev) => {
    if (closed) return;
    let bytes: Uint8Array | Promise<Uint8Array>;
    try {
      bytes = toBytes(ev.data);
    } catch {
      // An undecodable frame is not ours; dropping it is the safe response.
      return;
    }
    if (bytes instanceof Uint8Array) {
      dataHandler?.(bytes);
      return;
    }
    void bytes.then((resolved) => {
      if (!closed) dataHandler?.(resolved);
    });
  });
  const onCloseOnce = () => {
    if (closed) return;
    closed = true;
    closeHandler?.("ws-closed");
  };
  ws.addEventListener("close", onCloseOnce);
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    onCloseOnce();
  });

  return {
    kind,
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    async send(bytes) {
      if (closed || ws.readyState !== 1 /* OPEN */) throw new Error("transport closed");
      ws.send(bytes);
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
