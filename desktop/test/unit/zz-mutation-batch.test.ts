// TEMPORARY (L-010 batch mutation check for the review of bot/spec-sqlite-sync, D75; removed in the next commit).
// Copies the worktree, then for each mutant patches one src file in the copy, rebuilds out/ (L-017) and runs vitest on that mutant's related files there.
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const T = (name: string) => `test/unit/${name}.test.ts`;
const SPEC = "../spec/tests/store.spec.test.ts";
const STORE = [T("server-store-durability"), T("server-store"), T("server-store-writer"), SPEC];
const CONTENT = [T("server-content")];
const LOG = [SPEC, T("server-log")];
const BOTD = [T("botlingd-start-order"), T("server-store-durability")];
const ALL = [...new Set([...STORE, ...CONTENT, ...LOG, ...BOTD, T("server-store-crash"), T("server-store-compaction"), T("server-content-crash"), T("server-slots")])];

const CONN = "src/server/store/connection.ts";
const WRITER = "src/server/store/writer.ts";
const INDEX = "src/server/store/index.ts";
const SERVICE = "src/server/content/service.ts";
const LOGSTORE = "src/server/log/log-store.ts";
const BOTLINGD = "src/server/botlingd.ts";

// [name, file, find, replace, related files]
const M: [string, string, string, string, string[]][] = [
  ["M1 a failed flush owes nothing (marked ignores the debt)", CONN, "marked: () => mark || owing,", "marked: () => mark,", STORE],
  ["M2 the debt is never paid", CONN, "        flushes += 1;\n        owing = false;", "        flushes += 1;", STORE],
  ["M3 the debt is never set", CONN, "      owing = true;\n      try {\n        db.exec(\"PRAGMA synchronous = FULL\");", "      try {\n        db.exec(\"PRAGMA synchronous = FULL\");", STORE],
  ["M4 srv: rows not durable", CONN, "const DURABLE_ROWS_WHEN = \"stream LIKE 'srv:%'\";", "const DURABLE_ROWS_WHEN = \"stream LIKE 'zzz:%'\";", STORE],
  ["M5 forwardq left out of DURABLE_TABLES", CONN, "\"receipts\", \"slots\", \"cancels\", \"slot_results\", \"forwardq\",", "\"receipts\", \"slots\", \"cancels\", \"slot_results\",", STORE],
  ["M6 lostTail ignores the open mark", CONN, "  if (previous.open !== \"1\") return false;\n", "", STORE],
  ["M7 lostTail: an unknown boot counts as the same", CONN, "if (!previous.boot || current === null) return true;", "if (!previous.boot) return true;", STORE],
  ["M8 no Linux boot id", CONN, "    if (platform === \"linux\") {", "    if (platform === \"linuxx\") {", STORE],
  ["M9 the flush commits with NORMAL", CONN, "        db.exec(\"PRAGMA synchronous = FULL\");\n        db.exec(\"BEGIN IMMEDIATE\");", "        db.exec(\"PRAGMA synchronous = NORMAL\");\n        db.exec(\"BEGIN IMMEDIATE\");", STORE],
  ["M10 CommandContext.durable does nothing", WRITER, "durable: markDurable })", "durable: () => {} })", [T("server-store-durability"), ...CONTENT]],
  ["M11 a marked batch is not flushed", WRITER, "else if (gate.marked()) {", "else if (false) {", STORE],
  ["M12 a failed flush still acknowledges", WRITER, "try { gate.flush(); } finally {", "try { gate.flush(); } catch { /* mutant */ } finally {", STORE],
  ["M13 the external disk check is ignored", INDEX, "external ? null : current", "current", STORE],
  ["M14 onLostTail never runs", INDEX, "if (lost) options.onLostTail?.(db);", "", STORE],
  ["M15 a clean close is not marked", INDEX, "UPDATE meta SET value = '0' WHERE key = ?", "UPDATE meta SET value = '1' WHERE key = ?", STORE],
  ["M16 the boot is not stored", INDEX, "put.run(BOOT_KEY, current ?? \"\");", "put.run(BOOT_KEY, \"\");", STORE],
  ["M17 a dropped pin's commit is not flushed", SERVICE, "if (completed.drop) context.durable?.();", "", CONTENT],
  ["M18 every complete is flushed", SERVICE, "if (completed.drop) context.durable?.();", "context.durable?.();", CONTENT],
  ["M19 lostTailRewind retires nothing", LOGSTORE, "const streams = retireOwnStreams(db, \"rewind\");", "const streams: unknown[] = [];", LOG],
  ["M20 botlingd passes no onLostTail", BOTLINGD, "onLostTail: lostTailRewind(log),", "", BOTD],
];

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))) as NodeJS.ProcessEnv;

function build(cwd: string) {
  const r = spawnSync(process.execPath, ["build.mjs"], { cwd, env: env(), encoding: "utf8", timeout: 300_000 });
  return r.status === 0 ? "" : `BUILD FAILED ${r.status}: ${`${r.stdout}\n${r.stderr}`.slice(-800)}`;
}

function runVitest(cwd: string, filters: string[]) {
  const out = join(cwd, "mutant-report.json");
  rmSync(out, { force: true });
  const r = spawnSync(process.execPath, [join(desktop, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--outputFile=${out}`, "--maxWorkers=2", ...filters], { cwd, env: env(), encoding: "utf8", timeout: 900_000 });
  let json: any = null;
  try { json = JSON.parse(readFileSync(out, "utf8")); } catch { /* no report */ }
  const failed: string[] = json ? json.testResults.flatMap((f: any) => f.assertionResults.filter((a: any) => a.status === "failed").map((a: any) => a.title)) : [];
  return { code: r.status, total: json?.numTotalTests ?? 0, failed, files: json?.testResults?.length ?? 0, tail: json ? "" : `${r.stdout}\n${r.stderr}`.slice(-1500) };
}

it("batch mutation check", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-"));
  try {
    cpSync(root, tmp, { recursive: true, filter: (src) => ![".git", "node_modules", "out", "dist", ".bot", "release"].includes(basename(src)) });
    for (const dir of ["desktop", "Web", ""]) if (existsSync(join(root, dir, "node_modules"))) symlinkSync(join(root, dir, "node_modules"), join(tmp, dir, "node_modules"));
    const cwd = join(tmp, "desktop");
    const built = build(cwd);
    const base = runVitest(cwd, ALL);
    console.log(`MUTANT baseline(copy): ${built || "built"}, exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")}${base.tail}`);
    if (base.code !== 0 || base.failed.length || base.files < ALL.length) throw new Error("baseline in the copy does not pass: mutation results void");
    const originals = new Map<string, string>();
    for (const [name, file, find, replace, filters] of M) {
      const target = join(cwd, file);
      if (!originals.has(file)) originals.set(file, readFileSync(target, "utf8"));
      const original = originals.get(file)!;
      const n = original.split(find).length - 1;
      if (n !== 1) { console.log(`MUTANT ${name}: PATCH FAILED (found ${n}x)`); continue; }
      writeFileSync(target, original.replace(find, () => replace));
      const failedBuild = build(cwd);
      const r = failedBuild ? { code: -1, total: 0, failed: [] as string[], files: 0, tail: failedBuild } : runVitest(cwd, filters);
      writeFileSync(target, original);
      const verdict = r.total === 0 ? "NOT EVALUATED" : r.failed.length ? "KILLED" : r.code === 0 ? "SURVIVED" : "KILLED(exit only)";
      console.log(`MUTANT ${name}: ${verdict} (${r.total} tests, failed ${r.failed.length}: ${r.failed.slice(0, 3).join(" | ")})${r.tail}`);
    }
    build(cwd);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 3_300_000);
