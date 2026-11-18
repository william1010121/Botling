// TEMPORARY (L-010 batch mutation check for bot/card-speedup; removed in the final commit).
// Copies the worktree, then for each mutant in zz-mutants.json patches one src file in the copy, rebuilds out/ (L-017) and runs vitest on that mutant's related files there.
import { it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = dirname(desktop);
const M: { name: string; file: string; find: string; replace: string; tests: string[] }[] = JSON.parse(readFileSync(join(desktop, "test/unit/zz-mutants.json"), "utf8"));
const ALL = [...new Set([
  ...M.flatMap((m) => m.tests),
  ...["maintainer", "worker-cards", "inline-blocks", "component-cards", "claude-workers", "claude-app-tools", "bot-worker-cards", "prompts", "report-prompt", "report-results-rule", "routing-prompt", "claude-workers-core", "bot-prompt-hash", "delegation-prompt-snapshot", "components", "pin-only-components", "plugin-state-maintainer", "task-cards-removed", "reply-card", "relayed-card-answer", "verbatim-handoff-rule", "agy-instructions", "bot-split-characterization", "orchestration-default-rules", "reply", "plugin-reply-tags", "head"].map((t) => `test/unit/${t}.test.ts`),
])];

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
  const bad: string[] = json ? json.testResults.filter((f: any) => f.status === "failed" && !f.assertionResults.some((a: any) => a.status === "failed")).map((f: any) => `${f.name}: ${String(f.message).slice(0, 200)}`) : [];
  return { code: r.status, total: json?.numTotalTests ?? 0, failed, bad, files: json?.testResults?.length ?? 0, tail: json ? "" : `${r.stdout}\n${r.stderr}`.slice(-1500) };
}

it("batch mutation check", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-"));
  try {
    cpSync(root, tmp, { recursive: true, filter: (src) => ![".git", "node_modules", "out", "dist", ".bot", "release"].includes(basename(src)) });
    for (const dir of ["desktop", "Web", ""]) if (existsSync(join(root, dir, "node_modules"))) symlinkSync(join(root, dir, "node_modules"), join(tmp, dir, "node_modules"));
    const cwd = join(tmp, "desktop");
    const built = build(cwd);
    const base = runVitest(cwd, ALL);
    console.log(`MUTANT baseline(copy): ${built || "built"}, exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")} ${base.bad.join(" | ")}${base.tail}`);
    // A baseline failure does not void the run: a mutant counts as killed only by a failure the baseline does not already have.
    if (base.files < ALL.length && base.total === 0) throw new Error("baseline did not run: mutation results void");
    const known = new Set([...base.failed, ...base.bad]);
    const originals = new Map<string, string>();
    for (const { name, file, find, replace, tests } of M) {
      const target = join(cwd, file);
      if (!originals.has(file)) originals.set(file, readFileSync(target, "utf8"));
      const original = originals.get(file)!;
      const n = original.split(find).length - 1;
      if (n !== 1) { console.log(`MUTANT ${name}: PATCH FAILED (found ${n}x)`); continue; }
      writeFileSync(target, original.replace(find, () => replace));
      const failedBuild = build(cwd);
      const r = failedBuild ? { code: -1, total: 0, failed: [] as string[], bad: [] as string[], files: 0, tail: failedBuild } : runVitest(cwd, tests);
      writeFileSync(target, original);
      const fresh = r.failed.filter((title) => !known.has(title));
      const verdict = r.total === 0 ? "NOT EVALUATED" : fresh.length ? "KILLED" : r.bad.filter((entry) => !known.has(entry)).length ? "KILLED(file error)" : "SURVIVED";
      console.log(`MUTANT ${name}: ${verdict} (${r.total} tests, failed ${r.failed.length}: ${r.failed.slice(0, 3).join(" | ")}${r.bad.slice(0, 1).join("")})${r.tail}`);
    }
    build(cwd);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}, 7_000_000);
