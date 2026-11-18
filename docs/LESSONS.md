# Lessons (the nightly "mistake book")

Every night a worker looks back at the day's commits and reviews and writes down what went wrong, so the same
mistake is not made a fourth time. The procedure is in [`lessons-retro.md`](lessons-retro.md). Hard rules that came
out of this file are in [`code-standards.md`](code-standards.md).

Last run: 2026-11-19T03:00+08:00 (main at `16e9698e`; commits on main and all `bot/*` branches since 2026-11-18T12:07, no review files changed in the window; the chat archive was not read).

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
- Tags: fs, wire, ui, grant, import, test, merge, secret, build, web, components (the ones that apply)
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
- Status: open · days 2 of 3 (2026-11-15, 2026-11-16)
- Evidence:
  - 2026-11-15 | rework | `M5-07a-review.md` M5 (dev:ino anchor taken without checking the opened file is at the checked path), L1 (symlink loop, unbounded recursion) | fix `86f6347f`
  - 2026-11-15 | rework | `M5-07b-review.md` R1a R1b (a symlinked staging folder or `<dest>/sub` sends writes outside `<dest>`) | fix `3ed7e622`
  - 2026-11-15 | rework | `M6-05-review.md` #3 #4 #5 (copy follows links at copy time; a link under `imported/` reaches `server.db`; an existing `imported` link sends copies elsewhere) | fix `0a836552`, test `2350ea73`
  - 2026-11-15 | rework | `M6-01d-review.md` #1 (a symlinked target path writes into the 2.x folder), re-review #3 #4 (a link inside the target; a hard link to the secrets file) | fixes `c9212f98`, `6c507df0`
  - 2026-11-15 | thin-check | `M5-06a-followup-review.md` F1 (an artifacts link to the bot folder made the whole folder `free`) | fix `c9322e83`
  - 2026-11-16 | rework | `plugin-update-review.md` F1b (the stat cache in `revisionVerified` did not see a link put into a built-in plugin's folder, so the link kept the built-in's rights) | fix `efbb3670`, merge `d1d1d75e`

## L-003 · Look up keys that come from data with `Object.hasOwn`
- Rule: before `obj[key]` with a key from a peer, device, plugin, row or file, check `Object.hasOwn(obj, key)`, or use
  a `Map`.
- Why: `constructor`, `__proto__` and `toString` pass the id patterns and resolve to built-ins; the check threw inside
  the decision and wedged the origin's queue.
- Tags: wire, grant
- Status: promoted → CS-01 (days 3 of 3: 2026-11-15, 2026-11-16, 2026-11-17)
- Evidence:
  - 2026-11-15 | thin-check | `M5-15-review.md` F1 (a prototype-key `via.codeHash` throws and wedges the queue) | fix `912d34c5`, merge `fdb4223f`
  - 2026-11-16 | thin-check | (commit message of the plugin-trust review fix round) `grants[codeHash]` read with a hash from a stored row without `Object.hasOwn` in `plugin-admin.ts`; the admin list also needed an own-key check | fix `31b30cb4`
  - 2026-11-17 | thin-check | `claude-models-open-review.md` S3 (`claudeHint` looked a model id from settings up as `CLAUDE_HINT[model]`; `constructor` returned the `Object` function) | fix `9ece868f`, merge `613be3ba`

## L-004 · Clean outside text before it reaches a prompt, briefing, report, log or terminal
- Rule: names, row contents, file names and other text from a peer, a user or a file become one clean line
  (`botName()` or the same rules), control characters escaped (`\xNN`), quoted with `JSON.stringify` when quoted.
- Why: a newline in a peer bot's name wrote an `(App: …)` line into the main bot's briefing; a file name with a line
  break forged report lines and an ESC sequence reached the terminal; a quote inside an item closed the quoting.
- Tags: wire, ui, import
- Status: open · days 2 of 3 (2026-11-15, 2026-11-17)
- Evidence:
  - 2026-11-15 | thin-check | `M5-04c-review.md` F1 (peer names write lines into the main bot's briefing) | fix in merge `4685c93a`
  - 2026-11-15 | rework | `M5-14b-review.md` F4, re-review R2 (a quote inside a reads item closes the quoting) | fix `b8f48dda`, merge `bb212ac7`
  - 2026-11-15 | thin-check | `M6-05-review.md` #7 (report paths printed raw) | fix `0a836552`
  - 2026-11-17 | thin-check | `v3-pin-area-3-review.md` F1 (the Pin area's status block, appended after the user's message, carried `@Name` text from cards, so a bot reply summoned other bots into the chat; `briefing()` now writes `＠`) | fix `8eddac9f`

## L-005 · Size limits count JSON-escaped UTF-8 bytes, header included
- Rule: a limit on something sent in a frame counts the bytes of its JSON-escaped UTF-8 form plus the header room;
  check it against the right constant; test the largest legal input (CJK text, newlines, the longest path).
- Why: a schema that counts characters let a legal call-in grow past one frame (CJK and newlines expand), which jams
  the origin's queue; a 64 KiB chunk with a long path did not fit the bulk lane; a 500 MiB limit was checked against a
  2 GiB constant.
- Tags: wire
- Status: open · days 2 of 3 (2026-11-15, 2026-11-18)
- Evidence:
  - 2026-11-15 | rework | `M5-01-review.md` F1 (a schema-valid call-in can be larger than one frame) | fix `0d52c396`, merge `55c6cd6e`
  - 2026-11-15 | thin-check | `M5-07b-review.md` R3 (a 64 KiB chunk with a path over ~870 bytes does not fit the direct bulk lane; the wire test used a 4-byte payload) | fix `3ed7e622`
  - 2026-11-15 | thin-check | `M5-07a-review.md` H3 (the 500 MiB per-request limit checked against 2 GiB) | fix `86f6347f`, merge `a34f4c55`
  - 2026-11-18 | thin-check | (no review file; commit message) `chat.feedback` carried a full-size PNG (about 410 KB), past `FRAME_LIMIT`; `FeLink.send` refused to encode it and the item blocked its queue for ever, with every later message to that bot | fix `0a766178`

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
- Status: open · days 2 of 3 (2026-11-15, 2026-11-16)
- Evidence:
  - 2026-11-15 | rework | `M5-14b-review.md` F2, then re-review R1 (the F2 fix `291f0d84` still resent after Done → Review) | fix `b8f48dda`, merge `bb212ac7`
  - 2026-11-15 | rework | `M5-04a-review.md` re-review N1 (a duplicate slot conflict notifies twice; introduced by the F3 fix in `358dbdc6`) | fix in merge `e2f4ba62`
  - 2026-11-16 | thin-check | `plugins-ui-review.md` F1 (one Allow sent twice across Cancel → reopen; the in-flight key now lives in a ref, checked and set synchronously) | fix `b482790a`

## L-008 · Check authority and state again at the moment of use
- Rule: grants, code hashes, membership and cached state are checked where they are used: before each chunk, on a
  crash restart, on hot swap, on revoke, at the running hash, and again after every `await` that can interleave with
  a change.
- Why: a check only at the start lets later changes go unnoticed: a crash restart ran code edited after the grant, a
  revoked module kept running, a removed requester kept receiving chunks, the window showed a stale grant, and a
  reload put a removed secret back.
- Tags: grant, wire
- Status: promoted → CS-02 (days 3 of 3: 2026-11-15, 2026-11-16, 2026-11-17)
- Evidence:
  - 2026-11-15 | thin-check | `M5-18a-review.md` F1 F2 (a crash restart loads code changed after the grant check; a revoke does not stop the module) | fix `1e4f4f30`, merge `be8be56b`
  - 2026-11-15 | thin-check | `M5-14d-review.md` F1 (the shown grant goes stale after a hot swap) | fix `6887f7cc`
  - 2026-11-15 | thin-check | `M5-07a-review.md` H2 (the requester is not re-checked before each chunk) | fix `86f6347f`
  - 2026-11-15 | thin-check | `M5-14a-review.md` F1 (an old hash's grant raised with the current manifest's asks) | fix `9b599a05`
  - 2026-11-15 | thin-check | `M5-17-review.md` M1 (peer content checked at the owner's hash, not the running hash) | fix `da729e90`, merge `0086c220`
  - 2026-11-15 | thin-check | `M6-06-review.md` F2 (a reload that resolves after a removal brings the old secret back) | fix `0d68b87d`
  - 2026-11-16 | thin-check | `plugin-update-review.md` F1 F2 (a built-in update whose folder fails the check kept `builtIn: true`; `direct` and the cached state were read before `await catalog.download(...)` and not again, so a plugin removed during the download was still installed) | fixes `2bff52aa`, `efbb3670`, merge `d1d1d75e`
  - 2026-11-16 | thin-check | `plugin-trust-review.md` F1 F2 (the one-time trust migration recorded a plugin the bot had just written and revived revoked and 2.x-import rows) | fix `55727326`, `ef244e56`, merge `5209abcf`
  - 2026-11-16 | thin-check | `install-check-review.md` F2 (the bundle id was not checked again when the user pressed install) | fix `550044ac`, merge `77c97a5d`
  - 2026-11-16 | thin-check | `M7-12a-review.md` F1 (a local client could forward a command with any `slot.origin`; the origin was stamped, not bound to the device at use) | fix `4027a1f9`, merge `d9da2d50`
  - 2026-11-16 | thin-check | `M7-O05-review.md` five counterexamples (`stopped` kept in memory across `await port.stop` was saved by another save; a send began while a cancel was under way; a plugin's mark kept for the wrong turn; `app_send_message` skipped the check) | fixes `2c35a718`, `fafaa3d7`, `2724a80b`, `7a6f3217`
  - 2026-11-17 | thin-check | `pin-sorter-after-review.md` F3 (the `sorter.enabled` switch was read once at send, not again when the model answered), `pin-routing-review.md` F1(b) (after an `await` the plugin still wrote the card past the deadline) | fix `e9d3556f`, `bb09b9de`

## L-009 · A check that errors, or meets a missing value, refuses
- Rule: a check that throws, a null, unknown or missing value, a missing config, a timeout or a failed send refuses
  (403 / denied / corrupt), never 500, "allowed", or a silently skipped check. Required inputs to a check are
  required parameters.
- Why: a corrupt row gave 500 instead of 403; a missing `dataDir` silently turned the data-folder check off; a chunk
  before the grant was accepted; a failed send was ignored and chunks still flowed.
- Tags: grant, fs, wire
- Status: open · days 2 of 3 (2026-11-15, 2026-11-16)
- Evidence:
  - 2026-11-15 | thin-check | `M5-17-review.md` L1 (a corrupt row or reader failure gives 500 / `gone{offline}`) | fix `da729e90`
  - 2026-11-15 | thin-check | `M5-06a-review.md` item 2 (`isDeniedPath` fails open) | fix `de449fb7`, merge `49a5cd51`
  - 2026-11-15 | rework | `M5-06a-followup-review.md` F2 F3 (after that follow-up, a missing `dataDir` still turned the check off, and `dataDir` was optional) | fix `c9322e83`
  - 2026-11-15 | thin-check | `M5-07b-review.md` R4 (a chunk before `fetch.grant` is accepted) | fix `3ed7e622`
  - 2026-11-15 | thin-check | `M5-07a-review.md` H3 (a `false` from `sendWire` ignored, chunks still flow) | fix `86f6347f`
  - 2026-11-16 | thin-check | `M7-12a-review.md` F2 (found at the re-check of the F1 fix: a `local` command whose origin was not `desktop` returned early, before the machine-only refusal) | fix `0d7388d9`, merge `37e263db`
  - 2026-11-16 | thin-check | `M7-08-review.md` (a refused `botling.chat` in direct mode left the chat column instead of drawing the fallback) | fix `98e63e3d`

## L-010 · Every guard has a test that fails when the guard is removed
- Rule: write a test that fails when each guard you added is removed; an assertion that passes either way is
  replaced. The implementing worker does NOT run the mutation check, only writes the tests and runs the related
  test files (at most 2 `remote-test.sh` runs, no `--typecheck`). The reviewer runs the mutation check once, as one batch (see "Mutation check at review" below).
- Why: the mutation check kept finding guards whose removal no test noticed, and one assertion that was vacuous.
  Since 2026-11-16 (user decision) the check moves from every worker to the review: each mutant was its own commit
  and its own queued remote-test run, and queueing for the Linux test host took 39% of worker time.
- Mutation check at review: one `remote-test.sh` connection, one worktree on the host. `remote-test.sh` has no batch
  mode yet, so pass it one script (as the command to run on the host, or a small `mutate.sh` committed once with the
  review) that, for each mutant in turn, patches the file (`sed` or `git apply mutant-N.patch`), runs vitest on the
  related test files only, records pass/fail, then restores with `git checkout -- <file>`. The review's whole budget is this one connection: related tests and the mutation batch together. No commit and no separate
  queue entry per mutant. A mutant whose tests still pass is a finding (a guard no test protects).
- Tags: test
- Status: promoted → CS-03 (days 4: 2026-11-15, 2026-11-16, 2026-11-17, 2026-11-18)
- Evidence:
  - 2026-11-15 | thin-check | `M5-07b-review.md` F2 (nine guards survive mutation, the wrong-peer guard included) | tests in `3ed7e622`
  - 2026-11-15 | thin-check | `M5-15-review.md` F3 (mutants M1 and M9 survive; test 5's assertion is vacuous) | fix `912d34c5`
  - 2026-11-15 | thin-check | `M5-18a-review.md` F5 (7 of 12 mutants survive the branch's tests, "the check throws → allowed" among them; with the fix 4 redundant guards still survive) | fix `1e4f4f30`
  - 2026-11-15 | thin-check | `M5-14d-review.md` F2 (`catch` → `write`, fail open, survives) | fix `6887f7cc`
  - 2026-11-15 | thin-check | `M5-04c-review.md` N1 (mutant M9 survives) | fix in merge `4685c93a`
  - 2026-11-16 | thin-check | `install-check-review.md` F3 F4 (16 mutants, 1 survived: `sameLabel` without the dirty compare; two branch guards had no test) | fix `550044ac`
  - 2026-11-17 | thin-check | `v3-pin-area-review.md` R2 (44 mutants, 6 survived, among them the `pin-say` rate limit and `fit()` dropping an open question; one test was empty), `pin-routing-review.md` S6 (7 guards, no test), `pin-sorter-after-review.md` F4 (35 mutants, 6 survived, among them "timeout does not kill the child"), `pin-copy-review.md` F1b (K3) | fixes `f1be2ca4`, `bb09b9de`, `e9d3556f`, `a4d7316d`
  - 2026-11-17 | thin-check | `claude-models-open-review.md` S4 (blur, Esc and head custom guards survived), and later review batches (blank list entry, Maintainer's count, `launchSettings`; `lastModelAt` reset) | fixes `9ece868f`, `4608e116`, `5f942d0b`, `a9389904`
  - 2026-11-18 | thin-check | (no review files; commit messages) review batches left mutants alive on `pickUp` (M5), the results-list wording (M7 M9), the make-pinnable JSON (M8), the notice's own `try` (M12), the head-turn guard, the report box's pictures, `sameLine` and the seventh summary row, the isFile check of the shot folder, a Monitor past the cap held for an instant (M6), the all-twelve-options ticks; one probe was written but not run (`c5a72320`, budget spent) | fixes `a25910f0`, `8026faae`, `ae878513`, `333e6a10`, `4a8d31fc`, `db83159e`, `87d26953`, `fed92518`, `4b772b0c`, `a9e76a6e`, `c5a72320`
  - 2026-11-18 | thin-check | (no review file; commit messages) the release gate's command line, its workflow steps, the publish asset check and `package.mjs`'s version guard had no test until the review's mutation check found them unprotected; the platform guard and the repaired helper's mode of the agy helper likewise | fix `bc52f156e`, `095f033fb`

## L-011 · Run both sides' related tests on the merged tree before merging, and sweep a cause across all tests
- Rule: before review, merge the base (main or the open batch) into the branch; the related tests of both sides
  run once on the merged tree, counted in the step's budget of 1–2 `remote-test.sh` runs (no `--typecheck`). The one
  full `--typecheck` run is the final confirmation after the merge into main, not an extra run per step. When a test breaks for a cause (a minted id, a new row kind, a new
  count), search every test for the same cause in the same fix.
- Why: parallel branches were green alone and broke together. After M5-04g (`ff352ce8`) changed how the main bot and
  Maintainer ids are made, tests on main failed; the first fix repaired two of them, five more with the same cause
  failed until a second fix, and a later merge (`be8be56b`) was blamed in the meantime.
- Tags: merge, test
- Status: promoted → CS-04 (days 5: 2026-11-15, 2026-11-16, 2026-11-17, 2026-11-18, 2026-11-19; seen on 2 more days after promotion, mechanical guard proposed in the 2026-11-19 report)
- Evidence:
  - 2026-11-15 | bad-merge | `fix-main-tests-review.md` (tests failing on main since M5-04g `ff352ce8` and M5-13a) | fix `8f296801`, merge `5159a781`
  - 2026-11-15 | bad-merge | (no review file; commit message) five more botlingd tests failing on main since `ff352ce8`, first blamed on M5-18a `be8be56b` | fix `fad57516`, merge `4dbe4909`
  - 2026-11-15 | thin-check | `M5-14a-review.md` F2 (`server-intents.test.ts` intent count broken by the change) | fix `9b599a05`
  - 2026-11-15 | thin-check | `M5-18a-review.md` F6 F7 (five-file textual and semantic overlap with M5-14d; failures already on main) | merge `8785ba3f`
  - 2026-11-16 | bad-merge | (no review file; chat of the merge queue) main went red after the M7-S30b merge `c709bdee`: a test's `file:` URL allowlist still named the file the line had moved out of | fix `7b82e76d`
  - 2026-11-16 | bad-merge | (no review file; chat) four tests that read source text were red on main after the S01 and S32 splits, and a fifth (`plugin-server-part-grant`) was a timing test; none was run with the cards | merge `3dc7291a`
  - 2026-11-17 | rework | `v3-pin-area-review.md` R1 (the re-recorded `plugins-list` golden broke `renderer-plugin-feed` and `m7-surfaces-2x`, which read the same fixture; the sweep was repeated three more times for the same fixture) | fixes `f1be2ca4`, `38372154`, `d26e08bc`, `677c979e`, `26fda633`
  - 2026-11-18 | bad-merge | (no review file; commit messages) after the 3.2.0 merges: a duplicate import, a test using a setter the merge removed, tests red on main fixed in the release commit | fix `cad544ddc`, `cf28c65db`, `7a735034f`
  - 2026-11-19 | bad-merge | (no review file; commit message) `main.ts` shrank in `12896c576`, but the check-lines test kept the old line count and failed on every checkout (ubuntu CI) | fix `e3d583647`

## L-012 · A fix commit gets its own probe tests and a fresh mutation check
- Rule: each fix in a review round comes with the probe that failed before it, and the fix round's single
  `remote-test.sh` run covers the probes and the paths the fix added. A re-review runs nothing of its own: it reads that
  result and the diff; the mutation batch (L-010) is not repeated unless the coordinator asks for one more run.
- Why: fixes brought new findings or were only half done, so cards needed a second or third review.
- Tags: test
- Status: open · days 4 (2026-11-15, 2026-11-16, 2026-11-17, 2026-11-18); CS-05 proposal dropped at the second review
  (2026-11-18): 8 of the 9 reworked fixes already carried tests, so "a probe per fix" would not have prevented them.
  The repeated mistake is a fix that is wrong or half done although tested; it needs a narrower rule before it is
  proposed again.
- Evidence:
  - 2026-11-15 | rework | `M5-04a-review.md` re-review N1 (introduced by the F3 fix in `358dbdc6`) | fix in merge `e2f4ba62`
  - 2026-11-15 | rework | `M5-14b-review.md` re-review R1 (the F2 fix `291f0d84` passed its test only because the tier sent equalled the rows' tier) | fix `b8f48dda`
  - 2026-11-15 | rework | `M5-07a-review.md` re-review T1 T2 (the fix round `86f6347f` needed test fixes) | fix `6867ce4a`
  - 2026-11-15 | rework | `M6-01d-review.md` re-review #1 #2 (two medium findings after the fix round `865bec8d`; the fold also left the inode check untested) | fix `6c507df0`
  - 2026-11-16 | rework | `M7-11b-review.md` re-check (the F1 fix `0f6e247a` still froze the queue after a lost copy and a reconnect; F2 needed one more fix and a probe) | fix `e0df7064`
  - 2026-11-16 | rework | `M7-12a-review.md` re-check (the F1 fix `4027a1f9` made F2: an early return before the machine-only check) | fix `0d7388d9`, merge `37e263db`
  - 2026-11-17 | rework | `pin-routing-review.md` R1 (the fix round set a 3.5 s model limit; the real call took 3.5 to 5.5 s, so every line waited about 4 s and was sorted never) | fix `3520c12d`
  - 2026-11-18 | rework | (no review file; commit messages) the Monitor report fix: a timer cut off a wake turn that was still working, then a held report was lost to a failed turn or an API retry, then the spec needed a second fix | fixes `0ea2a290`, `2e1bba6b`, `128a112a`, merge `99d59ba5`
  - 2026-11-18 | rework | (no review file; commit messages) Note/Whiteboard card page hand-off: first the ready word, then a queue variant that failed its own tests and was taken back, then a page given up once asked again, then the review's S1 F1 (pages after a given-up page); the agy helper went from a pin, to no pin, to "an empty shipped helper is no helper" | fix `e1aa12012`, `1697538d6`, `0110916f3`, `095f033fb`

## L-013 · A branch that runs only in the packaged app gets a test that simulates packaged mode
- Rule: when code behaves differently when packaged (`app.isPackaged`, Electron fuses, `ELECTRON_RUN_AS_NODE`,
  `process.execPath`), add a unit test that drives the packaged branch without starting Electron or opening windows
  Code that runs inside an Electron process (botlingd, the plugin host's utility process) and reads a `.asar` path uses
  `original-fs`: Electron's `node:fs` answers a folder of size 0 whose mtime is the clock, and plain-node tests never see it.
- Why: with the RunAsNode fuse off, `ELECTRON_RUN_AS_NODE=1` is ignored, so packaged `botlingd` would have started
  the app itself instead of its plugin host and PDF job; the branch's 39 tests passed.
- Tags: build, test
- Status: open · days 2 of 3 (2026-11-15, 2026-11-17)
- Evidence:
  - 2026-11-15 | thin-check | `M6-07c-review.md` F1 F2 (branch `f460f996`: packaged children spawned as the app) | fix `e7580d9d`
  - 2026-11-17 | thin-check | `v3-m6/install-verify-review.md` (botling.dev hashed app.asar with `node:fs` inside Electron: no hash, a clock for builtAt, a good install reported as "neither"; every test ran in plain node) | fix `b3f96b07`, `9e4f5a4b`

## L-014 · A timing or two-process test passes many runs in a row before hand-off
- Rule: a new test that starts servers, waits on timers or races processes is run at least 10 times in a row before
  hand-off; assert on the thing the card promises, not on a side effect that appears at a varying time. A test waits
  for the event it needs (a gate file, a log line), never a fixed delay or a single count; a perf number is the median
  of several runs.
- Why: the M5-04c two-server test failed in 2 of 16 runs because of one wrong assertion, which cost a re-review round.
- Tags: test
- Status: open · days 2 of 3 (2026-11-15, 2026-11-19)
- Evidence:
  - 2026-11-15 | thin-check | `M5-04c-review.md` re-review (two-server test flaky, 2 of 16 runs) | fix `43cbda13`
  - 2026-11-19 | thin-check | (no review file; commit messages) CI runs after the merge: `background-work-output` fake task ended after 0.6 s and a loaded runner overran it, `two-servers-peer` counted once instead of waiting for the log line, the perf gate took one slow run (263 ms against 113-167 ms) | fix `46f4bf8d6`, `826ee854c`

## L-015 · Secret bytes never reach error text, reports, logs or a durable queue
- Rule: an error about a secrets file names the file, not its contents (no raw parser message); a secret typed in a
  window is never written in plaintext to an outbox, log or report.
- Why: a broken `plugin-secrets.json` put part of a sealed token into stdout and `import-report.md` through Node's
  JSON error text; a plugin token typed in the window was fsynced in plaintext to the window's outbox.
- Tags: secret, import
- Status: open · days 2 of 3 (2026-11-15, 2026-11-16)
- Evidence:
  - 2026-11-15 | thin-check | `M6-01d-review.md` #3 (a broken secrets file quoted into stdout and the report) | fix `c9212f98`
  - 2026-11-15 | thin-check | `M6-06-review.md` F1 (a typed secret lands in plaintext in the window's durable outbox) | fix `0d68b87d`
  - 2026-11-16 | thin-check | `plugin-deps-review.md` (the `plugins.deps` answer carried a plugin's raw failure message; now only `"failed"`, with a probe that plants a token and a path) | fix `a8f0fa54`

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

## L-017 · A batched mutation check starts from a passing baseline and rebuilds `out/` before tests that run the built core
- Rule: the L-010 batch harness first runs the selected tests once with no mutant, and a failing baseline voids the whole batch (nothing is "killed"; fix the baseline, run again). It runs `npm run build` (or the plugin's own build) after applying each mutant and again
  after restoring it, whenever any selected test reads `out/` (for example `desktop/test/unit/note-cards-core.test.ts`
  through `CoreHarness`, or `desktop/builtin-plugins/botling.deps/test/frame.test.ts`, which reads the prebuilt
  `out/…/ui.js`). A mutant whose only killer test reads `out/` and was not rebuilt is reported as "not evaluated",
  never as "survived" or "killed".
- Why: the harness edits `src/`, but those tests run the built output, so without a rebuild they never see the mutant.
  The mutant looks like it survived (or is judged wrongly): M13 (drop the `files` grant check at `host-events.ts:290`)
  in the duel-apis re-check, and R6 and R7 in the plugin-deps review.
- Tags: test, build
- Status: open · days 2 of 3 (2026-11-16, 2026-11-18)
- Evidence:
  - 2026-11-16 | thin-check | `.bot/artifacts/v3-m7/duel-apis-review.md` Re-check (M13 judged without a rebuild) | log `.bot/remote-test-logs/20261116-200436-6786-7cea257e.log`
  - 2026-11-16 | thin-check | `.bot/artifacts/v3-m7/plugin-deps-review.md` (R6 and R7, `frame.test.ts` reads prebuilt `out/…/ui.js`)
  - 2026-11-18 | thin-check | (no review file; chat of 11-18 11:14) a mutation batch of 27 checks for the Opus redo reported all of them caught, but its baseline run (no mutant) already failed on an assertion the test rig cannot satisfy, so no result counted; the batch was run again after the fix | fix `c998df9c`, merge `410dcd3e`

## L-018 · App code never hard-codes a fix for a component's inner look; ask Maintainer to change the component
- Rule: when something inside a component frame looks wrong in the chat (padding, spacing, alignment, colors, sizes of
  what the component draws), the app side (Web/src, `chat/*.css`, `message-body.ts`) does not add an offset, a negative
  margin, an override or a magic number to compensate. Components belong to Maintainer: ask it (a `<component>` request,
  with the context, for example "inside a worker card, no box around it") to change the component or the shared
  component layout so it fits that context. The app may only pass a context signal that already exists (for example the
  `componentTokens` hook); it does not invent a new one for this. A reviewer rejects a CSS rule or a test assertion that
  encodes a component's inner measurement.
- Why: a number copied from a component into the app (here "components draw up to ~12px padding") breaks without any
  test failing when the component changes (compact 8px and narrow 10px components were already off by 2–4px), and it
  puts a component's look in two places owned by different parties.
- Tags: ui, web, components
- Status: open · days 1 of 3 (2026-11-18)
- Evidence:
  - 2026-11-18 | rework | `bot/card-style-1b`: worker card with no box and no title showed the component's data about 12px in from the reply text; the review fix pulled the frame out by a hard-coded `--card-inset: 12px` (negative margins on `.worker-card-body > .component`) | the owner rejected it ("talk to Maintainer, do not hard-code"); added in `7b9ae771`, removed in the commit after `2b00e152`

## L-019 · Text a parser or mover takes out of a reply stays visible when its target is missing
- Rule: when a tag handler, a mover or a report holder removes text from a reply (`<pin-say>`, a held worker report, a
  redo's first drawing), the text goes to a place the user can see before it leaves the old one. If its target is not
  there (no open question, no line to move, no run left, the next turn failed or was retried), the text stays where it
  was. Text inside the tag keeps its own edges (a code span or fence at the start or end of a body is not trimmed away
  by a mask).
- Why: a `<pin-say>` answer vanished from the chat and the card when no question was waiting, when two questions were
  open, and when its body ended in a code span; a worker report held for a Monitor was lost to a failed wake turn or an
  API retry; a redo that ended with no report replaced the first drawing with nothing.
- Tags: ui, wire, test
- Status: open · days 2 of 3 (2026-11-17, 2026-11-18)
- Evidence:
  - 2026-11-17 | rework | `v3-pin-area-review.md` F1 (answers matched to the wrong question; an answer with no open question was dropped) | fix `b5b1587c`, merge `ad3d3af9`
  - 2026-11-17 | rework | `v3-pin-area-3-review.md` F2 (a `move="yes"` answer with no line to move vanished) | fix `8eddac9f`
  - 2026-11-17 | thin-check | `pin-copy-review.md` F1 F1b (a code span at the start or end of a `<pin-say>` body disappeared from chat and card; the implementer had deleted the assertion that guarded it, `f984deeb`; mutant K3 survived) | fix `a4d7316d`, merge `93df86ad`
  - 2026-11-18 | rework | (no review file; commit messages) a held good report lost to a failed wake turn or an API retry; a wake turn's output reached no run | fix `2e1bba6b`, `0ea2a290`, merge `99d59ba5`
  - 2026-11-18 | rework | (no review file; commit message) an Opus redo that ends with no report dropped the first drawing | fix `1c7cae5f`, merge `410dcd3e`

## L-020 · A wait limit inside another is shorter than the outer one, and its default is measured on the real call
- Rule: a deadline that sits inside another (a plugin's budget inside the core's hook deadline, a grace timer inside a
  run) is smaller than the outer one, counted from the same start, and re-checked after every `await` (L-008). Its
  default is checked against at least three real calls on a loaded machine (not a fake). When the thing waited for is
  still working, its result ends the wait, not the timer.
- Why: the Pin area waited 8 s for a small model while the core gave up at 5 s, so the status block went missing and a
  ghost turn appeared in the card; the fix set 3.5 s, but the real call took 3.5 to 5.5 s, so every line waited about
  4 s and was never sorted; a 30 s grace timer ended a Monitor run while its wake turn was still working.
- Tags: wire, ui, test
- Status: open · days 2 of 3 (2026-11-17, 2026-11-18)
- Evidence:
  - 2026-11-17 | rework | `pin-routing-review.md` F1 (plugin 8 s against core 5 s), then re-review R1 (3.5 s default, 0 of 4 real calls under it) | fix `bb09b9de`, `3520c12d`, merge `c1a0185a`
  - 2026-11-18 | rework | (no review file; commit message) a Monitor's wake turn that outlasts the 30 s grace was cut off | fix `0ea2a290`, merge `99d59ba5`

## L-021 · Plugin code that starts calling an app feature updates the declared list and the goldens that print it, in the same commit
- Rule: when a built-in plugin's code starts to call an app feature (`api.*`, `ccb.*`) or adds a setting or a prompt
  text, `app-features.ts` (its declared list), the kernel goldens, the dependency-board counts and the settings DOM
  golden that show it are changed in the same commit, and the `app-features` test file is in the related tests.
- Why: the built-in feature scan fails only on the merged bundle; the Pin area and Note declared lists were each
  behind their bundle by several features, and Catch-up's was missing `ccb.draw.component`.
- Tags: build, test
- Status: open · days 2 of 3 (2026-11-17, 2026-11-18)
- Evidence:
  - 2026-11-17 | thin-check | (chat of 11-17 03:25: `app-features` failing on main) `botling.note` called `api.bots.send` and `botling.pin-area` several features it did not declare | fix `4ec5eb71`, `5233a90a`, `535a806d`
  - 2026-11-18 | thin-check | (no review file; commit message) Catch-up's viewer draw was not declared; the built-bundle feature scan failed | fix `42b30bc6`

## L-022 · Types are read before hand-off, because the typecheck runs only at the end
- Rule: `tsc` runs only in the final confirmation, so before hand-off the implementer looks up every import, type name,
  union, nullable and optional field the change touches (`node desktop/scripts/where.mjs --exports <file>`, or read the
  type), also in test files and fixtures. A test that needs an untyped module uses the repo's way
  (`// @ts-expect-error`), not a new module declaration. The reviewer samples the same list.
- Why: the typecheck errors turned up after merges, one fix commit each: a missing import (three times), a union
  that lacked a value the code writes (`TraceData.by`), a nullable id, a storage type that asked for more than it
  needs, an untyped test dependency fixed twice, an import name that clashed with an export of the same file.
- Tags: build, test
- Status: promoted → CS-06 (days 3 of 3: 2026-11-16, 2026-11-17, 2026-11-18)
- Evidence:
  - 2026-11-16 | bad-merge | (no review file; commit messages) a line id can be null in `shell-fallback.test.ts`; the layout store's storage type asked for more than get and set | fix `c42bd5c5`, `81625739`
  - 2026-11-17 | bad-merge | `board-empty-plus-review.md` F1 (`subagent: true` is a type error, found by reading); `TraceData.by` lacked "app" ("typecheck failed after the merge"); `phase3a.spec` missed an import and the prompt helper's profile types | fix `860007e0`, `7ae93822`
  - 2026-11-18 | bad-merge | (no review file; commit messages) untyped `jsdom` declared as a module, then redone the repo's way; a missing `RemoteWorkerHost` import; type errors in two tests; an import that clashed with `message-body`'s own `chevron` export | fix `f3c5082a`, `af91bb3f`, `c32bb21d`, `e768eabe`, `3d3dfcc4`
  - 2026-11-18 | bad-merge | (no review file; commit messages) the pin-area model split forgot to import what its halves share (`SuggestView`, `suggestView`, `viewOf`); a test still called a setter that was gone | fix `517161238`, `7a735034f`

## L-023 · A sentence in a prompt or brief that names an ability is true for every engine that receives it
- Rule: a sentence in a bot prompt, worker brief or guide that names a tool, script, block kind or ability is checked
  against every engine and project that gets it (Claude, Codex, Antigravity, a worker, Maintainer, a project without the
  repo's scripts). A sentence true for one is sent only to that one, or reads "when you have X". Each such sentence has
  a probe test per engine profile.
- Why: bot prompts told Codex main to use file tools it does not have, told the others about an Antigravity-only
  handoff, and told workers without inline blocks to use them; a worker brief hard-wired `where.mjs` for workers that
  run in other projects, which wasted a turn.
- Tags: test
- Status: open · days 2 of 3 (2026-11-16, 2026-11-18)
- Evidence:
  - 2026-11-16 | rework | (no review file; chat of 11-16 02:24) the saved-tokens brief told workers to use `where.mjs`, which does not exist in other projects; sent back | (no hash in the chat)
  - 2026-11-18 | rework | (no review file; commit messages) the prompts said what each engine can do: agy handoff is agy only, Codex main has no file tools, Maintainer's editor call per transport, the report page rule names no inline blocks | fix `c5b24cd3`, `1f4f6e33`, `977be72b`, merge `9bbb7cef`, `5b0489c0`
  - 2026-11-18 | rework | (no review file; commit messages) a no-lookup sentence covered kinds with no example; an example title said another share than its data | fix `94b3b1e4`, `d6cebdbd`

## L-024 · A test that depends on the runner pins that fact, and a fix for one runner is checked against all of them
- Rule: a test that uses a temp root, a unix socket path, the platform, the shell or a clock states the fact it
  depends on instead of reading it from the machine: the socket path is measured against the 103-byte macOS limit with
  the longest name the test makes (a path made longer by a real-path fold counts), the platform and shell are passed in
  (`shell()` pinned per platform), and a golden recorded on one OS folds only on that OS. When a test is changed to
  pass on one runner, the same change is checked for macOS, Linux and Windows before it is committed.
- Why: `testRoot` in the botlingd harness was changed three times in one night: a real path (so `/var` equals
  `/private/var`), then back, then a short `/tmp` root, because each real-path fix made every socket 8 bytes longer and
  put six botlingd tests over the 103-byte limit; the zsh fold hid a `shell()` regression on Linux; 12 macOS CI tests
  failed on socket length alone.
- Tags: test, build
- Status: open · days 1 of 3 (2026-11-19)
- Evidence:
  - 2026-11-19 | rework | (no review file; commit messages, CI runs of the day) the macOS-runner differences fixed, then the fix lengthened the sockets, then undone; zsh fold limited to darwin; Windows-portable `cardScriptCommand` and `cardPictures` | fix `507174003`, `27c0aafc3`, `46f4bf8d6`, `826ee854c`

## L-025 · A workflow that repeats a step of `ci.yml` copies its environment, and a test compares the two
- Rule: a new or changed workflow (release, nightly) that runs a step `ci.yml` already runs (typecheck, `npm ci` for the
  relay, the heap size, timeouts) takes the same environment, install steps and job limits, or says in a comment why it
  differs. A job that is only a gate (plan, release check) never has `continue-on-error`. A release candidate is not
  re-running what CI already ran green on the same commit; the plan job requires that green run. The workflow's steps
  are tested by running the checker (`release-check.test.mjs`).
- Why: the first v3 tag build died in `npm run typecheck` (out of the default heap, exit 134) because only `ci.yml` had
  `NODE_OPTIONS=--max-old-space-size=6144`; twelve tests failed because `release.yml` never installed the relay's
  dependencies; the full unit suite on the release runner took 65 minutes of a 75-minute limit; a `continue-on-error` in
  the plan job would have let `needs: plan` pass on a failed plan.
- Tags: build
- Status: open · days 2 of 3 (2026-11-18, 2026-11-19)
- Evidence:
  - 2026-11-18 | rework | (no review file; commit messages) CI got the macOS typecheck heap, relay deps and job timeouts; the Antigravity helper pin failed on a runner with another Xcode | fix `12896c576`, `0fdb17b3c`
  - 2026-11-18 | rework | (no review file; commit message) the v3.2.3 tag build: the release typecheck ran out of memory (`release.yml` lacked the heap `ci.yml` had) | fix `2f776b9a5`
  - 2026-11-19 | rework | (no review file; commit messages) the same tag build: relay deps missing for `test:unit`, a 65-minute suite, plan job without the green-CI check and with `continue-on-error` | fix `630ad1ffa`, `697aca52b`, `27c0aafc3`

## Watch list (seen once, not a lesson yet)

- Plugin names matched by prefix: a `write` plugin `my` could run `my.plugin`'s commands
  (`M5-15-review.md` F2, fix `912d34c5`). Becomes a lesson if a second name-prefix bug shows up.
- One helper copied into three files (`isPackagedElectron()`, `M6-07c-review.md` F3, fix `e7580d9d`).
- Merging an old branch whose history held private host names, then resetting main (2026-11-15, chat of 17:35;
  `bot/v3-remote-test-clean` was merged instead). Becomes a lesson if a merge brings private strings in again.
- A speed shortcut that skips state it must still report: the start-up re-projection skipped unchanged workers, and the
  review found crash-cut workers stayed "running" (2026-11-18, fix `97bdfe17`, from `1a7135ac`). A second case makes it a lesson.
- A fix for a failing assertion that deletes it instead of finding the cause (`f984deeb`, 2026-11-17; the assertion
  guarded L-019). Recorded under L-019; a second deleted assertion makes it a lesson of its own.
- Rebuilding a path from its nearest existing ancestor cut a character: `realFolder` dropped the first letter of a
  missing part under `/` (2026-11-17, fix `f04de7ff`; moved off L-001 at the second review, since resolving with
  `realpathSync.native` would not have prevented it). A second off-by-one in path joining makes it a lesson.
- A test that expects a number the repo's own files produce (a line count, a file count) goes stale when the file changes:
  the check-lines test expected `main.ts` at 1169 lines after the split made it 1159 (2026-11-19, fix `e3d583647`).
  A second hard-coded size of the repo's own files makes it a lesson.
