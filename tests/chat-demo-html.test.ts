import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("chat demo desktop pairing page", () => {
  it("does not render attribution next to the pairing widget", () => {
    const html = readFileSync(resolve(__dirname, "../apps/chat/public/index.html"), "utf8");

    expect(html).toContain('id="pairCardContainer"');
    expect(html).not.toContain("Powered by Crosslink");
    expect(html).not.toContain("End-to-end encrypted with");
    expect(html).not.toContain("<footer");
  });
});
