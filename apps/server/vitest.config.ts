import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "spikes/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
