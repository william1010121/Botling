# Nightly lessons retro

The procedure one worker follows each night to update [`LESSONS.md`](LESSONS.md) and, when a lesson has earned it,
to propose a hard rule for [`code-standards.md`](code-standards.md). It takes about 15 minutes. Use the strong model
(opus): a promoted rule binds every later worker.

The retro writes only `docs/LESSONS.md` and `docs/code-standards.md`. It never changes code, `spec/`, `AGENTS.md` or
the review files, and never commits to main.

## 1. Set up

- Date `D` = today in Asia/Taipei (`TZ=Asia/Taipei date +%F`).
- Base: `main`. If an earlier `bot/v3-lessons*` branch is not merged into main yet
  (`git branch --no-merged main --list 'bot/v3-lessons*'`), start from the newest of those instead, so the day
  counts carry over, and say so in the report.
- `git worktree add .bot/worktrees/v3-lessons-D -b bot/v3-lessons-D <base>` (no `link-deps.sh` needed; no build or
  tests run).
- Window: from the `Last run:` time in `LESSONS.md` to now. A missed night is not lost: the window covers every day
  since the last run.

## 2. Read

Everything in the window, from the main checkout (the review files live in its `.bot/artifacts/`, which is not
tracked by git):

1. Commits on main and on every `bot/v3-*` branch:
   `git log --all --since='<Last run>' --format='%h %ad %s' --date=iso-local`, then the full message of anything
   whose subject has `review fix`, `re-review`, `follow-up`/`followup`, `Revert`, `fix`, `stale`, `broken` or
   `flaky`. Merge messages carry the card and the review verdict.
2. Review files changed in the window: `.bot/artifacts/v3-m*/*-review.md` (find them with `find … -newer` or by the
   date in their headings). A `Re-review`, `Third review`, `Follow-up review` or `Fix round` section is rework; read
   the findings, the mutation tables and the coordinator decisions.
3. Fix rounds: the `*-review-fix*.diff`, `*-rereview-*.diff` and probe files next to the reviews.
4. Card notes `.bot/artifacts/v3-m*/M*.md`: the "Standards check", "not verified" and "skipped" parts.
5. Batch notes `.bot/artifacts/v3-batches/batch-*.md` and `known-failing.md` (new failures, batches sent back), and
   remote test logs `.bot/artifacts/remote-tests/` if present.

## 3. Find

| Category | Look for |
|---|---|
| `rework` | a second or later review of the same card, a follow-up branch, a finding introduced by a fix, a fix that was only half done |
| `bad-merge` | main or a batch failing after a merge, a revert, a batch sent back, a fix for tests "broken since" a merge |
| `thin-check` | guards that survived the mutation check, vacuous assertions, flaky or skipped tests, a bug reachable only in a case the tests never ran (case-insensitive disk, packaged app, largest input), "not verified" in a note |

Skip findings that are only wording or info level, unless the same thing keeps coming back.

## 4. Write

For each finding:

1. **Match first.** If an existing lesson's rule would have prevented it, add one evidence line there:
   `- <date> | <category> | <review file> <finding ids> (what happened, a few words) | fix <hash>, merge <hash>`.
   The date is the date of the review or commit (Asia/Taipei), not tonight. If the rule needs to be a little wider
   to cover it, widen the wording and keep the id.
2. **Otherwise add a lesson** `L-NNN` (next free number) in the format at the top of `LESSONS.md`: Rule, Why, Tags,
   Status, Evidence. At most 10 new lessons a night; prefer medium-or-worse findings and repeats. A pattern seen once
   at low severity goes on the watch list instead.
3. **Recount days** for every lesson you touched: the number of distinct dates in its evidence lines. Update the
   `Status` line: `open · days N of 3 (date, date, …)`.
4. Verify every hash you wrote: `git cat-file -e <hash>^{commit}` must succeed. Verify every review file you named
   exists. No secrets, IP addresses, host names, emails or home paths in the files.
5. Update `Last run:` to now (`TZ=Asia/Taipei date +%Y-%m-%dT%H:%M%z`) with main's head hash.

Commit 1, on `bot/v3-lessons-D`: `lessons: retro D (N new, M updated)`.

## 5. Propose promotions

A lesson whose status is `open` and whose days reach 3 is proposed:

1. Add `## CS-nn · <rule>   (from L-NNN, proposed D)` to the "Hard rules" section of `code-standards.md`, with
   `Why:` (citing the evidence dates) and `Check:` (the helper, test or review step that verifies it). Keep the rule
   as narrow as the evidence: a hard rule is FIX FIRST for everyone.
2. Set the lesson's status to `proposed → CS-nn`.
3. If the lesson is also an item of the common-mistakes checklist, leave the checklist as it is; the coordinator
   updates it when the rule lands.

Commit 2 (one per promotion), on the same branch: `lessons: propose CS-nn from L-NNN`.

The proposal lands only after **a second worker** (not the retro worker; opus) checks it: the evidence lines are
real and are the same mistake, the rule is right and not wider than the evidence, the `Check:` line can be done. On
a pass the coordinator changes the status to `promoted → CS-nn` and the heading's "proposed" to "promoted", then
merges. On a fail the commit is reverted on the branch, and the lesson goes back to `open` with one line saying why.

For a lesson already `promoted`: record new evidence as usual. When it has been seen on 2 more days after its
promotion, propose a mechanical guard in the report (a shared helper, a test or a lint rule). The coordinator decides.

## 6. Report

Never merge or push. The coordinator merges the branch into the open batch (or main). Report in at most 5 lines:

1. Branch and commit(s) (`bot/v3-lessons-D`, hashes).
2. New lessons: id and one-line rule each.
3. Lessons with new evidence and their day counts; the most repeated mistake of the window.
4. Promotion proposals (`CS-nn` from `L-NNN`), or "none", and any mechanical-guard proposal.
5. Anything not read or not verified (a missing review file, an unknown hash).
