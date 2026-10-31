import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LINES, TurnLog, headCommit, mergeBase, parseNameStatus, parseNumstat, parseUnifiedDiff, reviewDiff, reviewFiles, safeRelative, snapshotTree } from "../../src/core/review";
import { WorktreeDesk } from "../../src/core/worktree-desk";
import { ReviewDiffView, ReviewFilesView } from "../../src/contract";
import type { BotProfile } from "../../src/core/store/workspace";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botling-review-test-"))); dirs.push(dir);
  const folder = join(dir, "repo"); mkdirSync(folder);
  git(folder, "init", "-b", "main"); git(folder, "config", "user.name", "T"); git(folder, "config", "user.email", "t@example.invalid");
  writeFileSync(join(folder, ".gitignore"), "ignored.log\n");
  writeFileSync(join(folder, "keep.txt"), lines(10));
  writeFileSync(join(folder, "gone.txt"), "bye\n");
  writeFileSync(join(folder, "old-name.txt"), lines(30, "moving"));
  writeFileSync(join(folder, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  git(folder, "add", "."); git(folder, "commit", "-m", "start");
  return { dir, folder };
}

describe("parsers", () => {
  it("reads name-status and numstat output, renames included", () => {
    const status = parseNameStatus("M\0a.ts\0A\0b.ts\0D\0c.ts\0R087\0old.ts\0new.ts\0T\0t.ts\0");
    expect([...status]).toEqual([["a.ts", { status: "M" }], ["b.ts", { status: "A" }], ["c.ts", { status: "D" }], ["new.ts", { status: "R", oldPath: "old.ts" }], ["t.ts", { status: "M" }]]);
    const stat = parseNumstat("3\t1\ta.ts\0-\t-\timg.png\0" + "2\t2\t\0old.ts\0new.ts\0");
    expect(stat.get("a.ts")).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stat.get("img.png")).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(stat.get("new.ts")).toEqual({ additions: 2, deletions: 2, binary: false });
  });

  it("splits a unified diff into hunks with old and new line numbers", () => {
    const text = ["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f", "@@ -3,3 +3,4 @@ fn", " same", "-old", "+new", "+extra", " tail", "\\ No newline at end of file", "@@ -20 +21 @@", "-x", "+y"].join("\n");
    const { hunks, additions, deletions, truncated } = parseUnifiedDiff(text);
    expect({ additions, deletions, truncated }).toEqual({ additions: 3, deletions: 2, truncated: false });
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines).toEqual([
      { t: "ctx", o: 3, n: 3, text: "same" }, { t: "del", o: 4, text: "old" }, { t: "add", n: 4, text: "new" }, { t: "add", n: 5, text: "extra" }, { t: "ctx", o: 5, n: 6, text: "tail" },
    ]);
    expect(hunks[1].lines[1]).toEqual({ t: "add", n: 21, text: "y" });
  });

  it("stops at the line cap, and cuts a very long line", () => {
    const body = Array.from({ length: 50 }, (_, i) => `+l${i}`).join("\n");
    const cut = parseUnifiedDiff(`@@ -0,0 +1,50 @@\n${body}`, 10);
    expect(cut.truncated).toBe(true);
    expect(cut.hunks[0].lines).toHaveLength(10);
    const long = parseUnifiedDiff(`@@ -0,0 +1 @@\n+${"x".repeat(5000)}`);
    expect(long.hunks[0].lines[0].text.length).toBeLessThan(2100);
    expect(long.hunks[0].lines[0].text.endsWith("…")).toBe(true);
  });

  it("recognises a binary diff", () => {
    expect(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary).toBe(true);
  });

  it("accepts only paths inside the checkout", () => {
    for (const ok of ["a.ts", "src/a b.ts", "dir/..name"]) expect(safeRelative(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "C:\\x", "a\0b"]) expect(safeRelative(bad)).toBe(false);
  });
});

describe("review of a real repository", () => {
  it("snapshots the working directory without touching the index or ignored files", async () => {
    const { folder } = repo();
    writeFileSync(join(folder, "new.txt"), "n\n");
    writeFileSync(join(folder, "ignored.log"), "noise\n");
    writeFileSync(join(folder, "keep.txt"), lines(11));
    git(folder, "add", "keep.txt"); writeFileSync(join(folder, "keep.txt"), lines(12));
    const before = git(folder, "status", "--porcelain=v2");
    const tree = await snapshotTree(folder);
    expect(git(folder, "status", "--porcelain=v2")).toBe(before);
    const names = git(folder, "ls-tree", "-r", "--name-only", tree).split("\n");
    expect(names).toContain("new.txt");
    expect(names).not.toContain("ignored.log");
    expect(git(folder, "show", `${tree}:keep.txt`)).toBe(lines(12).trimEnd());
  });

  it("lists added, modified, deleted and renamed files with counts, committed or not", async () => {
    const { folder } = repo();
    const start = (await headCommit(folder))!;
    writeFileSync(join(folder, "keep.txt"), lines(10).replace("line 3", "LINE 3") + "tail\n");
    unlinkSync(join(folder, "gone.txt"));
    renameSync(join(folder, "old-name.txt"), join(folder, "new-name.txt"));
    writeFileSync(join(folder, "added.txt"), "a\nb\n");
    writeFileSync(join(folder, "bin.dat"), Buffer.from([0, 9, 9, 9, 9]));
    git(folder, "add", "keep.txt"); git(folder, "commit", "-m", "part");   // some committed, some not
    const summary = await reviewFiles(folder, start, await snapshotTree(folder));
    const by = Object.fromEntries(summary.files.map((f) => [f.path, f]));
    expect(by["keep.txt"]).toMatchObject({ status: "M", additions: 2, deletions: 1 });
    expect(by["gone.txt"]).toMatchObject({ status: "D", additions: 0, deletions: 1 });
    expect(by["new-name.txt"]).toMatchObject({ status: "R", oldPath: "old-name.txt", additions: 0, deletions: 0 });
    expect(by["added.txt"]).toMatchObject({ status: "A", additions: 2 });
    expect(by["bin.dat"]).toMatchObject({ status: "M", binary: true });
    expect(summary.files.map((f) => f.path)).toEqual([...summary.files.map((f) => f.path)].sort());
    expect(summary.additions).toBe(4);
    expect(summary.capped).toBe(false);
  });

  it("shows one file's diff with line numbers, a rename, and a binary file as binary", async () => {
    const { folder } = repo();
    const start = (await headCommit(folder))!;
    writeFileSync(join(folder, "keep.txt"), lines(10).replace("line 5\n", "five\nfive and a half\n"));
    renameSync(join(folder, "old-name.txt"), join(folder, "new-name.txt"));
    writeFileSync(join(folder, "new-name.txt"), lines(30, "moving").replace("moving 1\n", "moved 1\n"));
    writeFileSync(join(folder, "bin.dat"), Buffer.from([0, 7, 7]));
    const to = await snapshotTree(folder);
    const keep = await reviewDiff(folder, start, to, { path: "keep.txt" });
    expect(keep).toMatchObject({ additions: 2, deletions: 1, tooLarge: false, truncated: false, binary: false });
    const flat = keep.hunks.flatMap((h) => h.lines);
    expect(flat).toContainEqual({ t: "del", o: 5, text: "line 5" });
    expect(flat).toContainEqual({ t: "add", n: 5, text: "five" });
    expect(flat).toContainEqual({ t: "add", n: 6, text: "five and a half" });
    const renamed = await reviewDiff(folder, start, to, { path: "new-name.txt", oldPath: "old-name.txt" });
    expect(renamed).toMatchObject({ additions: 1, deletions: 1 });
    expect((await reviewDiff(folder, start, to, { path: "bin.dat" })).binary).toBe(true);
  });

  it("guards a huge diff: not shown until forced, then capped", async () => {
    const { folder } = repo();
    const start = (await headCommit(folder))!;
    writeFileSync(join(folder, "big.txt"), lines(MAX_LINES + 500));
    const to = await snapshotTree(folder);
    const guarded = await reviewDiff(folder, start, to, { path: "big.txt" });
    expect(guarded).toMatchObject({ tooLarge: true, hunks: [], additions: MAX_LINES + 500 });
    const forced = await reviewDiff(folder, start, to, { path: "big.txt" }, true);
    expect(forced.tooLarge).toBe(false);
    expect(forced.hunks[0].lines).toHaveLength(MAX_LINES + 500);
  });

  it("refuses a path outside the checkout and a non-commit starting point", async () => {
    const { folder } = repo();
    const to = await snapshotTree(folder);
    await expect(reviewDiff(folder, null, to, { path: "../outside" })).rejects.toThrow(/inside the checkout/);
    await expect(reviewDiff(folder, "--output=/tmp/x", to, { path: "a" })).rejects.toThrow(/not a commit/);
    await expect(reviewFiles(folder, null, "HEAD")).rejects.toThrow(/not a tree/);
  });

  it("works in a repository with no commit yet (everything is new)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "botling-review-empty-"))); dirs.push(dir);
    git(dir, "init", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    expect(await headCommit(dir)).toBeNull();
    const summary = await reviewFiles(dir, null, await snapshotTree(dir));
    expect(summary.files).toMatchObject([{ path: "a.txt", status: "A", additions: 1 }]);
  });

  it("counts a branch from where it left its base", async () => {
    const { folder } = repo();
    const base = (await headCommit(folder))!;
    git(folder, "checkout", "-b", "feature");
    writeFileSync(join(folder, "f.txt"), "f\n"); git(folder, "add", "."); git(folder, "commit", "-m", "f");
    git(folder, "checkout", "main");
    writeFileSync(join(folder, "m.txt"), "m\n"); git(folder, "add", "."); git(folder, "commit", "-m", "m");
    git(folder, "checkout", "feature");
    expect(await mergeBase(folder, "main", "nope")).toBe(base);
    const summary = await reviewFiles(folder, await mergeBase(folder, "main", "nope"), await snapshotTree(folder));
    expect(summary.files.map((f) => f.path)).toEqual(["f.txt"]);
  });
});

describe("turn log", () => {
  it("keeps the last 30 turns per checkout and forgets a dropped one", () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-turnlog-")); dirs.push(dir);
    const log = new TurnLog(join(dir, "sub", "turns.json"));
    const tree = "a".repeat(40);
    for (let i = 0; i < 35; i++) log.add("w1", { id: `t${i}`, at: "2026-01-01T00:00:00Z", tree });
    log.add("w2", { id: "x", at: "2026-01-01T00:00:00Z", tree });
    expect(log.list("w1")).toHaveLength(30);
    expect(log.list("w1")[0].id).toBe("t5");
    log.add("w1", { id: "t34", at: "later", tree });
    expect(log.list("w1")).toHaveLength(30);
    log.drop("w1");
    expect(log.list("w1")).toEqual([]);
    expect(log.list("w2")).toHaveLength(1);
    writeFileSync(join(dir, "sub", "turns.json"), "not json");
    expect(log.list("w2")).toEqual([]);
    expect(readFileSync(join(dir, "sub", "turns.json"), "utf8")).toBe("not json");
  });
});

describe("worktree desk review", () => {
  function setup() {
    const { dir, folder } = repo();
    const profile: BotProfile = { id: "ID1", name: "P", role: "manager", avatar: "hexagon", folder, memoryPath: ".bot/memory.md", storeDir: join(dir, "store"), tools: [], job: null, problem: null };
    const desk = new WorktreeDesk({ dataDir: join(dir, "data"), settings: () => ({ enabled: true, root: join(dir, "wt") }), devWork: () => null, isDeveloper: () => false, moved: () => {} });
    return { dir, folder, profile, desk };
  }

  it("reviews a worktree against its base, the main checkout against HEAD, and returns shapes the contract accepts", async () => {
    const { folder, profile, desk } = setup();
    writeFileSync(join(folder, "main-wip.txt"), "someone else's work\n");
    const made = await desk.create(profile, "Fix it"); expect(made.ok).toBe(true);
    const { items } = await desk.view(profile);
    const wt = items[0];
    writeFileSync(join(wt.path, "keep.txt"), lines(10) + "more\n");
    git(wt.path, "add", "."); git(wt.path, "commit", "-m", "c1");
    writeFileSync(join(wt.path, "later.txt"), "x\n");

    const branch = ReviewFilesView.parse(await desk.reviewFiles(profile, wt.id, "branch"));
    expect(branch).toMatchObject({ ok: true, base: "main" });
    expect(branch.files.map((f) => f.path)).toEqual(["keep.txt", "later.txt"]);
    const uncommitted = await desk.reviewFiles(profile, wt.id, "uncommitted");
    expect(uncommitted.files.map((f) => f.path)).toEqual(["later.txt"]);
    const diff = ReviewDiffView.parse(await desk.reviewDiff(profile, wt.id, branch.from, branch.to, "keep.txt", undefined, false));
    expect(diff).toMatchObject({ ok: true, additions: 1 });

    const main = await desk.reviewFiles(profile, null, "uncommitted");
    expect(main.files.map((f) => f.path)).toEqual(["main-wip.txt"]);
    expect(git(folder, "status", "--porcelain")).toBe("?? main-wip.txt");   // the main checkout is only read
  });

  it("refuses an unknown worktree, a bad path, and a project with worktrees off", async () => {
    const { profile, desk, dir } = setup();
    expect(await desk.reviewFiles(profile, "nope", "branch")).toMatchObject({ ok: false, message: "That worktree is not there." });
    const made = await desk.create(profile, "x"); expect(made.ok).toBe(true);
    const wt = (await desk.view(profile)).items[0];
    const files = await desk.reviewFiles(profile, wt.id, "branch");
    expect(await desk.reviewDiff(profile, wt.id, files.from, files.to, "../x", undefined, false)).toMatchObject({ ok: false });
    const off = new WorktreeDesk({ dataDir: join(dir, "data"), settings: () => ({ enabled: false, root: null }), devWork: () => null, isDeveloper: () => false, moved: () => {} });
    expect(await off.reviewFiles(profile, null, "branch")).toMatchObject({ ok: false });
  });

  it("records the tree at each turn start in the current worktree, and shows what one turn changed", async () => {
    const { profile, desk } = setup();
    await desk.create(profile, "Turns");
    const wt = (await desk.view(profile)).items[0];
    await desk.turnStarted(profile, "turn-1");
    writeFileSync(join(wt.path, "one.txt"), "1\n");
    await desk.turnStarted(profile, "turn-2");
    writeFileSync(join(wt.path, "two.txt"), "2\n");

    const all = await desk.reviewFiles(profile, wt.id, "branch");
    expect(all.turns.map((t) => t.id)).toEqual(["turn-1", "turn-2"]);
    const first = await desk.reviewFiles(profile, wt.id, "turn", "turn-1");
    expect(first.files.map((f) => f.path)).toEqual(["one.txt"]);
    expect(first.turn).toBe("turn-1");
    const last = await desk.reviewFiles(profile, wt.id, "turn", "turn-2");
    expect(last.files.map((f) => f.path)).toEqual(["two.txt"]);
    expect(await desk.reviewFiles(profile, wt.id, "turn", "missing")).toMatchObject({ ok: false });
    const diff = await desk.reviewDiff(profile, wt.id, first.from, first.to, "one.txt", undefined, false);
    expect(diff.hunks[0].lines).toEqual([{ t: "add", n: 1, text: "1" }]);

    // Discarding the worktree forgets its turns.
    await desk.discard(profile, wt.id, true);
    await desk.turnStarted(profile, "turn-3");    // no current worktree: nothing recorded
    expect(await desk.reviewFiles(profile, wt.id, "turn", "turn-1")).toMatchObject({ ok: false });
  });

  it("records nothing while the session is in the project folder", async () => {
    const { profile, desk, dir } = setup();
    await desk.turnStarted(profile, "t");
    expect(() => readFileSync(join(dir, "store", "review-turns.json"))).toThrow();
  });
});
