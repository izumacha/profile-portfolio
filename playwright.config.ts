import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  retries: process.env.CI ? 2 : 0,
  expect: {
    // Tolerate minor antialiasing/font-rendering differences between the
    // machine that generated the snapshots and the CI runner.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "npx --yes http-server . -p 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

