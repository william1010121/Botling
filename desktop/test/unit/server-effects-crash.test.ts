// SIGKILL crash test of the effect outbox (M1 brief step 6). A child process (no window) runs the intent runtime over a
// fake engine whose turns take a while, sending chat.send, routines, card answers, the engine's own turns and some
// turn.stops; every turn the engine begins is fsync'ed to spawns.log first. The parent kills it with SIGKILL at a
// random moment, then restarts on the same server.db in-process (recovery, the worker, a new fake engine) and checks:
// - every turn the child began ends exactly once in the log (one `turn.finished` or one `turn.interrupted`);
// - a turn running at the kill has exactly one `turn.interrupted`, whose text is a prefix of the scripted reply
//   (the checkpoint), and its row is `interrupted`;
// - the restarted engine never begins a turn the child began (only rows still `queued`, which nothing began);
// - every acknowledged chat.send has its row; no row is left queued or started once the restart settled;
// - a second restart adds nothing; the file passes integrity_check.
//
// Knobs (environment): V3_EFFECTS_CRASH_RUNS=20, V3_EFFECTS_CRASH_DIR=<folder> (temp data folders, deleted afterwards),
// V3_EFFECTS_CRASH_REPORT=<file> (per-run results as JSON).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { effectCheckpointSink } from "../../src/server/effects";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";

const RUNS = Number(process.env.V3_EFFECTS_CRASH_RUNS || 20);
const CRASH_CHUNKS = Array.from({ length: 30 }, (_, i) => `c${i} `);
const FULL_TEXT = CRASH_CHUNKS.join("");
const root = mkdtempSync(join(process.env.V3_EFFECTS_CRASH_DIR || tmpdir(), "botling-effects-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface RunResult {
  run: number;
  killAfterMs: number;
  acked: number;
  childSpawns: number;
  finishedByChild: number;
  interrupted: number;
  interruptedWithText: number;
  queuedAtCrash: number;
  restartSpawns: number;
  respawned: number;
  doubleEnded: number;
  notEnded: number;
  /** Turns the engine began by itself whose turn.started never committed: the server never knew them (no row, no entry). */
  unrecordedCoreTurns: number;
  unrecordedOther: number;
  badText: number;
  ackedWithoutRow: number;
  leftOpen: number;
  secondRecoveryAdded: number;
  integrity: string;
}

function childRun(script: string, dataDir: string, killAfterMs: number): Promise<{ acked: Set<string>; stderr: string; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", script, dataDir], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    const acked = new Set<string>();
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
        else if (line.startsWith("ack ")) acked.add(line.slice(4));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (_code, signal) => { clearTimeout(timer); resolve({ acked, stderr, signal }); });
  });
}

/** Restarts on the data folder in-process: recovery, then the worker runs what was queued, until all settled. */
async function restart(store: ServerStore): Promise<{ engine: FakeTurnEngine; close(): void }> {
  const engine = new FakeTurnEngine({ bots: ["MAIN", "B1", "B2", "B3"], chunks: ["r"], chunkMs: 1 });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 40 });
  const runtime = new IntentRuntime({ store, engine, live, log: () => {} });
  await runtime.start();
  for (let round = 0; round < 8; round += 1) {
    await runtime.idle();
    await engine.allEnded();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.scope.submit(() => undefined);
  }
  return { engine, close: () => { runtime.close(); engine.close(); live.close(); } };
}

describe(`the effect outbox survives SIGKILL (${RUNS} runs)`, () => {
  const results: RunResult[] = [];

  it("interrupts each running turn exactly once and never begins it again", async () => {
    const script = join(root, "child.cjs");
    buildSync({
      entryPoints: [join(__dirname, "../fixtures/server-effects-crash-child.ts")],
      outfile: script, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["node:sqlite"], logLevel: "error",
    });
    for (let run = 1; run <= RUNS; run++) {
      const dataDir = join(root, `run-${run}`);
      mkdirSync(dataDir);
      const killAfterMs = 60 + Math.floor(Math.random() * 700);
      const { acked, stderr, signal } = await childRun(script, dataDir, killAfterMs);
      expect(stderr.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, "")).toBe("");
      expect(signal).toBe("SIGKILL");
      const spawnFile = join(dataDir, "spawns.log");
      const spawnLines = existsSync(spawnFile) ? readFileSync(spawnFile, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")) : [];
      const coreTurns = new Set(spawnLines.filter(([who]) => who === "core").map(([, turnId]) => turnId));
      const childSpawns = spawnLines.filter(([who]) => who !== "core").map(([, turnId]) => turnId);

      const store = await openServerStore(dataDir);
      const queuedAtCrash = Number((await store.submit((db) => db.prepare("SELECT count(*) AS n FROM effects WHERE kind = 'turn' AND state = 'queued'").get()!.n)));
      const first = await restart(store);
      const reader = store.openReader();
      let result: RunResult;
      try {
        const rows = reader.prepare("SELECT botId, turnId, state FROM effects WHERE kind = 'turn'").all()
          .map((row) => ({ botId: String(row.botId), turnId: String(row.turnId), state: String(row.state) }));
        const ends = new Map<string, { finished: number; interrupted: number; texts: string[] }>();
        for (const row of reader.prepare("SELECT kind, body FROM entries WHERE kind IN ('turn.finished', 'turn.interrupted')").all()) {
          const body = JSON.parse(String(row.body)) as { turnId: string; text: string };
          const end = ends.get(body.turnId) ?? { finished: 0, interrupted: 0, texts: [] };
          if (row.kind === "turn.finished") end.finished += 1;
          else { end.interrupted += 1; end.texts.push(body.text); }
          ends.set(body.turnId, end);
        }
        const childSet = new Set(childSpawns);
        const interruptedTurns = [...ends.entries()].filter(([, end]) => end.interrupted > 0);
        result = {
          run, killAfterMs, acked: acked.size, childSpawns: childSpawns.length,
          finishedByChild: childSpawns.filter((turnId) => (ends.get(turnId)?.finished ?? 0) > 0).length,
          interrupted: interruptedTurns.length,
          interruptedWithText: interruptedTurns.filter(([, end]) => end.texts.some((text) => text.length > 0)).length,
          queuedAtCrash,
          restartSpawns: first.engine.spawns.length,
          respawned: first.engine.spawns.filter((turnId) => childSet.has(turnId)).length + (childSpawns.length - childSet.size),
          doubleEnded: [...ends.values()].filter((end) => end.finished + end.interrupted > 1).length,
          notEnded: childSpawns.filter((turnId) => {
            if (!rows.some((row) => row.turnId === turnId) && !ends.has(turnId)) return false; // counted below
            const end = ends.get(turnId);
            return !end || end.finished + end.interrupted !== 1;
          }).length,
          unrecordedCoreTurns: childSpawns.filter((turnId) => coreTurns.has(turnId) && !rows.some((row) => row.turnId === turnId) && !ends.has(turnId)).length,
          unrecordedOther: childSpawns.filter((turnId) => !coreTurns.has(turnId) && !rows.some((row) => row.turnId === turnId)).length,
          badText: interruptedTurns.filter(([, end]) => end.texts.some((text) => !FULL_TEXT.startsWith(text))).length,
          ackedWithoutRow: [...acked].filter((turnId) => !rows.some((row) => row.turnId === turnId)).length,
          leftOpen: rows.filter((row) => row.state === "queued" || row.state === "started").length,
          secondRecoveryAdded: 0,
          integrity: String(reader.prepare("PRAGMA integrity_check").get()!.integrity_check),
        };
        // Every interrupted turn's row says so; the child's spawns all have rows that left `queued`.
        for (const [turnId] of interruptedTurns) {
          const row = rows.find((candidate) => candidate.turnId === turnId);
          if (row) expect(row.state, `run ${run} ${turnId}`).toBe("interrupted");
        }
        for (const turnId of childSet) {
          const row = rows.find((candidate) => candidate.turnId === turnId);
          if (row || !coreTurns.has(turnId)) expect(row?.state, `run ${run} ${turnId}`).not.toBe("queued");
        }
      } finally {
        reader.close();
        first.close();
      }
      // A second restart: nothing more to interrupt or begin.
      const before = Number((await store.submit((db) => db.prepare("SELECT count(*) AS n FROM entries WHERE kind = 'turn.interrupted'").get()!.n)));
      const second = await restart(store);
      const after = Number((await store.submit((db) => db.prepare("SELECT count(*) AS n FROM entries WHERE kind = 'turn.interrupted'").get()!.n)));
      result.secondRecoveryAdded = after - before + second.engine.spawns.length;
      second.close();
      await store.close();
      results.push(result);
      rmSync(dataDir, { recursive: true, force: true });
      expect(result, `run ${run}`).toMatchObject({
        respawned: 0, doubleEnded: 0, notEnded: 0, unrecordedOther: 0, badText: 0, ackedWithoutRow: 0, leftOpen: 0, secondRecoveryAdded: 0, integrity: "ok",
      });
      expect(result.restartSpawns, `run ${run}`).toBe(result.queuedAtCrash);
    }
    // The kills must land while turns were running.
    expect(results.filter((r) => r.interrupted > 0).length).toBeGreaterThanOrEqual(Math.ceil(RUNS * 0.8));
    const report = process.env.V3_EFFECTS_CRASH_REPORT;
    if (report) writeFileSync(report, JSON.stringify({ runs: results }, null, 2));
  }, Math.max(120_000, RUNS * 15_000));
});
