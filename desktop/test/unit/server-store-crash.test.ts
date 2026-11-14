// SIGKILL crash test of the server.db writer (M1 brief step 2). A child process (no window) commits scripted
// transactions and reports each acknowledged one; the parent kills it with SIGKILL at a random moment, reopens the
// data folder and checks: every acknowledged transaction is present, no transaction is partial, no failed command left
// a row, and the file passes integrity_check.
//
// Runs in the unit suite with 20 runs on a temp folder. Knobs (environment; BOTLING_* would be cleared by setup-env):
//   V3_STORE_CRASH_RUNS=20           number of runs
//   V3_STORE_CRASH_DIR=<folder>      where the temp data folders go (default: the OS temp folder); deleted afterwards
//   V3_STORE_CRASH_RUNTIME=electron  run the child under Electron's Node (ELECTRON_RUN_AS_NODE=1) instead of this Node
//   V3_STORE_CRASH_REPORT=<file>     also write the per-run results as JSON
// Example: V3_STORE_CRASH_DIR=/path/on/a/big/disk V3_STORE_CRASH_RUNTIME=electron \
//          npx vitest run test/unit/server-store-crash.test.ts
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { openReaderDb, openServerStore } from "../../src/server/store";

const RUNS = Number(process.env.V3_STORE_CRASH_RUNS || 20);
const RUNTIME = process.env.V3_STORE_CRASH_RUNTIME === "electron" ? "electron" : "node";
const root = mkdtempSync(join(process.env.V3_STORE_CRASH_DIR || tmpdir(), "botling-store-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runtime(): { command: string; env: NodeJS.ProcessEnv } {
  if (RUNTIME === "node") return { command: process.execPath, env: { ...process.env } };
  const electron = createRequire(import.meta.url)("electron") as unknown as string; // the binary's path under Node
  return { command: electron, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

interface RunResult {
  run: number;
  killAfterMs: number;
  acked: number;
  committed: number;
  committedNotAcked: number;
  lost: number;
  partial: number;
  failedRowsKept: number;
  integrity: string;
  ackedAfterReopenWrites: boolean;
}

function childRun(script: string, dataDir: string, killAfterMs: number): Promise<{ acked: Set<number>; stderr: string; signal: string | null }> {
  const { command, env } = runtime();
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--no-warnings", script, dataDir], { env, stdio: ["ignore", "pipe", "pipe"] });
    const acked = new Set<number>();
    let buffer = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line === "ready") timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
        else if (line.startsWith("ack ")) acked.add(Number(line.slice(4)));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (_code, signal) => { clearTimeout(timer); resolve({ acked, stderr, signal }); });
  });
}

describe(`server.db survives SIGKILL (${RUNS} runs, child on ${RUNTIME})`, () => {
  const results: RunResult[] = [];

  it("keeps every acknowledged transaction, whole, and nothing of a failed command", async () => {
    const script = join(root, "child.cjs");
    buildSync({
      entryPoints: [join(__dirname, "../fixtures/server-store-crash-child.ts")],
      outfile: script, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["node:sqlite"], logLevel: "error",
    });
    for (let run = 1; run <= RUNS; run++) {
      const dataDir = join(root, `run-${run}`);
      mkdirSync(dataDir);
      const killAfterMs = 20 + Math.floor(Math.random() * 600);
      const { acked, stderr, signal } = await childRun(script, dataDir, killAfterMs);
      expect(stderr.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, "")).toBe("");
      expect(signal).toBe("SIGKILL");

      // Reopen the way botlingd does (WAL recovery, migrations check), then read with a fresh connection.
      const store = await openServerStore(dataDir);
      const db = openReaderDb(store.file);
      let result: RunResult;
      try {
        const tags = (sql: string) => new Set(db.prepare(sql).all().map((row) => Number(row.t)));
        const entries = tags("SELECT seq AS t FROM entries WHERE stream = 'crash'");
        const receipts = tags("SELECT n AS t FROM receipts WHERE origin = 'crash'");
        const lists = tags("SELECT CAST(substr(name, 2) AS INTEGER) AS t FROM lists WHERE botId = 'crash'");
        const all = new Set([...entries, ...receipts, ...lists]);
        const partial = [...all].filter((t) => !(entries.has(t) && receipts.has(t) && lists.has(t))).length;
        const lost = [...acked].filter((t) => !entries.has(t) || !receipts.has(t) || !lists.has(t)).length;
        const failedRowsKept = Number(db.prepare("SELECT count(*) AS n FROM entries WHERE stream = 'fail'").get()!.n);
        result = {
          run, killAfterMs, acked: acked.size, committed: entries.size,
          committedNotAcked: [...entries].filter((t) => !acked.has(t)).length,
          lost, partial, failedRowsKept, integrity: String(db.pragma("integrity_check")), ackedAfterReopenWrites: false,
        };
      } finally {
        db.close();
      }
      // The reopened store takes new commands on top of what survived.
      await store.submit((w) => w.prepare("INSERT INTO lists (botId, name, body) VALUES ('after', 'x', '{}')").run());
      result.ackedAfterReopenWrites = true;
      await store.close();
      results.push(result);
      rmSync(dataDir, { recursive: true, force: true });
      expect(result, `run ${run}`).toMatchObject({ lost: 0, partial: 0, failedRowsKept: 0, integrity: "ok" });
    }
    // The kills must land while transactions were flowing, not before the first one.
    expect(results.filter((r) => r.acked > 0).length).toBeGreaterThanOrEqual(Math.ceil(RUNS * 0.8));
    const report = process.env.V3_STORE_CRASH_REPORT;
    if (report) writeFileSync(report, JSON.stringify({ runtime: RUNTIME, runs: results }, null, 2));
  }, Math.max(60_000, RUNS * 10_000));
});
