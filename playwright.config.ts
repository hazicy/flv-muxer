import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 90_000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  outputDir: "test-results/browser",
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
    headless: true,
    baseURL: "http://127.0.0.1:4179",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/browser/server.mjs",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
