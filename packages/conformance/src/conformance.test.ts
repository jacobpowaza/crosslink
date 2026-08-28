import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CrosslinkError,
  canonicalJson,
  decodeMessage,
  encodeFrame
} from "@crosslink/protocol";
import { runConformance, type ConformanceCorpus } from "./index.js";

describe("reference protocol conformance", () => {
  it("passes every positive and negative language-neutral vector", () => {
    const messages = JSON.parse(readFileSync(
      new URL("../../protocol/fixtures/messages-v1.json", import.meta.url),
      "utf8"
    )) as { version: number; cases: ConformanceCorpus["cases"] };
    const invalid = JSON.parse(readFileSync(
      new URL("../fixtures/invalid-v1.json", import.meta.url),
      "utf8"
    )) as { version: number; cases: ConformanceCorpus["invalid"] };
    const report = runConformance({
      canonicalJson,
      encodeFrame,
      decodeMessage,
      errorCode: (error) => error instanceof CrosslinkError ? error.code : undefined
    }, { version: 1, cases: messages.cases, invalid: invalid.cases });

    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(messages.cases.length * 3 + invalid.cases.length);
  });
});
