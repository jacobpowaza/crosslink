import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@crosslink/protocol": r("./packages/protocol/src/index.ts"),
      "@crosslink/core": r("./packages/core/src/index.ts"),
      "@crosslink/sdk-node": r("./packages/sdk-node/src/index.ts"),
      "@crosslink/sdk-browser": r("./packages/sdk-browser/src/index.ts"),
      "@crosslink/signaling": r("./services/signaling/src/index.ts"),
      "@crosslink/relay": r("./services/relay/src/index.ts"),
      "@crosslink/webrtc-adapter": r("./adapters/webrtc/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: [
      "packages/**/*.test.ts",
      "services/**/*.test.ts",
      "adapters/**/*.test.ts",
      "tests/**/*.test.ts"
    ],
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
