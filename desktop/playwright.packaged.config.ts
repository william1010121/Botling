import { defineConfig } from "@playwright/test";

// The packaged build's smoke test (Phase 5b): `npm run test:packaged` after `npm run dist:mac`.
export default defineConfig({
  testDir: "test/packaged",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: ".tmp/test-results-packaged",
});
