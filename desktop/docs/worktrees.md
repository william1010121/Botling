# App-managed git worktrees (Botling 2.2)

Before: the developer-mode briefing (`core/app-swap.ts`) only told the agent to run `git worktree add`
itself. Nothing tracked those worktrees, cleaned them up, or knew where an agent was working.
Now the app makes, tracks and removes them (`core/worktrees.ts`), and tells the engine session where to run.

## Data model

One `WorktreeManager` per bot. Its project folder is the main checkout. Records are kept in
`<bot store dir>/worktrees.json`:

    { version: 1, current: <id|null>, items: [ WorktreeRecord ] }

| field | meaning |
| --- | --- |
| `id` | UUID |
| `branch` | `bot/<slug>`, made by the app (matches the pattern `core/agent/isolated-git.ts` accepts) |
| `path` | the checkout |
| `base`, `baseCommit` | the branch it was made from and merges back into, and where that pointed |
| `task`, `owner` | the task card and the engine or worker it was made for (free text, may be null) |
| `status` | `active`, `merged` or `abandoned`; closed records are kept for history (last 20) |

`list()` adds live counts from git: changed files, commits ahead of the base, and `missing` when the folder is gone.

## Where they live

`<root>/<slug>`, one folder per worktree, `-2`, `-3`... on a name clash. Root, in order:

1. the "Worktree folder" setting, if set;
2. the developer project, when the work drive exists (`devWorkRoot()`, `/Volumes/My-SSD/botling-work` here), so the
   path is flat like `isolated-git.ts` expects;
3. `<data dir>/worktrees/<bot id>`.

Never inside the project folder: creating files there would touch the main checkout.

## Lifecycle

1. **Create** (`New worktree`): `git worktree add -b bot/<slug> <path> <base commit>`; base defaults to the branch the
   main checkout is on. The first active worktree becomes the bot's *current* one.
2. **Work**: the agent session runs in the current worktree (below).
3. **Merge into base**: the worktree must be clean (commit first); the main checkout must be on the base branch with no
   uncommitted changes. The base is merged into the branch *inside the worktree* (a conflict is found and
   `merge --abort`ed there, the files listed), then the main checkout fast-forwards (`--ff-only`). Then the worktree
   is removed and the branch deleted with `-d`. Record becomes `merged`.
4. **Discard**: removes worktree and branch. With uncommitted changes or unmerged commits it refuses
   (`dirty`/`unmerged`) until called with `force`, which the UI only does after the user confirms a dialog naming
   what will be lost. Record becomes `abandoned`.
5. Review (`core/review.ts`): see "Review" below. Commit and Open PR: see the end of that section.

Safety: the main checkout is changed only by the ff-merge in step 3; nothing is removed except by `git worktree remove`
on a path that is recorded and listed by `git worktree list`; every refusal says what happened ("nothing was merged").

## How the agent is told where it is

A session's working directory is fixed when its process starts, so it is per bot, not per message:

- Claude: `HeadConfig.cwd` = the current worktree.
- Codex: `CodexHeadConfig.cwd`; Codex workers (`startWorkerThread`) and monitored commands use the same `cwd`, so
  workers land in the worktree too. Native subagents inherit the session cwd.
- The bot's `.bot` folder (memory, inbox) stays in the project folder; it is passed as an extra `--add-dir` /
  writable root so memory still works. No other permission changes.
- Changing the current worktree (or merging/discarding it) restarts the idle session on the new folder, with a note.
- If the worktree is missing or git no longer lists it, the session falls back to the project folder.

Developer-mode briefing: when the feature is on and a worktree is current, the "do each task in a git worktree"
rule is replaced by "the app gave you a worktree (branch X at path Y): work there, commit there, do not run
`git worktree` yourself; the app merges it". With the feature off, or no current worktree, the old rule is
unchanged as the fallback.

## Setting

`worktrees` (Settings -> Developer, default **on**): turns on the Worktrees control in the chat header and the cwd
selection and prompt wording above. On by default because nothing happens until the user presses "New worktree"
(or a worktree exists), so it costs non-developers nothing; the control only appears for projects that are the
main checkout of a git repository. `worktreeRoot` overrides the folder.

## Review (diff API)

`review.files` / `review.diff` (contract) read what changed in a worktree, or in the project's main checkout
(`worktreeId: null`, against HEAD). Read only: nothing in the checkout, its index or its refs is changed.

- **Comparison.** The end is always a *tree of the working directory now* (`snapshotTree`: a temporary copy of the
  index, `git add -A`, `git write-tree`; only objects are written, ignored files are left out). So uncommitted and
  untracked files are in it, with no `git add -N`. The start depends on the scope:
  - `branch`: the merge-base of the base branch and HEAD (everything the worktree adds, committed or not);
  - `uncommitted`: HEAD;
  - `turn`: the tree recorded when that agent turn began, up to the tree recorded when the next one began (or now).
- `review.files` returns the files (A/M/D/R, +/-, binary) and the `from`/`to` it used; `review.diff` takes both back so
  the list and every file are of the same two trees.
- **Guards.** At most 1000 files listed. One file is shown up to 2000 changed lines; a bigger one comes back
  `tooLarge` with no hunks until asked again with `force`, which then caps at 20000 lines. A line over 2000
  characters is cut. Paths must be inside the checkout; `from`/`to` must be object ids.
- **Per-turn snapshots.** On each `turn.started` of a bot whose session runs in an app-made worktree, the desk records
  that worktree's tree (`<bot store dir>/review-turns.json`, last 30 per worktree, dropped on merge/discard). It is
  taken asynchronously at the start of the turn, so a file the agent writes in the first milliseconds is counted in
  the turn before it. A session in the project folder records nothing (the project folder is somebody's checkout).
