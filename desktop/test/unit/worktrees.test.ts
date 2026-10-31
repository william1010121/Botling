import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, worktreeSlug } from "../../src/core/worktrees";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string, message = file) => { writeFileSync(join(cwd, file), text); git(cwd, "add", "."); git(cwd, "commit", "-m", message); };

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "botling-wt-"))); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "t@example.invalid");
  commit(repo, "a.txt", "base\n");
  const manager = new WorktreeManager({ folder: repo, file: join(root, "data", "worktrees.json"), root: () => join(root, "work") });
  return { root, repo, manager };
}

describe("worktree lifecycle", () => {
  it("slugs names into safe branch and folder names", () => {
    expect(worktreeSlug("Fix the login bug!")).toBe("fix-the-login-bug");
    expect(worktreeSlug("../../etc")).toBe("etc");
    expect(worktreeSlug("日本語")).toBe("task");
  });

  it("creates a worktree on a new branch from the base, lists it, and makes it current", async () => {
    const { repo, manager, root } = fixture();
    const made = await manager.create({ name: "Add feature", task: "T1", owner: "claude" });
    expect(made.ok).toBe(true); if (!made.ok) return;
    expect(made.record).toMatchObject({ branch: "bot/add-feature", base: "main", status: "active", task: "T1", owner: "claude" });
    expect(made.record.path).toBe(join(root, "work", "add-feature"));
    expect(made.record.baseCommit).toBe(git(repo, "rev-parse", "main"));
    expect(git(made.record.path, "branch", "--show-current")).toBe("bot/add-feature");
    const listed = await manager.list();
    expect(listed.current).toBe(made.record.id);
    expect(listed.items[0]).toMatchObject({ changedFiles: 0, ahead: 0, missing: false });
    writeFileSync(join(made.record.path, "new.txt"), "x");
    expect((await manager.list()).items[0]!.changedFiles).toBe(1);
    expect(manager.sessionFolder()?.path).toBe(made.record.path);
    // The main checkout is untouched.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("gives a second worktree of the same name its own branch and folder", async () => {
    const { manager } = fixture();
    const one = await manager.create({ name: "same" }), two = await manager.create({ name: "same" });
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) expect([two.record.branch, one.record.path === two.record.path]).toEqual(["bot/same-2", false]);
  });

  it("refuses folders that are not a repository, a repository with no commits, and unknown bases", async () => {
    const { root, manager } = fixture();
    const none = join(root, "plain"); mkdirSync(none);
    expect(await new WorktreeManager({ folder: none, file: join(root, "n.json"), root: () => join(root, "w") }).create({ name: "x" })).toMatchObject({ ok: false, code: "not-a-repo" });
    const empty = join(root, "empty"); mkdirSync(empty); git(empty, "init", "-b", "main");
    expect(await new WorktreeManager({ folder: empty, file: join(root, "e.json"), root: () => join(root, "w") }).create({ name: "x" })).toMatchObject({ ok: false, code: "no-commits" });
    expect(await manager.create({ name: "x", base: "nope" })).toMatchObject({ ok: false, code: "unknown" });
  });

  it("merges committed work into the base, removes the worktree and branch, and keeps a merged record", async () => {
    const { repo, manager } = fixture();
    const made = await manager.create({ name: "feat" }); if (!made.ok) throw new Error("create");
    commit(made.record.path, "feat.txt", "feat\n");
    const merged = await manager.merge(made.record.id);
    expect(merged).toEqual({ ok: true, merged: 1 });
    expect(readFileSync(join(repo, "feat.txt"), "utf8")).toBe("feat\n");
    expect(existsSync(made.record.path)).toBe(false);
    expect(git(repo, "branch", "--list", "bot/feat")).toBe("");
    const listed = await manager.list();
    expect(listed.items[0]).toMatchObject({ status: "merged" });
    expect(listed.current).toBeNull();
    expect(manager.sessionFolder()).toBeNull();
  });

  it("merges after the base moved on by merging the base into the branch first", async () => {
    const { repo, manager } = fixture();
    const made = await manager.create({ name: "feat" }); if (!made.ok) throw new Error("create");
    commit(made.record.path, "feat.txt", "feat\n");
    commit(repo, "other.txt", "other\n");
    expect(await manager.merge(made.record.id)).toMatchObject({ ok: true });
    expect(existsSync(join(repo, "feat.txt")) && existsSync(join(repo, "other.txt"))).toBe(true);
  });

  it("will not merge an uncommitted worktree, a dirty or moved base, or an empty branch, and changes nothing", async () => {
    const { repo, manager } = fixture();
    const made = await manager.create({ name: "feat" }); if (!made.ok) throw new Error("create");
    expect(await manager.merge(made.record.id)).toMatchObject({ ok: false, code: "nothing" });
    commit(made.record.path, "feat.txt", "feat\n");
    writeFileSync(join(made.record.path, "wip.txt"), "wip");
    expect(await manager.merge(made.record.id)).toMatchObject({ ok: false, code: "dirty" });
    rmSync(join(made.record.path, "wip.txt"));
    writeFileSync(join(repo, "someone-else.txt"), "theirs");
    expect(await manager.merge(made.record.id)).toMatchObject({ ok: false, code: "base-dirty" });
    expect(readFileSync(join(repo, "someone-else.txt"), "utf8")).toBe("theirs");
    rmSync(join(repo, "someone-else.txt"));
    git(repo, "checkout", "-b", "elsewhere");
    expect(await manager.merge(made.record.id)).toMatchObject({ ok: false, code: "base-moved" });
    git(repo, "checkout", "main");
    expect(existsSync(join(repo, "feat.txt"))).toBe(false);
    expect(existsSync(made.record.path)).toBe(true);
  });

  it("reports a merge conflict with the files, aborts it, and leaves both sides as they were", async () => {
    const { repo, manager } = fixture();
    const made = await manager.create({ name: "feat" }); if (!made.ok) throw new Error("create");
    commit(made.record.path, "a.txt", "from branch\n");
    commit(repo, "a.txt", "from base\n");
    const head = git(made.record.path, "rev-parse", "HEAD"), baseHead = git(repo, "rev-parse", "HEAD");
    const result = await manager.merge(made.record.id);
    expect(result).toMatchObject({ ok: false, code: "conflict", files: ["a.txt"] });
    expect(git(made.record.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(made.record.path, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(baseHead);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("from base\n");
    expect((await manager.list()).items[0]!.status).toBe("active");
  });

  it("discards a clean worktree, but asks first when it has uncommitted changes or unmerged commits", async () => {
    const { repo, manager } = fixture();
    const clean = await manager.create({ name: "clean" }); if (!clean.ok) throw new Error("create");
    expect(await manager.discard(clean.record.id)).toMatchObject({ ok: true });
    expect(existsSync(clean.record.path)).toBe(false);
    expect(git(repo, "branch", "--list", "bot/clean")).toBe("");

    const dirty = await manager.create({ name: "dirty" }); if (!dirty.ok) throw new Error("create");
    writeFileSync(join(dirty.record.path, "wip.txt"), "wip");
    expect(await manager.discard(dirty.record.id)).toMatchObject({ ok: false, code: "dirty" });
    expect(existsSync(join(dirty.record.path, "wip.txt"))).toBe(true);
    commit(dirty.record.path, "c.txt", "c");
    writeFileSync(join(dirty.record.path, "more.txt"), "more");
    expect(await manager.discard(dirty.record.id)).toMatchObject({ ok: false, code: "dirty" });
    expect(await manager.discard(dirty.record.id, true)).toEqual({ ok: true, lost: { files: 1, commits: 1 } });
    expect(existsSync(dirty.record.path)).toBe(false);
    expect(git(repo, "branch", "--list", "bot/dirty")).toBe("");

    const ahead = await manager.create({ name: "ahead" }); if (!ahead.ok) throw new Error("create");
    commit(ahead.record.path, "d.txt", "d");
    expect(await manager.discard(ahead.record.id)).toMatchObject({ ok: false, code: "unmerged" });
    expect(existsSync(ahead.record.path)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("clears the record of a worktree whose folder was deleted, and drops it as the session folder", async () => {
    const { manager } = fixture();
    const made = await manager.create({ name: "gone" }); if (!made.ok) throw new Error("create");
    rmSync(made.record.path, { recursive: true, force: true });
    expect((await manager.list()).items[0]).toMatchObject({ missing: true });
    expect(manager.sessionFolder()).toBeNull();
    expect(await manager.merge(made.record.id)).toMatchObject({ ok: false, code: "missing" });
    expect(await manager.discard(made.record.id)).toMatchObject({ ok: true });
    expect((await manager.list()).items[0]!.status).toBe("abandoned");
  });

  it("selects the session folder: the current worktree, or none after setCurrent(null)", async () => {
    const { repo, manager } = fixture();
    const one = await manager.create({ name: "one" }), two = await manager.create({ name: "two" });
    if (!one.ok || !two.ok) throw new Error("create");
    expect(manager.sessionFolder()?.path).toBe(one.record.path);
    expect(await manager.setCurrent(two.record.id)).toEqual({ ok: true });
    expect(manager.sessionFolder()?.record.id).toBe(two.record.id);
    expect(await manager.setCurrent("nope")).toMatchObject({ ok: false });
    await manager.setCurrent(null);
    expect(manager.sessionFolder()).toBeNull();
    expect(repo).toBeTruthy();
  });

  it("does not treat a linked worktree as a main checkout", async () => {
    const { root, manager } = fixture();
    const made = await manager.create({ name: "one" }); if (!made.ok) throw new Error("create");
    const inside = new WorktreeManager({ folder: made.record.path, file: join(root, "x.json"), root: () => join(root, "w") });
    expect(await inside.create({ name: "nested" })).toMatchObject({ ok: false, code: "not-a-repo" });
  });
});
