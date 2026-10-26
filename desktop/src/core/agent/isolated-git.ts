// A deliberately small gate for commandExecution/requestApproval. This never executes the
// requested mutation, grants a command prefix, or changes Codex's sandbox/settings.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface IsolatedGitOwnership {
  implementationAuthorized: true;
  repo: string;
  worktree: string;
  branch: string;
  baseCommit: string;
  /** Exact repository-relative files; directories and patterns are never expanded. */
  files: string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "utf8", timeout: 2000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

// Refuse symlinks in every existing component, including missing/deleted owned files.
function canonical(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Noncanonical path");
  let part = path;
  while (true) {
    try { if (lstatSync(part).isSymbolicLink()) throw new Error("Symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(part) === part) break;
    part = dirname(part);
  }
  return path;
}

function destination(path: string): boolean {
  canonical(path);
  return /^\/private\/tmp\/botling-2x-[A-Za-z0-9_-]+$/.test(path)
    || /^\/Volumes\/My-SSD\/botling-work\/[A-Za-z0-9_-]+$/.test(path);
}

function fileName(file: unknown): file is string {
  return typeof file === "string" && file.length > 0 && !isAbsolute(file)
    && !file.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
    && !/[\\\x00-\x1f\x7f:*?\[\]]/.test(file) && !file.startsWith("-");
}

function shape(value: unknown): value is IsolatedGitOwnership {
  if (!value || typeof value !== "object") return false;
  const v = value as IsolatedGitOwnership;
  return v.implementationAuthorized === true && typeof v.repo === "string" && typeof v.worktree === "string" && typeof v.branch === "string"
    && /^bot\/[A-Za-z0-9][A-Za-z0-9_/-]*$/.test(v.branch)
    && typeof v.baseCommit === "string" && /^[a-f0-9]{40}$/.test(v.baseCommit)
    && Array.isArray(v.files) && v.files.length > 0 && v.files.length <= 1000 && v.files.every(fileName)
    && new Set(v.files).size === v.files.length;
}

function repoRoot(path: string): string {
  canonical(path);
  if (realpathSync(path) !== path || git(path, "rev-parse", "--show-toplevel") !== path) throw new Error("Not repository root");
  return path;
}

function common(path: string): string {
  return realpathSync(resolve(path, git(path, "rev-parse", "--git-common-dir")));
}

function safeRepository(repo: string): void {
  // These could change which repository/index is touched or execute arbitrary programs even
  // for an otherwise plain Git command. Unknown environments/configurations require review.
  if (Object.keys(process.env).some((key) => /^GIT_/i.test(key) && key !== "GIT_PAGER")) throw new Error("Git environment override");
  const config = git(repo, "config", "--list");
  if (/^(?:core\.(?:hookspath|fsmonitor)|commit\.gpgsign|core\.sshcommand|core\.worktree)=/im.test(config.split("\n").filter((line) => line !== "core.fsmonitor=false" && line !== "commit.gpgsign=false").join("\n"))) throw new Error("Executable or redirected Git configuration");
  const hooks = join(common(repo), "hooks");
  if (existsSync(hooks) && readdirSync(hooks).some((name) => !name.endsWith(".sample") && (statSync(join(hooks, name)).mode & 0o111))) throw new Error("Executable Git hook");
}

// Inspect effective attributes (including global/system/info rules) without invoking filters.
// --source binds worktree creation to the actual base tree rather than the shared index.
function safeAttributes(repo: string, files: string[], source?: string): void {
  const output = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "check-attr",
    ...(source ? [`--source=${source}`] : []), "--all", "-z", "--stdin"], {
    cwd: repo, input: files.join("\0") + "\0", encoding: "utf8", timeout: 2000,
    maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
  }).split("\0");
  for (let i = 0; i + 2 < output.length; i += 3) {
    if (output[i + 1] === "filter" && !["unset", "unspecified"].includes(output[i + 2])) throw new Error("Active checkout/clean filter");
  }
}

/** Only the coordinator's explicit structured handoff can mint ownership, never shell text. */
export function isolatedGitOwnership(value: unknown, authorizedRepo: string, others: unknown[] = []): IsolatedGitOwnership | undefined {
  try {
    if (!shape(value) || value.repo !== repoRoot(authorizedRepo) || !destination(value.worktree)) return;
    if (others.some((other) => !shape(other) || other.worktree === value.worktree || other.branch === value.branch)) return;
    safeRepository(value.repo);
    git(value.repo, "check-ref-format", `refs/heads/${value.branch}`);
    if (git(value.repo, "rev-parse", "--verify", `${value.baseCommit}^{commit}`) !== value.baseCommit) return;
    safeAttributes(value.repo, git(value.repo, "ls-tree", "-r", "--name-only", "-z", value.baseCommit).split("\0").filter(Boolean), value.baseCommit);
    if (existsSync(value.worktree) || git(value.repo, "for-each-ref", "--format=%(refname)", `refs/heads/${value.branch}`)) return;
    // The existing parent must be canonical, owned by this app's OS user, and not writable
    // by another user (the sticky system /private/tmp is the one permitted exception).
    const parent = statSync(dirname(value.worktree));
    if (dirname(value.worktree) !== "/private/tmp" && (parent.uid !== process.getuid?.() || (parent.mode & 0o022))) return;
    return { ...value, files: [...value.files] };
  } catch { return; }
}

// Shell grammar is intentionally conservative: quotes for spaces, no expansions/operators,
// redirection, environment assignments, newlines, globbing or concatenated commands.
function words(text: string): string[] | undefined {
  if (!text || /[\x00-\x1f\x7f$`;&|<>!*?\[\]{}~()^=#%]/.test(text)) return;
  const out: string[] = [];
  let word = "", quote = "", started = false;
  for (const char of text) {
    if (char === "\\") return;
    if (quote) { if (char === quote) quote = ""; else word += char; started = true; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === " ") { if (started) out.push(word); word = ""; started = false; }
    else { word += char; started = true; }
  }
  if (quote) return;
  if (started) out.push(word);
  return out;
}

export function approveIsolatedGit(value: unknown, authorizedRepo: string, request: { command?: unknown; cwd?: unknown }): boolean {
  try {
    if (!shape(value) || value.repo !== repoRoot(authorizedRepo) || !destination(value.worktree)) return false;
    if (typeof request.command !== "string" || typeof request.cwd !== "string") return false;
    let args = words(request.command);
    if (args?.length === 3 && ["/bin/sh", "/bin/bash", "/bin/zsh"].includes(args[0]) && ["-c", "-lc"].includes(args[1])) args = words(args[2]);
    if (!args || args.shift() !== "git") return false;
    let cwd = canonical(request.cwd);
    if (args[0] === "-C" && args[1]) { cwd = canonical(args[1]); args = args.slice(2); }
    if (cwd !== value.repo && cwd !== value.worktree) return false;
    safeRepository(value.repo);
    if (args[0] === "worktree") {
      if (args.length !== 6 || args[1] !== "add" || args[2] !== "-b" || args[3] !== value.branch || args[4] !== value.worktree || args[5] !== value.baseCommit || cwd !== value.repo) return false;
      return !!isolatedGitOwnership(value, authorizedRepo);
    }
    if (cwd !== value.worktree || repoRoot(cwd) !== cwd || common(cwd) !== common(value.repo)) return false;
    if (lstatSync(join(cwd, ".git")).isSymbolicLink() || !lstatSync(join(cwd, ".git")).isFile()) return false;
    if (statSync(cwd).uid !== process.getuid?.() || (statSync(cwd).mode & 0o022)) return false;
    if (git(cwd, "symbolic-ref", "--quiet", "HEAD") !== `refs/heads/${value.branch}`) return false;
    git(cwd, "merge-base", "--is-ancestor", value.baseCommit, "HEAD");
    const admin = canonical(git(cwd, "rev-parse", "--absolute-git-dir"));
    if (dirname(admin) !== join(common(value.repo), "worktrees")
      || readFileSync(join(admin, "gitdir"), "utf8").trim() !== join(cwd, ".git")) return false;
    const index = canonical(resolve(cwd, git(cwd, "rev-parse", "--git-path", "index")));
    if (index !== join(admin, "index") || !lstatSync(index).isFile() || statSync(index).nlink !== 1
      || statSync(index).uid !== process.getuid?.()) return false;
    canonical(join(admin, "HEAD"));
    canonical(join(common(cwd), "refs", "heads", value.branch));
    safeRepository(cwd);
    safeAttributes(cwd, value.files);
    const ownFile = (file: string) => value.files.includes(file) && canonical(join(cwd, file)) === join(cwd, file)
      && (!existsSync(join(cwd, file)) || lstatSync(join(cwd, file)).isFile());
    // Check both sides of renames, conflicts and every preexisting index entry. No pathspecs.
    const staged = git(cwd, "diff", "--cached", "--name-only", "--no-renames", "--no-ext-diff", "-z").split("\0").filter(Boolean);
    if (!staged.every(ownFile) || git(cwd, "ls-files", "--unmerged", "-z")) return false;
    if (staged.length && git(cwd, "ls-files", "--stage", "-z", "--", ...staged).split("\0").some((entry) => /^(120000|160000) /.test(entry))) return false;
    if (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((p) => existsSync(resolve(cwd, git(cwd, "rev-parse", "--git-path", p))))) return false;
    if (args[0] === "add") {
      const files = args.slice(args[1] === "--" ? 2 : 1);
      return files.length > 0 && files.every((file) => fileName(file) && ownFile(file));
    }
    return args.length === 3 && args[0] === "commit" && args[1] === "-m" && !!args[2].trim() && staged.length > 0;
  } catch { return false; }
}
