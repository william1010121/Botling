// Review of a checkout's changes (Botling 2.2, diff and PR review panel): which files changed against a
// starting point, and one file's diff as hunks, with guards so a huge change cannot freeze the app.
//
// The starting point (`from`) is a commit or tree; the end is a *tree of the working directory* made
// with a temporary index (`snapshotTree`), so uncommitted and untracked files are in the comparison
// without `git add -N` or any change to the real index, and the same function gives a per-turn diff
// (the tree recorded when a turn began, against the next one). Only objects are written to the
// repository; no ref, no index, no working file is touched.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./durable/atomic";

export type ReviewStatus = "A" | "M" | "D" | "R";
export interface ReviewFile {
  path: string;
  /** The old path of a rename. */
  oldPath?: string;
  status: ReviewStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface ReviewSummary {
  files: ReviewFile[];
  additions: number;
  deletions: number;
  /** More files changed than are listed. */
  capped: boolean;
}
export interface DiffLine {
  /** Context, added or deleted. */
  t: "ctx" | "add" | "del";
  /** Line number in the old file (not for added lines) and the new file (not for deleted lines). */
  o?: number;
  n?: number;
  text: string;
}
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface ReviewDiff {
  path: string;
  binary: boolean;
  additions: number;
  deletions: number;
  /** The file changed too much to show without asking (`force`). */
  tooLarge: boolean;
  /** The line cap cut the diff short. */
  truncated: boolean;
  hunks: DiffHunk[];
}

/** Files listed at most. */
export const MAX_FILES = 1000;
/** Lines shown for one file; changes beyond this need `force`, and are cut at FORCED_LINES. */
export const MAX_LINES = 2000;
export const FORCED_LINES = 20_000;
/** A longer line is cut (minified bundles). */
export const MAX_LINE_LENGTH = 2000;

export class ReviewError extends Error {}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile("git", ["-c", "core.quotepath=off", ...args], {
      cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", LC_ALL: "C", ...env },
    }, (error, stdout, stderr) => {
      if (error) fail(new ReviewError((stderr || String(stdout) || error.message).trim()));
      else done(String(stdout));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

const SHA = /^[0-9a-f]{40,64}$/;
/** A path is a repository-relative one: never absolute, never leaving the checkout. */
export function safeRelative(path: string): boolean {
  return !!path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !path.includes("\0") && !path.split(/[\\/]/).includes("..");
}

/** The tree of everything in the working directory now (tracked, modified, untracked; not ignored). */
export async function snapshotTree(cwd: string): Promise<string> {
  const real = resolve(cwd, (await run(cwd, ["rev-parse", "--git-path", "index"])).trim());
  const dir = mkdtempSync(join(tmpdir(), "botling-review-"));
  try {
    const index = join(dir, "index");
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    await run(cwd, ["add", "-A", "--", "."], env);
    return (await run(cwd, ["write-tree"], env)).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where the branch left its base: the commit its changes are counted from. */
export async function mergeBase(cwd: string, base: string, fallback: string): Promise<string> {
  try { return (await run(cwd, ["merge-base", base, "HEAD"])).trim() || fallback; } catch { return fallback; }
}

export async function headCommit(cwd: string): Promise<string | null> {
  try { return (await run(cwd, ["rev-parse", "--verify", "HEAD"])).trim(); } catch { return null; }
}

/** `from` may be a commit, a tree or (a repository with no commit yet) nothing: the empty tree. */
async function origin(cwd: string, from: string | null): Promise<string> {
  if (!from) return (await run(cwd, ["hash-object", "-t", "tree", "--stdin"], {}, "")).trim();
  if (!SHA.test(from)) throw new ReviewError("That starting point is not a commit.");
  return from;
}

export function parseNameStatus(raw: string): Map<string, { status: ReviewStatus; oldPath?: string }> {
  const tokens = raw.split("\0");
  const found = new Map<string, { status: ReviewStatus; oldPath?: string }>();
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[++i], path = tokens[++i];
      if (path) found.set(path, { status: letter === "R" ? "R" : "A", ...(letter === "R" ? { oldPath } : {}) });
    } else {
      const path = tokens[++i];
      if (path) found.set(path, { status: letter === "A" ? "A" : letter === "D" ? "D" : "M" });
    }
  }
  return found;
}

export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = raw.split("\0");
  const found = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]);
    if (!match) continue;
    let path = match[3];
    if (path === "") { i += 1; path = tokens[++i] ?? ""; } // a rename: old path, then new path
    const binary = match[1] === "-";
    if (path) found.set(path, { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
  }
  return found;
}

/** The files that differ between `from` and `to` (a tree made by `snapshotTree`). */
export async function reviewFiles(cwd: string, from: string | null, to: string): Promise<ReviewSummary> {
  if (!SHA.test(to)) throw new ReviewError("That is not a tree.");
  const start = await origin(cwd, from);
  const common = ["diff", "-M", "--no-ext-diff", "--no-textconv", "-z"];
  const [status, stat] = await Promise.all([
    run(cwd, [...common, "--name-status", start, to]),
    run(cwd, [...common, "--numstat", start, to]),
  ]);
  const kinds = parseNameStatus(status), counts = parseNumstat(stat);
  const files: ReviewFile[] = [...kinds].map(([path, kind]) => {
    const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
    return { path, ...(kind.oldPath ? { oldPath: kind.oldPath } : {}), status: kind.status, ...count };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const capped = files.length > MAX_FILES;
  const shown = capped ? files.slice(0, MAX_FILES) : files;
  return { files: shown, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), capped };
}

/** A unified diff as hunks, stopping after `maxLines` lines. */
export function parseUnifiedDiff(text: string, maxLines = MAX_LINES): { hunks: DiffHunk[]; truncated: boolean; additions: number; deletions: number; binary: boolean } {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null, o = 0, n = 0, count = 0, additions = 0, deletions = 0, truncated = false;
  const binary = /^Binary files .* differ$|^GIT binary patch$/m.test(text) && !/^@@ /m.test(text);
  for (const line of text.split("\n")) {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      if (count >= maxLines) { truncated = true; break; }
      current = { header: line, lines: [] };
      hunks.push(current);
      o = Number(head[1]); n = Number(head[2]);
      continue;
    }
    if (!current) continue; // the file header lines
    const mark = line[0];
    if (mark === "\\") continue; // "\ No newline at end of file"
    if (mark !== "+" && mark !== "-" && mark !== " ") continue;
    if (count >= maxLines) { truncated = true; break; }
    const body = line.slice(1);
    const cut = body.length > MAX_LINE_LENGTH ? `${body.slice(0, MAX_LINE_LENGTH)}…` : body;
    count++;
    if (mark === "+") { additions++; current.lines.push({ t: "add", n: n++, text: cut }); }
    else if (mark === "-") { deletions++; current.lines.push({ t: "del", o: o++, text: cut }); }
    else current.lines.push({ t: "ctx", o: o++, n: n++, text: cut });
  }
  return { hunks, truncated, additions, deletions, binary };
}

/** One file's diff. A change over MAX_LINES is not shown until asked for (`force`), then cut at FORCED_LINES. */
export async function reviewDiff(cwd: string, from: string | null, to: string, file: { path: string; oldPath?: string }, force = false): Promise<ReviewDiff> {
  if (!SHA.test(to)) throw new ReviewError("That is not a tree.");
  if (!safeRelative(file.path) || (file.oldPath !== undefined && !safeRelative(file.oldPath))) throw new ReviewError("That is not a path inside the checkout.");
  const start = await origin(cwd, from);
  const pathspec = ["--", ...(file.oldPath ? [file.oldPath] : []), file.path];
  const stat = parseNumstat(await run(cwd, ["diff", "-M", "--no-ext-diff", "--no-textconv", "-z", "--numstat", start, to, ...pathspec]));
  const counts = stat.get(file.path) ?? { additions: 0, deletions: 0, binary: false };
  const empty: ReviewDiff = { path: file.path, binary: counts.binary, additions: counts.additions, deletions: counts.deletions, tooLarge: false, truncated: false, hunks: [] };
  if (counts.binary) return empty;
  if (!force && counts.additions + counts.deletions > MAX_LINES) return { ...empty, tooLarge: true };
  const text = await run(cwd, ["diff", "-M", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", start, to, ...pathspec]);
  const parsed = parseUnifiedDiff(text, force ? FORCED_LINES : MAX_LINES);
  return { path: file.path, binary: parsed.binary, additions: counts.additions, deletions: counts.deletions, tooLarge: false, truncated: parsed.truncated, hunks: parsed.hunks };
}

// ---- Per-turn snapshots ----

export interface TurnSnapshot {
  /** The turn's id. */
  id: string;
  /** When it began (ISO). */
  at: string;
  /** The working directory's tree when it began. */
  tree: string;
}
const TURNS_KEPT = 30;

/**
 * The tree at the start of each agent turn, per checkout, so one turn's changes can be shown (the
 * tree it began with against the next turn's, or against now for the last). One small JSON file.
 */
export class TurnLog {
  constructor(private file: string) {}

  private read(): Record<string, TurnSnapshot[]> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      const out: Record<string, TurnSnapshot[]> = {};
      for (const [key, list] of Object.entries(raw ?? {})) {
        if (Array.isArray(list)) out[key] = list.filter((turn): turn is TurnSnapshot => !!turn && typeof turn.id === "string" && typeof turn.tree === "string" && SHA.test(turn.tree) && typeof turn.at === "string");
      }
      return out;
    } catch { return {}; }
  }

  list(key: string): TurnSnapshot[] { return this.read()[key] ?? []; }

  add(key: string, turn: TurnSnapshot) {
    const all = this.read();
    const list = (all[key] ?? []).filter((existing) => existing.id !== turn.id);
    list.push(turn);
    all[key] = list.slice(-TURNS_KEPT);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(all));
  }

  /** Forget a checkout that is gone. */
  drop(key: string) {
    const all = this.read();
    if (!(key in all)) return;
    delete all[key];
    writeFileAtomic(this.file, JSON.stringify(all));
  }
}
