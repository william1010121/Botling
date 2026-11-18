// TEMPORARY (L-010 batch mutation check for design-duel/20261118-7a2d1c; removed in the final commit).
// Copies the worktree, then for each mutant patches one src file in the copy, rebuilds out/ (L-017) and runs vitest on that mutant's related files there.
// MUT_DRY=1: only counts that every patch finds its text exactly once (no copy, no run).
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const T = (name: string) => `test/unit/${name}.test.ts`;
const PLUGIN = ["builtin-plugins/botling.routines/test/frame.test.ts"];
const CORE = [T("routines-core"), T("routine-last"), T("subbot-routines"), T("plugin-routines-api")];
const REND = [T("payload"), T("routine-words-chip"), T("sub-bot-nav"), T("sub-bot-nav-render")];
const WORDS = [...REND, ...PLUGIN];
const ALL = [...new Set([...CORE, ...REND, ...PLUGIN])];

const BR = "src/core/bot/bot-routines.ts";
const RL = "src/core/routine-last.ts";
const PAY = "src/renderer/payload.ts";
const NAV = "src/renderer/sub-bot-nav.ts";
const RW = "../Web/src/routine-words.ts";
const TASKS = "../Web/src/tasks.ts";
const PANEL = "builtin-plugins/botling.routines/src/RoutinesPanel.tsx";
const RT = "builtin-plugins/botling.routines/src/routines-text.ts";

// [name, file, find, replace, related files]
const M: [string, string, string, string, string[]][] = [
  ["C1 a run is not recorded", BR, '        this.routineLast[key] = { at: now, result: "sent" };\n', "", CORE],
  ["C2 the record is not saved", BR, '        if (!this.readOnly) this.store.saveSetting("routineLast", this.routineLast);\n      } catch', "      } catch", CORE],
  ["C3 a watch's ok and failed swap", BR, 'lastResult: state.ok ? "ok" : "failed"', 'lastResult: state.ok ? "failed" : "ok"', CORE],
  ["C4 no dispatchedAt fallback", BR, 'fallback === null ? null : { at: fallback, result: "sent" as const }', "null", CORE],
  ["C5 the schedule file's time is not passed", BR, "...this.lastView(job.id, job.task, dispatched)", "...this.lastView(job.id, job.task, null)", CORE],
  ["C6 a legacy job has no last-run fields", BR, "...this.lastView(`cron:${job.id}`.slice(0, 2_200), job.task, null), ", "", CORE],
  ["C7 the kept record is ignored", BR, "Object.hasOwn(this.routineLast, key) ? this.routineLast[key]! : fallback === null", "fallback === null", CORE],
  ["C8 a gone routine keeps its record", BR, "if (lost.length) {", "if (false) {", CORE],
  ["C9 every record is dropped at the next look", BR, "const lost = Object.keys(this.routineLast).filter((key) => !live.has(key));", "const lost = Object.keys(this.routineLast);", CORE],
  ["C10 a failed save throws out of the run", BR, "this.log(`routine last run not kept: ${(error as Error).message}`); }", "throw error; }", CORE],
  ["C11 no date range check", RL, "Number.isFinite(at) && Math.abs(at) <= 8.64e15", "Number.isFinite(at)", CORE],
  ["C12 an unknown result is kept", RL, "|| !RESULTS.has(e.result)", "|| false", CORE],
  ["C13 a prototype-like id is assigned", RL, "Object.defineProperty(out, id, { value: { at: e.at, result: e.result }, enumerable: true, writable: true, configurable: true });", 'out[id] = { at: e.at, result: e.result as LastRun["result"] };', CORE],
  ["R1 a chip's missing result reads as ok", PAY, 'result: routine.lastResult ?? "sent"', 'result: routine.lastResult ?? "ok"', REND],
  ["R2 a failing watch's chip is not failing", PAY, 'routine.watch?.state === "failing" ? "failing"', 'false ? "failing"', REND],
  ["R3 a due routine's chip is not due", PAY, 'routine.status === "due" ? "due"', 'false ? "due"', REND],
  ["R4 a pending routine is not counted as next", NAV, '(routine.status !== "enabled" && routine.status !== "pending")', 'routine.status !== "enabled"', REND],
  ["R5 an attention routine is not named", NAV, 'groupOf(routine) === "attention"', "false", REND],
  ["R6 an idle bot with only a standing shows nothing", NAV, "if (dot === \"idle\" && (next || state)) {", "if (dot === \"idle\" && next) {", REND],
  ["R7 the menu says the cron fields, not the schedule phrase", NAV, "schedule: cadence(routine) }", "schedule: routine.schedule }", REND],
  ["W1 an unconfirmed send gets a last line", RW, 'if (routine.status === "delivery_uncertain") return null;\n  const at', "const at", WORDS],
  ["W2 a failed prompt run is not bad", RW, 'routine.lastResult === "failed" ? { word: "Last run failed", detail: ago, tone: "bad" }', 'false ? { word: "Last run failed", detail: ago, tone: "bad" }', WORDS],
  ["W3 a failing watch needs no look", RW, ' || routine.watch?.state === "failing") return "attention"', ") return \"attention\"", WORDS],
  ["W4 hours run to three days", RW, "span < 86_400_000 * 2 ? `${Math.round(span / 3_600_000)} h`", "span < 86_400_000 * 3 ? `${Math.round(span / 3_600_000)} h`", WORDS],
  ["W5 the chip rounds days differently", TASKS, "if (ms < 2 * 86_400_000) return t(\"tasks.inHours\"", "if (ms < 3 * 86_400_000) return t(\"tasks.inHours\"", REND],
  ["W6 the chip tooltip says sent for a failed run", TASKS, 'last.result === "failed" ? "tasks.lastFailed" : "tasks.lastSent"', '"tasks.lastSent"', REND],
  ["W7 the chip has no routine tooltip line", TASKS, "if (task.routine) item.title = `${item.title}\\n${lastWords(task.routine.last, now)}`;", "", REND],
  ["P1 cancel needs no second question", PANEL, '(operation === "cancel" ? onAsk(routine.id) : onChange(operation, routine.id))', "onChange(operation, routine.id)", PLUGIN],
  ["P2 a double tap sends twice", PANEL, "    if (working.current) return;\n", "", PLUGIN],
  ["P3 Keep does not close the question", PANEL, "<button type=\"button\" onClick={() => onAsk(null)}>Keep</button>", "<button type=\"button\" onClick={() => undefined}>Keep</button>", PLUGIN],
  ["P4 the summary leaves out paused", RT, "    count.paused && `${count.paused} paused`,\n", "", PLUGIN],
  ["P5 a card has no last-result line", PANEL, "{result && <div className=\"routine-result\"", "{false && <div className=\"routine-result\"", PLUGIN],
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
  if (process.env.MUT_DRY) {
    for (const [name, file, find] of M) console.log(`DRY ${name}: ${readFileSync(join(desktop, file), "utf8").split(find).length - 1}x`);
    return;
  }
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
