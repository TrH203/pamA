import { defineConfig } from "vitest/config";

// Playwright owns tests/e2e (`pnpm test:e2e`); vitest runs the unit tests under src/.
// Component tests (*.test.tsx) opt into jsdom with a `@vitest-environment jsdom` comment.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
