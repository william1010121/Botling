// The machine's side of the project files (multi-machine phase 1): the app sends a base commit as a git bundle, the
// worker works on a branch in a worktree here, and the app takes the branch back as a bundle when the run ends.
//   <home>/repos/<project>.git     a bare repository per project: refs/botling/base is the latest base sent
//   <home>/work/<worker>           the worker's worktree, on its branch
// The base the app sends is a "snapshot" commit (the tree of the app's base commit, its parent the previous snapshot),
// so the machine needs no history and later sends are small. The app maps the branch back onto its real base.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLink } from "./server";

const NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^bot\/[A-Za-z0-9][A-Za-z0-9_./-]{0,120}$/;
const REF = /^refs\/botling\/[A-Za-z0-9][A-Za-z0-9_./-]{0,160}$/;

export function git(cwd: string | null, args: string[], input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: cwd ?? undefined, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim().slice(0, 1_000)}`));
      else resolve(stdout.trim());
    });
    if (input) child.stdin?.end(input);
  });
}

const need = (value: unknown, pattern: RegExp, what: string): string => {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) throw new Error(`Bad ${what}.`);
  return value;
};

export function gitRpc(home: string) {
  const repoOf = (project: string) => join(home, "repos", `${project}.git`);
  const workOf = (worker: string) => join(home, "work", worker);
  const ensureRepo = async (project: string) => {
    const repo = repoOf(project);
    if (!existsSync(join(repo, "HEAD"))) {
      mkdirSync(repo, { recursive: true, mode: 0o700 });
      await git(repo, ["init", "--bare", "-q"]);
    }
    // Commits a worker makes need a name even on a machine with no git identity.
    for (const [key, value] of [["user.name", "Botling worker"], ["user.email", "worker@botling.invalid"]] as const) {
      try { await git(repo, ["config", key]); } catch { await git(repo, ["config", key, value]); }
    }
    return repo;
  };

  return async (op: string, args: Record<string, unknown>, link: AgentLink): Promise<unknown> => {
    switch (op) {
      case "gitBase": {
        const repo = repoOf(need(args.project, NAME, "project"));
        if (!existsSync(join(repo, "HEAD"))) return { base: null };
        try { return { base: await git(repo, ["rev-parse", "--verify", "-q", "refs/botling/base^{commit}"]) }; } catch { return { base: null }; }
      }
      case "gitReceive": {
        const project = need(args.project, NAME, "project");
        const ref = args.ref === undefined ? "refs/botling/base" : need(args.ref, REF, "ref");
        const data = await link.takeBlob(String(args.blob ?? ""));
        const repo = await ensureRepo(project);
        const dir = mkdtempSync(join(tmpdir(), "botling-bundle-"));
        try {
          const file = join(dir, "base.bundle");
          writeFileSync(file, data);
          await git(repo, ["bundle", "verify", "-q", file]);
          await git(repo, ["fetch", "-q", file, `+${ref}:refs/botling/base`]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
        return { base: await git(repo, ["rev-parse", "refs/botling/base^{commit}"]) };
      }
      case "worktree": {
        const project = need(args.project, NAME, "project"), worker = need(args.worker, NAME, "worker");
        const base = need(args.base, SHA, "base"), branch = need(args.branch, BRANCH, "branch");
        const repo = await ensureRepo(project);
        const cwd = workOf(worker);
        if (existsSync(join(cwd, ".git"))) return { cwd, created: false };
        mkdirSync(join(home, "work"), { recursive: true, mode: 0o700 });
        let exists = true;
        try { await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]); } catch { exists = false; }
        await git(repo, exists ? ["worktree", "add", "-q", cwd, branch] : ["worktree", "add", "-q", "-b", branch, cwd, base]);
        return { cwd, created: true };
      }
      case "gitSend": {
        const worker = need(args.worker, NAME, "worker"), base = need(args.base, SHA, "base");
        const cwd = workOf(worker);
        if (!existsSync(join(cwd, ".git"))) throw new Error("This worker has no folder on the machine.");
        // Work the worker left uncommitted goes onto its branch too, so nothing stays behind on the machine.
        if (await git(cwd, ["status", "--porcelain"])) {
          await git(cwd, ["add", "-A"]);
          await git(cwd, ["commit", "-q", "--no-verify", "-m", typeof args.message === "string" && args.message.trim() ? args.message.slice(0, 200) : "Worker's uncommitted changes"]);
        }
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        const branch = await git(cwd, ["symbolic-ref", "-q", "HEAD"]);
        if (head === base) return { head, commits: 0, blob: null };
        const commits = Number(await git(cwd, ["rev-list", "--count", `${base}..${head}`]));
        const dir = mkdtempSync(join(tmpdir(), "botling-bundle-"));
        try {
          const file = join(dir, "work.bundle");
          await git(cwd, ["bundle", "create", "-q", file, branch, `^${base}`]);
          const blob = link.sendBlob(readFileSync(file));
          return { head, commits, branch, blob };
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
      case "cleanup": {
        const worker = need(args.worker, NAME, "worker"), project = need(args.project, NAME, "project");
        const cwd = workOf(worker);
        const repo = repoOf(project);
        if (existsSync(cwd)) { try { await git(repo, ["worktree", "remove", "--force", cwd]); } catch { rmSync(cwd, { recursive: true, force: true }); } }
        try { await git(repo, ["worktree", "prune"]); } catch { /* nothing to prune */ }
        if (typeof args.branch === "string" && BRANCH.test(args.branch)) { try { await git(repo, ["branch", "-D", "-q", args.branch]); } catch { /* gone */ } }
        return { removed: true };
      }
      default:
        throw new Error(`Unknown request ${op}.`);
    }
  };
}
