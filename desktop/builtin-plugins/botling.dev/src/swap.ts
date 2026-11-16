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
/** Botling 3: the window starts botlingd, which must open its store and see a window attach first. */
export const HEALTH_WAIT_S_V3 = 120;
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
export const healthyFile = (root: string) => join(updateFolder(root), "healthy");
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

/**
 * Botling 3's script, run as: install.sh botlingd-pid target new backup healthy rolled-back seconds app-data previous server-data.
 * The app is the window plus botlingd, which runs the core and stops itself once the window quit (server/shell-bridge.ts
 * `quitForInstall`). The script waits for botlingd, ends whatever still runs from the old bundle (a window that did not quit;
 * a botlingd it started again), swaps the app keeping the old one, checks the copy's signature, opens it on the same data
 * folders and waits for `healthy` (written by the new botlingd once a window attached, core/self-update.ts). A build that
 * does not come up is ended, kept as <target>.failed, and the old one put back and opened. botlingd is never SIGKILLed
 * before the swap; only a new build that ignores SIGTERM is (else the old build could not start on the data folder).
 * After the install-3.0 script (.bot/artifacts/install-3.0/install.sh).
 */
export const INSTALL_SCRIPT_V3 = `#!/bin/bash
# Installs a new Botling 3 build once its window and botlingd have stopped; puts the old one back if the new one does not
# come up. Written by Botling 3 (builtin-plugins/botling.dev).
PID="$1"; TARGET="$2"; NEW="$3"; BACKUP="$4"; HEALTHY="$5"; ROLLED="$6"; WAIT="$7"; DATA="$8"; PREVIOUS="\${9:-$2}"; SERVER="\${10:-}"
OPEN="\${BOTLING_TEST_OPEN:-/usr/bin/open}"
DITTO="\${BOTLING_TEST_DITTO:-/usr/bin/ditto}"
CODESIGN="\${BOTLING_TEST_CODESIGN:-/usr/bin/codesign}"
XATTR="\${BOTLING_TEST_XATTR:-/usr/bin/xattr}"
QUIT_WAIT="\${BOTLING_TEST_QUIT_WAIT:-300}"
APP_WAIT="\${BOTLING_TEST_APP_WAIT:-30}"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
alive() { kill -0 "$1" 2>/dev/null; }
# The processes whose program is inside bundle $1 (the window, botlingd, what they started), but not this script.
app_pids() {
  ps -A -ww -o pid=,command= | BUNDLE_DIR="$1/Contents/MacOS/" SELF="$$" awk '{
    line = $0; sub(/^[ ]*[0-9]+[ ]/, "", line)
    if ($1 != ENVIRON["SELF"] && index(line, ENVIRON["BUNDLE_DIR"]) == 1) print $1
  }'
}
botlingd_pids() {
  ps -A -ww -o pid=,command= | BUNDLE_DIR="$1/Contents/MacOS/" awk '{
    line = $0; sub(/^[ ]*[0-9]+[ ]/, "", line)
    if (index(line, ENVIRON["BUNDLE_DIR"]) == 1 && index(line, " --botlingd") > 0) print $1
  }'
}
# Waits poll five times a second (a whole second per poll added up to a second to each wait); limits stay in seconds.
TICK=0.2
ticks() { echo $(( $1 * 5 )); }
wait_gone() { local n=0 max; max="$(ticks "$2")"; while [ -n "$(app_pids "$1")" ]; do [ "$n" -ge "$max" ] && return 1; sleep "$TICK"; n=$((n + 1)); done; return 0; }
# Ends what runs from bundle $1: SIGTERM (the window quits, botlingd stops as for botlingd stop), then SIGKILL; with $2 = 0
# never botlingd (it may still be saving), so that case fails instead.
end_bundle() {
  local pids; pids="$(app_pids "$1")"
  [ -z "$pids" ] && return 0
  say "still running from $1: $(echo $pids); SIGTERM"
  kill -TERM $pids 2>/dev/null
  wait_gone "$1" "$APP_WAIT" && return 0
  pids="$(app_pids "$1")"
  if [ "$2" = 0 ]; then
    local keep; keep=" $(echo $(botlingd_pids "$1")) "
    local p; local hard=""
    for p in $pids; do case "$keep" in *" $p "*) ;; *) hard="$hard $p" ;; esac; done
    pids="$hard"
  fi
  if [ -n "$(echo $pids)" ]; then say "still running after SIGTERM: $(echo $pids); SIGKILL"; kill -KILL $pids 2>/dev/null; fi
  wait_gone "$1" 5
}
launch() (
  # The script is botlingd's child: its data overrides name botlingd's folder, not the window's.
  unset BOTLING_DATA_DIR BOTLING_APP_DATA_DIR BOTLING_APP_LOCAL_DATA_DIR BOTLING_APP_BUNDLE BOTLING_SERVER_DATA_DIR BOTLING_SERVER_SOCKET ELECTRON_RUN_AS_NODE
  unset BOTLING_MAIN_PID BOTLING_STARTUP_LOG BOTLING_SHOT_COMMAND BOTLING_CHECK_COMMAND BOTLING_REPORT_COMMAND BOTLING_REPORT_DOCS BOTLING_APP_COMMAND
  args=(-n "$1")
  [ -n "$DATA" ] && args+=(--env "BOTLING_DATA_DIR=$DATA")
  if [ -n "$SERVER" ] && { [ -z "$DATA" ] || [ "$SERVER" != "$DATA/server" ]; }; then args+=(--env "BOTLING_SERVER_DATA_DIR=$SERVER"); fi
  "$OPEN" "\${args[@]}"
)
reopen() { launch "$1"; }
# The new build is copied beside the target and its signature checked while the old build is still quitting (botlingd
# needs about ten seconds to stop; the copy used to start only after that). Once the old one is gone the swap is two renames.
STAGE="$TARGET.staging"
stage() {
  rm -rf "$STAGE"
  mkdir -p "$(dirname "$TARGET")" || return 3
  say "copying the new build to $STAGE while the old one quits"
  "$DITTO" "$NEW" "$STAGE" || { rm -rf "$STAGE"; return 1; }
  "$CODESIGN" --verify "$STAGE" || { rm -rf "$STAGE"; return 2; }
  "$XATTR" -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
  say "the new build is copied and its signature checks out"
}
putback() { if [ -n "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi; }
fail() { say "$1"; echo "$1" > "$ROLLED"; }
# Nothing was installed: let the copy end, then remove it (the old build stays as it is).
drop_stage() { wait "$STAGER" 2>/dev/null; rm -rf "$STAGE"; }
stage & STAGER=$!
say "waiting for botlingd ($PID) to stop; it stops once the Botling 3 window quit"
n=0; max="$(ticks "$QUIT_WAIT")"; while alive "$PID" && [ "$n" -lt "$max" ]; do sleep "$TICK"; n=$((n + 1)); done
if alive "$PID"; then
  say "botlingd did not stop in $QUIT_WAIT seconds; SIGTERM, as botlingd stop sends"
  kill -TERM "$PID" 2>/dev/null
  n=0; max="$(ticks "$APP_WAIT")"; while alive "$PID" && [ "$n" -lt "$max" ]; do sleep "$TICK"; n=$((n + 1)); done
fi
if alive "$PID"; then drop_stage; fail "botlingd did not stop; nothing changed"; reopen "$PREVIOUS"; exit 1; fi
if ! end_bundle "$PREVIOUS" 0; then drop_stage; fail "Botling 3 did not quit; nothing changed"; reopen "$PREVIOUS"; exit 1; fi
wait "$STAGER"; STAGED=$?
case "$STAGED" in
  0) ;;
  1) fail "could not copy the new build"; reopen "$PREVIOUS"; exit 1 ;;
  2) fail "the copied build's signature does not check out"; reopen "$PREVIOUS"; exit 1 ;;
  *) fail "could not make the folder for the new build"; reopen "$PREVIOUS"; exit 1 ;;
esac
if [ -e "$TARGET" ]; then
  say "moving $TARGET to $BACKUP"
  mv "$TARGET" "$BACKUP" || { rm -rf "$STAGE"; fail "could not move the old build"; reopen "$PREVIOUS"; exit 1; }
else
  BACKUP=""
  say "installing to $TARGET (the running build stays at $PREVIOUS)"
fi
mv "$STAGE" "$TARGET" || { rm -rf "$STAGE"; putback; fail "could not put the new build in place"; reopen "$PREVIOUS"; exit 1; }
say "opening the new build"
launch "$TARGET"
n=0; max="$(ticks "$WAIT")"
while [ "$n" -lt "$max" ]; do
  if [ -f "$HEALTHY" ]; then say "the new build is up"; exit 0; fi
  sleep "$TICK"; n=$((n + 1))
done
say "the new build did not come up in $WAIT seconds; putting the old one back"
end_bundle "$TARGET" 1
rm -rf "$TARGET.failed"; mv "$TARGET" "$TARGET.failed" 2>/dev/null
putback
fail "the new build did not come up in $WAIT seconds"
reopen "$PREVIOUS"
exit 1
`;

/**
 * Writes the state and the script; returns the command that runs the script (detached; the app quits right after).
 * With `serverDir` (Botling 3: botlingd's data folder) it is the Botling 3 script, `pid` is botlingd's, and the command
 * ends with that folder (thirteen words).
 */
export function prepareInstall(root: string, from: BuildInfo, to: BuildInfo, requester: string, note: string, pid: number, dataDir: string, now = new Date(), target = from.path, serverDir?: string): string[] {
  // Rollback and the detached script must name the real folders, not an alias.
  root = physicalPath(root);
  if (dataDir) dataDir = physicalPath(dataDir);
  const v3 = !!serverDir;
  const folder = updateFolder(root);
  mkdirSync(join(folder, "backups"), { recursive: true });
  for (const marker of [healthyFile(root), rolledBackFile(root)]) rmSync(marker, { force: true });
  const stamp = `${now.toISOString().slice(0, 10)}-${Math.floor(now.getTime() / 1000)}`;
  const backup = join(folder, "backups", `Botling-${v3 ? 3 : 2}-${from.version.replace(/[^0-9A-Za-z.-]/g, "_")}-${stamp}.app`);
  const state: InstallState = { from, to, requesterID: requester, note, startedAt: now.toISOString(), backup };
  writeFileAtomic(stateFile(root), JSON.stringify(state, null, 2));
  writeFileSync(scriptFile(root), v3 ? INSTALL_SCRIPT_V3 : INSTALL_SCRIPT, { mode: 0o700 });
  const command = ["/usr/bin/nohup", "/bin/bash", scriptFile(root), String(pid), target, to.path, backup, healthyFile(root), rolledBackFile(root), String(v3 ? HEALTH_WAIT_S_V3 : HEALTH_WAIT_S), dataDir, from.path];
  return v3 ? [...command, physicalPath(serverDir!)] : command;
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

