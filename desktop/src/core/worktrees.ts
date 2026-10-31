// App-managed git worktrees: the app, not the agent, makes the checkout a task works in, tracks it
// and cleans it up. One WorktreeManager per bot (its project folder is the main checkout); its
// records live in one small JSON file. Design: desktop/docs/worktrees.md.
//
// Safety rules, enforced here and tested against real temporary repositories:
//   - the main checkout is only ever changed by a fast-forward merge into the base branch, and only
//     when it is on that branch with no uncommitted changes; otherwise the merge is reported, not forced;
//   - a worktree with uncommitted changes or unmerged commits is never removed without `force`;
//   - a merge conflict is found in the worktree (base merged into the branch there), reported, and
//     aborted, so nothing is left half-merged anywhere;
//   - only paths the app recorded and `git worktree list` confirms are ever removed, by git itself.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./durable/atomic";

export type WorktreeStatus = "active" | "merged" | "abandoned";

export interface WorktreeRecord {
  id: string;
  /** The branch the app made for it (`bot/<slug>`). */
  branch: string;
  /** Where it is checked out. */
  path: string;
  /** The branch it was made from and merges back into. */
  base: string;
  /** What `base` pointed at when it was made. */
  baseCommit: string;
  /** The task card it works for, when there is one. */
  task: string | null;
  /** Who works in it: an engine name or a worker's task id, free text. */
  owner: string | null;
  status: WorktreeStatus;
  createdAt: string;
  closedAt?: string;
  /** The pull request opened for the branch from the app (its link). */
  pr?: string;
}

/** A record with what git says about it now. */
export interface WorktreeView extends WorktreeRecord {
  /** Files with uncommitted changes (0 for a closed one). */
  changedFiles: number;
  /** Commits on the branch that `base` does not have. */
  ahead: number;
  /** The folder is gone (deleted outside the app). */
  missing: boolean;
}

interface Stored { version: 1; current: string | null; items: WorktreeRecord[] }

/** What an action did: ok, or why it did not, in a sentence that can be shown as it is. */
export type WorktreeResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; code: WorktreeFailure; message: string; files?: string[] };
export type WorktreeFailure =
  | "not-a-repo" | "no-commits" | "detached" | "unknown" | "exists" | "git"
  | "dirty" | "unmerged" | "base-dirty" | "base-moved" | "conflict" | "nothing" | "missing";

export interface WorktreeOptions {
  /** The bot's project folder: the main checkout (or a folder inside it). */
  folder: string;
  /** Where the records are kept. */
  file: string;
  /** Where new worktrees go, one folder each. */
  root: () => string;
  /** Closed records kept for history. */
  keepClosed?: number;
}

const CLOSED_KEPT = 20;

class GitError extends Error {
  constructor(message: string, readonly stdout = "") { super(message); }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      if (error) fail(new GitError((stderr || stdout || error.message).trim(), String(stdout)));
      else done(String(stdout).trimEnd());
    });
  });
}

const safeReal = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** A task name as a branch/folder name: `Fix the login bug!` -> `fix-the-login-bug`. */
export function worktreeSlug(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return slug || "task";
}

export class WorktreeManager {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private options: WorktreeOptions) {}

  /** One action at a time per bot: git's own locks would make concurrent ones fail anyway. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private read(): Stored {
    try {
      const raw = JSON.parse(readFileSync(this.options.file, "utf8")) as Partial<Stored>;
      if (raw && Array.isArray(raw.items)) {
        return { version: 1, current: typeof raw.current === "string" ? raw.current : null, items: raw.items.filter((item): item is WorktreeRecord => !!item && typeof item.id === "string" && typeof item.path === "string" && typeof item.branch === "string") };
      }
    } catch { /* none yet */ }
    return { version: 1, current: null, items: [] };
  }

  private write(stored: Stored) {
    const closed = stored.items.filter((item) => item.status !== "active");
    const drop = new Set(closed.slice(0, Math.max(0, closed.length - (this.options.keepClosed ?? CLOSED_KEPT))).map((item) => item.id));
    stored.items = stored.items.filter((item) => !drop.has(item.id));
    if (stored.current && !stored.items.some((item) => item.id === stored.current && item.status === "active")) stored.current = null;
    mkdirSync(dirname(this.options.file), { recursive: true });
    writeFileAtomic(this.options.file, JSON.stringify(stored, null, 2));
  }

  /** The main checkout's top folder, or why this is not one. */
  private async main(): Promise<{ ok: true; top: string } | { ok: false; code: WorktreeFailure; message: string }> {
    try {
      const top = safeReal(await git(this.options.folder, ["rev-parse", "--show-toplevel"]));
      // Run from a linked worktree it would name that worktree, never a main checkout to merge into.
      const common = safeReal(resolve(top, await git(top, ["rev-parse", "--git-common-dir"])));
      if (basename(common) !== ".git" || safeReal(dirname(common)) !== top) return { ok: false, code: "not-a-repo", message: "This project folder is not the main checkout of a git repository." };
      await git(top, ["rev-parse", "--verify", "HEAD"]).catch(() => { throw new GitError("no-commits"); });
      return { ok: true, top };
    } catch (error) {
      if (error instanceof GitError && error.message === "no-commits") return { ok: false, code: "no-commits", message: "The repository has no commits yet; make one first." };
      return { ok: false, code: "not-a-repo", message: "This project folder is not a git repository." };
    }
  }

  /** Whether worktrees can be made for this project at all. */
  async available(): Promise<boolean> { return (await this.main()).ok; }

  /** The main checkout's top folder (null: the project is not one). */
  async top(): Promise<string | null> {
    const main = await this.main();
    return main.ok ? main.top : null;
  }

  /** One active record by id. */
  get(id: string): WorktreeRecord | null {
    return this.active(id)?.record ?? null;
  }

  /** Worktrees git knows of in this repository: path -> branch. */
  private async registered(top: string): Promise<Map<string, string | null>> {
    const out = await git(top, ["worktree", "list", "--porcelain"]);
    const found = new Map<string, string | null>();
    let path: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) { path = safeReal(line.slice(9)); found.set(path, null); }
      else if (line.startsWith("branch ") && path) found.set(path, line.slice(7).replace(/^refs\/heads\//, ""));
    }
    return found;
  }

  private async changed(path: string): Promise<number> {
    const out = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
    return out ? out.split("\n").length : 0;
  }

  /** Records, with live counts. Active ones first. */
  list(): Promise<{ current: string | null; items: WorktreeView[] }> {
    return this.serial(async () => {
      const stored = this.read();
      const items: WorktreeView[] = [];
      for (const record of stored.items) {
        const view: WorktreeView = { ...record, changedFiles: 0, ahead: 0, missing: false };
        if (record.status === "active") {
          view.missing = !existsSync(record.path);
          if (!view.missing) {
            try {
              view.changedFiles = await this.changed(record.path);
              view.ahead = Number(await git(record.path, ["rev-list", "--count", `${record.base}..${record.branch}`])) || 0;
            } catch { view.missing = true; }
          }
        }
        items.push(view);
      }
      items.sort((a, b) => Number(b.status === "active") - Number(a.status === "active") || b.createdAt.localeCompare(a.createdAt));
      return { current: stored.current, items };
    });
  }

  /** Make a worktree and branch off the base (default: the branch the main checkout is on). */
  create(input: { name: string; base?: string | null; task?: string | null; owner?: string | null }): Promise<WorktreeResult<{ record: WorktreeRecord }>> {
    return this.serial(async () => {
      const main = await this.main();
      if (!main.ok) return main;
      let base = input.base?.trim() || "";
      try {
        if (!base) {
          base = await git(main.top, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
          if (!base) return { ok: false, code: "detached", message: "The main checkout is not on a branch; pick a base branch." } as const;
        }
        await git(main.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]);
      } catch { return { ok: false, code: "unknown", message: `There is no branch named ${base}.` } as const; }
      const baseCommit = await git(main.top, ["rev-parse", `refs/heads/${base}`]);

      const stored = this.read();
      const taken = new Set(stored.items.filter((item) => item.status === "active").flatMap((item) => [item.branch, item.path]));
      const slug = worktreeSlug(input.name);
      const root = resolve(this.options.root());
      let suffix = 1, branch = "", path = "";
      for (;; suffix++) {
        const stem = suffix === 1 ? slug : `${slug}-${suffix}`;
        branch = `bot/${stem}`; path = join(root, stem);
        if (taken.has(branch) || taken.has(path) || existsSync(path)) continue;
        if (await git(main.top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false)) continue;
        break;
      }
      mkdirSync(root, { recursive: true });
      try {
        await git(main.top, ["worktree", "add", "-b", branch, path, baseCommit]);
      } catch (error) {
        return { ok: false, code: "git", message: `git could not make the worktree: ${(error as Error).message}` };
      }
      const record: WorktreeRecord = {
        id: randomUUID().toLowerCase(), branch, path: safeReal(path), base, baseCommit, task: input.task ?? null, owner: input.owner ?? null,
        status: "active", createdAt: new Date().toISOString(),
      };
      stored.items.push(record);
      stored.current ??= record.id;
      this.write(stored);
      return { ok: true, record };
    });
  }

  /** Remember the pull request opened for a worktree's branch. */
  setPr(id: string, url: string): Promise<void> {
    return this.serial(async () => {
      const found = this.active(id);
      if (!found) return;
      found.record.pr = url;
      this.write(found.stored);
    });
  }

  /** The worktree the bot's agent works in (null: the project folder itself). */
  setCurrent(id: string | null): Promise<WorktreeResult> {
    return this.serial(async () => {
      const stored = this.read();
      if (id !== null && !stored.items.some((item) => item.id === id && item.status === "active")) return { ok: false, code: "unknown", message: "That worktree is not active." } as const;
      stored.current = id;
      this.write(stored);
      return { ok: true } as const;
    });
  }

  /**
   * The folder an agent session should start in: the current worktree while it is still there (a
   * checkout has a `.git` file). Synchronous: a session starts without waiting on git.
   */
  sessionFolder(): { path: string; record: WorktreeRecord } | null {
    const stored = this.read();
    const record = stored.items.find((item) => item.id === stored.current && item.status === "active");
    return record && existsSync(join(record.path, ".git")) ? { path: record.path, record } : null;
  }

  private active(id: string): { stored: Stored; record: WorktreeRecord } | null {
    const stored = this.read();
    const record = stored.items.find((item) => item.id === id && item.status === "active");
    return record ? { stored, record } : null;
  }

  /**
   * Merge the branch into its base, then remove the worktree and branch. The worktree must be clean
   * (commit first); the main checkout must be on the base with no changes; base is merged into the
   * branch first, inside the worktree, so a conflict is found and aborted there.
   */
  merge(id: string): Promise<WorktreeResult<{ merged: number }>> {
    return this.serial(async () => {
      const found = this.active(id);
      if (!found) return { ok: false, code: "unknown", message: "That worktree is not active." } as const;
      const { stored, record } = found;
      const main = await this.main();
      if (!main.ok) return main;
      if (!existsSync(record.path)) return { ok: false, code: "missing", message: "The worktree folder is gone; discard it to clear the record." } as const;
      const registered = await this.registered(main.top);
      if (registered.get(safeReal(record.path)) !== record.branch) return { ok: false, code: "missing", message: "Git no longer lists this worktree on its branch; discard it to clear the record." } as const;

      const changed = await this.changed(record.path);
      if (changed) return { ok: false, code: "dirty", message: `The worktree has ${changed} uncommitted file${changed === 1 ? "" : "s"}. Commit them first (nothing was merged).` } as const;
      const onBase = await git(main.top, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
      if (onBase !== record.base) return { ok: false, code: "base-moved", message: `The main checkout is on ${onBase || "a detached HEAD"}, not ${record.base}. Switch it back (nothing was merged).` } as const;
      const dirty = await this.changed(main.top);
      if (dirty) return { ok: false, code: "base-dirty", message: `The main checkout has ${dirty} uncommitted file${dirty === 1 ? "" : "s"} on ${record.base}. Commit or stash them, then merge again (nothing was merged).` } as const;
      const ahead = Number(await git(record.path, ["rev-list", "--count", `${record.base}..${record.branch}`])) || 0;
      if (!ahead) return { ok: false, code: "nothing", message: "The branch has no commits beyond its base; there is nothing to merge." } as const;

      // 1. Bring the base into the branch, in the worktree.
      try {
        await git(record.path, ["merge", "--no-edit", record.base]);
      } catch (error) {
        const files = (await git(record.path, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
        await git(record.path, ["merge", "--abort"]).catch(() => undefined);
        return { ok: false, code: "conflict", message: files.length ? `Merging ${record.base} into ${record.branch} conflicts in ${files.join(", ")}. Nothing was changed; resolve it in the worktree.` : `Merging ${record.base} into ${record.branch} failed: ${(error as Error).message}`, files } as const;
      }
      // 2. Fast-forward the base to the branch in the main checkout.
      try {
        await git(main.top, ["merge", "--ff-only", record.branch]);
      } catch (error) {
        return { ok: false, code: "git", message: `The base could not be fast-forwarded: ${(error as Error).message}` } as const;
      }
      // 3. Clean up: git itself refuses to remove what is not clean or merged.
      await git(main.top, ["worktree", "remove", record.path]).catch(() => undefined);
      await git(main.top, ["branch", "-d", record.branch]).catch(() => undefined);
      record.status = "merged"; record.closedAt = new Date().toISOString();
      this.write(stored);
      return { ok: true, merged: ahead } as const;
    });
  }

  /**
   * Remove a worktree and its branch without merging. Uncommitted changes or unmerged commits are
   * only thrown away with `force` (the caller asks the user first).
   */
  discard(id: string, force = false): Promise<WorktreeResult<{ lost: { files: number; commits: number } }>> {
    return this.serial(async () => {
      const found = this.active(id);
      if (!found) return { ok: false, code: "unknown", message: "That worktree is not active." } as const;
      const { stored, record } = found;
      const main = await this.main();
      if (!main.ok) return main;
      const gone = !existsSync(record.path);
      let files = 0, commits = 0;
      if (!gone) {
        try {
          files = await this.changed(record.path);
          commits = Number(await git(record.path, ["rev-list", "--count", `${record.base}..${record.branch}`])) || 0;
        } catch { /* unreadable: treated as clean, git remove decides */ }
        if ((files || commits) && !force) {
          const what = [files ? `${files} uncommitted file${files === 1 ? "" : "s"}` : "", commits ? `${commits} unmerged commit${commits === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
          return { ok: false, code: files ? "dirty" : "unmerged", message: `The worktree has ${what}; discarding loses them. Confirm to discard anyway.` } as const;
        }
        const registered = await this.registered(main.top);
        if (registered.has(safeReal(record.path)) && safeReal(record.path) !== main.top) {
          try { await git(main.top, ["worktree", "remove", ...(force ? ["--force"] : []), record.path]); }
          catch (error) { return { ok: false, code: "git", message: `git could not remove the worktree: ${(error as Error).message}` } as const; }
        }
      }
      await git(main.top, ["worktree", "prune"]).catch(() => undefined);
      await git(main.top, ["branch", force ? "-D" : "-d", record.branch]).catch(() => undefined);
      record.status = "abandoned"; record.closedAt = new Date().toISOString();
      this.write(stored);
      return { ok: true, lost: { files, commits } } as const;
    });
  }
}
