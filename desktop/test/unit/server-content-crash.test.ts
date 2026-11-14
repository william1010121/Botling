// SIGKILL crash test of the content index (M1 brief step 13): a child posts finished lines naming a video, a picture and
// a PDF (test/fixtures/server-content-crash-child.ts) and is killed with SIGKILL at a random moment. After reopening:
// every acknowledged line is there; no line entry is without its content_refs/content_names rows and no such row is
// without its entry; every reference names a content row; every kept pin file exists; every content.ready entry is
// matched by its rows. Then recovery at start hashes what was preparing and sweeps orphan pins, and the same holds.
//
// Knobs (environment): V3_CONTENT_CRASH_RUNS=20, V3_CONTENT_CRASH_DIR=<folder> (default: the OS temp folder).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { ContentService } from "../../src/server/content";
import { openReaderDb, openServerStore, type Db } from "../../src/server/store";

const RUNS = Number(process.env.V3_CONTENT_CRASH_RUNS || 20);
const MODES = ["auto", "copy", "path"] as const;
const STREAM = "bot:crash" as StreamId;
const root = mkdtempSync(join(process.env.V3_CONTENT_CRASH_DIR || tmpdir(), "botling-content-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function childRun(script: string, dataDir: string, mediaDir: string, mode: string, killAfterMs: number) {
  return new Promise<{ acked: Set<number>; hashed: Set<number>; stderr: string; signal: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", script, dataDir, mediaDir, mode], { stdio: ["ignore", "pipe", "pipe"] });
    const acked = new Set<number>();
    const hashed = new Set<number>();
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
        else if (line.startsWith("hashed ")) hashed.add(Number(line.slice(7)));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (_code, signal) => { clearTimeout(timer); resolve({ acked, hashed, stderr, signal }); });
  });
}

/** Every rule of the content index over the store as it is; returns what is broken. */
function problems(db: Db, acked: Set<number>): string[] {
  const out: string[] = [];
  const entries = db.prepare("SELECT seq, kind, body FROM entries WHERE stream = ? ORDER BY seq").all(STREAM);
  const lines = new Set(entries.filter((row) => row.kind === "message.added").map((row) => Number(row.seq)));
  const ready = entries.filter((row) => row.kind === "content.ready").map((row) => ({ seq: Number(row.seq), body: JSON.parse(String(row.body)) as { lineId: string; url: string; ref: { id: string } } }));
  const readySeqs = new Set(ready.map((item) => item.seq));
  const names = db.prepare("SELECT seq, line, path, id FROM content_names WHERE stream = ?").all(STREAM);
  const refs = db.prepare("SELECT id, seq FROM content_refs WHERE stream = ?").all(STREAM);
  const content = new Map(db.prepare("SELECT id, pin, path, state FROM content").all().map((row) => [String(row.id), row]));
  for (const seq of acked) if (!lines.has(seq)) out.push(`acknowledged line ${seq} lost`);
  for (const seq of lines) {
    const nameIds = new Set(names.filter((row) => Number(row.seq) === seq).map((row) => String(row.id)));
    const refIds = new Set(refs.filter((row) => Number(row.seq) === seq).map((row) => String(row.id)));
    if (names.filter((row) => Number(row.seq) === seq).length !== 3) out.push(`line ${seq}: ${nameIds.size} names, expected 3`);
    if ([...nameIds].sort().join() !== [...refIds].sort().join()) out.push(`line ${seq}: names ${[...nameIds]} vs refs ${[...refIds]}`);
  }
  for (const row of [...names, ...refs]) {
    const seq = Number(row.seq);
    if (!lines.has(seq) && !readySeqs.has(seq)) out.push(`row at ${seq} without its entry`);
  }
  for (const row of refs) if (!content.has(String(row.id))) out.push(`ref ${row.id} at ${row.seq} without a content row`);
  for (const row of content.values()) if (row.pin !== "path" && !existsSync(String(row.path))) out.push(`pin file of ${row.id} missing`);
  for (const item of ready) {
    if (!refs.some((row) => Number(row.seq) === item.seq && row.id === item.body.ref.id)) out.push(`content.ready ${item.seq} without its ref`);
    const name = names.find((row) => row.line === item.body.lineId && `file://${row.path}` === decodeURI(item.body.url));
    if (!name || name.id !== item.body.ref.id) out.push(`content.ready ${item.seq} does not match its line's name`);
  }
  const integrity = String(db.pragma("integrity_check"));
  if (integrity !== "ok") out.push(`integrity ${integrity}`);
  return out;
}

describe(`content references survive SIGKILL (${RUNS} runs)`, () => {
  it("never leaves a line entry without its references or a reference without its entry", async () => {
    const script = join(root, "child.cjs");
    buildSync({
      entryPoints: [join(__dirname, "../fixtures/server-content-crash-child.ts")],
      outfile: script, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["node:sqlite"], logLevel: "error",
    });
    const summary: Array<{ run: number; mode: string; acked: number; hashed: number; pendingAtKill: number; rehashed: number; swept: number }> = [];
    for (let run = 1; run <= RUNS; run++) {
      const mode = MODES[(run - 1) % MODES.length]!;
      const dataDir = join(root, `run-${run}`, "data");
      const mediaDir = join(root, `run-${run}`, "media");
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(mediaDir, { recursive: true });
      const killAfterMs = 100 + Math.floor(Math.random() * 900);
      const { acked, hashed, stderr, signal } = await childRun(script, dataDir, mediaDir, mode, killAfterMs);
      expect(stderr.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, ""), `run ${run}`).toBe("");
      expect(signal).toBe("SIGKILL");

      const store = await openServerStore(dataDir);
      const db = openReaderDb(store.file);
      try {
        expect(problems(db, acked), `run ${run} (${mode}) after the kill`).toEqual([]);
        const pendingAtKill = Number(db.prepare("SELECT count(*) AS n FROM content WHERE id LIKE 'pending:%' AND state = 'preparing'").get()!.n);
        const service = new ContentService({ store, dataDir, serverId: store.meta("serverId")! });
        const { swept, rehashed } = await service.recover();
        await service.idle();
        expect(problems(db, acked), `run ${run} (${mode}) after recovery`).toEqual([]);
        expect(Number(db.prepare("SELECT count(*) AS n FROM content WHERE state = 'preparing'").get()!.n), `run ${run}: still preparing`).toBe(0);
        const kept = new Set(db.prepare("SELECT path FROM content WHERE pin != 'path'").all().map((row) => String(row.path)));
        expect(readdirSync(service.pinsDir).map((name) => join(service.pinsDir, name)).filter((file) => !kept.has(file)), `run ${run}: orphan pins`).toEqual([]);
        await service.close();
        summary.push({ run, mode, acked: acked.size, hashed: hashed.size, pendingAtKill, rehashed, swept });
      } finally {
        db.close();
        await store.close();
      }
      rmSync(join(root, `run-${run}`), { recursive: true, force: true });
    }
    // The kills must land while lines were being posted and hashed.
    expect(summary.filter((r) => r.acked > 0).length).toBeGreaterThanOrEqual(Math.ceil(RUNS * 0.8));
    console.log(`content crash runs: ${JSON.stringify(summary)}`);
  }, Math.max(120_000, RUNS * 15_000));
});
