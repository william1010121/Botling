# Code standards

Read this before you write or review code. It has two parts:

1. **Hard rules.** Breaking one is FIX FIRST in review, with no exceptions.
2. **Common-mistakes checklist.** Every implementer and reviewer handoff includes it word for word, and every
   implementation note answers each item in a "Standards check" section (done / not applicable). Review files say
   "Standards: checked" or "Standards: broken (<items>)".

Where these come from: [`LESSONS.md`](LESSONS.md), the nightly mistake book ([`lessons-retro.md`](lessons-retro.md)).

## Hard rules

Rules arrive here only by promotion: a lesson in `LESSONS.md` seen on 3 different days becomes a
`CS-nn` rule, and a second worker checks every promotion before it lands. Only the owner (or the coordinator bot on
the owner's word) removes a rule.

## CS-01 · Look up a key that comes from data with `Object.hasOwn` (or a `Map`) before `obj[key]`   (from L-003, proposed 2026-11-18)
Why: `constructor`, `__proto__` and `toString` pass id patterns and resolve to built-ins: a prototype-key `via.codeHash` wedged the queue (2026-11-15), `grants[codeHash]` from a stored row needed `Object.hasOwn` (2026-11-16), and `claudeHint` returned the `Object` function for a model id `constructor` (2026-11-17).
Check: A reviewer greps the diff for `[` lookups on data-keyed objects; a test passes `constructor` and `__proto__` as the key.

## CS-02 · Grants, hashes, membership, switches and cached state are checked again where they are used, including after every `await` that can interleave   (from L-008, proposed 2026-11-18)
Why: A check only at the start let later changes through: a crash restart ran code edited after the grant, a revoked module kept running (2026-11-15); a plugin removed during a download was still installed, a revoked row was revived, a bundle id was not rechecked on the press, and a cancel/send race kept `stopped` in the file (2026-11-16); a switch read once at send still moved a line after it was turned off (2026-11-17).
Check: The reviewer lists each `await` in the changed code that follows a check and reads whether the check is repeated after it; a test changes the state during the `await` (a revoke, a switch off, a removal) and expects a refusal.

## CS-03 · Every guard a change adds has a test that fails when the guard is removed; a surviving mutant is FIX FIRST   (from L-010, proposed 2026-11-18)
Why: Mutation batches at review found unprotected guards on all four days: nine guards in M5-07b (2026-11-15), 1 of 16 in the install check (2026-11-16), 6 of 44, 6 of 35 and 7 unprotected guards on the Pin area cards (2026-11-17), and a dozen probes written for survivors on 2026-11-18.
Check: The reviewer's one-connection batch (L-010); every survivor is either killed by a probe in the fix round or named an equivalent mutant in the review with the reason.

Format of a rule:

```markdown
## CS-01 · <one-line rule>   (from L-NNN, promoted YYYY-MM-DD)
Why: what broke when it was not followed (with the lesson's evidence dates).
Check: how a reviewer or a test verifies it (the helper to use, the test to write).
```

## Common-mistakes checklist

Paste this block into every implementer and reviewer handoff. It collects the mistakes that keep coming back in
reviews; the lesson ids point at the evidence in `LESSONS.md`.

```text
Before you say "done" (mistakes found in reviews since 2026-11-15; answer each in your note's
"Standards check" as done or n/a; reviewers check each one):
1. Paths: compare real paths from fs.realpathSync.native (nearest existing ancestor for a new path),
   never typed strings or the JS realpathSync (it keeps the case you typed). Mac volumes are
   case-insensitive, /var is /private/var, /System/Volumes/Data is a firmlink that even .native does
   not fold: also compare dev:ino, or fold that prefix (realPath() in import/run.ts), before a path
   becomes a key or a hash. Path tests pass under the default macOS temp folder. (L-001)
2. Symlink-safe files: stage beside the target (same parent), open with O_NOFOLLOW / "wx", after
   open require fstat = regular file with the same dev:ino as lstat, one same-parent rename at the
   end; reads anchor dev:ino after open; never follow a symlinked folder without a visited set. (L-002)
3. Keys from data: Object.hasOwn(obj, key) or a Map before obj[key] ("constructor", "__proto__",
   "toString" pass id patterns). (L-003)
4. Text from a peer, a user, a row or a file name: one clean line (botName()), control characters
   escaped, quotes via JSON.stringify, before it reaches a prompt, a briefing, a report, a log or the
   terminal. (L-004)
5. Secrets: never in error text, reports, logs or a durable outbox; name the file, not its
   contents. (L-015)
6. Sizes: limits count JSON-escaped UTF-8 bytes with the header room, against the right constant;
   test the largest legal input (CJK, newlines, longest path). (L-005)
7. Ids from outside used as a path part: /^[A-Za-z0-9_-]{1,64}$/ first; "." and ".." must fail.
   (L-006)
8. UI and retries: a double tap, a retry, Back or Review never sends twice (in-flight guard in a
   ref; a retry reuses the same request id and choice); a duplicate reply is dropped. (L-007)
9. Authority at use: re-check grants, hashes, membership and cached state where they are used
   (each chunk, crash restart, hot swap, revoke, after every await). (L-008)
10. Fail closed: a check that throws, a null / unknown / missing value, missing config, a timeout
    or a failed send refuses; never 500, "allowed" or a skipped check. (L-009)
11. Tests: every guard has a test that fails when it is removed; the implementing worker only writes
    the tests and runs the related test files, it does NOT run a mutation check (the reviewer does it once,
    as one batch, see L-010); each fix commit brings its own probe test; timing or two-process tests repeat their 10 runs inside one remote-test run (loop on the host), not as 10 runs;
    packaged-only branches get a test that simulates packaged mode. (L-010, L-012, L-013, L-014)
12. Before review: merge your base (main or the open batch) so the review sees the merged tree; the related tests of
    both sides run once on it, inside your budget of at most 2 remote-test runs (no `--typecheck`); the one full
    typecheck run happens after the merge into main. When a test breaks for a cause, fix every test with that
    cause. Over the budget: stop and report. (L-011)
13. Test budget: at most 1–2 `remote-test.sh` runs per step (implementing 2, review 1, fix 1, re-review 0),
    only related test files, no `--typecheck`; one full `--typecheck` confirmation after the merge into main,
    then build. Never rerun to be sure. (AGENTS.md "Test budget")
```

Hand-offs also paste every hard rule above (none yet) and the one-line rules of the lessons whose tags match the
card (`fs`, `wire`, `ui`, `grant`, `import`, `test`, `merge`, `secret`, `build`).
