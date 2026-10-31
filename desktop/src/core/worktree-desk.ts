// The app side of app-managed worktrees (core/worktrees.ts): one manager per bot, where they go, the
// folder a session starts in, what the agent is told, and the Worktrees control's actions as the
// contract has them. The server wires it; settings and the developer project are read through deps.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PrCreateView, PrDraftView, ReviewDiffView, ReviewFilesView, ReviewScope, WorktreeAction, WorktreesView } from "../contract";
import type { BotProfile } from "./store/workspace";
import { commitAll, existingPr, openPr, prefill } from "./publish";
import { ReviewError, TurnLog, headCommit, mergeBase, reviewDiff, reviewFiles, snapshotTree } from "./review";
import { WorktreeManager, type WorktreeRecord, type WorktreeResult } from "./worktrees";

export interface WorktreeDeskDeps {
  dataDir: string;
  /** The Worktrees setting and its folder override. */
  settings: () => { enabled: boolean; root: string | null };
  /** The work drive's folder, and whether this bot is Botling's own source's project (flat folders there). */
  devWork: () => string | null;
  isDeveloper: (botId: string) => boolean;
  /** Called when the folder a bot's session starts in changed (or its worktree was merged or discarded). */
  moved: (botId: string, reason: { told: string; shown: string }) => void;
  platform?: NodeJS.Platform;
  openTerminal?: (path: string) => Promise<void>;
  /** The GitHub CLI's command (default `gh`); tests point it at a fake. */
  gh?: string;
}

const failed = (message: string): WorktreeAction => ({ ok: false, message });
const noDraft = (message: string): PrDraftView => ({ ok: false, message, title: "", body: "", base: "", branch: "", commits: 0, url: null });
const noFiles = (message: string, scope: ReviewScope): ReviewFilesView => ({ ok: false, message, scope, from: "", to: "", base: "", files: [], additions: 0, deletions: 0, capped: false, turns: [], turn: null });
const noDiff = (message: string, path: string): ReviewDiffView => ({ ok: false, message, path, binary: false, additions: 0, deletions: 0, tooLarge: false, truncated: false, hunks: [] });

export class WorktreeDesk {
  private managers = new Map<string, WorktreeManager>();
  private logs = new Map<string, TurnLog>();
  constructor(private deps: WorktreeDeskDeps) {}

  /** Where the next worktree of this bot goes. */
  root(profile: BotProfile): string {
    const { root } = this.deps.settings();
    if (root) return root;
    const work = this.deps.isDeveloper(profile.id) ? this.deps.devWork() : null;
    return work ?? join(this.deps.dataDir, "worktrees", profile.id);
  }

  manager(profile: BotProfile): WorktreeManager {
    let manager = this.managers.get(profile.id);
    if (!manager) {
      manager = new WorktreeManager({ folder: profile.folder, file: join(profile.storeDir, "worktrees.json"), root: () => this.root(profile) });
      this.managers.set(profile.id, manager);
    }
    return manager;
  }

  private turns(profile: BotProfile): TurnLog {
    let log = this.logs.get(profile.id);
    if (!log) { log = new TurnLog(join(profile.storeDir, "review-turns.json")); this.logs.set(profile.id, log); }
    return log;
  }

  /** Main and team chats have no worktrees of their own. */
  private eligible(profile: BotProfile) { return profile.role !== "main" && !profile.problem; }

  /** The folder this bot's session starts in: its current worktree, or its project folder. */
  sessionFolder(profile: BotProfile): string {
    if (!this.deps.settings().enabled || !this.eligible(profile)) return profile.folder;
    return this.manager(profile).sessionFolder()?.path ?? profile.folder;
  }

  /** More folders the session may use: the project's `.bot` (memory, inbox) when it starts in a worktree. */
  extraDirs(profile: BotProfile): string[] {
    return this.sessionFolder(profile) === profile.folder ? [] : [join(profile.folder, ".bot")];
  }

  /** The current worktree, for the briefing; null when the session runs in the project folder. */
  current(profile: BotProfile): WorktreeRecord | null {
    if (!this.deps.settings().enabled || !this.eligible(profile)) return null;
    return this.manager(profile).sessionFolder()?.record ?? null;
  }

  /** What the agent is told at a wake when it works in an app-made worktree. */
  note(profile: BotProfile): string {
    const record = this.current(profile);
    if (!record) return "";
    return `(App: Worktree. The app made a git worktree for this work and your working directory is in it: branch ${record.branch}, folder ${record.path}, made from ${record.base}. Edit, build, test and commit there. Do not run git worktree yourself and do not change the main checkout at ${profile.folder}: when the work is committed, say so; the user merges or discards the worktree from the app. Your memory and inbox stay in the project folder: memory is ${join(profile.folder, profile.memoryPath)}; read and write that file, not a .bot folder under your working directory.)`;
  }

  async view(profile: BotProfile): Promise<WorktreesView> {
    const { enabled } = this.deps.settings();
    const root = this.root(profile);
    if (!enabled || !this.eligible(profile)) return { enabled, available: false, current: null, root, items: [] };
    const manager = this.manager(profile);
    const available = await manager.available();
    if (!available) return { enabled, available, current: null, root, items: [] };
    const { current, items } = await manager.list();
    return { enabled, available, current, root, items: items.map(({ id, branch, path, base, task, owner, status, createdAt, changedFiles, ahead, missing, pr }) => ({ id, branch, path, base, task, owner, status, createdAt, changedFiles, ahead, missing, pr: pr ?? null })) };
  }

  private done(profile: BotProfile, result: WorktreeResult<object>, ok: string, told: string): WorktreeAction {
    if (!result.ok) return { ok: false, message: result.message, ...(result.files ? { files: result.files } : {}) };
    this.deps.moved(profile.id, { told, shown: ok });
    return { ok: true, message: ok };
  }

  private guard(profile: BotProfile): WorktreeAction | null {
    return this.deps.settings().enabled && this.eligible(profile) ? null : failed("Worktrees are off for this project.");
  }

  async create(profile: BotProfile, name: string, base?: string): Promise<WorktreeAction> {
    const off = this.guard(profile); if (off) return off;
    const result = await this.manager(profile).create({ name, base: base ?? null, owner: "agent" });
    if (!result.ok) return failed(result.message);
    return this.done(profile, result, `Made ${result.record.branch} from ${result.record.base}.`, "you now work in a new git worktree; see the Worktree note");
  }

  async use(profile: BotProfile, id: string | null): Promise<WorktreeAction> {
    const off = this.guard(profile); if (off) return off;
    return this.done(profile, await this.manager(profile).setCurrent(id), id ? "Switched worktree." : "Back in the project folder.", "your working directory changed; see the Worktree note");
  }

  async merge(profile: BotProfile, id: string): Promise<WorktreeAction> {
    const off = this.guard(profile); if (off) return off;
    const result = await this.manager(profile).merge(id);
    if (result.ok) this.turns(profile).drop(id);
    return this.done(profile, result, result.ok ? `Merged ${result.merged} commit${result.merged === 1 ? "" : "s"} and removed the worktree.` : "", "your worktree was merged and removed; you are in the project folder again");
  }

  async discard(profile: BotProfile, id: string, force: boolean): Promise<WorktreeAction> {
    const off = this.guard(profile); if (off) return off;
    const result = await this.manager(profile).discard(id, force);
    if (result.ok) this.turns(profile).drop(id);
    if (!result.ok) return { ok: false, message: result.message, ...(result.code === "dirty" || result.code === "unmerged" ? { confirm: true } : {}) };
    return this.done(profile, result, "Discarded the worktree and its branch.", "your worktree was discarded; you are in the project folder again");
  }

  /** A turn began in this bot's session: remember its worktree's tree, for the per-turn review. */
  async turnStarted(profile: BotProfile, turnId: string): Promise<void> {
    try {
      if (!this.deps.settings().enabled || !this.eligible(profile)) return;
      const found = this.manager(profile).sessionFolder();
      if (!found) return;
      const tree = await snapshotTree(found.path);
      this.turns(profile).add(found.record.id, { id: turnId, at: new Date().toISOString(), tree });
    } catch { /* a turn is never held up, or failed, by this */ }
  }

  /** Where a review looks: the main checkout (`id` null) or an active worktree. */
  private async place(profile: BotProfile, id: string | null): Promise<{ cwd: string; record: WorktreeRecord | null } | string> {
    if (!this.deps.settings().enabled || !this.eligible(profile)) return "Worktrees are off for this project.";
    const manager = this.manager(profile);
    if (id === null) {
      const top = await manager.top();
      return top ? { cwd: top, record: null } : "This project folder is not the main checkout of a git repository.";
    }
    const record = manager.get(id);
    if (!record || !existsSync(join(record.path, ".git"))) return "That worktree is not there.";
    return { cwd: record.path, record };
  }

  /** The files changed in a worktree (or the main checkout) for a scope, and the commits/trees they are compared between. */
  async reviewFiles(profile: BotProfile, id: string | null, scope: ReviewScope, turn?: string): Promise<ReviewFilesView> {
    const place = await this.place(profile, id);
    if (typeof place === "string") return noFiles(place, scope);
    const { cwd, record } = place;
    try {
      const turns = record ? this.turns(profile).list(record.id) : [];
      let from: string | null, base: string, picked: string | null = null;
      let to = await snapshotTree(cwd);
      if (scope === "turn") {
        const at = turns.findIndex((candidate) => candidate.id === turn);
        if (at < 0) return { ...noFiles("That turn was not recorded.", scope), turns: turns.map(({ id, at }) => ({ id, at })) };
        from = turns[at].tree; picked = turns[at].id; base = "turn";
        if (turns[at + 1]) to = turns[at + 1].tree;
      } else if (scope === "branch" && record) {
        from = await mergeBase(cwd, record.base, record.baseCommit); base = record.base;
      } else {
        from = await headCommit(cwd); base = "HEAD";
      }
      const summary = await reviewFiles(cwd, from, to);
      return { ok: true, message: "", scope, from: from ?? "", to, base, ...summary, turns: turns.map(({ id, at }) => ({ id, at })), turn: picked };
    } catch (error) {
      return noFiles(error instanceof ReviewError ? error.message : `Could not read the changes: ${(error as Error).message}`, scope);
    }
  }

  /** One file's diff between the two revisions `reviewFiles` returned. */
  async reviewDiff(profile: BotProfile, id: string | null, from: string, to: string, path: string, oldPath: string | undefined, force: boolean): Promise<ReviewDiffView> {
    const place = await this.place(profile, id);
    if (typeof place === "string") return noDiff(place, path);
    try {
      return { ok: true, message: "", ...(await reviewDiff(place.cwd, from || null, to, { path, ...(oldPath ? { oldPath } : {}) }, force)) };
    } catch (error) {
      return noDiff(error instanceof ReviewError ? error.message : `Could not read the diff: ${(error as Error).message}`, path);
    }
  }

  /** An app-made worktree that is there: commit and pull request are for these only, never the main checkout. */
  private tree(profile: BotProfile, id: string): WorktreeRecord | string {
    if (!this.deps.settings().enabled || !this.eligible(profile)) return "Worktrees are off for this project.";
    const record = this.manager(profile).get(id);
    return record && existsSync(join(record.path, ".git")) ? record : "That worktree is not there.";
  }

  /** Stage and commit everything in a worktree. */
  async commit(profile: BotProfile, id: string, message: string): Promise<WorktreeAction> {
    const record = this.tree(profile, id);
    if (typeof record === "string") return failed(record);
    const result = await commitAll(record.path, message);
    if (!result.ok) return failed(result.message);
    return { ok: true, message: `Committed ${result.files} file${result.files === 1 ? "" : "s"} as ${result.sha}.` };
  }

  /** What the pull request form starts with. */
  async prDraft(profile: BotProfile, id: string): Promise<PrDraftView> {
    const record = this.tree(profile, id);
    if (typeof record === "string") return noDraft(record);
    try {
      const draft = await prefill(record.path, record.branch, record.base);
      const url = record.pr ?? await existingPr(record.path, record.branch, this.deps.gh);
      return { ok: true, message: "", ...draft, base: record.base, branch: record.branch, url };
    } catch (error) {
      return noDraft(`Could not read the commits: ${(error as Error).message}`);
    }
  }

  /** Push the branch and open the pull request; its link is kept on the worktree. */
  async prCreate(profile: BotProfile, id: string, title: string, body: string): Promise<PrCreateView> {
    const record = this.tree(profile, id);
    if (typeof record === "string") return { ok: false, message: record, url: null, existing: false };
    const result = await openPr(record.path, { branch: record.branch, base: record.base, title, body, ...(this.deps.gh ? { gh: this.deps.gh } : {}) });
    if (!result.ok) return { ok: false, message: result.message, url: null, existing: false };
    await this.manager(profile).setPr(id, result.url);
    return { ok: true, message: result.existing ? "A pull request is already open; the new commits were pushed to it." : "Opened the pull request.", url: result.url, existing: result.existing };
  }

  async terminal(profile: BotProfile, id: string): Promise<WorktreeAction> {
    const { items } = await this.manager(profile).list();
    const record = items.find((item) => item.id === id && item.status === "active" && !item.missing);
    if (!record) return failed("That worktree is not there.");
    const platform = this.deps.platform ?? process.platform;
    if (!this.deps.openTerminal && platform !== "darwin") return failed("Opening a terminal here is only supported on macOS; the folder is " + record.path);
    try { await (this.deps.openTerminal ?? openMacTerminal)(record.path); } catch (error) { return failed(`Could not open a terminal: ${(error as Error).message}`); }
    return { ok: true, message: "Opened a terminal." };
  }
}

function openMacTerminal(path: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("open", ["-a", "Terminal", path], { stdio: "ignore" });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`open exited ${code}`))));
  });
}
