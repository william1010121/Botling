import { defineConfig } from "@playwright/test";

// The packaged build's smoke test (Phase 5b): `npm run test:packaged` after `npm run dist:mac`.
export default defineConfig({
  // No packaged binary/relaunch may run during ordinary hidden validation.
  testIgnore:process.env.BOTLING_TEST_ALLOW_FOCUS==="1"?[]:["**/*"],
  testDir: "test/packaged",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: ".tmp/test-results-packaged",
});
