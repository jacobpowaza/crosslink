#!/usr/bin/env node
/**
 * Regenerates packages/protocol/fixtures/messages-v1.json.
 * Run: npm run gen:fixtures -w @crosslink/protocol
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encodeMessage, encodeFrame, sampleMessages } from "../dist/index.js";

const outDir = new URL("../fixtures/", import.meta.url).pathname;

const cases = sampleMessages().map(({ name, obj }) => {
  const canonical = Buffer.from(encodeMessage(obj)).toString("utf8");
  const frame = encodeFrame(obj);
  return { name, obj, canonical, frame_hex: Buffer.from(frame).toString("hex") };
});

mkdirSync(outDir, { recursive: true });
writeFileSync(
  `${outDir}messages-v1.json`,
  JSON.stringify({ version: 1, generated_by: "@crosslink/protocol", cases }, null, 2) + "\n"
);
console.log(`wrote ${cases.length} fixtures`);
