import { defineConfig } from "vitest/config";

// Playwright owns tests/e2e (`pnpm test:e2e`); vitest runs the unit tests under src/.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
