import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests that exercise macOS-only machinery. They are not run elsewhere because the code under test
// cannot run there (ditto, codesign, the Antigravity helper, a .app bundle's install script), not because they fail.
const macOnly = [
  "app-swap",
  "agy-mcp", "agy-acp", "agy-full-permission", "agy-runtime-settings", "agy-runtime-settings-core", "agy-workers",
].map((name) => `test/unit/${name}.test.ts`);

// Heavy on a busy Mac, quick on Linux (M5-19's 10,000-case property test: 156 s on a loaded Mac, 3.6 s on the Linux
// host). A local macOS run skips them; remote-test.sh (Linux) and CI run them, with their full case counts (never shrink
// a case count to make a test fit here). BOTLING_TEST_HEAVY=1 runs them on the Mac anyway. A name whose file does not
// exist yet does nothing.
const heavyLocal = [
  "grant-property",
].map((name) => `test/unit/${name}.test.ts`);
const skipHeavy = process.platform === "darwin" && !process.env.CI && process.env.BOTLING_TEST_HEAVY !== "1";

// Reads the packaged helper, which only a macOS arm64 build whose clang output matches the reviewed pin produces.
const needsHelper = existsSync("out/core/agy-file-helper.base64") ? [] : ["test/unit/agy-runtime-install.test.ts"];

// Tests kept beside their code (most co-located tests are not run yet; add a file here once it passes, and to
// package.json's test:unit, which CI runs).
const colocated = ["src/mobile-bridge/pairing.test.ts", "src/mobile-bridge/bridge.test.ts", "mobile/pair.test.ts"];

// relay/src (the relay server some tests start) imports `ws`. relay/ has no install of its own in a checkout made with
// `npm ci` here (link-deps.sh links one in a worktree), so Node would look up the folders above it and could find
// another, older ws (~/node_modules); the tests use this install's ws 8 (relay/package.json pins 8.x too).
const wsDir = (() => { try { return dirname(createRequire(import.meta.url).resolve("ws/package.json")); } catch { return null; } })();

export default defineConfig({
  cacheDir: ".cache/vite",
  resolve: { alias: wsDir ? [{ find: /^ws$/, replacement: join(wsDir, "wrapper.mjs") }] : [] },
  test: {
    include: ["test/unit/**/*.test.ts", ...colocated, "test/live/**/*.test.ts", "../spec/tests/**/*.test.ts", "builtin-plugins/*/test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      ...(process.platform === "darwin" ? [] : macOnly),
      ...(skipHeavy ? heavyLocal : []),
      ...needsHelper,
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
