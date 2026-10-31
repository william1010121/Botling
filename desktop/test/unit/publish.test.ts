import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitAll, openPr, prefill, remoteOf } from "../../src/core/publish";
import { WorktreeDesk } from "../../src/core/worktree-desk";
import { PrCreateView, PrDraftView, WorktreesView } from "../../src/contract";
import type { BotProfile } from "../../src/core/store/workspace";

const posix = process.platform !== "win32";   // the fake gh is a shell script
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function setup(remote = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botling-publish-"))); dirs.push(dir);
  const repo = join(dir, "repo"); mkdirSync(repo);
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n"); git(repo, "add", "."); git(repo, "commit", "-m", "start");
  const bare = join(dir, "remote.git");
  if (remote) { execFileSync("git", ["init", "--bare", "-b", "main", bare]); git(repo, "remote", "add", "origin", bare); git(repo, "push", "-q", "origin", "main"); }
  git(repo, "checkout", "-q", "-b", "bot/fix-login");
  return { dir, repo, bare };
}

/** A gh that records its arguments, answers `pr view` from a file, and prints a link for `pr create`. */
function fakeGh(dir: string, behavior: { existing?: string; createFails?: string } = {}) {
  const bin = join(dir, "bin"); mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  if (behavior.existing) writeFileSync(join(bin, "existing"), behavior.existing);
  writeFileSync(gh, `#!/bin/sh
here=$(dirname "$0")
printf '%s\\n' "$*" >> "$here/log"
case "$1 $2" in
  "pr view") if [ -f "$here/existing" ]; then cat "$here/existing"; exit 0; fi; echo "no pull requests found" >&2; exit 1;;
  "pr create") ${behavior.createFails ? `echo "${behavior.createFails}" >&2; exit 1` : 'echo "Creating pull request"; echo "https://github.com/o/r/pull/7"; exit 0'};;
esac
echo "gh version 2.0.0"
`);
  chmodSync(gh, 0o755);
  return { gh, log: () => (existsSync(join(bin, "log")) ? readFileSync(join(bin, "log"), "utf8").trim().split("\n") : []) };
}

describe("commit", () => {
  it("stages everything, new files included, and commits", async () => {
    const { repo } = setup(false);
    writeFileSync(join(repo, "a.txt"), "changed\n"); writeFileSync(join(repo, "new.txt"), "n\n");
    const result = await commitAll(repo, "  Fix the login  \n\nDetails here");
    expect(result).toMatchObject({ ok: true, files: 2 });
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Fix the login");
    expect(git(repo, "log", "-1", "--format=%b")).toBe("Details here");
  });

  it("refuses an empty message, and nothing to commit", async () => {
    const { repo } = setup(false);
    expect(await commitAll(repo, "   ")).toMatchObject({ ok: false, code: "empty" });
    expect(await commitAll(repo, "msg")).toMatchObject({ ok: false, code: "nothing", message: "There is nothing to commit." });
  });

  it("reports a failing commit (a hook that refuses) with git's words, leaving the files", async () => {
    const { repo } = setup(false);
    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n"); chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    writeFileSync(join(repo, "a.txt"), "x\n");
    const result = await commitAll(repo, "msg");
    expect(result).toMatchObject({ ok: false, code: "git" });
    expect((result as any).message).toContain("lint failed");
    expect(git(repo, "status", "--porcelain")).toBe("M  a.txt");
  });
});

describe("prefill", () => {
  it("uses the subject of a single commit, else the branch name and a list of commits", async () => {
    const { repo } = setup(false);
    expect(await prefill(repo, "bot/fix-login", "main")).toEqual({ title: "Fix login", body: "", commits: 0 });
    writeFileSync(join(repo, "b"), "b"); git(repo, "add", "."); git(repo, "commit", "-m", "Add b", "-m", "Because b.");
    expect(await prefill(repo, "bot/fix-login", "main")).toEqual({ title: "Add b", body: "Because b.", commits: 1 });
    writeFileSync(join(repo, "c"), "c"); git(repo, "add", "."); git(repo, "commit", "-m", "Add c");
    expect(await prefill(repo, "bot/fix-login", "main")).toEqual({ title: "Fix login", body: "- Add b\n- Add c", commits: 2 });
  });
});

describe.skipIf(!posix)("open PR", () => {
  const commit = (repo: string) => { writeFileSync(join(repo, "f.txt"), "f\n"); git(repo, "add", "."); git(repo, "commit", "-m", "Add f"); };

  it("pushes the branch, runs gh pr create with the title and body, and returns the link", async () => {
    const { dir, repo, bare } = setup(); commit(repo);
    const fake = fakeGh(dir);
    const result = await openPr(repo, { branch: "bot/fix-login", base: "main", title: " Fix login ", body: "Body\nlines", gh: fake.gh });
    expect(result).toEqual({ ok: true, url: "https://github.com/o/r/pull/7", existing: false });
    expect(git(bare, "branch", "--list", "bot/fix-login")).toContain("bot/fix-login");
    expect(git(repo, "rev-parse", "--abbrev-ref", "bot/fix-login@{upstream}")).toBe("origin/bot/fix-login");
    const create = fake.log().find((line) => line.startsWith("pr create"))!;
    expect(create).toContain("--base main --head bot/fix-login --title Fix login --body Body");
  });

  it("reports the PR that is already open instead of making a second, still pushing new commits", async () => {
    const { dir, repo, bare } = setup(); commit(repo);
    const fake = fakeGh(dir, { existing: "https://github.com/o/r/pull/3" });
    const result = await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh: fake.gh });
    expect(result).toEqual({ ok: true, url: "https://github.com/o/r/pull/3", existing: true });
    expect(fake.log().some((line) => line.startsWith("pr create"))).toBe(false);
    expect(git(bare, "rev-parse", "bot/fix-login")).toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("says so when gh is not installed, and pushes nothing", async () => {
    const { dir, repo, bare } = setup(); commit(repo);
    const result = await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh: join(dir, "no-such-gh") });
    expect(result).toMatchObject({ ok: false, code: "no-gh" });
    expect((result as any).message).toContain("GitHub CLI (gh) is not installed");
    expect(git(bare, "branch", "--list", "bot/fix-login")).toBe("");
  });

  it("says so when there is no remote", async () => {
    const { dir, repo } = setup(false); commit(repo);
    expect(await remoteOf(repo)).toBeNull();
    const result = await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh: fakeGh(dir).gh });
    expect(result).toMatchObject({ ok: false, code: "no-remote" });
    expect((result as any).message).toContain("no remote");
  });

  it("refuses uncommitted changes, no commits, and an empty title", async () => {
    const { dir, repo } = setup();
    const { gh } = fakeGh(dir);
    expect(await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh })).toMatchObject({ ok: false, code: "nothing" });
    commit(repo); writeFileSync(join(repo, "wip"), "w");
    expect(await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh })).toMatchObject({ ok: false, code: "dirty" });
    expect(await openPr(repo, { branch: "bot/fix-login", base: "main", title: "  ", body: "", gh })).toMatchObject({ ok: false, code: "empty" });
  });

  it("explains a gh failure after the push, with the sign-in hint when it is about auth", async () => {
    const { dir, repo } = setup(); commit(repo);
    const result = await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh: fakeGh(dir, { createFails: "gh: To use GitHub CLI, run: gh auth login" }).gh });
    expect(result).toMatchObject({ ok: false, code: "pr" });
    expect((result as any).message).toContain("The branch was pushed");
    expect((result as any).message).toContain("gh auth login");
  });

  it("reports a failed push in git's words", async () => {
    const { dir, repo, bare } = setup(); commit(repo);
    rmSync(bare, { recursive: true, force: true });
    const result = await openPr(repo, { branch: "bot/fix-login", base: "main", title: "t", body: "", gh: fakeGh(dir).gh });
    expect(result).toMatchObject({ ok: false, code: "push" });
  });
});

describe.skipIf(!posix)("worktree desk commit and PR", () => {
  function deskSetup(options: { existing?: string } = {}) {
    const { dir, repo, bare } = setup();
    git(repo, "checkout", "-q", "main"); git(repo, "branch", "-D", "bot/fix-login");
    const fake = fakeGh(dir, options);
    const profile: BotProfile = { id: "ID1", name: "P", role: "manager", avatar: "hexagon", folder: repo, memoryPath: ".bot/memory.md", storeDir: join(dir, "store"), tools: [], job: null, problem: null };
    const desk = new WorktreeDesk({ dataDir: join(dir, "data"), settings: () => ({ enabled: true, root: join(dir, "wt") }), devWork: () => null, isDeveloper: () => false, moved: () => {}, gh: fake.gh });
    return { dir, repo, bare, profile, desk, fake };
  }

  it("commits in the worktree, pre-fills the form, opens the PR, and shows the link on the worktree", async () => {
    const { repo, bare, profile, desk, fake } = deskSetup();
    expect((await desk.create(profile, "Fix login")).ok).toBe(true);
    const wt = (await desk.view(profile)).items[0];
    writeFileSync(join(wt.path, "login.ts"), "x\n");
    expect(await desk.commit(profile, wt.id, "")).toMatchObject({ ok: false });
    expect(await desk.commit(profile, wt.id, "Fix the login")).toEqual({ ok: true, message: expect.stringMatching(/^Committed 1 file as [0-9a-f]+\.$/) });
    expect(git(wt.path, "log", "-1", "--format=%s")).toBe("Fix the login");

    const draft = PrDraftView.parse(await desk.prDraft(profile, wt.id));
    expect(draft).toMatchObject({ ok: true, title: "Fix the login", base: "main", branch: "bot/fix-login", commits: 1, url: null });
    const made = PrCreateView.parse(await desk.prCreate(profile, wt.id, draft.title, "Why: because"));
    expect(made).toMatchObject({ ok: true, url: "https://github.com/o/r/pull/7", existing: false });
    expect(git(bare, "branch", "--list", "bot/fix-login")).toContain("bot/fix-login");
    expect(fake.log().find((l) => l.startsWith("pr create"))).toContain("--title Fix the login");

    const view = WorktreesView.parse(await desk.view(profile));
    expect(view.items[0].pr).toBe("https://github.com/o/r/pull/7");
    expect((await desk.prDraft(profile, wt.id)).url).toBe("https://github.com/o/r/pull/7");
    expect(git(repo, "status", "--porcelain")).toBe("");   // the main checkout was not touched
    expect(git(repo, "log", "-1", "--format=%s")).toBe("start");
  });

  it("refuses an unknown worktree and a dirty one, with the reason", async () => {
    const { profile, desk } = deskSetup();
    expect(await desk.commit(profile, "nope", "m")).toMatchObject({ ok: false, message: "That worktree is not there." });
    expect(await desk.prCreate(profile, "nope", "t", "")).toMatchObject({ ok: false, url: null });
    await desk.create(profile, "Dirty");
    const wt = (await desk.view(profile)).items[0];
    writeFileSync(join(wt.path, "wip"), "w");
    expect(await desk.prCreate(profile, wt.id, "t", "")).toMatchObject({ ok: false, message: expect.stringContaining("uncommitted") });
    expect(await desk.commit(profile, wt.id, "wip")).toMatchObject({ ok: true });
    expect(await desk.prCreate(profile, wt.id, "t", "")).toMatchObject({ ok: true });
  });
});
