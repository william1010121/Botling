// Botling 3 M1 acceptance evidence (brief §5). Never part of `npm test` / `test:unit`: these runs take minutes, drive
// the built botlingd (out/server/main.cjs, run `npm run build` first) with the fake engine and no window, and write
// JSON reports for the evidence files. test/setup-env.ts clears BOTLING_* inside the test process, so the knobs are
// V3_ACCEPT_* (see test/acceptance/README.md).
//
//   npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/<check>.test.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    include: ["test/acceptance/**/*.test.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    setupFiles: ["./test/setup-env.ts"],
  },
});
