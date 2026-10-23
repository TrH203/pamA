import { defineConfig } from "@playwright/test";

// Runs against the demo server (seeded data, offline models). Build the web app first.
export const DEMO_OUT = `${import.meta.dirname}/.playwright/demo.json`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:7472", trace: "retain-on-failure" },
  webServer: {
    command: `PAMA_PORT=7472 PAMA_DEMO_OUT=${DEMO_OUT} PAMA_WEB_DIR=${import.meta.dirname}/dist pnpm --filter @pama/server demo`,
    url: "http://127.0.0.1:7472/v1/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
