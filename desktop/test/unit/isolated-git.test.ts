import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveIsolatedGit, isolatedGitOwnership, type IsolatedGitOwnership } from "../../src/core/agent/isolated-git";
import { CodexSession, type CodexOutput } from "../../src/core/agent/codex";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture() {
  const root = mkdtempSync("/private/tmp/botling-2x-git-test-"); dirs.push(root);
  const repo = join(root, "repo"); mkdirSync(repo); git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "own.txt"), "base\n"); writeFileSync(join(repo, "other.txt"), "base\n");
  git(repo, "add", "."); git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "base");
  const ownership: IsolatedGitOwnership = { implementationAuthorized: true, repo, worktree: `${root}-worker`, branch: "bot/test", baseCommit: git(repo, "rev-parse", "HEAD"), files: ["own.txt", "new file.txt"] };
  dirs.push(ownership.worktree);
  const create = `git worktree add -b ${ownership.branch} ${ownership.worktree} ${ownership.baseCommit}`;
  const approve = (command: string, cwd = repo) => approveIsolatedGit(ownership, repo, { command, cwd });
  const checkout = () => { git(repo, "worktree", "add", "-b", ownership.branch, ownership.worktree, ownership.baseCommit); };
  return { repo, ownership, approve, checkout, create, root };
}

// The gate's allowed destinations are macOS paths (/private/tmp/...), so these only make sense there.
const onMac = describe.skipIf(process.platform !== "darwin");
onMac("isolated worker Git approval", () => {
  it("validates ownership and runs the approved creation, staging and commit in a real isolated repository", () => {
    const f = fixture(), w = f.ownership.worktree;
    expect(isolatedGitOwnership(f.ownership, f.repo)).toEqual(f.ownership);
    expect(f.approve(f.create)).toBe(true); f.checkout(); expect(f.approve(f.create)).toBe(false);
    writeFileSync(join(w, "own.txt"), "changed\n"); writeFileSync(join(w, "new file.txt"), "new\n");
    expect(f.approve(`git -C ${w} add -- own.txt 'new file.txt'`)).toBe(true);
    git(w, "add", "--", "own.txt", "new file.txt");
    expect(f.approve("/bin/zsh -lc 'git commit -m \"Owned change\"'", w)).toBe(true);
    git(w, "commit", "-m", "Owned change");
    expect(git(w, "show", "--format=", "--name-only").split("\n")).toEqual(["new file.txt", "own.txt"]);
    expect(readFileSync(join(f.repo, "own.txt"), "utf8")).toBe("base\n");
  });
  it("refuses missing/research ownership, unauthorized repos, duplicate claims, main and invalid base", () => {
    const f = fixture();
    for (const value of [undefined, {}, { ...f.ownership, implementationAuthorized: false }, { ...f.ownership, repo: f.root }, { ...f.ownership, baseCommit: "f".repeat(40) }, { ...f.ownership, files: ["."] }, { ...f.ownership, files: ["../other"] }, { ...f.ownership, branch: "main" }]) {
      expect(isolatedGitOwnership(value, f.repo)).toBeUndefined();
      expect(approveIsolatedGit(value, f.repo, { command: f.create, cwd: f.repo })).toBe(false);
    }
    expect(isolatedGitOwnership(f.ownership, f.repo, [f.ownership])).toBeUndefined(); expect(f.approve(f.create, f.root)).toBe(false);
  });
  it("requires a new canonical destination, no symlink and new branch", () => {
    const f = fixture();
    for (const path of ["/tmp/botling-2x-escape", "/private/tmp/elsewhere", `${f.ownership.worktree}/../escape`, `${f.ownership.worktree}/nested`, "/Volumes/My-SSD/botling-work/../escape"]) expect(isolatedGitOwnership({ ...f.ownership, worktree: path }, f.repo)).toBeUndefined();
    symlinkSync(f.root, f.ownership.worktree); expect(isolatedGitOwnership(f.ownership, f.repo)).toBeUndefined();
    unlinkSync(f.ownership.worktree); git(f.repo, "branch", f.ownership.branch); expect(isolatedGitOwnership(f.ownership, f.repo)).toBeUndefined();
  });
  it.each([
    "git push", "git merge main", "git branch -D bot/test", "git checkout main", "git add .", "git add -A", "git add --all", "git add -- ../own.txt", "git add -- /private/tmp/file", "git add -- other.txt", "git add -- ':!other.txt'", "git add -- '*.txt'", "git -c alias.x=push x", "git --git-dir=/tmp/evil add own.txt", "git commit -am all", "git commit --amend -m change", "git commit --no-verify -m change", "git commit -m change -- own.txt", "git commit -m change && touch /tmp/evil", "git add own.txt; git push", "git add own.txt\ngit push", "git add own.txt | cat", "git add $(touch /tmp/evil)", "git add `touch /tmp/evil`", "git add own.txt > /tmp/evil", "GIT_INDEX_FILE=/tmp/evil git add own.txt", "env git add own.txt", "cd /tmp && git add own.txt", "git add -- own.txt\\;touch", "git add -- ",
  ])("falls back for unsafe/unowned command: %s", (command) => { const f = fixture(); f.checkout(); expect(f.approve(command, f.ownership.worktree)).toBe(false); });
  it("refuses shared/main/detached checkout operations", () => {
    const f = fixture(); f.checkout(); writeFileSync(join(f.repo, "own.txt"), "shared\n"); git(f.repo, "add", "own.txt");
    expect(f.approve("git add own.txt")).toBe(false); expect(f.approve("git commit -m shared")).toBe(false);
    git(f.ownership.worktree, "checkout", "--detach"); expect(f.approve("git add own.txt", f.ownership.worktree)).toBe(false);
  });
  it("refuses preexisting unowned index for both add/commit; permits add after clearing it", () => {
    const f = fixture(); f.checkout(); const w = f.ownership.worktree;
    writeFileSync(join(w, "other.txt"), "someone else's work\n"); git(w, "add", "other.txt");
    expect(f.approve("git add own.txt", w)).toBe(false); expect(f.approve("git commit -m owned", w)).toBe(false);
    git(w, "reset", "--", "other.txt"); expect(f.approve("git add own.txt", w)).toBe(true); expect(f.approve("git commit -m empty", w)).toBe(false);
  });
  it("refuses symlink files/directories, directories and unsafe worktree permissions", () => {
    const f = fixture(); f.checkout(); const w = f.ownership.worktree;
    rmSync(join(w, "own.txt")); symlinkSync(join(f.repo, "own.txt"), join(w, "own.txt")); expect(f.approve("git add own.txt", w)).toBe(false);
    unlinkSync(join(w, "own.txt")); mkdirSync(join(w, "own.txt")); expect(f.approve("git add own.txt", w)).toBe(false);
    f.ownership.files.push("link/other.txt"); symlinkSync(f.repo, join(w, "link")); expect(f.approve("git add link/other.txt", w)).toBe(false);
    chmodSync(w, 0o777); expect(f.approve("git add 'new file.txt'", w)).toBe(false);
  });
  it("refuses a foreign repository masquerading at the assigned destination", () => {
    const f = fixture(); mkdirSync(f.ownership.worktree); git(f.ownership.worktree, "init", "-b", f.ownership.branch);
    expect(f.approve("git add own.txt", f.ownership.worktree)).toBe(false);
  });
  it("refuses main in the assigned worktree and unauthorized rename destinations", () => {
    const f = fixture(); f.checkout(); const w = f.ownership.worktree;
    git(w, "checkout", "--ignore-other-worktrees", "main"); expect(f.approve("git add own.txt", w)).toBe(false);
    git(w, "checkout", f.ownership.branch); git(w, "mv", "own.txt", "unowned.txt"); expect(f.approve("git commit -m rename", w)).toBe(false);
  });
  it("refuses active clean filters and staged symlinks even after the working file is removed", () => {
    const f = fixture(); f.checkout(); const w = f.ownership.worktree;
    writeFileSync(join(w, ".gitattributes"), "own.txt filter=evil\n"); expect(f.approve("git add own.txt", w)).toBe(false); rmSync(join(w, ".gitattributes"));
    rmSync(join(w, "own.txt")); symlinkSync("/private/tmp/outside", join(w, "own.txt")); git(w, "add", "own.txt"); unlinkSync(join(w, "own.txt")); expect(f.approve("git commit -m symlink", w)).toBe(false);
  });
  it("refuses an index symlink into the shared checkout and a branch ref symlink", () => {
    const f = fixture(); f.checkout(); const w = f.ownership.worktree;
    const index = git(w, "rev-parse", "--git-path", "index");
    const bytes = readFileSync(index); unlinkSync(index); symlinkSync(join(f.repo, ".git/index"), index);
    expect(f.approve("git add own.txt", w)).toBe(false); unlinkSync(index); writeFileSync(index, bytes);
    const ref = join(f.repo, ".git/refs/heads", f.ownership.branch); unlinkSync(ref); symlinkSync(join(f.repo, ".git/refs/heads/main"), ref);
    expect(f.approve("git add own.txt", w)).toBe(false);
  });
  it("refuses executable Git hooks/config and index environment overrides", () => {
    const f = fixture(), hook = join(f.repo, ".git/hooks/post-checkout"); writeFileSync(hook, "#!/bin/sh\nexit 0\n"); chmodSync(hook, 0o755);
    expect(f.approve(f.create)).toBe(false); rmSync(hook);
    git(f.repo, "config", "filter.evil.clean", "touch /tmp/evil");
    // Unused global filters (e.g. Git LFS) do not grant execution and need not block plain files.
    expect(f.approve(f.create)).toBe(true);
    writeFileSync(join(f.repo, ".git/info/attributes"), "*.txt filter=evil\n"); expect(f.approve(f.create)).toBe(false);
    rmSync(join(f.repo, ".git/info/attributes")); git(f.repo, "config", "--unset", "filter.evil.clean");
    const old = process.env.GIT_INDEX_FILE;
    try { process.env.GIT_INDEX_FILE = "/tmp/foreign-index"; expect(f.approve(f.create)).toBe(false); }
    finally { if (old === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = old; }
  });
});
function writes(out: CodexOutput[]) { return out.filter((o) => o.kind === "write").map((o) => o.value as any); }
function items(out: CodexOutput[]) { return out.filter((o) => o.kind === "item").map((o) => o.item); }
function sessionFixture(ownershipEnabled = true, f = fixture(), bypassPermissions = true) {
  const s = new CodexSession({ cwd: f.repo, instructions: "Coordinator", workerInstructions: "Worker", resumeThread: null, model: null, workerModel: null, effort: null, restoredWorkers: [], bypassPermissions });
  s.start(); s.receive(JSON.stringify({ id: 1, result: {} })); s.receive(JSON.stringify({ id: 2, result: { thread: { id: "coordinator" } } }));
  const call = (id: string, tool: string, args: any) => s.receive(JSON.stringify({ id, method: "item/tool/call", params: { threadId: "coordinator", tool, arguments: args } }));
  const handed = call("handoff", "app_handoff", { instructions: "Implementation: own files", ...(ownershipEnabled ? { isolated_git: f.ownership } : {}) });
  const receipt = JSON.parse(writes(handed)[0].result.contentItems[0].text), start = writes(handed).find((v) => v.method === "thread/start");
  const turn = writes(s.receive(JSON.stringify({ id: start.id, result: { thread: { id: "worker" } } }))).find((v) => v.method === "turn/start");
  s.receive(JSON.stringify({ id: turn.id, result: { turn: { id: "worker-turn" } } }));
  let request = 0;
  const ask = (command: string, fields: any = {}) => {
    const rpcId = ++request === 1 ? "approval" : `approval-${request}`;
    return s.receive(JSON.stringify({ id: rpcId, method: "item/commandExecution/requestApproval", params: { command, cwd: f.repo, environmentId: "local", threadId: "worker", turnId: "worker-turn", ...fields } }));
  };
  return { ...f, s, ask, call, receipt };
}
onMac("Codex single-request app approval path", () => {
  it("model-supplied implementation authorization does not bypass auto/manual permission mode", () => {
    const f = sessionFixture(true, fixture(), false);
    expect(f.receipt.isolated_git_approval).toBe("manual");
    const out = f.ask(f.create);
    expect(writes(out).some(value => value.result?.decision === "accept")).toBe(false);
    expect(items(out).some(item => item.kind === "permission")).toBe(true);
  });

  it("auto-accepts only its live owning worker; persists ownership; others show manual cards", () => {
    const f = sessionFixture(); expect(f.receipt.isolated_git_approval).toBe("validated");
    expect(writes(f.ask(f.create))).toEqual([{ jsonrpc: "2.0", id: "approval", result: { decision: "accept" } }]);
    expect(f.s.workerRecords[0].isolatedGit).toEqual(f.ownership);
    f.checkout(); const w = f.ownership.worktree;
    writeFileSync(join(w, "own.txt"), "changed\n");
    expect(writes(f.ask(`git -C ${w} add -- own.txt`))[0].result).toEqual({ decision: "accept" });
    git(w, "add", "own.txt");
    expect(writes(f.ask("git commit -m owned", { cwd: w }))[0].result).toEqual({ decision: "accept" });
    git(w, "commit", "-m", "owned");
    for (const fields of [{ threadId: "coordinator" }, { threadId: "unknown" }, { environmentId: "remote" }, { environmentId: null }, { availableDecisions: ["cancel"] }, { networkApprovalContext: {} }, { turnId: "stale" }, { turnId: null }, { cwd: "/private/tmp" }]) {
      // Lifecycle handling may decline stale owners instead of emitting a manual card.
      const out = f.ask(f.create, fields);
      expect(writes(out).some((value) => value.result?.decision === "accept")).toBe(false);
      expect(items(out).some((item) => item.kind === "permission") || writes(out).some((value) => value.result?.decision === "decline")).toBe(true);
    }
    const manual = items(f.ask("git push")).find((item) => item.kind === "permission");
    expect(manual).toMatchObject({ kind: "permission", tool: "Bash" });
    if (!manual || manual.kind !== "permission") throw new Error("Missing manual permission card");
    expect(writes(f.s.answer(manual.requestId, true))[0].result).toEqual({ decision: "accept" });
  });
  it("auto-accepts only command approvals, never stdin sent to a running process", () => {
    const f = sessionFixture(); f.checkout(); const w = f.ownership.worktree; writeFileSync(join(w, "own.txt"), "changed\n");
    const add = `/bin/zsh -lc 'git -C ${w} add -- own.txt'`;
    for (const kind of ["writeStdin", "unknown", null]) {
      const out = f.ask(add, { kind });
      expect(writes(out).some((value) => value.result?.decision === "accept")).toBe(false);
      expect(items(out)).toMatchObject([{ kind: "permission", tool: "Bash" }]);
    }
    expect(writes(f.ask(add, { kind: "command" }))[0].result).toEqual({ decision: "accept" });
  });
  it("keeps legacy grants manual and refuses automatic approval after stop", () => {
    const f = sessionFixture(false); expect(f.receipt.isolated_git_approval).toBe("manual");
    expect(items(f.ask(f.create))).toMatchObject([{ kind: "permission", tool: "Bash" }]);
    const g = sessionFixture(); g.s.stop(); expect(writes(g.ask(g.create)).some((value) => value.result?.decision === "accept")).toBe(false);
  });
  it("does not grant another bot session the same worker destination", () => {
    const f = sessionFixture(); const other = sessionFixture(true, f);
    expect(f.receipt.isolated_git_approval).toBe("validated"); expect(other.receipt.isolated_git_approval).toBe("manual");
    f.checkout(); expect(items(other.ask(`git -C ${f.ownership.worktree} add -- own.txt`))).toMatchObject([{ kind: "permission", tool: "Bash" }]);
  });
  it("revokes approval ownership on follow-up", () => {
    const f = sessionFixture(); f.call("steer", "app_send_message", { task_id: f.receipt.task_id, message: "Research only now" });
    expect(items(f.ask(f.create))).toMatchObject([{ kind: "permission", tool: "Bash" }]); expect(f.s.workerRecords[0].isolatedGit).toBeUndefined();
  });
});
