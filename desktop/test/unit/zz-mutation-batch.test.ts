// TEMPORARY (L-010 batch mutation check for bot/prompt-fix-p0; removed in the final commit).
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
const REG = [T("app-tools-registry"), T("agy-worker-bridge")];
const PROMPTS = [T("prompts"), T("delegation-prompt-snapshot"), T("worktree-cwd")];
const MAINT = [T("prompts"), T("maintainer")];
const RULES = [T("orchestration-default-rules"), T("orchestration-plugin")];
const ASK = [T("auto-mode")];
const LIST = [T("projects"), T("routines-core"), T("head")];
const ALL = [...new Set([...REG, ...PROMPTS, ...MAINT, ...RULES, ...ASK, ...LIST])];

const REGISTRY = "src/core/app-tools/registry.ts";
const PROMPTS_TS = "src/core/prompts.ts";
const MAINT_TS = "src/core/maintainer-text.ts";
const RULES_TS = "src/core/orchestration/default-rules.ts";
const ASK_TS = "src/core/bot/questions.ts";
const PROJECTS_TS = "src/core/projects.ts";

const TIDY_NEW = "When app_task_result arrives, record app_task_checkpoint for its task_id (complete only if the report confirms the update, else blocked), then reply only OK if the memory was saved. If it failed, report the blocker and do not claim the memory was saved.)`,\n      ";
const OLD_TAIL = "When app_task_result confirms the update completed, reply only OK. If it failed, report the blocker and do not claim the memory was saved.)`,\n      ";
const RETRY_TAIL = " If it is refused again, do not retry: tell the user.)";

// [name, file, find, replace, related files]
const M: [string, string, string, string, string[]][] = [
  ["M1 engine enum default again has codex", REGISTRY, 'engine: ({ engines = ["agy"] })', 'engine: ({ engines = ["agy", "codex"] })', REG],
  ["M2 agy handoff description promises Codex again", REGISTRY, "an app-managed Antigravity (agy) worker", "an app-managed agy or Codex worker", REG],
  ["M3 Codex main bot gets no no-files line", PROMPTS_TS, "...(codex ? [CODEX_MAIN_NO_FILES_LINE] : []),", "...[],", PROMPTS],
  ["M4 every main bot gets the no-files line", PROMPTS_TS, "...(codex ? [CODEX_MAIN_NO_FILES_LINE] : []),", "CODEX_MAIN_NO_FILES_LINE,", PROMPTS],
  ["M5 tidy: no checkpoint step", PROMPTS_TS, TIDY_NEW + "handoff:", OLD_TAIL + "handoff:", PROMPTS],
  ["M6 handoff: no checkpoint step", PROMPTS_TS, TIDY_NEW + "resume:", OLD_TAIL + "resume:", PROMPTS],
  ["M7a retry rule: owner is not named", PROMPTS_TS, "A worker's or subagent's call: do not run it yourself; tell that worker to run it again, as the message says. ", "", PROMPTS],
  ["M7b retry rule: own call sentence gone", PROMPTS_TS, "Your own call: run it again exactly as it was. ", "", PROMPTS],
  ["M7c retry rule: no stop after a second refusal", PROMPTS_TS, "If the retry is refused again, or when the user did not allow it, do not try it again: carry on", "When the user did not allow it, carry on", PROMPTS],
  ["M8 editor route: follow-up fix not rerouted", MAINT_TS, ".replace(EDITOR_FIX, () => route.fix)", "", MAINT],
  ["M9 editor route: busy-editor send not rerouted", MAINT_TS, ".replace(EDITOR_BUSY, () => route.busy)", "", MAINT],
  ["M10 codex route uses subagent_type", MAINT_TS, "call app_handoff with role ", "call app_handoff with subagent_type ", MAINT],
  ["M11 claude route uses role", MAINT_TS, "call app_handoff with subagent_type ", "call app_handoff with role ", MAINT],
  ["M12 codex Maintainer gets no no-tools line", MAINT_TS, 'transport === "codex" ? routed.replace(', "false ? routed.replace(", MAINT],
  ["M13 claude Maintainer gets the no-tools line", MAINT_TS, 'transport === "codex" ? routed.replace(', "true ? routed.replace(", MAINT],
  ["M14 Maintainer rewrite skipped on Codex", PROMPTS_TS, '&& (engine === "codex" || workers)) system = maintainerEditorRoute', "&& workers) system = maintainerEditorRoute", MAINT],
  ["M15 Maintainer rewrite always uses the claude route", PROMPTS_TS, 'maintainerEditorRoute(system, engine === "codex" ? "codex" : "claude");', 'maintainerEditorRoute(system, "claude");', MAINT],
  ["M16 every bot's instructions are rewritten", PROMPTS_TS, 'if (profile.id === MAINTAINER_PROMPT_ID && (engine === "codex" || workers)) system = maintainerEditorRoute', 'if ((engine === "codex" || workers)) system = maintainerEditorRoute', MAINT],
  ["M17 reports.11 back to the old sentence", RULES_TS, "A maintenance (tidy or switch) turn goes: acceptance receipt, end the turn, worker report, checkpoint, then OK.", "Maintenance reports also require a checkpoint before OK.", RULES],
  ["M18 Codex worker allow: no stop after a second refusal", ASK_TS, "tell that worker (app_send_message) to run it again as it was and carry on." + RETRY_TAIL, "tell that worker (app_send_message) to run it again as it was and carry on.)", ASK],
  ["M19 Codex own allow: no stop after a second refusal", ASK_TS, "run it again as it was, then carry on." + RETRY_TAIL + "`", "run it again as it was, then carry on.)`", ASK],
  ["M20 subagent allow: no stop after a second refusal", ASK_TS, "tell that subagent (SendMessage) to run it again as it was and carry on." + RETRY_TAIL, "tell that subagent (SendMessage) to run it again as it was and carry on.)", ASK],
  ["M21 project list header: no no-file-tools sentence", PROJECTS_TS, " If you have no file or shell tools (Codex), have an app_handoff worker do either, and say it is done only after its report arrives.)", ")", LIST],
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
