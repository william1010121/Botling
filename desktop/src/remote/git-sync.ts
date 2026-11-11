// The app's side of a remote worker's project files (multi-machine phase 1, agent/git.ts is the machine's):
//   push: the base commit goes to the machine as a "snapshot" commit (its tree; its parent the snapshot sent before),
//         so the machine needs no history and later pushes carry only what changed; the worker gets a worktree on its
//         branch there, from that snapshot.
//   pull: when a run ends the branch comes back as a bundle; its commits are replayed here onto the real base (same
//         trees, authors, dates and messages), so the local branch has the worker's commits on the commit it started
//         from. Replaying is deterministic: pulling again after more commits fast-forwards the same branch.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionLink } from "./session";

export function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    }, (error, stdout, stderr) => {
      if (error) fail(new Error(`git ${args[0]}: ${(stderr || error.message).trim().slice(0, 1_000)}`));
      else done(stdout.trim());
    });
  });
}
const gitOk = (cwd: string, args: string[]) => git(cwd, args).then(() => true, () => false);

/** A stable name for a local project on the machine (its repository's folder, hashed). */
export const projectKey = (top: string) => `p-${createHash("sha256").update(resolve(top)).digest("hex").slice(0, 16)}`;
/** The branch a remote worker works on (here and there). */
export const remoteBranch = (worker: string, name: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "worker";
  return `bot/remote-${slug}-${worker.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
};

/** Fixed identity and dates: the same tree on the same parent is the same snapshot commit every time. */
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "Botling", GIT_AUTHOR_EMAIL: "snapshot@botling.invalid", GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Botling", GIT_COMMITTER_EMAIL: "snapshot@botling.invalid", GIT_COMMITTER_DATE: "1700000000 +0000",
};

export interface RemoteGitOptions {
  /** The local folder the worker would have run in (inside the project's repository). */
  cwd: string;
  machine: string;
  worker: string;
  /** The worker's name (its branch is named after it). */
  name: string;
  /** The real commit it starts from, once chosen (kept across runs and app restarts). */
  base?: string | null;
  saveBase?(base: string): void;
}

export interface PullResult { branch: string; head: string | null; commits: number; note: string }

export class RemoteGit {
  private top: string | null = null;
  private prefix = "";
  base: string | null;
  readonly branch: string;
  constructor(readonly options: RemoteGitOptions) {
    this.base = options.base ?? null;
    this.branch = remoteBranch(options.worker, options.name);
  }

  /** The repository's top folder and the worker's folder inside it. */
  private async where() {
    if (this.top) return this.top;
    try { this.top = await git(this.options.cwd, ["rev-parse", "--show-toplevel"]); } catch {
      throw new Error(`A worker on another machine needs its project in git: ${this.options.cwd} is not in a git repository.`);
    }
    this.prefix = await git(this.options.cwd, ["rev-parse", "--show-prefix"]);
    return this.top;
  }
  private get outRef() { return `refs/botling/out/${this.options.machine}`; }
  /** The snapshot this worker's branch starts from (per worker: another worker may move the machine's base on). */
  private get snapshotRef() { return `refs/botling/snap/${this.options.worker}`; }

  /** Push: the base to the machine, the worker's worktree there. Gives the folder claude runs in on the machine. */
  async prepare(link: SessionLink): Promise<{ cwd: string }> {
    const top = await this.where();
    const project = projectKey(top);
    if (!this.base) {
      this.base = await git(top, ["rev-parse", "HEAD^{commit}"]).catch(() => { throw new Error(`${top} has no commits yet; commit something before handing work to another machine.`); });
      this.options.saveBase?.(this.base);
    }
    const where = (made: { cwd: string }) => ({ cwd: this.prefix ? join(made.cwd, this.prefix) : made.cwd });
    // A worker that ran there before goes on in its own worktree, from its own snapshot.
    const mine = await git(top, ["rev-parse", "-q", "--verify", `${this.snapshotRef}^{commit}`]).catch(() => null);
    if (mine) {
      try { return where(await link.rpc("worktree", { project, worker: this.options.worker, base: mine, branch: this.branch }) as { cwd: string }); } catch { /* gone there: sent again below */ }
    }
    const tree = await git(top, ["rev-parse", `${this.base}^{tree}`]);
    const remote = (await link.rpc("gitBase", { project }) as { base: string | null }).base;
    const remoteHere = remote ? await gitOk(top, ["cat-file", "-e", `${remote}^{commit}`]) : false;
    const snapshot = await git(top, ["commit-tree", tree, ...(remoteHere ? ["-p", remote!] : []), "-m", `Botling base ${this.base}`], SNAPSHOT_ENV);
    if (remote !== snapshot) {
      const dir = mkdtempSync(join(tmpdir(), "botling-bundle-"));
      try {
        await git(top, ["update-ref", this.outRef, snapshot]);
        const file = join(dir, "base.bundle");
        await git(top, ["bundle", "create", "-q", file, this.outRef, ...(remoteHere ? [`^${remote}`] : [])]);
        const blob = link.sendBlob(readFileSync(file));
        const got = (await link.rpc("gitReceive", { project, blob, ref: this.outRef }) as { base: string }).base;
        if (got !== snapshot) throw new Error(`The machine has base ${got}, not ${snapshot}.`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await git(top, ["update-ref", "-d", this.outRef]).catch(() => undefined);
      }
    }
    await git(top, ["update-ref", this.snapshotRef, snapshot]);
    return where(await link.rpc("worktree", { project, worker: this.options.worker, base: snapshot, branch: this.branch }) as { cwd: string });
  }

  /** Pull: the worker's branch back from the machine, replayed onto the real base as a local branch. */
  async pull(link: SessionLink, message: string): Promise<PullResult> {
    const top = await this.where();
    if (!this.base) return { branch: this.branch, head: null, commits: 0, note: "" };
    const snapshot = await git(top, ["rev-parse", "-q", "--verify", `${this.snapshotRef}^{commit}`]).catch(() => null);
    if (!snapshot) return { branch: this.branch, head: null, commits: 0, note: "" };
    const sent = await link.rpc("gitSend", { worker: this.options.worker, base: snapshot, message }) as { head: string; commits: number; blob: string | null; branch?: string };
    if (!sent.blob || !sent.commits) return { branch: this.branch, head: null, commits: 0, note: "" };
    const data = await link.takeBlob(sent.blob);
    const dir = mkdtempSync(join(tmpdir(), "botling-bundle-"));
    const inRef = `refs/botling/in/${this.options.worker}`;
    try {
      const file = join(dir, "work.bundle");
      writeFileSync(file, data);
      await git(top, ["bundle", "verify", "-q", file]);
      await git(top, ["fetch", "-q", "--no-tags", file, `+${sent.branch ?? `refs/heads/${this.branch}`}:${inRef}`]);
      const head = await this.replay(top, snapshot, inRef);
      const local = `refs/heads/${this.branch}`;
      const old = await git(top, ["rev-parse", "-q", "--verify", local]).catch(() => null);
      let branch = this.branch;
      if (old && old !== head && !(await gitOk(top, ["merge-base", "--is-ancestor", old, head]))) {
        // The local branch moved on its own: the machine's work goes beside it, not over it.
        branch = `${this.branch}-${head.slice(0, 7)}`;
        await git(top, ["update-ref", `refs/heads/${branch}`, head]);
      } else if (old !== head) {
        const checkedOut = (await git(top, ["worktree", "list", "--porcelain"])).split("\n").some((l) => l === `branch ${local}`);
        if (checkedOut) {
          branch = `${this.branch}-${head.slice(0, 7)}`;
          await git(top, ["update-ref", `refs/heads/${branch}`, head]);
        } else await git(top, ["update-ref", local, head, ...(old ? [old] : [])]);
      }
      const count = Number(await git(top, ["rev-list", "--count", `${this.base}..${head}`]));
      return { branch, head, commits: count, note: `The worker ran on another machine; its work is on branch ${branch} here (${count} commit${count === 1 ? "" : "s"} on ${this.base.slice(0, 10)}, head ${head.slice(0, 10)}). Merge it when it is right.` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await git(top, ["update-ref", "-d", inRef]).catch(() => undefined);
    }
  }

  /** Replays the commits after `snapshot` up to `ref` onto the real base. */
  private async replay(top: string, snapshot: string, ref: string): Promise<string> {
    const real = this.base!;
    const map = new Map<string, string>([[snapshot, real]]);
    const list = (await git(top, ["rev-list", "--reverse", "--topo-order", "--parents", `${snapshot}..${ref}`])).split("\n").filter(Boolean);
    let last = real;
    for (const line of list) {
      const [commit, ...parents] = line.split(" ");
      const fields = await git(top, ["show", "-s", "--format=%T%n%an%n%ae%n%ad%n%cn%n%ce%n%cd", "--date=raw", commit!]);
      const [tree, an, ae, ad, cn, ce, cd] = fields.split("\n");
      const message = await git(top, ["show", "-s", "--format=%B", commit!]);
      const mapped = parents.map((p) => map.get(p) ?? p);
      const args = ["commit-tree", tree!, ...mapped.flatMap((p) => ["-p", p]), "-m", message || "(no message)"];
      last = await git(top, args, { GIT_AUTHOR_NAME: an!, GIT_AUTHOR_EMAIL: ae!, GIT_AUTHOR_DATE: ad!, GIT_COMMITTER_NAME: cn!, GIT_COMMITTER_EMAIL: ce!, GIT_COMMITTER_DATE: cd! });
      map.set(commit!, last);
    }
    return last;
  }
}
