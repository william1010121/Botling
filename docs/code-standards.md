# Code standards

Read this before you write or review code. It has two parts:

1. **Hard rules.** Breaking one is FIX FIRST in review, with no exceptions.
2. **Common-mistakes checklist.** Every implementer and reviewer handoff includes it word for word, and every
   implementation note answers each item in a "Standards check" section (done / not applicable). Review files say
   "Standards: checked" or "Standards: broken (<items>)".

Where these come from: [`LESSONS.md`](LESSONS.md), the nightly mistake book ([`lessons-retro.md`](lessons-retro.md)).

## Hard rules

_None yet._ Rules arrive here only by promotion: a lesson in `LESSONS.md` seen on 3 different days becomes a
`CS-nn` rule, and a second worker checks every promotion before it lands. Only the owner (or the coordinator bot on
the owner's word) removes a rule.

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
11. Tests: every guard has a test that fails when it is removed (run the mutation check); each fix
    commit brings its own probe test; timing or two-process tests pass 10 runs in a row;
    packaged-only branches get a test that simulates packaged mode. (L-010, L-012, L-013, L-014)
12. Before review: merge your base (main or the open batch) and run the related tests of both
    sides on the merged tree; when a test breaks for a cause, fix every test with that cause. (L-011)
```

Hand-offs also paste every hard rule above (none yet) and the one-line rules of the lessons whose tags match the
card (`fs`, `wire`, `ui`, `grant`, `import`, `test`, `merge`, `secret`, `build`).
