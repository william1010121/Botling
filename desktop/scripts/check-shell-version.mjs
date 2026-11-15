// Build check: `minFeVersion` names the shell only (M7-10b; plan-change §4.3 check 4, D55, N8).
//   node scripts/check-shell-version.mjs [--repo <dir>] [--whole] [--no-baseline] [<base> [<head>]]      (default: main HEAD)
//   node scripts/check-shell-version.mjs [--repo <dir>] --update      rewrite desktop/fe-shell-baseline.json from the working tree
//
// A commit that touches only plugin sources (desktop/builtin-plugins/**, desktop/src/renderer/plugins/**; tests, docs and
// notes beside them do not count) must leave both halves of the manifest's shell part as they were:
//   - the value of `MIN_FE_VERSION` (found by name under desktop/src, so a card may move the constant), and
//   - the shell hash (fe-shell-manifest.mjs: the files of the shell, never a plugin source).
// A commit that touches anything else may change them. Every non-merge commit of <base>..<head> is checked against its first
// parent; `--whole` checks <base> → <head> as one change instead. Both values are read from git, nothing is checked out.
// The build's manifest is not committed, so the committed baseline (desktop/fe-shell-baseline.json: the shell part as of the last shell
// change) is what <head> is compared with: if the shell's files or MIN_FE_VERSION at <head> differ from it, the change that moved them
// has to run `--update` in the same branch (a plugin-only change never needs to; it moves neither). `--no-baseline` skips that part.
// Exit 1 lists the commits that broke the rule; a value that cannot be read fails (never "unchanged").
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { findMinFeVersion, fsTree, gitTree, isNeutralPath, isPluginSourcePath, parseShellBaseline, SHELL_BASELINE_FILE, shellBaselineText, shellHash, shellManifest } from "../fe-shell-manifest.mjs";

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** What a change is: "plugin-only" (plugin sources, with tests and docs at most), "none" (nothing but tests and docs), or "other". */
export function classifyChange(paths) {
  const real = paths.filter((path) => !isNeutralPath(path) || isPluginSourcePath(path));
  if (real.length === 0) return "none";
  return real.every(isPluginSourcePath) ? "plugin-only" : "other";
}

/** The two values of the shell part at `ref`: { minFeVersion, hash }. */
export const shellAt = (repo, ref, hash = shellHash) => { const tree = gitTree(repo, ref); return { minFeVersion: findMinFeVersion(tree), hash: hash(tree) }; };

/**
 * Checks the change `from` → `to` (commits or refs). `paths` are the repo-relative paths it touches.
 * Returns { kind, problems: string[] }; a plugin-only change with a problem fails. `hash(tree)` is the shell hash (a test's way to try a wrong definition).
 */
export function checkChange(repo, from, to, paths, { hash = shellHash } = {}) {
  const kind = classifyChange(paths);
  const problems = [];
  if (kind !== "plugin-only") return { kind, problems };
  const before = shellAt(repo, from, hash), after = shellAt(repo, to, hash);
  if (after.minFeVersion === null) problems.push("MIN_FE_VERSION is not defined exactly once under desktop/src (cannot tell that it is unchanged)");
  else if (before.minFeVersion !== after.minFeVersion) problems.push(`MIN_FE_VERSION changed (${JSON.stringify(before.minFeVersion)} -> ${JSON.stringify(after.minFeVersion)}) in a plugin-only change`);
  if (before.hash !== after.hash) problems.push(`the shell hash changed (${before.hash.slice(0, 12)} -> ${after.hash.slice(0, 12)}) in a plugin-only change`);
  return { kind, problems };
}

/** <ref>'s shell part against the committed baseline: a list of problems (empty when they agree). */
export function checkBaseline(repo, ref, hash = shellHash) {
  let text;
  try { text = gitTree(repo, ref).read(SHELL_BASELINE_FILE); } catch { return [`${SHELL_BASELINE_FILE} is missing at ${ref} (run: node desktop/scripts/check-shell-version.mjs --update)`]; }
  const baseline = parseShellBaseline(text);
  if (!baseline) return [`${SHELL_BASELINE_FILE} is not a valid baseline (run: node desktop/scripts/check-shell-version.mjs --update)`];
  const now = shellAt(repo, ref, hash), problems = [];
  if (now.minFeVersion !== baseline.minFeVersion) problems.push(`MIN_FE_VERSION is ${JSON.stringify(now.minFeVersion)} but the baseline says ${JSON.stringify(baseline.minFeVersion)}`);
  if (now.hash !== baseline.hash) problems.push(`the shell hash is ${now.hash.slice(0, 12)} but the baseline says ${baseline.hash.slice(0, 12)}`);
  return problems.length ? [...problems, "the shell changed without a new baseline: run node desktop/scripts/check-shell-version.mjs --update and commit it"] : [];
}

const changedPaths = (repo, from, to) => git(repo, "diff", "--name-only", "-z", "--no-renames", from, to).split("\0").filter(Boolean);

/** Checks every non-merge commit of base..head (or the whole range as one change). Returns [{ commit, subject, kind, problems }]. */
export function checkRange(repo, base, head, { whole = false, hash = shellHash } = {}) {
  if (whole) return [{ commit: head, subject: `${base}..${head}`, ...checkChange(repo, base, head, changedPaths(repo, base, head), { hash }) }];
  const commits = git(repo, "rev-list", "--reverse", "--no-merges", "--topo-order", `${base}..${head}`).split("\n").filter(Boolean);
  return commits.map((commit) => {
    const parents = git(repo, "rev-list", "--parents", "-n", "1", commit).trim().split(" ").slice(1);
    const subject = git(repo, "log", "-1", "--format=%s", commit).trim();
    // A root commit has no parent: its paths are everything it adds, and nothing before it to compare with.
    if (parents.length === 0) return { commit, subject, kind: "other", problems: [] };
    return { commit, subject, ...checkChange(repo, parents[0], commit, changedPaths(repo, parents[0], commit), { hash }) };
  });
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => { const at = args.indexOf(flag); return at < 0 ? null : args.splice(at, 2)[1] ?? null; };
  const repo = resolve(take("--repo") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const flag = (name) => args.includes(name) && args.splice(args.indexOf(name), 1).length === 1;
  const whole = flag("--whole"), noBaseline = flag("--no-baseline"), update = flag("--update");
  if (update) {
    const shell = shellManifest(fsTree(repo));
    if (shell.minFeVersion === null) throw new Error("MIN_FE_VERSION is not defined exactly once under desktop/src");
    writeFileSync(resolve(repo, SHELL_BASELINE_FILE), shellBaselineText(shell));
    console.log(`check-shell-version: ${SHELL_BASELINE_FILE} updated (${shell.minFeVersion}, ${shell.hash.slice(0, 12)})`);
    return 0;
  }
  const [base = "main", head = "HEAD"] = args;
  const results = checkRange(repo, base, head, { whole });
  const failed = results.filter((result) => result.problems.length > 0);
  const baseline = noBaseline ? [] : checkBaseline(repo, head);
  for (const problem of baseline) console.error(`check-shell-version: ${head}: ${problem}`);
  for (const result of failed) for (const problem of result.problems) console.error(`check-shell-version: ${result.commit.slice(0, 10)} ${JSON.stringify(result.subject)}: ${problem}`);
  console.log(`check-shell-version: ${results.length} change${results.length === 1 ? "" : "s"} checked, ${results.filter((r) => r.kind === "plugin-only").length} plugin-only, ${failed.length} failed${noBaseline ? "" : baseline.length ? ", baseline out of date" : ", baseline ok"}`);
  return failed.length === 0 && baseline.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))); } catch (error) { console.error(`check-shell-version: ${String(error?.message ?? error).split("\n")[0]}`); process.exit(2); }
}
