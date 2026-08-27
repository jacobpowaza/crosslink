/**
 * An in-memory `WsLike` pair for tests.
 *
 * `WsLike` is the seam the browser SDK is written against, so a fake that
 * satisfies it lets the pairing flow, transport handling and reconnect logic
 * be exercised without a network, a server, or a DOM.
 *
 * Shipped in the package (rather than kept in a test file) so downstream
 * embedders can test their own integrations against the same seam.
 */
import type { WsLike } from "./ws.js";

type Listener = (ev?: unknown) => void;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export interface MockSocketOptions {
  /** Delay before the socket reports itself open. Default: next microtask. */
  openDelayMs?: number;
  /** Fail the connection instead of opening it. */
  failToOpen?: boolean;
}

/** One end of a mock connection. Messages written here surface on its peer. */
export class MockSocket implements WsLike {
  readyState: number = CONNECTING;
  binaryType = "arraybuffer";
  /** Everything this end has sent, in order. */
  readonly sent: unknown[] = [];

  private readonly listeners = new Map<string, Set<Listener>>();
  private peer?: MockSocket;

  constructor(
    readonly url: string,
    options: MockSocketOptions = {}
  ) {
    const open = (): void => {
      if (this.readyState !== CONNECTING) return;
      if (options.failToOpen) {
        this.readyState = CLOSED;
        this.emit("error", { type: "error" });
        this.emit("close", { code: 1006, reason: "failed to open" });
        return;
      }
      this.readyState = OPEN;
      this.emit("open", { type: "open" });
    };
    if (options.openDelayMs && options.openDelayMs > 0) {
      setTimeout(open, options.openDelayMs);
    } else {
      queueMicrotask(open);
    }
  }

  /** Joins two mock sockets so each one's sends arrive at the other. */
  static pair(urlA = "ws://a", urlB = "ws://b"): [MockSocket, MockSocket] {
    const a = new MockSocket(urlA);
    const b = new MockSocket(urlB);
    a.attach(b);
    b.attach(a);
    return [a, b];
  }

  attach(peer: MockSocket): void {
    this.peer = peer;
  }

  addEventListener(type: "open" | "close" | "error", cb: (ev?: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: string,
    cb: ((ev?: unknown) => void) | ((ev: { data: unknown }) => void)
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb as Listener);
  }

  removeEventListener(type: string, cb: (ev?: unknown) => void): void {
    this.listeners.get(type)?.delete(cb as Listener);
  }

  send(data: unknown): void {
    if (this.readyState !== OPEN) throw new Error("mock socket is not open");
    this.sent.push(data);
    // Deliver asynchronously so a send inside a message handler cannot
    // re-enter synchronously and produce ordering a real socket never would.
    queueMicrotask(() => this.peer?.deliver(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSED;
    this.emit("close", { code, reason });
    const peer = this.peer;
    queueMicrotask(() => peer?.remoteClosed(code, reason));
  }

  /** Simulates a transport-level failure (not a clean close). */
  fail(reason = "mock failure"): void {
    if (this.readyState === CLOSED) return;
    this.emit("error", { type: "error", reason });
    this.readyState = CLOSED;
    this.emit("close", { code: 1006, reason });
    const peer = this.peer;
    queueMicrotask(() => peer?.remoteClosed(1006, reason));
  }

  /** Pushes a message into this end as though the peer had sent it. */
  deliver(data: unknown): void {
    if (this.readyState !== OPEN) return;
    this.emit("message", { data });
  }

  private remoteClosed(code: number, reason: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit("close", { code, reason });
  }

  private emit(type: string, ev: unknown): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) {
      try {
        cb(ev);
      } catch {
        /* a listener throwing must not stop the others, as in the DOM */
      }
    }
  }
}

export { CONNECTING as MOCK_CONNECTING, OPEN as MOCK_OPEN, CLOSING as MOCK_CLOSING, CLOSED as MOCK_CLOSED };
