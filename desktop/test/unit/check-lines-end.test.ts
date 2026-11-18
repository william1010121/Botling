// M7-S109: the end state of the big-file split. The baseline holds exactly one entry (the frozen desktop/src/main/main.ts),
// check-lines.mjs fails when any other product file passes 800 lines, and CI runs it. The unit tests of the script itself are
// in check-lines.test.ts; this file pins the end state.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const script = resolve(repoRoot, "desktop/scripts/check-lines.mjs");
const realBaseline = resolve(repoRoot, "desktop/scripts/line-baseline.json");
const ciFile = resolve(repoRoot, ".github/workflows/ci.yml");
const MAIN = "desktop/src/main/main.ts";

type Baseline = { about: string; files: Record<string, number>; frozen: Record<string, string> };
const readBaseline = () => JSON.parse(readFileSync(realBaseline, "utf8")) as Baseline;

let repo = "";
const lines = (n: number) => "x\n".repeat(n);
function put(rel: string, content: string) {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content);
}
function run(extra: string[] = []) {
  const r = spawnSync(process.execPath, [script, "--root", repo, "--baseline", realBaseline, ...extra], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}
function hasGit(dir: string) {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("M7-S109 end state of line-baseline.json", () => {
  it("holds exactly one entry, the frozen desktop/src/main/main.ts, and no other exception", () => {
    const b = readBaseline();
    expect(Object.keys(b.files)).toEqual([MAIN]);
    expect(b.files[MAIN]).toBe(1169);
    expect(Object.keys(b.frozen)).toEqual([MAIN]);
    expect(b.frozen[MAIN]).toContain("not split");
    expect(Object.keys(b).sort()).toEqual(["about", "files", "frozen"]);
  });
});

describe("check-lines on the end state", () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "check-lines-end-"));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    put(MAIN, lines(1169)); // the frozen file at its recorded size
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("passes with the real baseline when main.ts is frozen at 1169 and everything else is at most 800 lines", () => {
    put("desktop/src/core/edge.ts", lines(800));
    const r = run();
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.out).toContain("1 over 800 lines, 1 in the baseline");
  });

  it("fails when any other product file passes 800 lines, and the message says to split it", () => {
    put("desktop/src/core/edge.ts", lines(801));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.err).toContain("desktop/src/core/edge.ts: 801 lines is over 800 and the file is not in the baseline");
    expect(r.err).toContain("split it");
  });

  it("fails for a renderer css file and an .mjs script over 800 lines too", () => {
    put("desktop/src/renderer/big.css", lines(801));
    put("desktop/scripts/big.mjs", lines(801));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.err).toContain("desktop/src/renderer/big.css: 801 lines");
    expect(r.err).toContain("desktop/scripts/big.mjs: 801 lines");
  });

  it("fails when the frozen main.ts grows by one line, naming the reason", () => {
    put(MAIN, lines(1170));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.err).toContain("frozen (Botling 2 only, user 2026-11-16: not split)");
    expect(r.err).toContain("grew to 1170 lines, its baseline is 1169");
  });
});

describe("the real checkout", () => {
  // The Linux test host checks the commit out as a worktree; skip only where git cannot read the tree.
  it.skipIf(!hasGit(repoRoot))("passes check-lines: main.ts is the only product file over 800 lines", () => {
    const r = spawnSync(process.execPath, [script, "--root", repoRoot], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 over 800 lines, 1 in the baseline");
    // The script prints main.ts's real size (the baseline is a ceiling, 12896c576 took the file under it), not the baseline.
    const mainLines = readFileSync(resolve(repoRoot, MAIN), "utf8").split("\n").length - 1;
    expect(r.stdout).toContain(`${mainLines}  ${MAIN}`);
    expect(mainLines).toBeLessThanOrEqual(readBaseline().files[MAIN]);
  });
});

describe("CI", () => {
  it("runs check-lines in the desktop job, once, as a step that blocks (no step-level continue-on-error)", () => {
    const text = readFileSync(ciFile, "utf8");
    const all = text.split("\n");
    const isRun = (line: string) => /^\s*(?:-\s*)?run:\s*npm run check:lines\s*$/.test(line);
    expect(all.filter(isRun)).toHaveLength(1);
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "desktop/package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:lines"]).toBe("node scripts/check-lines.mjs");
    // The `desktop:` job runs from its header to the next job header (two-space key), whichever job that is.
    const start = all.findIndex((line) => /^  desktop:\s*$/.test(line));
    expect(start).toBeGreaterThanOrEqual(0);
    const next = all.findIndex((line, i) => i > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line));
    const job = all.slice(start, next < 0 ? all.length : next);
    expect(job.join("\n")).toContain("working-directory: desktop"); // the job's defaults run in desktop/
    // The step: found by its run line, from its `- ` line (at or above the run line) to the line before the next step.
    const at = job.findIndex(isRun);
    expect(at, "the check:lines step is in the desktop job").toBeGreaterThanOrEqual(0);
    const isStepStart = (line: string) => /^ {6}- /.test(line);
    let from = at;
    while (from > 0 && !isStepStart(job[from])) from -= 1;
    let to = at + 1;
    while (to < job.length && !isStepStart(job[to])) to += 1;
    const step = job.slice(from, to).join("\n");
    expect(step).not.toMatch(/continue-on-error/);
  });
});
