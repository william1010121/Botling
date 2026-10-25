import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  workers: 1,
  // Native activation cases stay excluded, even if a file-wide opt-in was supplied.
  grepInvert: /app-switch blur|native Electron window blur/,
  reporter: [["list"]],
  outputDir: ".tmp/test-results",
});
