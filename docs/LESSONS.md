# Lessons (the nightly "mistake book")

Every night a worker looks back at the day's commits and reviews and writes down what went wrong, so the same
mistake is not made a fourth time. The procedure is in [`lessons-retro.md`](lessons-retro.md). Hard rules that came
out of this file are in [`code-standards.md`](code-standards.md).

Last run: 2026-11-15T16:17+08:00 (main at `76cb33b5`; all `bot/v3-*` commits and review files up to that time)

## What goes in

Three kinds of mistakes, one category per evidence line:

| Category | Means | Typical signal |
|---|---|---|
| `rework` | fixed, then reworked | a re-review or third review, a follow-up branch, a fix that brought a new finding |
| `bad-merge` | should not have merged | main or a batch fails after the merge, a revert, a batch sent back |
| `thin-check` | verification too thin | a guard that survives the mutation check, a test that passes without the guard, a skipped or flaky test, "not verified" in a note |

## Entry format

```markdown
## L-NNN · <one-line rule>
- Rule: what to do, concrete enough that a reviewer can check it.
- Why: what broke (or would have) when it was not done.
- Tags: fs, wire, ui, grant, import, test, merge, secret, build (the ones that apply)
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - <date> | <category> | <review file> <finding ids> (what happened) | fix <commit>, merge <commit>
```

- **Evidence** names real commits (short hashes that `git cat-file -e` accepts) and review files by name
  (`.bot/artifacts/v3-m*/<card>-review.md` in the main checkout, which is not tracked by git).
- **Days** = the number of distinct dates in the evidence lines (Asia/Taipei; the date of the review or commit, not
  the night the retro ran). Several cards making the same mistake on one day count as one day. The `Status` line
  lists the dates seen.
- **Status** is one of `open`, `proposed → CS-nn` (promotion waiting for its check), `promoted → CS-nn`.

## Promotion rule

- A lesson seen on **3 different days** while `open` is proposed for promotion: the retro worker writes the rule as
  `CS-nn` in `code-standards.md` in a separate commit on the retro branch and sets the status to `proposed → CS-nn`.
- **A second worker checks every promotion before it lands** (the evidence is real, the rule is right and not too
  wide, the `Check:` line can actually be checked). Only then is the branch merged and the status set to
  `promoted → CS-nn`. A rejected proposal is reverted on the branch and the lesson stays `open` with a note why.
- After promotion, new evidence is still recorded. Seen on 2 more days after promotion → the retro proposes a
  mechanical guard (a shared helper, a test or a lint rule) instead of more words.
- Only the owner (or the coordinator bot on the owner's word) removes a hard rule.

## Lessons

## L-001 · Compare paths by their real path from `realpathSync.native`
- Rule: before comparing, nesting or hashing a path, resolve it with `fs.realpathSync.native` (nearest existing
  ancestor for a path that does not exist yet). Never compare typed strings, and never use the JS `realpathSync`,
  which keeps the case it was given. Tests that compare paths must pass under the default macOS temp folder.
- Why: the Mac's default volume is case-insensitive (`V2` and `v2` are one folder), `/var` is `/private/var`, and
  `/System/Volumes/Data/...` is a firmlink to the same folder. String compares let an import write into the 2.x data
  folder and let one folder get two "imported once" keys. `realpathSync.native` fixes the case and the `/var` link
  (the JS `realpathSync` also resolves `/var`, but keeps the case), but it does **not** fold a firmlink spelling, so
  also compare dev:ino, or fold the `/System/Volumes/Data` prefix as `realPath()` in `import/run.ts` does, before a path
  becomes a key or a hash.
- Tags: fs, import, test
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | rework | `M6-05-review.md` #1 #2 (a target spelled in another case lands inside the 2.x folder; the same bug flagged in M6-01d's `run.ts`) | fix `0a836552`
  - 2026-11-15 | rework | `M6-01d-review.md` first round #1, then re-review #1 #2 (after fix rounds `c9212f98` and `865bec8d`, a folder was still compared as a string with the real path, and a firmlink spelling got a second `sourceHash`) | fix `6c507df0`, merge `76cb33b5`
  - 2026-11-15 | thin-check | `M5-07b-review.md` R2 (`.PARTIAL/` on a case-insensitive disk: success reported, files lost) | fix `3ed7e622`
  - 2026-11-15 | rework | `M5-07a-review.md` re-review T1 (a test compared the asked path with the stored real path; passed only with a temp folder that has no symlink) | fix `6867ce4a`

## L-002 · Symlink-safe file access: stage beside, `O_NOFOLLOW`, dev:ino, one rename
- Rule: a write into a folder someone else can change stages next to the target (same parent), opens with
  `O_NOFOLLOW` / `"wx"`, checks after open that `fstat` is a regular file with the same dev:ino as `lstat`, and ends
  with one rename inside the same parent. A read anchors dev:ino after open and re-checks the real path. A folder walk
  never follows a symlinked folder without a visited set.
- Why: a symlink can be swapped in between the check and the write; `rename` and `copyFileSync` follow it. Today this
  let a bot redirect the requester's writes outside `<dest>`, copy outside files into the trusted `imported/` area,
  and reach `server.db`.
- Tags: fs, import
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | rework | `M5-07a-review.md` M5 (dev:ino anchor taken without checking the opened file is at the checked path), L1 (symlink loop, unbounded recursion) | fix `86f6347f`
  - 2026-11-15 | rework | `M5-07b-review.md` R1a R1b (a symlinked staging folder or `<dest>/sub` sends writes outside `<dest>`) | fix `3ed7e622`
  - 2026-11-15 | rework | `M6-05-review.md` #3 #4 #5 (copy follows links at copy time; a link under `imported/` reaches `server.db`; an existing `imported` link sends copies elsewhere) | fix `0a836552`, test `2350ea73`
  - 2026-11-15 | rework | `M6-01d-review.md` #1 (a symlinked target path writes into the 2.x folder), re-review #3 #4 (a link inside the target; a hard link to the secrets file) | fixes `c9212f98`, `6c507df0`
  - 2026-11-15 | thin-check | `M5-06a-followup-review.md` F1 (an artifacts link to the bot folder made the whole folder `free`) | fix `c9322e83`

## L-003 · Look up keys that come from data with `Object.hasOwn`
- Rule: before `obj[key]` with a key from a peer, device, plugin, row or file, check `Object.hasOwn(obj, key)`, or use
  a `Map`.
- Why: `constructor`, `__proto__` and `toString` pass the id patterns and resolve to built-ins; the check threw inside
  the decision and wedged the origin's queue.
- Tags: wire, grant
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-15-review.md` F1 (a prototype-key `via.codeHash` throws and wedges the queue) | fix `912d34c5`, merge `fdb4223f`

## L-004 · Clean outside text before it reaches a prompt, briefing, report, log or terminal
- Rule: names, row contents, file names and other text from a peer, a user or a file become one clean line
  (`botName()` or the same rules), control characters escaped (`\xNN`), quoted with `JSON.stringify` when quoted.
- Why: a newline in a peer bot's name wrote an `(App: …)` line into the main bot's briefing; a file name with a line
  break forged report lines and an ESC sequence reached the terminal; a quote inside an item closed the quoting.
- Tags: wire, ui, import
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-04c-review.md` F1 (peer names write lines into the main bot's briefing) | fix in merge `4685c93a`
  - 2026-11-15 | rework | `M5-14b-review.md` F4, re-review R2 (a quote inside a reads item closes the quoting) | fix `b8f48dda`, merge `bb212ac7`
  - 2026-11-15 | thin-check | `M6-05-review.md` #7 (report paths printed raw) | fix `0a836552`

## L-005 · Size limits count JSON-escaped UTF-8 bytes, header included
- Rule: a limit on something sent in a frame counts the bytes of its JSON-escaped UTF-8 form plus the header room;
  check it against the right constant; test the largest legal input (CJK text, newlines, the longest path).
- Why: a schema that counts characters let a legal call-in grow past one frame (CJK and newlines expand), which jams
  the origin's queue; a 64 KiB chunk with a long path did not fit the bulk lane; a 500 MiB limit was checked against a
  2 GiB constant.
- Tags: wire
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | rework | `M5-01-review.md` F1 (a schema-valid call-in can be larger than one frame) | fix `0d52c396`, merge `55c6cd6e`
  - 2026-11-15 | thin-check | `M5-07b-review.md` R3 (a 64 KiB chunk with a path over ~870 bytes does not fit the direct bulk lane; the wire test used a 4-byte payload) | fix `3ed7e622`
  - 2026-11-15 | thin-check | `M5-07a-review.md` H3 (the 500 MiB per-request limit checked against 2 GiB) | fix `86f6347f`, merge `a34f4c55`

## L-006 · An id from outside passes a strict pattern before it becomes a path part
- Rule: test `/^[A-Za-z0-9_-]{1,64}$/` (or a stricter id type) before building a path from an outside id; `.` and
  `..` must fail. Schema types such as `RowKey` and `ContractId` are not path-safe.
- Why: a peer row `bot:..` made the inbox path point one level up; the main bot's own `inbox.md` was read, sent to the
  peer and emptied.
- Tags: fs, wire
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-04c-review.md` F2 (a peer bot id used as a path part unchecked) | fix in merge `4685c93a`

## L-007 · A retry, a duplicate or a double tap acts once
- Rule: a UI action has an in-flight guard (a ref, not state, because two taps in one batch see the old state); a
  retry, Back or Review resends nothing already sent and reuses the same request id and the same choice; a protocol
  handler drops a duplicate reply for a slot that is no longer pending.
- Why: a double tap sent two grants per machine; after the first fix, Done → Review re-ticked the old tier and sent
  a second grant at a different tier; a duplicate `slot conflict` notified the caller twice.
- Tags: ui, wire
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | rework | `M5-14b-review.md` F2, then re-review R1 (the F2 fix `291f0d84` still resent after Done → Review) | fix `b8f48dda`, merge `bb212ac7`
  - 2026-11-15 | rework | `M5-04a-review.md` re-review N1 (a duplicate slot conflict notifies twice; introduced by the F3 fix in `358dbdc6`) | fix in merge `e2f4ba62`

## L-008 · Check authority and state again at the moment of use
- Rule: grants, code hashes, membership and cached state are checked where they are used: before each chunk, on a
  crash restart, on hot swap, on revoke, at the running hash, and again after every `await` that can interleave with
  a change.
- Why: a check only at the start lets later changes go unnoticed: a crash restart ran code edited after the grant, a
  revoked module kept running, a removed requester kept receiving chunks, the window showed a stale grant, and a
  reload put a removed secret back.
- Tags: grant, wire
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-18a-review.md` F1 F2 (a crash restart loads code changed after the grant check; a revoke does not stop the module) | fix `1e4f4f30`, merge `be8be56b`
  - 2026-11-15 | thin-check | `M5-14d-review.md` F1 (the shown grant goes stale after a hot swap) | fix `6887f7cc`
  - 2026-11-15 | thin-check | `M5-07a-review.md` H2 (the requester is not re-checked before each chunk) | fix `86f6347f`
  - 2026-11-15 | thin-check | `M5-14a-review.md` F1 (an old hash's grant raised with the current manifest's asks) | fix `9b599a05`
  - 2026-11-15 | thin-check | `M5-17-review.md` M1 (peer content checked at the owner's hash, not the running hash) | fix `da729e90`, merge `0086c220`
  - 2026-11-15 | thin-check | `M6-06-review.md` F2 (a reload that resolves after a removal brings the old secret back) | fix `0d68b87d`

## L-009 · A check that errors, or meets a missing value, refuses
- Rule: a check that throws, a null, unknown or missing value, a missing config, a timeout or a failed send refuses
  (403 / denied / corrupt), never 500, "allowed", or a silently skipped check. Required inputs to a check are
  required parameters.
- Why: a corrupt row gave 500 instead of 403; a missing `dataDir` silently turned the data-folder check off; a chunk
  before the grant was accepted; a failed send was ignored and chunks still flowed.
- Tags: grant, fs, wire
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-17-review.md` L1 (a corrupt row or reader failure gives 500 / `gone{offline}`) | fix `da729e90`
  - 2026-11-15 | thin-check | `M5-06a-review.md` item 2 (`isDeniedPath` fails open) | fix `de449fb7`, merge `49a5cd51`
  - 2026-11-15 | rework | `M5-06a-followup-review.md` F2 F3 (after that follow-up, a missing `dataDir` still turned the check off, and `dataDir` was optional) | fix `c9322e83`
  - 2026-11-15 | thin-check | `M5-07b-review.md` R4 (a chunk before `fetch.grant` is accepted) | fix `3ed7e622`
  - 2026-11-15 | thin-check | `M5-07a-review.md` H3 (a `false` from `sendWire` ignored, chunks still flow) | fix `86f6347f`

## L-010 · Every guard has a test that fails when the guard is removed
- Rule: write a test that fails when each guard you added is removed; an assertion that passes either way is
  replaced. The implementing worker does NOT run the mutation check, only writes the tests and runs the related
  test files. The reviewer runs the mutation check once, as one batch (see "Mutation check at review" below).
- Why: the mutation check kept finding guards whose removal no test noticed, and one assertion that was vacuous.
  Since 2026-11-16 (user decision) the check moves from every worker to the review: each mutant was its own commit
  and its own queued remote-test run, and queueing for the Linux test host took 39% of worker time.
- Mutation check at review: one `remote-test.sh` connection, one worktree on the host. `remote-test.sh` has no batch
  mode yet, so pass it one script (as the command to run on the host, or a small `mutate.sh` committed once with the
  review) that, for each mutant in turn, patches the file (`sed` or `git apply mutant-N.patch`), runs vitest on the
  related test files only, records pass/fail, then restores with `git checkout -- <file>`. No commit and no separate
  queue entry per mutant. A mutant whose tests still pass is a finding (a guard no test protects).
- Tags: test
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-07b-review.md` F2 (nine guards survive mutation, the wrong-peer guard included) | tests in `3ed7e622`
  - 2026-11-15 | thin-check | `M5-15-review.md` F3 (mutants M1 and M9 survive; test 5's assertion is vacuous) | fix `912d34c5`
  - 2026-11-15 | thin-check | `M5-18a-review.md` F5 (7 of 12 mutants survive the branch's tests, "the check throws → allowed" among them; with the fix 4 redundant guards still survive) | fix `1e4f4f30`
  - 2026-11-15 | thin-check | `M5-14d-review.md` F2 (`catch` → `write`, fail open, survives) | fix `6887f7cc`
  - 2026-11-15 | thin-check | `M5-04c-review.md` N1 (mutant M9 survives) | fix in merge `4685c93a`

## L-011 · Run both sides' related tests on the merged tree before merging, and sweep a cause across all tests
- Rule: before review and again before merge, merge the base (main or the open batch) into the branch and run the
  related tests of both sides on the merged tree. When a test breaks for a cause (a minted id, a new row kind, a new
  count), search every test for the same cause in the same fix.
- Why: parallel branches were green alone and broke together. After M5-04g (`ff352ce8`) changed how the main bot and
  Maintainer ids are made, tests on main failed; the first fix repaired two of them, five more with the same cause
  failed until a second fix, and a later merge (`be8be56b`) was blamed in the meantime.
- Tags: merge, test
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | bad-merge | `fix-main-tests-review.md` (tests failing on main since M5-04g `ff352ce8` and M5-13a) | fix `8f296801`, merge `5159a781`
  - 2026-11-15 | bad-merge | (no review file; commit message) five more botlingd tests failing on main since `ff352ce8`, first blamed on M5-18a `be8be56b` | fix `fad57516`, merge `4dbe4909`
  - 2026-11-15 | thin-check | `M5-14a-review.md` F2 (`server-intents.test.ts` intent count broken by the change) | fix `9b599a05`
  - 2026-11-15 | thin-check | `M5-18a-review.md` F6 F7 (five-file textual and semantic overlap with M5-14d; failures already on main) | merge `8785ba3f`

## L-012 · A fix commit gets its own probe tests and a fresh mutation check
- Rule: each fix in a review round comes with the probe that failed before it, and the reviewer's mutation check (one batch,
  see L-010) is run again on the fixed code, including the paths the fix itself added.
- Why: fixes brought new findings or were only half done, so cards needed a second or third review.
- Tags: test
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | rework | `M5-04a-review.md` re-review N1 (introduced by the F3 fix in `358dbdc6`) | fix in merge `e2f4ba62`
  - 2026-11-15 | rework | `M5-14b-review.md` re-review R1 (the F2 fix `291f0d84` passed its test only because the tier sent equalled the rows' tier) | fix `b8f48dda`
  - 2026-11-15 | rework | `M5-07a-review.md` re-review T1 T2 (the fix round `86f6347f` needed test fixes) | fix `6867ce4a`
  - 2026-11-15 | rework | `M6-01d-review.md` re-review #1 #2 (two medium findings after the fix round `865bec8d`; the fold also left the inode check untested) | fix `6c507df0`

## L-013 · A branch that runs only in the packaged app gets a test that simulates packaged mode
- Rule: when code behaves differently when packaged (`app.isPackaged`, Electron fuses, `ELECTRON_RUN_AS_NODE`,
  `process.execPath`), add a unit test that drives the packaged branch without starting Electron or opening windows.
- Why: with the RunAsNode fuse off, `ELECTRON_RUN_AS_NODE=1` is ignored, so packaged `botlingd` would have started
  the app itself instead of its plugin host and PDF job; the branch's 39 tests passed.
- Tags: build, test
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M6-07c-review.md` F1 F2 (branch `f460f996`: packaged children spawned as the app) | fix `e7580d9d`

## L-014 · A timing or two-process test passes many runs in a row before hand-off
- Rule: a new test that starts servers, waits on timers or races processes is run at least 10 times in a row before
  hand-off; assert on the thing the card promises, not on a side effect that appears at a varying time.
- Why: the M5-04c two-server test failed in 2 of 16 runs because of one wrong assertion, which cost a re-review round.
- Tags: test
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M5-04c-review.md` re-review (two-server test flaky, 2 of 16 runs) | fix `43cbda13`

## L-015 · Secret bytes never reach error text, reports, logs or a durable queue
- Rule: an error about a secrets file names the file, not its contents (no raw parser message); a secret typed in a
  window is never written in plaintext to an outbox, log or report.
- Why: a broken `plugin-secrets.json` put part of a sealed token into stdout and `import-report.md` through Node's
  JSON error text; a plugin token typed in the window was fsynced in plaintext to the window's outbox.
- Tags: secret, import
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M6-01d-review.md` #3 (a broken secrets file quoted into stdout and the report) | fix `c9212f98`
  - 2026-11-15 | thin-check | `M6-06-review.md` F1 (a typed secret lands in plaintext in the window's durable outbox) | fix `0d68b87d`

## L-016 · A snapshot that proves a folder was not changed records every item's kind, content hash and link target
- Rule: a test that proves a folder (for example the 2.x folder after an import) was not changed snapshots every item,
  not just regular files: its kind (file, folder, symlink), a content hash for each file, and the target for each
  symlink (links are not followed). The test has two mutation checks that the snapshot catches: creating an empty
  folder in the folder, and rewriting a file with the same bytes. Fixture files get an old fixed mtime, so a rewrite
  always shows in the snapshot.
- Why: the M6-10b snapshot compared only sizes and mtimes, so a same-size rewrite with restored mtime went unseen; the
  M6-09 snapshot listed only regular files, so an empty folder or a link added to the 2.x root passed (mutant M3).
- Tags: 2.x, import, tests
- Status: open · days 1 of 3 (2026-11-15)
- Evidence:
  - 2026-11-15 | thin-check | `M6-10b` fix check (snapshot compared size and mtime, not content) | fix `dd6823ac`
  - 2026-11-15 | thin-check | `M6-09-review.md` F1 (snapshot skipped folders and symlinks; mutant M3 survived) | fix `c833a081`

## Watch list (seen once, not a lesson yet)

- Plugin names matched by prefix: a `write` plugin `my` could run `my.plugin`'s commands
  (`M5-15-review.md` F2, fix `912d34c5`). Becomes a lesson if a second name-prefix bug shows up.
- One helper copied into three files (`isPackagedElectron()`, `M6-07c-review.md` F3, fix `e7580d9d`).
