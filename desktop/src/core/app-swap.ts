// Installing a developer build (`<install-build path="…/Botling 2.app">what changed</install-build>`): the project
// that is Botling's own source may ask to install a build it made. The user confirms on a card in the main bot's
// chat; then a small script outside the app waits for it to quit (bots write their notes first), moves the running
// build aside, puts the new one in its place and opens it. The new build says it came up by writing `healthy` once
// it has run `HEALTHY_AFTER_MS`; if it does not within `HEALTH_WAIT_S`, the script puts the old build back, opens it,
// and writes `rolled-back`. Either way the next start tells the bot that asked how it went.
// `<app-screenshot/>` sends that bot a picture of the app's window.
//
// This is the only way the app replaces itself without electron-updater (main/updates.ts), which installs
// released versions: notices about those are announced here, in the main bot's chat (`announceRelease`).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./durable/atomic";

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

/** Resolve existing symlinks, retaining lexical paths for destinations that do not exist yet. */
function physicalPath(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

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
 * The script, run as: install.sh pid target new backup healthy rolled-back seconds data-dir previous.
 * `previous` is the running build, opened again when the new one fails. A target that is not there yet needs no backup.
 */
export const INSTALL_SCRIPT = `#!/bin/bash
# Installs a new Botling 2 build while the old one quits; puts the old one back if the
# new one does not come up. Written by Botling 2 (core/app-swap.ts, after 1.x's SelfUpdate.swift).
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
  "src/core/agent/codex.ts", "src/core/agent/codex-tools.json", "src/core/settings.ts", "src/core/app-swap.ts",
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
  /** Whether developer mode is on (Settings → Developer). The main bot's update notice is shown only then. */
  developerMode: () => boolean;
  mainBot: () => DeskBot;
  bot: (id: string) => DeskBot | null;
  /** Main's pid (the script waits for it to quit) and its data folder (the new build opens with it). */
  appPid: number | null;
  appDataDir: string | null;
  /** Where developer work goes (`devWorkRoot`); absent or null: beside the project. */
  devWork?: () => string | null;
  /** Starts the script detached, then asks main to quit. */
  launchInstaller: (command: string[], log: string) => void;
  /** A PNG of the app's window, or null. */
  captureWindow: () => Promise<string | null>;
  /** Main downloads the newer release and restarts on it (`main/updates.ts`). */
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

  /** What the developer project's manager is told on top of a manager's usual instructions (`developerBriefing`). */
  briefing(bot: DeskBot, appWorktree = false): string {
    if (this.deps.developer()?.id !== bot.id) return "";
    // Development work goes on the work drive when it is there (`devWorkRoot`), else beside the project.
    const work = this.deps.devWork?.() ?? null;
    const worktrees = work ?? join(bot.profile.folder, ".bot", "worktrees");
    const dist = work ? join(work, "builds", "dist") : null;
    return `(App: Developer mode. This folder is Botling's own source, the app you are running in (Botling 2 is in desktop/), and you develop it.
${appWorktree
  ? "- One writer at a time. The app made the git worktree you work in (the Worktree note says where): edit, build and test there and commit there; do not run git worktree yourself. When the tests pass, say so; the user merges it into the main branch from the app, which removes the worktree. If git status in the main folder shows changes you did not make, someone else is working: stop and ask the user."
  : `- One writer at a time. Do each task in a git worktree of its own: git worktree add ${worktrees}/<short-task> -b bot/<short-task>. Edit, build and test there; when the tests pass, merge it into the main branch and remove the worktree. If git status in the main folder shows changes you did not make, someone else is working: stop and ask the user.`}
- Feedback from the user ("not right" on a reply) comes to you with the chat around it. First write a test that shows the problem, then fix it, then say in one sentence what was wrong.
- To try your work: ${appWorktree ? "from your worktree (relative paths; do not cd to the main folder)" : "from the main folder, after merging,"} build the app with cd desktop && ${dist ? `BOTLING_DIST_DIR=${dist} ` : ""}npm run dist:dir; it is written to ${dist ?? "desktop/dist"}/mac-arm64/Botling 2.app (mac-x64 on Intel).
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
    return this.card(build, running, note, from);
  }

  /** The confirm card. */
  private card(build: BuildInfo, running: BuildInfo, note: string, from: DeskBot) {
    const main = this.deps.mainBot();
    const lines = [`**${from.profile.name}** wants to install a new Botling build and restart.`, "", `- New: ${buildLabel(build)}`, `- Running: ${buildLabel(running)}`, `- Installed in place: ${running.path}. Existing data stays in its current location.`];
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
    lines.push("", `Bots save their original conversations and unfinished work before restart. Supported work resumes automatically; pending permissions or uncertain execution stay paused for reconciliation. If the new build does not come up within ${HEALTH_WAIT_S} seconds, the running one comes back by itself.`);
    const install = "Install and restart";
    main.appNotice(lines.join("\n"), [
      { label: sensitive ? `${install} anyway` : install, recommended: !sensitive },
      { label: "Not now", recommended: sensitive },
    ], (index) => this.answer(build, from.id, what, index === 0), { sourceID: from.id });
    from.queueNote(`(App: The user sees a card asking to install ${buildLabel(build)}. Nothing happens until they pick.)`);
  }

  /** Your pick on a build card (`answerBuild`): the script is written and started, and the app quits for it. */
  answer(build: BuildInfo, requester: string, note: string, install: boolean): void {
    const asker = this.deps.bot(requester);
    if (!install) {
      asker?.queueNote(`(App: The user chose not to install ${buildLabel(build)} now.)`);
      return;
    }
    const running = this.deps.runningBuild();
    if (!running || !this.deps.appPid) return;
    try {
      const command = prepareInstall(this.deps.root, running, build, requester, note, this.deps.appPid, this.deps.appDataDir ?? "");
      this.deps.log(`installing ${buildLabel(build)} for ${requester}`);
      this.deps.launchInstaller(command, installLog(this.deps.root));
    } catch (error) {
      this.deps.mainBot().appNotice(`Couldn't install ${buildLabel(build)}: ${(error as Error).message}. Nothing was installed.`, undefined, undefined, { sourceID: requester });
      asker?.queueNote(`(App: ${buildLabel(build)} was not installed: ${(error as Error).message}.)`);
    }
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
        const how = "";
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
    // Everyone else updates from the sidebar entry (renderer/UpdateEntry.tsx); the chat notice is for developers.
    if (!this.deps.developerMode()) return null;
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
