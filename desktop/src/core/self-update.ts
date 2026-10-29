// Developer mode's own builds (1.x's SelfUpdate.swift and Workspace+Developer.swift): the project that
// is Botling's own source may ask, with `<install-build path="…/Botling 2.app">what changed</install-build>`,
// to install a build it made. The user confirms on a card in the main bot's chat; then a small script
// outside the app waits for it to quit (bots write their notes first), moves the running build aside,
// puts the new one in its place and opens it. The new build says it came up by writing `healthy` once it
// has run `HEALTHY_AFTER_MS`; if it does not within `HEALTH_WAIT_S`, the script puts the old build back,
// opens it, and writes `rolled-back`. Either way the next start tells the bot that asked how it went.
// `<app-screenshot/>` sends that bot a picture of the app's window.
//
// Signed releases (main/updates.ts finds them, main/update-install.ts installs them) are announced the
// same way: an update notice in the main bot's chat, installed and restarted on only after the user's
// pick there (`announceRelease`).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./durable/atomic";
import { planText, PART_NAMES, type HotReport, type InstallPlan } from "../hot-install-plan";

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

/** The external volume a path is on (`/Volumes/<name>`), or null when it is on this Mac's own disk. */
export function externalVolume(path: string): string | null {
  const match = /^\/Volumes\/([^/]+)(?:\/|$)/.exec(resolve(path));
  return match ? join("/Volumes", match[1]!) : null;
}

/**
 * Where a developer build is installed: in place of the running one when that is on this Mac's own disk;
 * else (running from an external volume) as ~/Applications/<same name>.app. Only development work lives on
 * the external drive; the app the user runs does not. The copy on the drive is left as it is and is the one
 * opened again if the new build does not come up.
 */
export function installTarget(running: string, home: string): string {
  return externalVolume(running) && home.startsWith("/") ? join(home, "Applications", basename(running)) : resolve(running);
}

/** Resolve existing symlinks, retaining lexical paths for destinations that do not exist yet. */
function physicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * Where external data goes when installing a local build (including an app already local): the data folder
 * it opens with when nothing names one (`localDataDir`, ~/Library/Application Support/Botling 2 Dev Trial for
 * a dev trial build), when the data is on an external volume now. Null: it stays where it is. The script
 * copies it there (leaving the copy on the drive as it is) only if this Mac's disk has room.
 */
export function localDataMove(dataDir: string | null, _running: string, target: string, localDataDir: string | null | undefined): string | null {
  if (!dataDir || !localDataDir || !localDataDir.startsWith("/") || !dataDir.startsWith("/")) return null;
  if (!externalVolume(physicalPath(dataDir)) || externalVolume(localDataDir) || externalVolume(physicalPath(dirname(localDataDir))) || externalVolume(physicalPath(target))) return null;
  const local = resolve(localDataDir);
  const source = physicalPath(dataDir);
  return local === source || local.startsWith(`${source}/`) ? null : local;
}

/** Room the data's copy must leave free on this Mac's disk, beyond its own size (KiB; the script's MARGIN). */
export const DATA_MARGIN_KB = 2 * 1024 * 1024;

/** Whether a folder is there: on an external volume only when that volume is mounted (not an empty /Volumes stub). */
export function folderAvailable(path: string): boolean {
  const volume = externalVolume(path);
  try {
    if (volume && statSync(volume).dev === statSync("/Volumes").dev) return false;
    return statSync(path).isDirectory();
  } catch { return false; }
}

/** The external work drive's folder for development (BOTLING_DEV_WORK_DIR; Botling's maintainers use /Volumes/My-SSD/botling-work). */
export const DEV_WORK_DIR = "/Volumes/My-SSD/botling-work";

/** Where developer work (worktrees, builds) goes: the work drive's folder when it is there, else null (beside the project). */
export function devWorkRoot(env: Record<string, string | undefined> = process.env, available = folderAvailable): string | null {
  const dir = env.BOTLING_DEV_WORK_DIR?.trim() || DEV_WORK_DIR;
  return dir.startsWith("/") && available(dir) ? resolve(dir) : null;
}

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
  /** Why this install restarts (main's comparison: "restart (kernel changed: main process)"); absent before hot installs existed. */
  mode?: string;
}

export const updateFolder = (root: string) => join(root, "self-update");
const stateFile = (root: string) => join(updateFolder(root), "state.json");
const healthyFile = (root: string) => join(updateFolder(root), "healthy");
const rolledBackFile = (root: string) => join(updateFolder(root), "rolled-back");
const failuresFile = (root: string) => join(updateFolder(root), "failures");
export const installLog = (root: string) => join(updateFolder(root), "install.log");
const scriptFile = (root: string) => join(updateFolder(root), "install.sh");

const declinedFile = (root: string) => join(updateFolder(root), "declined-release");

/** The release the user said Not now to (it is not announced again). */
export function declinedRelease(root: string): string | null {
  try { return readFileSync(declinedFile(root), "utf8").trim() || null; } catch { return null; }
}

function setDeclinedRelease(root: string, version: string) {
  mkdirSync(updateFolder(root), { recursive: true });
  writeFileSync(declinedFile(root), `${version}\n`);
}

/** Builds in a row that did not come up. */
export function failures(root: string): number {
  try { const count = Number.parseInt(readFileSync(failuresFile(root), "utf8").trim(), 10); return Number.isFinite(count) ? count : 0; } catch { return 0; }
}

export function setFailures(root: string, count: number) {
  mkdirSync(updateFolder(root), { recursive: true });
  writeFileSync(failuresFile(root), `${count}\n`);
}

/**
 * The script, run as: install.sh pid target new backup healthy rolled-back seconds data-dir previous [local-data].
 * (1.x's, with the new build opened with the data folder this one uses.) `previous` is the running build,
 * opened again when the new one fails; it differs from `target` when the build moves off an external volume
 * (`installTarget`), and is then left untouched. A target that is not there yet needs no backup.
 *
 * `local-data` (`localDataMove`): the data folder moves with the build. Once the app has quit, the data is
 * copied there (without the old builds kept in self-update/backups, or Electron's single-instance lock) if the disk has room for it plus
 * DATA_MARGIN_KB, the old folder's path is rewritten to the new one in the copy's text files, and the new
 * build opens with an explicit BOTLING_DATA_DIR matching the health check (it says
 * it is up in the copy's self-update/healthy). The data on the drive is never changed but for its finished
 * install state; it is what the old build reopens with if the new one does not come up, and the copy is then
 * set aside. Without room, the data stays on the drive and the new build opens with it, as before.
 */
export const INSTALL_SCRIPT = `#!/bin/bash
# Installs a new Botling 2 build while the old one quits; puts the old one back if the
# new one does not come up. Written by Botling 2 (core/self-update.ts, after 1.x's SelfUpdate.swift).
PID="$1"; TARGET="$2"; NEW="$3"; BACKUP="$4"; HEALTHY="$5"; ROLLED="$6"; WAIT="$7"; DATA="$8"; PREVIOUS="\${9:-$2}"; LOCAL="\${10:-}"
OPEN="\${BOTLING_TEST_OPEN:-/usr/bin/open}"
MARGIN=${DATA_MARGIN_KB}
NEWDATA="$DATA"; MOVED=""; ASIDE=""
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
kib() { if [ -e "$1" ]; then du -sk "$1" 2>/dev/null | awk '{print $1}'; else echo 0; fi; }
movedata() {
  case "$HEALTHY" in "$DATA"/*) ;; *) say "the install state is not in $DATA; the data stays there"; return 1;; esac
  local skip parent need free part
  skip="$(dirname "$HEALTHY")/backups"
  need=$(( $(kib "$DATA") - $(kib "$skip") + MARGIN ))
  parent="$(dirname "$LOCAL")"
  mkdir -p "$parent" || { say "could not make $parent; the data stays in $DATA"; return 1; }
  free="\${BOTLING_TEST_FREE_KB:-$(df -Pk "$parent" | awk 'NR==2 {print $4}')}"
  if [ -z "$free" ] || [ "$free" -lt "$need" ]; then
    say "not enough room for the data on this disk ($free KiB free, $need KiB needed with the margin); it stays in $DATA"; return 1
  fi
  part="$LOCAL.partial"
  rm -rf "$part"
  say "copying the data from $DATA to $LOCAL (without \${skip#"$DATA"/})"
  if ! /usr/bin/rsync -a --exclude "/\${skip#"$DATA"/}/" --exclude "/electron/Singleton*" "$DATA/" "$part/"; then
    say "could not copy the data; it stays in $DATA"; rm -rf "$part"; return 1
  fi
  find "$part" -type f -print0 | xargs -0 grep -lIF -- "$DATA" 2>/dev/null | while IFS= read -r file; do
    OLDDIR="$DATA" NEWDIR="$LOCAL" /usr/bin/perl -pi -e 's/\\Q$ENV{OLDDIR}\\E/$ENV{NEWDIR}/g' "$file" && say "rewrote the data folder's path in \${file#"$part"/}"
  done
  if [ -e "$LOCAL" ]; then
    ASIDE="$LOCAL.before-$(date '+%Y%m%d-%H%M%S')"
    say "moving the data already at $LOCAL to $ASIDE"
    mv "$LOCAL" "$ASIDE" || { say "could not; the data stays in $DATA"; ASIDE=""; rm -rf "$part"; return 1; }
  fi
  mv "$part" "$LOCAL" || { say "could not put the copy in place; the data stays in $DATA"; rm -rf "$part"; if [ -n "$ASIDE" ]; then mv "$ASIDE" "$LOCAL"; fi; return 1; }
  HEALTHY="$LOCAL/\${HEALTHY#"$DATA"/}"; NEWDATA="$LOCAL"; MOVED=1
  return 0
}
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
if [ -n "$LOCAL" ] && [ -n "$DATA" ]; then movedata; fi
say "opening the new build\${MOVED:+ with the data in $LOCAL}"
launch "$TARGET" "$NEWDATA"
for i in $(seq 1 "$WAIT"); do
  if [ -f "$HEALTHY" ]; then
    say "the new build is up"
    if [ -n "$MOVED" ]; then
      OLDSTATE="$(dirname "$ROLLED")/state.json"
      mv "$OLDSTATE" "$OLDSTATE.moved" 2>/dev/null
      printf 'Botling 2 now keeps its data in %s (copied %s by the install of %s).\\nThis folder is left as it was; the build on the drive opens with it.\\n' "$LOCAL" "$(date '+%Y-%m-%d %H:%M:%S')" "$TARGET" > "$DATA/MOVED-TO-LOCAL-DISK.txt"
    fi
    exit 0
  fi
  sleep 1
done
say "the new build did not come up in $WAIT seconds; putting the old one back"
pkill -f "$TARGET/Contents/MacOS/" ; sleep 2
rm -rf "$TARGET.failed"; mv "$TARGET" "$TARGET.failed" 2>/dev/null
putback
if [ -n "$MOVED" ]; then
  FAILED="$LOCAL.failed-$(date '+%Y%m%d-%H%M%S')"
  say "setting the data copy aside as $FAILED; the build on the drive opens with $DATA"
  mv "$LOCAL" "$FAILED"
  if [ -n "$ASIDE" ]; then mv "$ASIDE" "$LOCAL"; fi
fi
echo "the new build did not come up in $WAIT seconds" > "$ROLLED"
reopen "$PREVIOUS"
exit 1
`;

/** Writes the state and the script; returns the command that runs the script (detached; the app quits right after). */
export function prepareInstall(root: string, from: BuildInfo, to: BuildInfo, requester: string, note: string, pid: number, dataDir: string, now = new Date(), mode?: string, target = from.path, localData = ""): string[] {
  // Pin the source before migration replaces a local alias (symlink) with the real copy.
  // Rollback and the detached script must still name the original data on the drive.
  root = physicalPath(root);
  if (dataDir) dataDir = physicalPath(dataDir);
  const folder = updateFolder(root);
  mkdirSync(join(folder, "backups"), { recursive: true });
  for (const marker of [healthyFile(root), rolledBackFile(root)]) rmSync(marker, { force: true });
  const stamp = `${now.toISOString().slice(0, 10)}-${Math.floor(now.getTime() / 1000)}`;
  const backup = join(folder, "backups", `Botling-2-${from.version.replace(/[^0-9A-Za-z.-]/g, "_")}-${stamp}.app`);
  const state: InstallState = { from, to, requesterID: requester, note, startedAt: now.toISOString(), backup, ...(mode ? { mode } : {}) };
  writeFileAtomic(stateFile(root), JSON.stringify(state, null, 2));
  writeFileSync(scriptFile(root), INSTALL_SCRIPT, { mode: 0o700 });
  return ["/usr/bin/nohup", "/bin/bash", scriptFile(root), String(pid), target, to.path, backup, healthyFile(root), rolledBackFile(root), String(HEALTH_WAIT_S), dataDir, from.path, ...(localData ? [localData] : [])];
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

/** The new build is up: the script stops waiting, and the state is done with. */
export function markHealthy(root: string) {
  mkdirSync(updateFolder(root), { recursive: true });
  writeFileSync(healthyFile(root), "ok\n");
  finishInstall(root);
}

export function finishInstall(root: string) {
  rmSync(stateFile(root), { force: true });
  rmSync(rolledBackFile(root), { force: true });
}

/** Files whose changes alter what bots are told or allowed to do (repo-relative endings); a build that changes them says so on its card. */
export const SENSITIVE_PATHS = [
  "src/core/prompts.ts", "src/core/prompts-codex-text.ts", "src/core/maintainer-text.ts", "src/core/agent/head.ts",
  "src/core/agent/codex.ts", "src/core/agent/codex-tools.json", "src/core/settings.ts", "src/core/self-update.ts",
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

// ------------------------------------------------------------------------------------------------
// The workspace's side (Workspace+Developer.swift)

/** What the desk needs of a bot. */
export interface DeskBot {
  readonly id: string;
  readonly profile: { name: string; folder: string };
  appNotice(text: string, choices?: { label: string; recommended?: boolean; detail?: string }[], onPick?: (index: number) => void, more?: { sourceID?: string }): string;
  relay(text: string, more?: { files?: string[] }): unknown;
  queueNote(note: string): void;
}

export interface DevBuildDeps {
  /** The core's data folder (state, script, log, screenshots under self-update/). */
  root: string;
  /** The app bundle running now (null: not running from a bundle, as in development). */
  runningBuild: () => BuildInfo | null;
  /** The developer project's bot while developer mode is on. */
  developer: () => DeskBot | null;
  mainBot: () => DeskBot;
  bot: (id: string) => DeskBot | null;
  /** Main's pid (the script waits for it to quit) and its data folder (the new build opens with it). */
  appPid: number | null;
  appDataDir: string | null;
  /** Where a build replacing `running` is installed (`installTarget`); absent: in its place. */
  installTarget?: (running: string) => string;
  /** The data folder the app opens with when nothing names one (packaged: ~/Library/Application Support/…); the data moves there with a build that moves off an external volume (`localDataMove`). */
  localDataDir?: string | null;
  /** Where developer work goes (`devWorkRoot`); absent or null: beside the project. */
  devWork?: () => string | null;
  /** Starts the script detached, then asks main to quit. */
  launchInstaller: (command: string[], log: string) => void;
  /** A PNG of the app's window, or null. */
  captureWindow: () => Promise<string | null>;
  /**
   * Main compares a build with the running one (main/hot-install.ts): hot when only the core, chat page or
   * shell changed. Absent: every install restarts, as before.
   */
  planBuild?: (path: string) => Promise<InstallPlan>;
  /** Main authenticates the confirmed mode: hot apply, or snapshot-protected restart. */
  hotInstall?: (request: { mode: "hot" | "restart"; path: string; requester: string; note: string; from: string; to: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Main downloads and verifies the newer release, then quits for its install (`update-install.ts`). */
  installRelease?: () => Promise<{ ok: boolean; error?: string }>;
  log: (line: string) => void;
}

/** A newer signed release main found (main/updates.ts), to announce in the main bot's chat. */
export interface ReleaseNotice {
  version: string;
  name: string;
  url: string;
  /** The version running now. */
  current: string;
  /** Null: it can be installed from here; else why not (open the release page instead). */
  unavailable: string | null;
}

/** A path as 1.x reads `<install-build path>` (`folderURL`: ~ and file: URLs). */
function bundlePath(raw: string): string | null {
  let path = raw.trim();
  if (!path) return null;
  if (path.startsWith("file:")) { try { path = decodeURIComponent(new URL(path).pathname); } catch { return null; } }
  if (path === "~" || path.startsWith("~/")) path = join(process.env.HOME ?? "", path.slice(1));
  return path.startsWith("/") ? resolve(path) : null;
}

export class DevBuilds {
  constructor(private deps: DevBuildDeps) {}

  /** Where a build replacing `running` goes (`installTarget`). */
  private target(running: BuildInfo): string { return this.deps.installTarget?.(running.path) ?? running.path; }
  /** Whether it goes somewhere else than the running build (off an external volume). */
  private moves(running: BuildInfo): boolean { return resolve(this.target(running)) !== resolve(running.path); }
  /** Where the data goes with this install (`localDataMove`); null: it stays. */
  private dataMove(running: BuildInfo): string | null { return localDataMove(this.deps.appDataDir, running.path, this.target(running), this.deps.localDataDir); }

  /** What the developer project's manager is told on top of a manager's usual instructions (`developerBriefing`). */
  briefing(bot: DeskBot): string {
    if (this.deps.developer()?.id !== bot.id) return "";
    // Development work goes on the work drive when it is there (`devWorkRoot`), else beside the project.
    const work = this.deps.devWork?.() ?? null;
    const worktrees = work ?? join(bot.profile.folder, ".bot", "worktrees");
    const dist = work ? join(work, "builds", "dist") : null;
    return `(App: Developer mode. This folder is Botling's own source, the app you are running in (Botling 2 is in desktop/), and you develop it.
- One writer at a time. Do each task in a git worktree of its own: git worktree add ${worktrees}/<short-task> -b bot/<short-task>. Edit, build and test there; when the tests pass, merge it into the main branch and remove the worktree. If git status in the main folder shows changes you did not make, someone else is working: stop and ask the user.
- Feedback from the user ("not right" on a reply) comes to you with the chat around it. First write a test that shows the problem, then fix it, then say in one sentence what was wrong.
- To try your work: from the main folder, after merging, build the app with cd desktop && ${dist ? `BOTLING_DIST_DIR=${dist} ` : ""}npm run dist:dir; it is written to ${dist ?? "desktop/dist"}/mac-arm64/Botling 2.app (mac-x64 on Intel).
- To install it: write where you are into your memory file first (you are restarted too), then end your reply with <install-build path="full path of that Botling 2.app">what changed, in a sentence or two</install-build>. The user confirms; the app restarts on the new build and tells you whether it came up. A build that does not come up is rolled back by itself.
- To see the running app: end your reply with <app-screenshot/>; a picture of its window comes back to you.
- Never change what bots may do (tools, permissions, the prompts' rules) unless the user asked for it; the install card shows such changes to the user.)`;
  }

  /**
   * A manager asked to install a build (`proposeBuild`): only the developer project, from a real app bundle of
   * Botling 2 that is not the running one, while builds have not failed too often; a card shows what changes,
   * with a warning when it changes what bots are told or allowed to do.
   */
  propose(path: string, note: string, from: DeskBot) {
    if (this.deps.developer()?.id !== from.id) {
      from.queueNote("(App: Installing builds of Botling needs developer mode with this project as Botling's source; it is off. Nothing was installed.)");
      return;
    }
    const main = this.deps.mainBot();
    const refuse = (why: string) => {
      main.appNotice(`${from.profile.name} asked to install a Botling build, but ${why}`, undefined, undefined, { sourceID: from.id });
      from.queueNote(`(App: The build was not installed: ${why})`);
    };
    const running = this.deps.runningBuild();
    if (!running || !this.deps.appPid) return refuse("this Botling is not running from an app bundle (a development run), so it cannot replace itself.");
    if (failures(this.deps.root) >= FAILURE_LIMIT) return refuse(`the last ${FAILURE_LIMIT} builds did not come up, so installing is paused. Turn developer mode off and on in Settings to allow it again.`);
    const folder = bundlePath(path);
    const build = folder ? readBuild(folder) : null;
    if (!build) return refuse(`there is no app bundle at ${path}.`);
    if (build.bundleID !== running.bundleID) return refuse(`${path} is not Botling 2 (${build.bundleID}).`);
    if (build.path === running.path) return refuse("that is the build running now; build into desktop/dist/ and point at that.");
    // Main must authenticate the candidate even when a restart is expected.
    if (!this.deps.planBuild) return refuse("signed build verification is unavailable.");
    // Main compares the builds first, so the card can say whether the app restarts.
    return this.deps.planBuild(build.path).then(
      (plan) => plan.blocked ? refuse(plan.mode === "restart" ? plan.reasons.join("; ") : "Build verification failed") : this.card(build, running, note, from, plan),
      (error) => refuse(`could not authenticate the build: ${(error as Error).message}`),
    );
  }

  /** The confirm card; `plan` null: not compared (always a restart, as in 1.x). */
  private card(build: BuildInfo, running: BuildInfo, note: string, from: DeskBot, plan: InstallPlan | null) {
    const main = this.deps.mainBot();
    const hot = plan?.mode === "hot";
    const lines = [hot ? `**${from.profile.name}** wants to install a new Botling build without restarting.` : `**${from.profile.name}** wants to install a new Botling build and restart.`, "", `- New: ${buildLabel(build)}`, `- Running: ${buildLabel(running)}`];
    if (plan) lines.push(`- Expected: ${planText(plan)}`);
    // Authenticated installs use the snapshot-protected main installer in place; never promise
    // the legacy helper's implicit app/data relocation on this card.
    lines.push(`- Installed in place: ${running.path}. Existing data stays in its current location.`);
    const what = note.trim();
    if (what) lines.push("", what);
    if (build.dirty) lines.push("", "It was built from uncommitted changes.");
    let sensitive = false;
    if (running.commit && build.commit) {
      const changes = sensitiveChanges(from.profile.folder, running.commit, build.commit);
      if (changes?.length) {
        sensitive = true;
        lines.push("", "⚠️ **It changes what bots are told or allowed to do:**", ...changes.map((change) => `- \`${change.file}\` +${change.added} −${change.removed}`));
        lines.push("", `To read it first: \`git -C ${from.profile.folder} diff ${running.commit.slice(0, 7)} ${build.commit.slice(0, 7)} -- ${changes.map((change) => change.file).join(" ")}\``);
      }
    } else {
      lines.push("", "Which commits these are is not known, so changes to what bots may do cannot be shown.");
    }
    if (hot) {
      lines.push("", "The app keeps running: the new build is installed for the next launch, and its changed parts are applied in place. Bots finish their turns (or pause between tool calls) and go on in the same conversations. If the new core fails its self-check, the running one stays and the app on disk is put back.");
    } else {
      lines.push("", `Bots save their original conversations and unfinished work before restart. Supported work resumes automatically; pending permissions or uncertain execution stay paused for reconciliation. If the new build does not come up within ${HEALTH_WAIT_S} seconds, the running one comes back by itself.`);
    }
    const install = hot ? "Install and hot-apply" : "Install and restart";
    main.appNotice(lines.join("\n"), [
      { label: sensitive ? `${install} anyway` : install, recommended: !sensitive },
      { label: "Not now", recommended: sensitive },
    ], (index) => this.answer(build, from.id, what, index === 0, plan), { sourceID: from.id });
    from.queueNote(`(App: The user sees a card asking to install ${buildLabel(build)}${plan ? ` (${planText(plan)})` : ""}. Nothing happens until they pick.)`);
  }

  /**
   * Your pick on a build card (`answerBuild`). The builds are compared again: if the way it installs is no
   * longer what the card said (it was rebuilt meanwhile), nothing is installed and the bot is told to ask again.
   */
  answer(build: BuildInfo, requester: string, note: string, install: boolean, shown: InstallPlan | null = null): Promise<void> | void {
    const asker = this.deps.bot(requester);
    if (!install) {
      asker?.queueNote(`(App: The user chose not to install ${buildLabel(build)} now.)`);
      return;
    }
    const running = this.deps.runningBuild();
    if (!running || !this.deps.appPid) return;
    if (!this.deps.planBuild) { asker?.queueNote("(App: Signed build verification is unavailable. Nothing was installed.)"); return; }
    return this.deps.planBuild(build.path).then(async (plan) => {
      if (plan.blocked) { this.deps.mainBot().appNotice(`Build refused: ${plan.mode === "restart" ? plan.reasons.join("; ") : "verification failed"}`); return; }
      if (shown && plan.mode !== shown.mode) {
        const why = `${buildLabel(build)} changed since the card was shown (it now means ${planText(plan)}), so nothing was installed.`;
        this.deps.mainBot().appNotice(`${why} Ask again to see it.`, undefined, undefined, { sourceID: requester });
        asker?.queueNote(`(App: ${why} Ask again with <install-build> if it should be installed.)`);
        return;
      }
      // Main routes incompatible storage/kernel generations through the signed restart installer,
      // which snapshots quiescent data before candidate boot. Never use the legacy developer helper.
      const answer = await this.deps.hotInstall!({ mode: plan.mode, path: build.path, requester, note, from: buildLabel(running), to: buildLabel(build) })
        .catch((error) => ({ ok: false, error: (error as Error).message }));
      if (answer.ok) { this.deps.log(`installing ${buildLabel(build)} for ${requester} (${plan.mode})`); return; }
      this.deps.mainBot().appNotice(`Couldn't install ${buildLabel(build)}: ${answer.error ?? "main refused"}. Nothing was installed.`, undefined, undefined, { sourceID: requester });
      asker?.queueNote(`(App: ${buildLabel(build)} was not installed: ${answer.error ?? "main refused"}.)`);
    }, (error) => { this.deps.mainBot().appNotice(`Couldn't install ${buildLabel(build)}: ${(error as Error).message}`); });
  }

  /** Main's report of a hot install (main/hot-install.ts), to this core whether it is the new one or the one that stayed. */
  hotOutcome(report: HotReport) {
    const main = this.deps.mainBot();
    const asker = this.deps.bot(report.requester);
    const applied = report.applied.map((part) => PART_NAMES[part]).join(", ");
    if (report.ok) {
      setFailures(this.deps.root, 0);
      const what = applied ? `hot-applied: ${applied}` : "hot-applied: nothing besides the version differed";
      main.appNotice(`Botling installed ${report.to} (was ${report.from}) for ${asker?.profile.name ?? "a bot"} without restarting — ${what}. The kernel is unchanged; the next launch starts this build too.`, undefined, undefined, { sourceID: report.requester });
      try {
        asker?.relay(`(App) Botling installed ${report.to}, the build you asked to install${report.note ? ` (${report.note})` : ""}, without restarting — ${what}. Check that your change works (<app-screenshot/> shows the window), then say in one sentence whether it does.`);
      } catch (error) { this.deps.log(`could not tell ${report.requester}: ${(error as Error).message}`); }
      return;
    }
    const count = failures(this.deps.root) + 1;
    setFailures(this.deps.root, count);
    const paused = count >= FAILURE_LIMIT ? ` That is ${count} in a row: installing is paused until developer mode is turned off and on again.` : "";
    const still = applied ? ` Still running from the new build: ${applied}.` : "";
    const disk = report.disk === "stuck"
      ? ` The app on disk could not be put back, so it is now the new build while the old one runs: restart required (the next launch starts ${report.to}).`
      : report.disk === "restored" ? ` The app on disk was put back to ${report.from}.` : " The app on disk was not changed.";
    main.appNotice(`The new build ${report.to} could not be hot-applied: ${report.error ?? "it failed"}. ${report.from} keeps running.${still}${disk}${paused}`, undefined, undefined, { sourceID: report.requester });
    try {
      asker?.relay(`(App) The build you asked to install, ${report.to}, could not be hot-applied: ${report.error ?? "it failed"}. ${report.from} keeps running.${still}${disk} Find out why before trying again.${paused}`);
    } catch (error) { this.deps.log(`could not tell ${report.requester}: ${(error as Error).message}`); }
  }

  /**
   * At start: how an install went (`checkSelfUpdate`). The new build counts as up once it has run
   * `healthyAfterMs`; then the bot that asked is told, and so are you.
   */
  check(healthyAfterMs = HEALTHY_AFTER_MS): NodeJS.Timeout | null {
    const outcome = installOutcome(this.deps.root);
    if (!outcome) return null;
    const { state } = outcome;
    const main = this.deps.mainBot();
    if (outcome.kind === "installed") {
      const timer = setTimeout(() => {
        markHealthy(this.deps.root);
        setFailures(this.deps.root, 0);
        const asker = this.deps.bot(state.requesterID);
        const how = state.mode ? ` — ${state.mode.replace(/^restart/, "restarted")}` : "";
        main.appNotice(`Botling restarted on ${buildLabel(state.to)} (was ${buildLabel(state.from)}), installed for ${asker?.profile.name ?? "a bot"}${how}.`, undefined, undefined, { sourceID: state.requesterID });
        try {
          asker?.relay(`(App) Botling restarted on ${buildLabel(state.to)}, the build you asked to install${state.note ? ` (${state.note})` : ""}${how}. Read your memory file for where you were, check that your change works (<app-screenshot/> shows the window), then say in one sentence whether it does.`);
        } catch (error) { this.deps.log(`could not tell ${state.requesterID}: ${(error as Error).message}`); }
      }, healthyAfterMs);
      timer.unref?.();
      return timer;
    }
    finishInstall(this.deps.root);
    const count = failures(this.deps.root) + 1;
    setFailures(this.deps.root, count);
    const paused = count >= FAILURE_LIMIT ? ` That is ${count} in a row: installing is paused until developer mode is turned off and on again.` : "";
    main.appNotice(`The new build ${buildLabel(state.to)} did not come up (${outcome.reason}); ${buildLabel(state.from)} is running again.${paused}`, undefined, undefined, { sourceID: state.requesterID });
    try {
      this.deps.bot(state.requesterID)?.relay(`(App) The build you asked to install, ${buildLabel(state.to)}, did not come up: ${outcome.reason}. Botling put ${buildLabel(state.from)} back. The install log is ${installLog(this.deps.root)}; the failed build was kept beside the app as Botling 2.app.failed. Find out why before trying again.${paused}`);
    } catch (error) { this.deps.log(`could not tell ${state.requesterID}: ${(error as Error).message}`); }
    return null;
  }

  /** Releases announced in this run (a card does not outlive a restart, so the next run announces again). */
  private announced = new Set<string>();

  /**
   * A newer release: an update notice in the main bot's chat, like a build card (`proposeBuild`). Nothing is
   * installed until the user picks Install and restart there; then the app installs it and restarts on it.
   * Not now is remembered for that version.
   */
  announceRelease(release: ReleaseNotice): string | null {
    if (this.announced.has(release.version) || declinedRelease(this.deps.root) === release.version) return null;
    this.announced.add(release.version);
    const main = this.deps.mainBot();
    const lines = [`**Botling ${release.version}** is available (running ${release.current}).`, "", `[${release.name}](${release.url})`];
    if (release.unavailable || !this.deps.installRelease) {
      lines.push("", `It can't be installed from here: ${release.unavailable ?? "this Botling cannot replace itself."}`);
      return main.appNotice(lines.join("\n"));
    }
    lines.push("", "Bots save their original conversations and unfinished work before restart. Supported work resumes automatically; pending permissions or uncertain execution stay paused for reconciliation.");
    return main.appNotice(lines.join("\n"), [
      { label: "Install and restart", recommended: true },
      { label: "Not now" },
    ], (index) => this.answerRelease(release, index === 0));
  }

  /** Your pick on a release card. */
  answerRelease(release: ReleaseNotice, install: boolean) {
    if (!install) { setDeclinedRelease(this.deps.root, release.version); return; }
    const installRelease = this.deps.installRelease;
    if (!installRelease) return;
    this.deps.log(`installing release ${release.version}`);
    const failed = (why: string) => {
      this.announced.delete(release.version);
      this.deps.mainBot().appNotice(`Couldn't install Botling ${release.version}: ${why}`);
    };
    void installRelease().then((answer) => { if (!answer.ok) failed(answer.error ?? "it did not start."); }, (error) => failed((error as Error).message));
  }

  /** Developer mode turned on again: builds get a fresh start after failures (`setDeveloperMode`). */
  developerModeOn() {
    if (existsSync(failuresFile(this.deps.root))) setFailures(this.deps.root, 0);
  }

  /** The developer project's manager asked to see the app (`sendScreenshot`): a picture of its window comes back. */
  screenshot(to: DeskBot) {
    if (this.deps.developer()?.id !== to.id) {
      to.queueNote("(App: Screenshots of Botling need developer mode with this project as its source.)");
      return;
    }
    void this.deps.captureWindow().then((picture) => {
      try {
        if (!picture) to.relay("(App) Couldn't take a screenshot of the app's window.");
        else to.relay("(App) The app's window right now.", { files: [picture] });
      } catch (error) { this.deps.log(`screenshot: ${(error as Error).message}`); }
    }, (error) => this.deps.log(`screenshot: ${(error as Error).message}`));
  }
}

/** Starts the install script detached from the core (its output in the install log); it outlives the app. */
export function spawnInstaller(command: string[], log: string) {
  mkdirSync(join(log, ".."), { recursive: true });
  const out = openSync(log, "a");
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ["ignore", out, out] });
  child.unref();
}
