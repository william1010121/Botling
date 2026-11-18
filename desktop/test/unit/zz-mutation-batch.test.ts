// TEMPORARY (L-010 batch mutation check for bot/jank-core-events-2; removed in the next commit).
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
const KILL = [T("server-tap-jank"), T("store"), T("contract")];
const ALL = [...new Set([...KILL, T("chat-state-shell"), T("main-v3-adapter"), T("core-watch"), T("components-core"), T("app-dom-golden"), T("chat-frame-rerender"), T("core-split-characterization"), T("main-v3-botlingd")])];

const FIT = "src/server/effects/fit.ts";
const STORE = "src/renderer/store.ts";
const CONTRACT = "src/contract/results.ts";

// [name, file, find, replace, killer files]
const M: [string, string, string, string, string[]][] = [
  ["S1 renderer always replaces", STORE, "event.partial ? { ...view.components, ...event.components } : event.components", "event.components", KILL],
  ["S2 renderer always merges", STORE, "event.partial ? { ...view.components, ...event.components } : event.components", "{ ...view.components, ...event.components }", KILL],
  ["S3 renderer merge: the old entries win", STORE, "{ ...view.components, ...event.components }", "{ ...event.components, ...view.components }", KILL],
  ["S4 fit: partial not set", FIT, "    whole.partial = true;\n", "", KILL],
  ["S5 fit: the marker's own bytes not counted", FIT, "      if (Object.hasOwn(left, name)) delete left[name];\n", "", KILL],
  ["S6 fit: a cut list is not marked", FIT, "  if (cut) {\n    whole.partial = true;", "  if (false) {\n    whole.partial = true;", KILL],
  ["S7 contract: partial may be false", CONTRACT, "partial: z.literal(true).optional() })", "partial: z.boolean().optional() })", KILL],
  ["S8 contract: partial required", CONTRACT, "partial: z.literal(true).optional() })", "partial: z.literal(true) })", KILL],
  ["S9 contract: no partial field", CONTRACT, ", partial: z.literal(true).optional() })", " })", KILL],
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
  return { code: r.status, total: json?.numTotalTests ?? 0, failed, files: json?.testResults?.length ?? 0, err: `${r.stdout}\n${r.stderr}`.slice(-3000), tail: json ? "" : `${r.stdout}\n${r.stderr}`.slice(-1500) };
}

it("batch mutation check", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mut-"));
  try {
    cpSync(root, tmp, { recursive: true, filter: (src) => ![".git", "node_modules", "out", "dist", ".bot", "release"].includes(basename(src)) });
    for (const dir of ["desktop", "Web", ""]) if (existsSync(join(root, dir, "node_modules"))) symlinkSync(join(root, dir, "node_modules"), join(tmp, dir, "node_modules"));
    const cwd = join(tmp, "desktop");
    const built = build(cwd); // the baseline files botlingd-remote-worker and fe-link-two-servers read out/; the killer files do not (L-017)
    const base = runVitest(cwd, ALL);
    console.log(`MUTANT baseline(copy): ${built}, exit ${base.code}, ${base.files} files, ${base.total} tests, failed ${base.failed.length} ${base.failed.join(" | ")}${base.tail}${base.code !== 0 ? " STDERR " + base.err : ""}`);
    // A non-zero exit with no failed test is printed above (STDERR) and does not stop the batch; the killer files get a baseline of their own.
    if (base.failed.length || base.files < ALL.length) throw new Error("baseline in the copy does not pass: mutation results void");
    const killBase = runVitest(cwd, KILL);
    console.log(`MUTANT baseline(killer files): exit ${killBase.code}, ${killBase.files} files, ${killBase.total} tests, failed ${killBase.failed.length}${killBase.code !== 0 ? " STDERR " + killBase.err : ""}`);
    if (killBase.code !== 0 || killBase.failed.length) throw new Error("killer files baseline does not pass: mutation results void");
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
