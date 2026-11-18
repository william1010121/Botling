// TEMPORARY (L-010 batch mutation check for bot/single-model-picker; removed in the final commit).
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
const ALL = [T("payload"), T("primary-engine"), T("seen-heads"), T("chat-state-channel"), T("chat-state-receiver")];
const PAYLOAD = "src/renderer/payload.ts";

// [name, file, find, replace, related files]
const M: [string, string, string, string, string[]][] = [
  ["P1 no null-heads branch (one engine gets nothing)", PAYLOAD, "  if (!heads) {\n    const only", "  if (false as boolean) {\n    const only", ALL],
  ["P2 null heads with several engines picks the first", PAYLOAD, "engines.length === 1 ? engines[0]! : null", "engines.length >= 1 ? engines[0]! : null", ALL],
  ["P3 one-head chip labelled with the raw id", PAYLOAD, "label: headName(only)", "label: only", ALL],
  ["P4 call site drops bot.heads", PAYLOAD, "...headsParts(chat.heads, bot.heads),", "...headsParts(chat.heads),", ALL],
  ["P5 one-head state also carries rounds", PAYLOAD, "chosen: only } } : {};", "chosen: only }, rounds: null } : {};", ALL],
  ["P6 one-head chosen is not its engine", PAYLOAD, "chosen: only } } : {};", "chosen: \"codex\" } } : {};", ALL],
  ["P7 zero engines still offers an option", PAYLOAD, "const only = engines.length === 1 ? engines[0]! : null;", "const only = engines.length === 1 ? engines[0]! : (\"claude\" as const);", ALL],
  ["P8 two-head view loses its answerWith", PAYLOAD, "answerWith: { options: heads.engines.map(", "answerWith_: { options: heads.engines.map(", ALL],
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
