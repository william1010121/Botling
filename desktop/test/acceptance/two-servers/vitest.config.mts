// Botling 3 M3 two-server runs (brief §3, §5): the long fault-injection, property and media runs over two (or three)
// built botlingd on loopback, through test/support/two-servers.ts and fault-proxy.ts. Never part of `npm test` /
// `test:unit` / `test:changed`; the harness's own quick self-test is test/unit/two-servers-harness.test.ts, which this
// config runs too. Build first (`npm run build`), headless only; knobs are V3_ACCEPT_* (test/setup-env.ts clears BOTLING_*).
//
//   npx vitest run --config test/acceptance/two-servers/vitest.config.mts [file]
import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    include: ["test/acceptance/two-servers/**/*.test.ts", "test/unit/two-servers-harness.test.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    passWithNoTests: true,
    setupFiles: ["./test/setup-env.ts"],
  },
});
