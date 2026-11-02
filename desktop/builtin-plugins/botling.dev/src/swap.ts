// Installing a developer build (`<install-build path="…/Botling 2.app">what changed</install-build>`): the project
// that is Botling's own source may ask to install a build it made. The user confirms on a card in the main bot's
// chat; then a small script outside the app waits for it to quit (bots write their notes first), moves the running
// build aside, puts the new one in its place and opens it. The new build says it came up by writing `healthy` once
// it has run `HEALTHY_AFTER_MS` (the core does that: core/self-update.ts); if it does not within `HEALTH_WAIT_S`, the
// script puts the old build back, opens it, and writes `rolled-back`. Either way the next start tells the bot that
// asked how it went. `<app-screenshot/>` sends that bot a picture of the app's window.
//
// This is the only way the app replaces itself without electron-updater (main/updates.ts), which installs
// released versions: notices about those are announced by the core (core/self-update.ts).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../../../src/core/durable/atomic";

/** Seconds the new build has to come up. */
export const HEALTH_WAIT_S = 90;
/** How long a new build must have run before it counts as up. */
export const HEALTHY_AFTER_MS = 8_000;
/** Builds in a row that failed to come up before installing pauses. */
export const FAILURE_LIMIT = 2;

/** A build of Botling 2 as its Info.plist describes it (`BuildInfo`). */
export interface BuildInfo {
  path: string;
  bundleID: string;
  version: string;
  /** The git commit it was built from (`BotlingGitCommit`), and whether there were uncommitted changes. */
  commit: string | null;
  dirty: boolean;
}

/** "2.0.0 (abc1234)", "2.0.0 (abc1234, uncommitted changes)". */
export function buildLabel(build: BuildInfo): string {
  const parts = [build.commit?.slice(0, 7), build.dirty ? "uncommitted changes" : null].filter(Boolean);
  return parts.length ? `${build.version} (${parts.join(", ")})` : build.version;
}

/** The string values of an Info.plist (XML; a binary one is converted with plutil on macOS). */
export function plistStrings(file: string): Record<string, string> | null {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  if (!text.trimStart().startsWith("<")) {
    if (process.platform !== "darwin") return null;
    try { text = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file], { encoding: "utf8", timeout: 5_000 }); } catch { return null; }
  }
  const out: Record<string, string> = {};
  const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for (const match of text.matchAll(/<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\s*\/>)/g)) {
    out[unescape(match[1]!)] = match[2] !== undefined ? unescape(match[2]) : match[3]!;
  }
  return out;
}

/** Reads a `.app` bundle; null if it is no app (no Info.plist or no executable). */
export function readBuild(bundle: string): BuildInfo | null {
  const path = resolve(bundle);
  if (!path.endsWith(".app")) return null;
  const info = plistStrings(join(path, "Contents", "Info.plist"));
  const id = info?.CFBundleIdentifier;
  const executable = info?.CFBundleExecutable;
  if (!info || !id || !executable || executable.includes("/")) return null;
  try {
    const stat = statSync(join(path, "Contents", "MacOS", executable));
    if (!stat.isFile() || !(stat.mode & 0o111)) return null;
  } catch { return null; }
  const commit = info.BotlingGitCommit || info.CCBGitCommit || null;
  const dirty = [info.BotlingGitDirty, info.CCBGitDirty].some((value) => value === "1" || value === "true");
  return { path, bundleID: id, version: info.CFBundleShortVersionString || "?", commit, dirty };
}

/** Resolve existing symlinks, retaining lexical paths for destinations that do not exist yet. */
function physicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export { DEV_WORK_DIR, devWorkRoot, externalVolume, folderAvailable } from "../../../src/core/self-update";

/** What is under way, in `<root>/self-update/state.json`. */
export interface InstallState {
  from: BuildInfo;
  to: BuildInfo;
  /** The project whose bot asked for it, told how it went. */
  requesterID: string;
  note: string;
  startedAt: string;
  /** Where the running build was moved. */
  backup: string;
}

export const updateFolder = (root: string) => join(root, "self-update");
const stateFile = (root: string) => join(updateFolder(root), "state.json");
const healthyFile = (root: string) => join(updateFolder(root), "healthy");
const rolledBackFile = (root: string) => join(updateFolder(root), "rolled-back");
export const failuresFile = (root: string) => join(updateFolder(root), "failures");
export const installLog = (root: string) => join(updateFolder(root), "install.log");
const scriptFile = (root: string) => join(updateFolder(root), "install.sh");

/** Builds in a row that did not come up. */
export function failures(root: string): number {
  try { const count = Number.parseInt(readFileSync(failuresFile(root), "utf8").trim(), 10); return Number.isFinite(count) ? count : 0; } catch { return 0; }
}

export function setFailures(root: string, count: number) {
  mkdirSync(updateFolder(root), { recursive: true });
  writeFileSync(failuresFile(root), `${count}\n`);
}

/**
 * The script, run as: install.sh pid target new backup healthy rolled-back seconds data-dir previous.
 * `previous` is the running build, opened again when the new one fails. A target that is not there yet needs no backup.
 */
export const INSTALL_SCRIPT = `#!/bin/bash
# Installs a new Botling 2 build while the old one quits; puts the old one back if the
# new one does not come up. Written by Botling 2 (builtin-plugins/botling.dev, after 1.x's SelfUpdate.swift).
PID="$1"; TARGET="$2"; NEW="$3"; BACKUP="$4"; HEALTHY="$5"; ROLLED="$6"; WAIT="$7"; DATA="$8"; PREVIOUS="\${9:-$2}"
OPEN="\${BOTLING_TEST_OPEN:-/usr/bin/open}"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
launch() (
  # The installer is a core child: its data override names core/, not the app profile.
  # Main recreates these commands/identities from the new bundle and chosen profile.
  unset BOTLING_DATA_DIR BOTLING_APP_DATA_DIR BOTLING_APP_LOCAL_DATA_DIR BOTLING_APP_BUNDLE
  unset BOTLING_MAIN_PID BOTLING_STARTUP_LOG BOTLING_SHOT_COMMAND BOTLING_CHECK_COMMAND BOTLING_REPORT_COMMAND BOTLING_REPORT_DOCS
  if [ -n "$2" ]; then "$OPEN" -n "$1" --env "BOTLING_DATA_DIR=$2"; else "$OPEN" -n "$1"; fi
)
reopen() { launch "$1" "$DATA"; }
putback() { if [ -n "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi; }
say "waiting for Botling 2 ($PID) to quit"
for i in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$PID" 2>/dev/null; then say "it did not quit; nothing changed"; echo "did not quit" > "$ROLLED"; exit 1; fi
if [ -e "$TARGET" ]; then
  say "moving $TARGET to $BACKUP"
  mv "$TARGET" "$BACKUP" || { say "could not move the old build"; echo "could not move the old build" > "$ROLLED"; reopen "$PREVIOUS"; exit 1; }
else
  BACKUP=""
  say "installing to $TARGET (the running build stays at $PREVIOUS)"
  mkdir -p "$(dirname "$TARGET")" || { say "could not make $(dirname "$TARGET")"; echo "could not make the folder for the new build" > "$ROLLED"; reopen "$PREVIOUS"; exit 1; }
fi
if ! /usr/bin/ditto "$NEW" "$TARGET"; then
  say "could not copy the new build; putting the old one back"
  rm -rf "$TARGET"; putback; echo "could not copy the new build" > "$ROLLED"; reopen "$PREVIOUS"; exit 1
fi
say "opening the new build"
launch "$TARGET" "$DATA"
for i in $(seq 1 "$WAIT"); do
  if [ -f "$HEALTHY" ]; then say "the new build is up"; exit 0; fi
  sleep 1
done
say "the new build did not come up in $WAIT seconds; putting the old one back"
pkill -f "$TARGET/Contents/MacOS/" ; sleep 2
rm -rf "$TARGET.failed"; mv "$TARGET" "$TARGET.failed" 2>/dev/null
putback
echo "the new build did not come up in $WAIT seconds" > "$ROLLED"
reopen "$PREVIOUS"
exit 1
`;

/** Writes the state and the script; returns the command that runs the script (detached; the app quits right after). */
export function prepareInstall(root: string, from: BuildInfo, to: BuildInfo, requester: string, note: string, pid: number, dataDir: string, now = new Date(), target = from.path): string[] {
  // Rollback and the detached script must name the real folders, not an alias.
  root = physicalPath(root);
  if (dataDir) dataDir = physicalPath(dataDir);
  const folder = updateFolder(root);
  mkdirSync(join(folder, "backups"), { recursive: true });
  for (const marker of [healthyFile(root), rolledBackFile(root)]) rmSync(marker, { force: true });
  const stamp = `${now.toISOString().slice(0, 10)}-${Math.floor(now.getTime() / 1000)}`;
  const backup = join(folder, "backups", `Botling-2-${from.version.replace(/[^0-9A-Za-z.-]/g, "_")}-${stamp}.app`);
  const state: InstallState = { from, to, requesterID: requester, note, startedAt: now.toISOString(), backup };
  writeFileAtomic(stateFile(root), JSON.stringify(state, null, 2));
  writeFileSync(scriptFile(root), INSTALL_SCRIPT, { mode: 0o700 });
  return ["/usr/bin/nohup", "/bin/bash", scriptFile(root), String(pid), target, to.path, backup, healthyFile(root), rolledBackFile(root), String(HEALTH_WAIT_S), dataDir, from.path];
}

/** How the last install went, read at start: null when none was under way. */
export type InstallOutcome = { kind: "installed"; state: InstallState } | { kind: "rolledBack"; state: InstallState; reason: string };

export function installOutcome(root: string): InstallOutcome | null {
  let state: InstallState;
  try {
    state = JSON.parse(readFileSync(stateFile(root), "utf8")) as InstallState;
    if (!state?.from?.path || !state?.to?.path || typeof state.requesterID !== "string") return null;
  } catch { return null; }
  try {
    const reason = readFileSync(rolledBackFile(root), "utf8").trim();
    return { kind: "rolledBack", state, reason };
  } catch { return { kind: "installed", state }; }
}

/** The new build is up (the core wrote `healthy`, core/self-update.ts): the state is done with. */
export function finishInstall(root: string) {
  rmSync(stateFile(root), { force: true });
  rmSync(rolledBackFile(root), { force: true });
}

/** Files whose changes alter what bots are told or allowed to do (repo-relative endings); a build that changes them says so on its card. */
export const SENSITIVE_PATHS = [
  "src/core/prompts.ts", "src/core/prompts-codex-text.ts", "src/core/prompts/delegation.ts", "src/core/prompts-agy.ts",
  "src/core/maintainer-text.ts", "src/core/agent/head.ts",
  "src/core/agent/codex.ts", "src/core/app-tools/registry.ts", "src/core/settings.ts", "builtin-plugins/botling.dev/src/swap.ts", "src/core/self-update.ts", "src/core/plugins/app-seam.ts",
  "src/core/permission-rules.ts", "src/core/store/workspace.ts",
];
/** Changed lines with these anywhere count too. */
export const SENSITIVE_PATTERN = "allowedTools|disallowedTools|NEVER_ALWAYS|alwaysAllowed|permission-mode|allowRules|harmless|TOOLBOX|developerMode";

/** The sensitive files changed between two commits in `repo`, with lines added and removed (null: git could not say). */
export function sensitiveChanges(repo: string, from: string, to: string, git = "git"): { file: string; added: number; removed: number }[] | null {
  const run = (args: string[]) => {
    try { return execFileSync(git, ["-C", repo, ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  };
  const stats = run(["diff", "--numstat", from, to]);
  if (stats === null) return null;
  const matching = new Set((run(["diff", "--name-only", "-G", SENSITIVE_PATTERN, from, to]) ?? "").split("\n").filter(Boolean));
  return stats.split("\n").flatMap((line) => {
    const parts = line.split("\t");
    if (parts.length !== 3) return [];
    const file = parts[2]!;
    if (!matching.has(file) && !SENSITIVE_PATHS.some((path) => file === path || file.endsWith(`/${path}`))) return [];
    return [{ file, added: Number(parts[0]) || 0, removed: Number(parts[1]) || 0 }];
  });
}

