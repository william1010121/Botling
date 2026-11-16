// M7-S109: the end state of the big-file split. The baseline holds exactly one entry (the frozen desktop/src/main/main.ts),
// check-lines.mjs fails when any other product file passes 800 lines, and CI runs it. The unit tests of the script itself are
// in check-lines.test.ts; this file pins the end state.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(here, "../../..");
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
    expect(r.stdout).toContain(`1169  ${MAIN}`);
  });
});

describe("CI", () => {
  it("runs check-lines in the desktop job, once, not as an optional or failure-tolerant step", () => {
    const text = readFileSync(ciFile, "utf8");
    const runs = text.split("\n").filter((line) => /^\s*-?\s*run:\s*npm run check:lines\s*$/.test(line));
    expect(runs).toHaveLength(1);
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "desktop/package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:lines"]).toBe("node scripts/check-lines.mjs");
    // the step sits inside the `desktop:` job (after its header, before the `spec:` job), whose defaults run in desktop/
    const desktopJob = text.slice(text.indexOf("\n  desktop:\n"), text.indexOf("\n  spec:\n"));
    expect(desktopJob).toContain("working-directory: desktop");
    expect(desktopJob).toContain("run: npm run check:lines");
    const step = desktopJob.slice(desktopJob.indexOf("name: Product file size gate"));
    expect(step.split("\n      - ")[0]).not.toMatch(/continue-on-error/);
  });
});
