// Commit and pull request for a worktree (Botling 2.2, part 2): "Commit" stages everything in the worktree and
// commits it; "Open PR" pushes the branch and runs `gh pr create`. Only ever run in an app-made worktree,
// never in the project's main checkout. Every refusal says what happened and what to do, in a sentence
// that can be shown as it is: no `gh`, not signed in, no remote, nothing to open a PR for.
import { execFile } from "node:child_process";

export type PublishFailure = "empty" | "nothing" | "dirty" | "no-remote" | "no-gh" | "push" | "pr" | "git";
export type PublishResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: PublishFailure; message: string };

interface Ran { code: number; out: string; err: string; missing: boolean }

function run(command: string, args: string[], cwd: string, timeout = 120_000): Promise<Ran> {
  return new Promise((done) => {
    execFile(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (error, stdout, stderr) => {
      const failure = error as { code?: number | string } | null;
      const code = !failure ? 0 : typeof failure.code === "number" ? failure.code : 1;
      done({ code, out: String(stdout).trimEnd(), err: String(stderr).trimEnd(), missing: failure?.code === "ENOENT" });
    });
  });
}
const git = (cwd: string, args: string[]) => run("git", ["-c", "core.quotepath=off", ...args], cwd);
const said = (ran: Ran) => (ran.err || ran.out || "no message").split("\n").slice(-6).join("\n").trim();

/** What a PR for this branch would say, from its commits: one commit's subject, else the branch's name. */
export async function prefill(cwd: string, branch: string, base: string): Promise<{ title: string; body: string; commits: number }> {
  const log = await git(cwd, ["log", "--reverse", "--format=%s%x1f%b%x1e", `${base}..HEAD`]);
  const entries = log.out.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [subject, ...rest] = entry.split("\x1f");
    return { subject: subject.trim(), body: rest.join("").trim() };
  });
  const title = entries.length === 1 ? entries[0].subject : branch.replace(/^bot\//, "").replace(/-+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const lines = entries.slice(0, 30).map((entry) => `- ${entry.subject}`);
  const body = entries.length === 1 ? entries[0].body : lines.join("\n") + (entries.length > 30 ? `\n- and ${entries.length - 30} more` : "");
  return { title, body, commits: entries.length };
}

/** Stage everything in the worktree and commit it. */
export async function commitAll(cwd: string, message: string): Promise<PublishResult<{ sha: string; files: number }>> {
  const text = message.trim();
  if (!text) return { ok: false, code: "empty", message: "Write a commit message first." };
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) return { ok: false, code: "git", message: `git could not read the worktree: ${said(status)}` };
  if (!status.out) return { ok: false, code: "nothing", message: "There is nothing to commit." };
  const files = status.out.split("\n").length;
  const added = await git(cwd, ["add", "-A"]);
  if (added.code !== 0) return { ok: false, code: "git", message: `git could not stage the files: ${said(added)}` };
  const made = await git(cwd, ["commit", "-m", text]);
  if (made.code !== 0) return { ok: false, code: "git", message: `The commit failed: ${said(made)}` };
  const sha = (await git(cwd, ["rev-parse", "--short", "HEAD"])).out;
  return { ok: true, sha, files };
}

/** The remote a branch is pushed to: origin, else the only or first one. */
export async function remoteOf(cwd: string): Promise<string | null> {
  const list = (await git(cwd, ["remote"])).out.split("\n").map((name) => name.trim()).filter(Boolean);
  return list.includes("origin") ? "origin" : list[0] ?? null;
}

export interface PrInput { branch: string; base: string; title: string; body: string; gh?: string }

/** The open PR for a branch, if `gh` knows one. */
export async function existingPr(cwd: string, branch: string, gh = "gh"): Promise<string | null> {
  const found = await run(gh, ["pr", "view", branch, "--json", "url,state", "--jq", 'select(.state=="OPEN") | .url'], cwd, 60_000);
  return found.code === 0 && /^https?:\/\//.test(found.out) ? found.out.split("\n")[0] : null;
}

/** Push the branch and open a pull request for it (or report the one already open). */
export async function openPr(cwd: string, input: PrInput): Promise<PublishResult<{ url: string; existing: boolean }>> {
  const gh = input.gh ?? "gh";
  const title = input.title.trim();
  if (!title) return { ok: false, code: "empty", message: "Write a title for the pull request." };
  const dirty = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty.code === 0 && dirty.out) {
    const n = dirty.out.split("\n").length;
    return { ok: false, code: "dirty", message: `The worktree has ${n} uncommitted file${n === 1 ? "" : "s"}. Commit them first (nothing was pushed).` };
  }
  const ahead = Number((await git(cwd, ["rev-list", "--count", `${input.base}..HEAD`])).out) || 0;
  if (!ahead) return { ok: false, code: "nothing", message: `The branch has no commits beyond ${input.base}; there is nothing to open a pull request for.` };
  const remote = await remoteOf(cwd);
  if (!remote) return { ok: false, code: "no-remote", message: "This repository has no remote, so there is nowhere to push. Add one (git remote add origin <url>) and try again." };
  const version = await run(gh, ["--version"], cwd, 20_000);
  if (version.missing) return { ok: false, code: "no-gh", message: "The GitHub CLI (gh) is not installed or not on the PATH. Install it from https://cli.github.com, run gh auth login, and try again (nothing was pushed)." };

  const open = await existingPr(cwd, input.branch, gh);
  const pushed = await git(cwd, ["push", "--set-upstream", remote, `HEAD:refs/heads/${input.branch}`]);
  if (pushed.code !== 0) return { ok: false, code: "push", message: `Pushing ${input.branch} to ${remote} failed: ${said(pushed)}` };
  if (open) return { ok: true, url: open, existing: true };

  const made = await run(gh, ["pr", "create", "--base", input.base, "--head", input.branch, "--title", title, "--body", input.body], cwd);
  if (made.code !== 0) {
    const reason = said(made);
    const auth = /auth|login|token|credential/i.test(reason) ? " Run gh auth login first." : "";
    return { ok: false, code: "pr", message: `The branch was pushed, but gh could not open the pull request: ${reason}${auth}` };
  }
  const url = made.out.split("\n").reverse().find((line) => /^https?:\/\//.test(line.trim()));
  if (!url) return { ok: false, code: "pr", message: `The branch was pushed, but gh printed no pull request link: ${said(made)}` };
  return { ok: true, url: url.trim(), existing: false };
}
