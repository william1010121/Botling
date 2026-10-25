import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    include: ["test/unit/**/*.test.ts", "test/live/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Each file may launch several core/CLI children. Bound aggregate CPU/process pressure by default.
    maxWorkers: 2,
    reporters: ["default", "./test/failure-reporter.ts"],
  },
});
