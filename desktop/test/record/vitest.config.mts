// `npm run test:record`: records the real CLIs' worker streams (record-worker-streams.test.ts). Never part of
// `npm test`. test/setup-env.ts clears BOTLING_* inside the test process, so the recording switches are handed
// over here with `provide` (read with `inject("recordStreams")`).
import { defineConfig } from "vitest/config";

const keys = ["BOTLING_RECORD_STREAMS", "BOTLING_RECORD_TMP", "BOTLING_RECORD_ENGINES", "BOTLING_RECORD_SCENARIOS", "BOTLING_RECORD_CODEX_MODEL", "BOTLING_AGY_ACP_PATH"];

export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    include: ["test/record/**/*.test.ts"],
    testTimeout: 420_000,
    hookTimeout: 60_000,
    pool: "forks",
    maxWorkers: 1,
    setupFiles: ["./test/setup-env.ts"],
    provide: { recordStreams: Object.fromEntries(keys.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))) },
  },
});
