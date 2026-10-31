import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Tests that exercise macOS-only machinery. They are not run elsewhere because the code under test
// cannot run there (ditto, codesign, osascript, renamex_np, the Antigravity helper), not because they fail.
// The first group is the old self-updater that 2.1.0 replaces with electron-updater (then these go away).
const macOnly = [
  "update-install", "update-maintenance", "update-spawn", "self-update", "review-c", "review-d", "review-e", "review-f",
  "hot-install", "mobile-hot-apply", "history-hot-compatibility",
  "agy-mcp", "agy-acp", "agy-full-permission", "agy-runtime-settings", "agy-runtime-settings-core", "agy-workers",
].map((name) => `test/unit/${name}.test.ts`);
// These insist on a checkout under /Volumes/My-SSD (a rule of the author's machine).
const mySsdOnly = ["input-trace-harness", "input-trace-main"].map((name) => `test/unit/${name}.test.ts`);

// Reads the packaged helper, which only a macOS arm64 build whose clang output matches the reviewed pin produces.
const needsHelper = existsSync("out/core/agy-file-helper.base64") ? [] : ["test/unit/agy-runtime-install.test.ts"];

export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    include: ["test/unit/**/*.test.ts", "test/live/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      ...(process.platform === "darwin" ? [] : macOnly),
      ...needsHelper,
      ...(process.cwd().startsWith("/Volumes/My-SSD/") ? [] : mySsdOnly),
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    setupFiles: ["./test/setup-env.ts"],
    // Each file may launch several core/CLI children. Bound aggregate CPU/process pressure by default.
    maxWorkers: 2,
    reporters: ["default", "./test/failure-reporter.ts"],
  },
});
