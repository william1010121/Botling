// TEMPORARY (L-010 batch mutation check for bot/spec-monitor-fix2; removed in the final commit).
// Copies the worktree, then for each mutant patches claude-workers.ts in the copy and runs vitest on the related files there.
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const FILE = "src/core/agent/claude-workers.ts";
const FILTERS = ["test/unit/claude-workers.test.ts", "worker-process.spec.test.ts"];

const M: [string, string, string][] = [
  ["M1 no clearApiRetry in holdForMonitor", "    // A turn that began while an API retry waited (a Monitor's event) ended well: no try is owed any more.\n    clearApiRetry(proc);\n", ""],
  ["M2 capped dropped at an API retry", "        proc.apiRetries = attempt;\n        proc.carried = kept;\n", "        proc.apiRetries = attempt;\n        proc.carried = kept;\n        proc.capped = undefined;\n"],
  ["M2b capped lives on the hold (cleared with it)", "  proc.monitorHold = undefined;\n}", "  proc.monitorHold = undefined;\n  proc.capped = undefined;\n}"],
  ["M3a carried not kept at an API retry", "        proc.carried = kept;\n", ""],
  ["M3b failure drops the held report (finalText)", "finalText: result.ok ? result.text : kept ? earlierReportText(kept) : null", "finalText: result.ok ? result.text : null"],
  ["M3c process exit drops carried", "finalText: carried ? earlierReportText(carried) : null", "finalText: null"],
  ["M3d carried not merged into the next report", "const earlier = held?.text || proc.carried;", "const earlier = held?.text;"],
  ["M4a re-hold after cap (end ignores capped)", " && !proc.capped && this.liveMonitors(proc).length", " && this.liveMonitors(proc).length"],
  ["M4b monitorChanged ignores capped", "    if (proc.capped) return;\n    const live", "    const live"],
  ["M4c cap under a turn does not set capped", "        if (held.on === \"cap\") proc.capped = true;\n", ""],
  ["M4d grace under a turn also sets capped", "if (held.on === \"cap\") proc.capped = true;", "proc.capped = true;"],
  ["M5 onExit does not release the held report", "    if (proc.monitorHold) { this.end(proc, run, proc.monitorHold.result, true); return; }\n", ""],
  ["M6 end() leaves the hold standing after a failure", "    if (proc.monitorHold) { clearHold(proc); run.emit({ type: \"waitingOn\", on: null }); }\n", ""],
  ["M7 no once-guards on merging", "if (result.ok && earlier && held !== result && earlier !== result.text) result", "if (result.ok && earlier) result"],
  ["M8 carried not cleared by a good result", "    if (result.ok) proc.carried = undefined;\n", ""],
  ["M9 stop() leaves the hold", "    clearApiRetry(proc);\n    clearHold(proc);\n    if (proc.settle)", "    clearApiRetry(proc);\n    if (proc.settle)"],
  ["M10 close() leaves the hold", "      clearApiRetry(proc);\n      clearHold(proc);\n      Object.assign(", "      clearApiRetry(proc);\n      Object.assign("],
  ["M11 spawn does not reset carried/capped", "pendingResult: undefined, carried: undefined, capped: undefined, finishing: undefined", "pendingResult: undefined, finishing: undefined"],
  ["M12 steer-in-place does not reset carried/capped", "Object.assign(proc, { run, record: r, opening: { run: run.run, base: null }, pendingResult: undefined, carried: undefined, capped: undefined });", "Object.assign(proc, { run, record: r, opening: { run: run.run, base: null }, pendingResult: undefined });"],
  ["M13 onExit does not clear carried/capped", "    const carried = proc.carried;\n    proc.carried = undefined;\n    proc.capped = undefined;\n", "    const carried = proc.carried;\n"],
  ["M14 end() does not clear carried/capped", "    proc.run = undefined;\n    proc.carried = undefined;\n    proc.capped = undefined;\n    proc.queued.clear();\n    proc.apiRetries = 0;", "    proc.run = undefined;\n    proc.queued.clear();\n    proc.apiRetries = 0;"],
];

function runVitest(cwd: string) {
  const out = join(cwd, "mutant-report.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST"))) as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, [join(desktop, "node_modules/vitest/vitest.mjs"), "run", "--reporter=json", `--outputFile=${out}`, "--maxWorkers=2", ...FILTERS], { cwd, env, encoding: "utf8", timeout: 900_000 });
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
    const target = join(cwd, FILE);
    const original = readFileSync(target, "utf8");
    const base = runVitest(cwd);
    console.log(`MUTANT baseline(copy): exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")}${base.tail}`);
    if (base.code !== 0 || base.failed.length || base.files < 2) throw new Error("baseline in the copy does not pass: mutation results void");
    for (const [name, find, replace] of M) {
      const n = original.split(find).length - 1;
      if (n !== 1) { console.log(`MUTANT ${name}: PATCH FAILED (found ${n}x)`); continue; }
      writeFileSync(target, original.replace(find, () => replace));
      const r = runVitest(cwd);
      writeFileSync(target, original);
      const verdict = r.total === 0 ? "NOT EVALUATED" : r.failed.length ? "KILLED" : r.code === 0 ? "SURVIVED" : "KILLED(exit only)";
      console.log(`MUTANT ${name}: ${verdict} (${r.total} tests, failed ${r.failed.length}: ${r.failed.slice(0, 3).join(" | ")})${r.tail}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 3_300_000);
