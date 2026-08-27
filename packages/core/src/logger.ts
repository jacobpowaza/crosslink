/**
 * Structured logging.
 *
 * Crosslink logs are structured records, never format strings: every call is
 * `log.level(event, fields?)` where `event` is a stable dot-separated id and
 * `fields` is a flat bag of JSON-ish values. Stable event ids make logs
 * greppable and let embedders route them into their own observability stack.
 *
 * The default is `noopLogger` — a library must never write to a host
 * application's stdout uninvited. `consoleLogger()` is provided for
 * development and for CLI hosts that genuinely own the terminal.
 *
 * Loggers are cheap and immutable: `child()` returns a new logger carrying
 * additional bindings (e.g. the device id of a session) that are merged into
 * every record it emits.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Returns a logger that merges `bindings` into every record. */
  child(bindings: LogFields): Logger;
  /** Cheap guard so callers can skip building expensive field objects. */
  isEnabled(level: LogLevel): boolean;
}

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50
};

/** A single structured record handed to a LogSink. */
export interface LogRecord {
  level: LogLevel;
  /** epoch milliseconds */
  time: number;
  /** stable dot-separated event id, e.g. "session.established" */
  event: string;
  fields: LogFields;
}

export type LogSink = (record: LogRecord) => void;

/* ------------------------------------------------------------------ */
/* redaction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Field names that must never reach a log sink in full. Crosslink's own call
 * sites avoid passing these, but embedders bind arbitrary fields via `child()`
 * and application handlers log their own data, so the base logger enforces it.
 */
const SECRET_KEY_RE =
  /(^|[._-])(secret|token|password|passphrase|seed|privkey|private_?key|auth|authorization|cookie|api_?key|credential)s?([._-]|$)/i;

const MAX_STRING_FIELD = 512;
const MAX_DEPTH = 4;

/** Replaces secret-looking values with a length-preserving marker. */
export function redactFields(fields: LogFields): LogFields {
  return redactObject(fields, 0) as LogFields;
}

function redactObject(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_FIELD
      ? `${value.slice(0, MAX_STRING_FIELD)}…[+${value.length - MAX_STRING_FIELD}]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: (value as { code?: string }).code };
  }
  if (value instanceof Uint8Array) return `[bytes ${value.length}]`;
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => redactObject(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? redactSecret(v) : redactObject(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function redactSecret(value: unknown): string {
  if (typeof value === "string") return `[redacted ${value.length}]`;
  if (value instanceof Uint8Array) return `[redacted ${value.length}]`;
  return "[redacted]";
}

/* ------------------------------------------------------------------ */
/* implementations                                                     */
/* ------------------------------------------------------------------ */

class BaseLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel,
    private readonly bindings: LogFields
  ) {}

  isEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[this.minLevel];
  }

  child(bindings: LogFields): Logger {
    return new BaseLogger(this.sink, this.minLevel, { ...this.bindings, ...bindings });
  }

  trace(event: string, fields?: LogFields): void {
    this.emit("trace", event, fields);
  }
  debug(event: string, fields?: LogFields): void {
    this.emit("debug", event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.emit("info", event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.emit("warn", event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.emit("error", event, fields);
  }

  private emit(level: LogLevel, event: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;
    let record: LogRecord;
    try {
      record = {
        level,
        time: Date.now(),
        event,
        fields: redactFields({ ...this.bindings, ...(fields ?? {}) })
      };
    } catch {
      // A field with a throwing getter must not break the caller.
      record = { level, time: Date.now(), event, fields: { _logError: "field-serialization-failed" } };
    }
    try {
      this.sink(record);
    } catch {
      /* a broken sink must never break the caller */
    }
  }
}

const NOOP_CHILD: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  isEnabled: () => false,
  child: () => NOOP_CHILD
};

/** The default logger: discards everything, allocates nothing. */
export const noopLogger: Logger = NOOP_CHILD;

export interface CreateLoggerOptions {
  level?: LogLevel;
  bindings?: LogFields;
}

/** Builds a logger that forwards structured records to `sink`. */
export function createLogger(sink: LogSink, options: CreateLoggerOptions = {}): Logger {
  return new BaseLogger(sink, options.level ?? "info", options.bindings ?? {});
}

export interface ConsoleLoggerOptions extends CreateLoggerOptions {
  /** emit newline-delimited JSON instead of human-readable lines */
  json?: boolean;
  /** override the console-like target (tests, custom transports) */
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

/**
 * Development logger. Human-readable by default; pass `json: true` for
 * newline-delimited JSON suitable for log shippers.
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const target = options.console ?? console;
  const sink: LogSink = (record) => {
    const method =
      record.level === "error"
        ? target.error
        : record.level === "warn"
          ? target.warn
          : record.level === "info"
            ? target.info
            : target.debug;
    if (options.json) {
      method.call(target, JSON.stringify(record));
      return;
    }
    const stamp = new Date(record.time).toISOString().slice(11, 23);
    const rest = Object.entries(record.fields)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(" ");
    method.call(
      target,
      `${stamp} ${record.level.toUpperCase().padEnd(5)} ${record.event}${rest ? ` ${rest}` : ""}`
    );
  };
  return createLogger(sink, options);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /\s/.test(value) ? JSON.stringify(value) : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Collects records in memory. Intended for tests and diagnostics buffers. */
export class MemoryLogSink {
  readonly records: LogRecord[] = [];

  constructor(private readonly limit = 1000) {}

  readonly sink: LogSink = (record) => {
    this.records.push(record);
    if (this.records.length > this.limit) this.records.shift();
  };

  logger(options: CreateLoggerOptions = {}): Logger {
    return createLogger(this.sink, { level: "trace", ...options });
  }

  /** All records whose event id equals or starts with `prefix`. */
  matching(prefix: string): LogRecord[] {
    return this.records.filter((r) => r.event === prefix || r.event.startsWith(`${prefix}.`));
  }

  clear(): void {
    this.records.length = 0;
  }
}
