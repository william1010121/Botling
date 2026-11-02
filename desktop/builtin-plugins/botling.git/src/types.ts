// What botling.git's program part answers its frames (these were the core's `worktrees.*`, `pr.*` and `review.*` commands).
export interface WorktreeItem {
  id: string; branch: string; path: string; base: string; task: string | null; owner: string | null;
  status: "active" | "merged" | "abandoned"; createdAt: string;
  changedFiles: number; ahead: number; missing: boolean;
  /** The pull request opened from the app for this branch. */
  pr?: string | null;
}
export interface WorktreesView {
  /** The Worktrees setting. */
  enabled: boolean;
  /** This project is the main checkout of a git repository with a commit, so worktrees can be made. */
  available: boolean;
  /** The one its agent works in (null: the project folder). */
  current: string | null;
  /** Where the next one is made. */
  root: string;
  items: WorktreeItem[];
}
/** What an action did; a refusal carries a sentence to show as it is. `confirm`: asking again with `force` would lose work. */
export interface WorktreeAction { ok: boolean; message: string; files?: string[]; confirm?: boolean }

/** The pull request form's start (title and body from the commits) and what opening one did. */
export interface PrDraftView {
  ok: boolean; message: string;
  title: string; body: string; base: string; branch: string; commits: number;
  /** A pull request already open for the branch. */
  url: string | null;
}
export interface PrCreateView { ok: boolean; message: string; url: string | null; existing: boolean }

/** Review of a checkout's changes: the files, and one file's diff. */
export type ReviewScope = "branch" | "uncommitted" | "turn";
export interface ReviewFilesView {
  ok: boolean; message: string;
  scope: ReviewScope;
  /** What the files are compared from and to (commits or trees; "" is the empty tree): pass both back to `review.diff`. */
  from: string; to: string;
  /** The branch the changes are counted from, for a title ("main"). */
  base: string;
  files: { path: string; oldPath?: string; status: "A" | "M" | "D" | "R"; additions: number; deletions: number; binary: boolean }[];
  additions: number; deletions: number; capped: boolean;
  /** The agent turns recorded in this worktree, oldest first; `turn` is the one the files are of. */
  turns: { id: string; at: string }[];
  turn: string | null;
}
export interface ReviewDiffView {
  ok: boolean; message: string;
  path: string; binary: boolean; additions: number; deletions: number;
  tooLarge: boolean; truncated: boolean;
  hunks: { header: string; lines: { t: "ctx" | "add" | "del"; o?: number; n?: number; text: string }[] }[];
}
