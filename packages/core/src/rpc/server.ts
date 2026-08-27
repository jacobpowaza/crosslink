/**
 * Host-side RPC router: authorization, validation, dispatch, streaming,
 * cancellation, timeouts, rate limiting and event broadcast.
 *
 * The host is the enforcement point - every request is checked against the
 * requesting device's granted capabilities every time.
 */
import {
  CrosslinkError,
  ErrorCodes,
  Limits,
  MessageTypes,
  makeRequestId,
  type CrosslinkMessage,
  type Json,
} from "@crosslink/protocol";
import { randomBytes } from "../crypto/primitives.js";
import { authorizeOrThrow, type CapabilityRegistry, type DeviceGrants } from "../capabilities.js";
import { noopLogger, type Logger } from "../logger.js";
import type { ConsentBroker } from "../permissions.js";
import { miniValidator, type MiniSchema, type Validator } from "../schema.js";
import type { CrosslinkSession } from "../session.js";

export interface RpcContext {
  deviceId: string;
  requestId: string;
  signal: AbortSignal;
  /** Request-scoped logger, pre-bound with device id, method and request id. */
  log: Logger;
  /** mid-handler progress events (stream chunks without ending the stream) */
  emitProgress(d: Json): void;
}

export interface ExposeOptions {
  /** capability/capabilities required to invoke this method */
  capability?: string | string[];
  /** declarative input schema (mini validator) */
  inputSchema?: MiniSchema;
  /** arbitrary custom validator; takes precedence over inputSchema */
  validate?: Validator;
  /** safe to auto-retry across reconnects */
  idempotent?: boolean;
  timeoutMs?: number;
}

export type RpcHandler = (input: unknown, ctx: RpcContext) => unknown;

export interface EventOptions {
  /** capability required to subscribe */
  capability?: string;
}

interface MethodRecord {
  options: ExposeOptions;
  handler: RpcHandler;
}

interface Inflight {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RpcRouterDeps {
  logger?: Logger;
  /**
   * Capability definitions. Required for `confirmEachUse` enforcement: without
   * it the router cannot know which capabilities need a per-use prompt.
   */
  registry?: CapabilityRegistry;
  /** Obtains per-use confirmation for `confirmEachUse` capabilities. */
  consent?: ConsentBroker;
  /** Resolves a device id to a human name for consent prompts. */
  deviceName?(deviceId: string): string | undefined;
}

const rand12 = () => randomBytes(12);

export class RpcRouter {
  private methods = new Map<string, MethodRecord>();
  private events = new Map<string, EventOptions>();
  private sessions = new Set<CrosslinkSession>();
  private inflight = new Map<CrosslinkSession, Map<string, Inflight>>();
  private subscriptions = new Map<CrosslinkSession, Map<string, string>>();
  private rateWindows = new Map<CrosslinkSession, { start: number; count: number }>();

  private readonly logger: Logger;

  constructor(
    private readonly getGrants: () => DeviceGrants,
    private readonly limits: {
      maxInflight?: number;
      ratePerSec?: number;
      requestTimeoutMs?: number;
    } = {},
    private readonly deps: RpcRouterDeps = {}
  ) {
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Installs the per-use consent broker after construction. Hosts build the
   * router early (so `expose()` works before `start()`) but can only build the
   * broker once the capability registry is populated.
   */
  setConsentBroker(consent: ConsentBroker | undefined): this {
    this.deps.consent = consent;
    return this;
  }

  /* ------------------------------ registration ----------------------- */

  expose(method: string, handler: RpcHandler, options: ExposeOptions = {}): this {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(method)) {
      throw new TypeError(`invalid method name: ${method}`);
    }
    this.methods.set(method, { options, handler });
    return this;
  }

  declareEvent(event: string, options: EventOptions = {}): this {
    this.events.set(event, options);
    return this;
  }

  get exposedMethods(): string[] {
    return [...this.methods.keys()];
  }

  requiredCapabilities(method: string): string[] {
    const cap = this.methods.get(method)?.options.capability;
    return cap ? (Array.isArray(cap) ? cap : [cap]) : [];
  }

  /* ------------------------------- events ---------------------------- */

  /** Broadcasts an event to all subscribed + authorized sessions. */
  publish(event: string, payload?: Json): void {
    if (!this.events.has(event)) {
      throw new TypeError(`event not declared: ${event}`);
    }
    const capability = this.events.get(event)?.capability;
    for (const session of this.sessions) {
      for (const [subId, eventName] of this.subscriptions.get(session) ?? []) {
        if (eventName !== event) continue;
        if (capability && !this.getGrants().hasAll(session.meta.peerDeviceId, [capability])) {
          continue;
        }
        try {
          session.send({
            v: "1.0",
            t: MessageTypes.EVT,
            s: subId,
            e: event,
            ...(payload !== undefined ? { p: payload } : {})
          });
        } catch {
          /* dead session; its close path cleans up */
        }
      }
    }
  }

  /* ------------------------------- plumbing -------------------------- */

  handleMessage(session: CrosslinkSession, msg: CrosslinkMessage): void {
    // Lazy registration: any traffic from an authenticated session makes it
    // eligible for event fan-out.
    if (!this.sessions.has(session)) this.sessions.add(session);
    switch (msg.t) {
      case MessageTypes.REQ:
        this.handleRequest(session, msg);
        break;
      case MessageTypes.CANCEL:
        this.handleCancel(session, msg.i);
        break;
      case MessageTypes.SUB:
        this.handleSubscribe(session, msg.s, msg.e);
        break;
      case MessageTypes.UNSUB:
        this.subscriptions.get(session)?.delete(msg.s);
        break;
      case MessageTypes.PING:
        try {
          session.send({ v: "1.0", t: MessageTypes.PONG, ts: msg.ts });
        } catch {
          /* dead session */
        }
        break;
      default:
        break;
    }
  }

  handleSessionClosed(session: CrosslinkSession): void {
    this.logger.debug("rpc.session-closed", {
      deviceId: session.meta.peerDeviceId,
      inflight: this.inflight.get(session)?.size ?? 0
    });
    this.deps.consent?.endSession(session.meta.peerDeviceId);
    this.sessions.delete(session);
    for (const inflight of this.inflight.get(session)?.values() ?? []) {
      inflight.controller.abort();
      if (inflight.timer) clearTimeout(inflight.timer);
    }
    this.inflight.delete(session);
    this.subscriptions.delete(session);
    this.rateWindows.delete(session);
  }

  /* ------------------------------- requests -------------------------- */

  private handleRequest(
    session: CrosslinkSession,
    msg: Extract<CrosslinkMessage, { t: typeof MessageTypes.REQ }>
  ): void {
    const deviceId = session.meta.peerDeviceId;

    if (!this.checkRate(session)) {
      this.replyError(session, msg.i, ErrorCodes.RATE_LIMITED, "rate limit exceeded");
      return;
    }

    const record = this.methods.get(msg.m);
    if (!record) {
      this.replyError(session, msg.i, ErrorCodes.METHOD_NOT_FOUND, `unknown method "${msg.m}"`);
      return;
    }

    const grants = this.getGrants();
    if (!grants.knows(deviceId)) {
      // device dropped entirely (revoked mid-session)
      this.logger.warn("rpc.revoked-device-call", { deviceId, method: msg.m });
      this.replyError(session, msg.i, ErrorCodes.DEVICE_REVOKED, "device has no grants");
      return;
    }
    try {
      authorizeOrThrow(grants, deviceId, msg.m, this.requiredCapabilities(msg.m));
    } catch (err) {
      this.logger.info("rpc.denied", {
        deviceId,
        method: msg.m,
        code: (err as { code?: string }).code,
        granted: grants.grantedTo(deviceId)
      });
      this.replyErrorFrom(session, msg.i, err);
      return;
    }

    const sessionInflight = this.inflight.get(session) ?? new Map();
    if (sessionInflight.size >= (this.limits.maxInflight ?? Limits.DEFAULT_MAX_INFLIGHT)) {
      this.replyError(session, msg.i, ErrorCodes.RATE_LIMITED, "too many concurrent requests");
      return;
    }

    const validator =
      record.options.validate ??
      (record.options.inputSchema ? miniValidator(record.options.inputSchema) : undefined);

    let input: unknown = undefined;
    if ("p" in msg && msg.p !== undefined) input = msg.p;

    if (validator) {
      const invalid = validator(input);
      if (invalid) {
        this.replyErrorFrom(session, msg.i, invalid);
        return;
      }
    }

    const controller = new AbortController();
    const inflightEntry: Inflight = { controller };
    sessionInflight.set(msg.i, inflightEntry);
    this.inflight.set(session, sessionInflight);

    const timeoutMs =
      record.options.timeoutMs ?? this.limits.requestTimeoutMs ?? Limits.DEFAULT_REQUEST_TIMEOUT_MS;
    inflightEntry.timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const ctx: RpcContext = {
      deviceId,
      requestId: msg.i,
      signal: controller.signal,
      log: this.logger.child({ deviceId, method: msg.m, requestId: msg.i }),
      emitProgress: (d) => {
        this.sendChunk(session, msg.i, progressSeq++, d);
      }
    };
    let progressSeq = 0;

    this.logger.debug("rpc.request", {
      deviceId,
      method: msg.m,
      requestId: msg.i,
      transport: session.meta.transportKind
    });

    queueMicrotask(() => {
      void this.invoke(session, msg, record, input, ctx, inflightEntry, sessionInflight);
    });
  }

  private async invoke(
    session: CrosslinkSession,
    msg: Extract<CrosslinkMessage, { t: typeof MessageTypes.REQ }>,
    record: MethodRecord,
    input: unknown,
    ctx: RpcContext,
    entry: Inflight,
    sessionInflight: Map<string, Inflight>
  ): Promise<void> {
    let result: unknown;
    try {
      await this.requireConsent(session, msg.m, input, ctx);
      result = await record.handler(input, ctx);
    } catch (err) {
      this.finishInflight(session, msg.i, entry, sessionInflight);
      if (ctx.signal.aborted) {
        this.replyError(session, msg.i, ErrorCodes.CANCELLED, "request cancelled");
      } else {
        this.replyErrorFrom(session, msg.i, err);
      }
      return;
    }
    this.finishInflight(session, msg.i, entry, sessionInflight);

    if (
      result &&
      typeof result === "object" &&
      Symbol.asyncIterator in (result as object)
    ) {
      try {
        let n = 0;
        const iterator = (result as AsyncIterable<Json>)[Symbol.asyncIterator]();
        for (;;) {
          if (ctx.signal.aborted) {
            this.replyError(session, msg.i, ErrorCodes.CANCELLED, "stream cancelled");
            return;
          }
          const next = await iterator.next();
          if (next.done) {
            session.send({
              v: "1.0",
              t: MessageTypes.END,
              i: msg.i,
              ...(next.value !== undefined ? { p: next.value as Json } : {})
            });
            return;
          }
          this.sendChunk(session, msg.i, n++, next.value as Json);
        }
      } catch (err) {
        this.replyErrorFrom(session, msg.i, err);
        return;
      }
    }

    try {
      session.send({
        v: "1.0",
        t: MessageTypes.RES,
        i: msg.i,
        ...(result !== undefined ? { p: result as Json } : {})
      });
    } catch {
      /* session died mid-flight */
    }
  }

  /**
   * Runs the per-use confirmation for every `confirmEachUse` capability this
   * method requires. Throws CONSENT_DENIED / CONSENT_TIMEOUT, which reach the
   * caller as an ordinary error reply.
   */
  private async requireConsent(
    session: CrosslinkSession,
    method: string,
    input: unknown,
    ctx: RpcContext
  ): Promise<void> {
    const consent = this.deps.consent;
    if (!consent) return;
    for (const capability of this.requiredCapabilities(method)) {
      if (!consent.requiresConsent(capability)) continue;
      await consent.require({
        deviceId: session.meta.peerDeviceId,
        deviceName: this.deps.deviceName?.(session.meta.peerDeviceId),
        method,
        capability,
        input
      });
      if (ctx.signal.aborted) {
        throw new CrosslinkError(ErrorCodes.CANCELLED, "cancelled while awaiting confirmation");
      }
    }
  }

  private finishInflight(
    _session: CrosslinkSession,
    id: string,
    entry: Inflight,
    sessionInflight: Map<string, Inflight>
  ): void {
    if (entry.timer) clearTimeout(entry.timer);
    sessionInflight.delete(id);
  }

  private sendChunk(session: CrosslinkSession, id: string, n: number, d: Json): void {
    session.send({ v: "1.0", t: MessageTypes.CHUNK, i: id, n, d });
  }

  private replyError(session: CrosslinkSession, id: string, code: string, message: string): void {
    try {
      session.send({
        v: "1.0",
        t: MessageTypes.ERR,
        i: id,
        e: { code, message }
      });
    } catch {
      /* dead session */
    }
  }

  private replyErrorFrom(session: CrosslinkSession, id: string, err: unknown): void {
    const cle = CrosslinkError.from(err);
    if (CrosslinkError.isInternal(cle.code)) {
      // The wire reply is deliberately opaque; the detail belongs in the log.
      this.logger.error("rpc.handler-error", {
        deviceId: session.meta.peerDeviceId,
        requestId: id,
        error: err
      });
    }
    const safeCode = CrosslinkError.isInternal(cle.code) ? ErrorCodes.INTERNAL : cle.code;
    const message = CrosslinkError.isInternal(cle.code)
      ? "internal error"
      : cle.message.slice(0, 256);
    this.replyError(session, id, safeCode, message);
  }

  private handleCancel(session: CrosslinkSession, targetId: string): void {
    const entry = this.inflight.get(session)?.get(targetId);
    if (entry) entry.controller.abort();
  }

  private handleSubscribe(session: CrosslinkSession, subId: string, event: string): void {
    if (!this.events.has(event)) {
      this.replyError(session, subId, ErrorCodes.METHOD_NOT_FOUND, `unknown event "${event}"`);
      return;
    }
    const capability = this.events.get(event)?.capability;
    if (capability && !this.getGrants().hasAll(session.meta.peerDeviceId, [capability])) {
      this.replyError(
        session,
        subId,
        ErrorCodes.CAPABILITY_DENIED,
        `event "${event}" requires capability ${capability}`
      );
      return;
    }
    const map = this.subscriptions.get(session) ?? new Map<string, string>();
    map.set(subId, event);
    this.subscriptions.set(session, map);
  }

  private checkRate(session: CrosslinkSession): boolean {
    const now = Date.now();
    const window = this.rateWindows.get(session);
    const limit = this.limits.ratePerSec ?? Limits.DEFAULT_RATE_PER_SEC;
    if (!window || now - window.start >= 1000) {
      this.rateWindows.set(session, { start: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= limit;
  }
}

/** Exported for tests/diagnostics. */
export function newRequestId(): string {
  return makeRequestId(rand12);
}
