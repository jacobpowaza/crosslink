import { describe, expect, it, vi } from "vitest";
import {
  MemoryLogSink,
  consoleLogger,
  createLogger,
  noopLogger,
  redactFields,
  type LogRecord
} from "./logger.js";

describe("logger", () => {
  it("filters by level and reports what it will emit", () => {
    const sink = new MemoryLogSink();
    const log = createLogger(sink.sink, { level: "warn" });

    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("warn")).toBe(true);
    expect(log.isEnabled("error")).toBe(true);

    log.debug("dropped");
    log.info("also.dropped");
    log.warn("kept");
    log.error("kept.too");

    expect(sink.records.map((r) => r.event)).toEqual(["kept", "kept.too"]);
  });

  it("merges child bindings into every record, child winning on conflict", () => {
    const sink = new MemoryLogSink();
    const root = sink.logger().child({ appId: "com.example", role: "host" });
    const session = root.child({ peer: "dev_abc" });

    session.info("session.opened", { transport: "lan" });
    session.info("session.closed", { role: "override" });

    expect(sink.records[0].fields).toEqual({
      appId: "com.example",
      role: "host",
      peer: "dev_abc",
      transport: "lan"
    });
    expect(sink.records[1].fields.role).toBe("override");
  });

  it("stamps level and time on each record", () => {
    const sink = new MemoryLogSink();
    const before = Date.now();
    sink.logger().error("boom");
    const record = sink.records[0];
    expect(record.level).toBe("error");
    expect(record.time).toBeGreaterThanOrEqual(before);
  });

  describe("redaction", () => {
    it("replaces secret-looking fields with a length marker", () => {
      const out = redactFields({
        token: "super-secret-value",
        api_key: "abcdef",
        authorization: "Bearer xyz",
        seed_b64: "AAAA",
        deviceId: "dev_public"
      });
      expect(out.token).toBe("[redacted 18]");
      expect(out.api_key).toBe("[redacted 6]");
      expect(out.authorization).toBe("[redacted 10]");
      expect(out.seed_b64).toBe("[redacted 4]");
      // Non-secret fields survive: redaction that eats the useful context
      // would defeat the purpose of logging at all.
      expect(out.deviceId).toBe("dev_public");
    });

    it("redacts nested secrets and summarizes byte arrays", () => {
      const out = redactFields({
        relay: { url: "https://relay.example", token: "aaaaaaaa" },
        payload: new Uint8Array(64)
      }) as { relay: Record<string, unknown>; payload: string };
      expect(out.relay.url).toBe("https://relay.example");
      expect(out.relay.token).toBe("[redacted 8]");
      expect(out.payload).toBe("[bytes 64]");
    });

    it("truncates very long strings rather than flooding the sink", () => {
      const out = redactFields({ sdp: "v".repeat(2000) }) as { sdp: string };
      expect(out.sdp.length).toBeLessThan(600);
      expect(out.sdp).toContain("[+1488]");
    });

    it("flattens errors to name/message/code", () => {
      const err = Object.assign(new Error("nope"), { code: "unauthorized" });
      const out = redactFields({ error: err }) as { error: Record<string, unknown> };
      expect(out.error).toEqual({ name: "Error", message: "nope", code: "unauthorized" });
    });
  });

  it("never lets a broken sink break the caller", () => {
    const log = createLogger(() => {
      throw new Error("sink exploded");
    });
    expect(() => log.info("still.fine")).not.toThrow();
  });

  it("survives a field whose getter throws", () => {
    const sink = new MemoryLogSink();
    const hostile = {
      get boom(): string {
        throw new Error("nope");
      }
    };
    expect(() => sink.logger().info("hostile", { hostile })).not.toThrow();
    expect(sink.records).toHaveLength(1);
  });

  it("noopLogger discards everything and reports nothing enabled", () => {
    expect(noopLogger.isEnabled("error")).toBe(false);
    expect(() => noopLogger.child({ a: 1 }).error("x", { b: 2 })).not.toThrow();
  });

  describe("consoleLogger", () => {
    it("routes each level to the matching console method", () => {
      const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const log = consoleLogger({ console: target, level: "trace" });

      log.trace("t");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");

      expect(target.debug).toHaveBeenCalledTimes(2); // trace + debug
      expect(target.info).toHaveBeenCalledTimes(1);
      expect(target.warn).toHaveBeenCalledTimes(1);
      expect(target.error).toHaveBeenCalledTimes(1);
    });

    it("emits parseable NDJSON in json mode", () => {
      const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      consoleLogger({ console: target, json: true }).info("evt", { n: 1 });

      const parsed = JSON.parse(target.info.mock.calls[0][0] as string) as LogRecord;
      expect(parsed.event).toBe("evt");
      expect(parsed.fields).toEqual({ n: 1 });
    });

    it("redacts through the console formatter too", () => {
      const target = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      consoleLogger({ console: target }).info("auth", { token: "hunter2" });
      expect(target.info.mock.calls[0][0]).not.toContain("hunter2");
    });
  });

  describe("MemoryLogSink", () => {
    it("matches by event prefix on dot boundaries", () => {
      const sink = new MemoryLogSink();
      const log = sink.logger();
      log.info("session.opened");
      log.info("session.closed");
      log.info("sessionish.other");

      expect(sink.matching("session").map((r) => r.event)).toEqual([
        "session.opened",
        "session.closed"
      ]);
    });

    it("bounds memory at the configured limit", () => {
      const sink = new MemoryLogSink(3);
      const log = sink.logger();
      for (let i = 0; i < 10; i++) log.info(`e${i}`);
      expect(sink.records).toHaveLength(3);
      expect(sink.records[0].event).toBe("e7");
    });
  });
});
