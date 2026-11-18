// TEMPORARY (L-010 batch mutation check for bot/jank-core-events; removed in the next commit).
// Copies the worktree, then for each mutant patches one src file in the copy and runs vitest on that mutant's killer files there.
// out/ is built once for the baseline (some baseline files read it); no killer file reads out/, so mutants are not rebuilt (L-017).
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const T = (name: string) => `test/unit/${name}.test.ts`;
const KILL = [T("server-tap-jank"), T("server-log-diffstore")];
const ALL = [...new Set([...KILL, T("server-summary-rows"), T("server-effects-crash"), T("server-intents"), T("server-slots-order"), T("server-store-compaction"), T("push-triggers"), T("botlingd-remote-worker"), T("fe-link-two-servers"), T("server-botlingd"), T("import-chats")])];

const TAP = "src/server/effects/tap.ts";
const FIT = "src/server/effects/fit.ts";
const RUNTIME = "src/server/intents/runtime.ts";
const START = "src/server/botlingd-start.ts";

// [name, file, find, replace, killer files]
const M: [string, string, string, string, string[]][] = [
  ["T1 no replacement of a waiting snapshot", TAP, "if (other === key) {", "if (false) {", KILL],
  ["T2 replacement reaches over an event of another kind", TAP, "if (other === null) break;", "if (other === null) continue;", KILL],
  ["T3 sub-agent key ignores the sub-agent id", TAP, "`s\\u0000${event.botId}\\u0000${event.subagent.id}`", "`s\\u0000${event.botId}`", KILL],
  ["T4 bot key ignores the bot id", TAP, "`b\\u0000${event.bot.id}`", "`b`", KILL],
  ["T5 sub-agent key ignores the bot id", TAP, "`s\\u0000${event.botId}\\u0000${event.subagent.id}`", "`s\\u0000${event.subagent.id}`", KILL],
  ["T6 an event of another kind is not urgent", TAP, "this.urgent = true;", "", KILL],
  ["T7 urgent does not break a running window", TAP, "if (!this.urgent) return;", "return;", KILL],
  ["T8 flush leaves the timer running", TAP, "if (this.timer) { clearTimeout(this.timer); this.timer = null; }", "if (this.timer) { this.timer = null; }", KILL],
  ["T9 flush keeps urgent set", TAP, "    this.urgent = false;\n    const taken", "    const taken", KILL],
  ["T10 urgent still waits for the window", TAP, "if (wait > 0 && !this.urgent) {", "if (wait > 0) {", KILL],
  ["T11 a hold does not stop the schedule", TAP, "if (this.holds > 0 || !this.pending.length) return;", "if (!this.pending.length) return;", KILL],
  ["T12 no window at all", TAP, "const wait = this.options.coalesceMs ?? 0;", "const wait = 0;", KILL],
  ["T13 scheduled stays set after the timer is broken", TAP, "      this.timer = null;\n      this.scheduled = false;\n    }\n    if (this.scheduled) return;", "      this.timer = null;\n    }\n    if (this.scheduled) return;", KILL],
  ["T14 runtime does not pass coalesceMs", RUNTIME, "...(options.coalesceMs ? { coalesceMs: options.coalesceMs } : {}),", "", KILL],
  ["T15 botlingd does not set coalesceMs", START, "mirrorBotUpdates: true, coalesceMs: 200, content", "mirrorBotUpdates: true, content", KILL],
  ["F1 kept steps are the oldest, not the newest", FIT, "  holder.steps = steps.slice(start);\n  // The sum", "  holder.steps = steps.slice(0, steps.length - start);\n  // The sum", KILL],
  ["F2 sub-agent steps not cut", FIT, "cutSteps(copy, subagent, limit);", "", KILL],
  ["F3 sub-agent texts not cut", FIT, "for (const key of size(", "for (const key of [] || size(", KILL],
  ["F4 sub-agent texts cut in fixed order (result first)", FIT, 'size("result") >= size("prompt") ? ["result", "prompt"] : ["prompt", "result"]', '["result", "prompt"]', KILL],
  ["F5 components not cut", FIT, "      cutComponents(copy, limit);", "      break;", KILL],
  ["F6 components cut smallest first", FIT, "b.size - a.size || (a.name < b.name ? -1 : 1)", "a.size - b.size || (a.name < b.name ? -1 : 1)", KILL],
  ["F7 components cut walks the record's own order", FIT, "  sizes.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : 1));\n", "", KILL],
  ["F8 components cut over-counts what it saved", FIT, "    over -= size;", "    over -= size * 1000;", KILL],
  ["F9 components cut stops one early (keeps an over-size record)", FIT, "    if (over <= 0) break;\n    delete left[name];", "    if (over <= 1_000_000) break;\n    delete left[name];", KILL],
];

const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))) as NodeJS.ProcessEnv;

function build(cwd: string) {
  const r = spawnSync(process.execPath, ["build.mjs"], { cwd, env: env(), encoding: "utf8", timeout: 300_000 });
  return r.status === 0 ? "built" : `BUILD FAILED ${r.status}: ${`${r.stdout}\n${r.stderr}`.slice(-800)}`;
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
    const built = build(cwd); // the baseline files botlingd-remote-worker and fe-link-two-servers read out/; the killer files do not (L-017)
    const base = runVitest(cwd, ALL);
    console.log(`MUTANT baseline(copy): ${built}, exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")}${base.tail}`);
    if (base.code !== 0 || base.failed.length || base.files < ALL.length) throw new Error("baseline in the copy does not pass: mutation results void");
    const originals = new Map<string, string>();
    for (const [name, file, find, replace, filters] of M) {
      const target = join(cwd, file);
      if (!originals.has(file)) originals.set(file, readFileSync(target, "utf8"));
      const original = originals.get(file)!;
      const n = original.split(find).length - 1;
      if (n !== 1) { console.log(`MUTANT ${name}: PATCH FAILED (found ${n}x)`); continue; }
      writeFileSync(target, original.replace(find, () => replace));
      const r = runVitest(cwd, filters);
      writeFileSync(target, original);
      const verdict = r.total === 0 ? "NOT EVALUATED" : r.failed.length ? "KILLED" : r.code === 0 ? "SURVIVED" : "KILLED(exit only)";
      console.log(`MUTANT ${name}: ${verdict} (${r.total} tests, failed ${r.failed.length}: ${r.failed.slice(0, 3).join(" | ")})${r.tail}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 3_300_000);
