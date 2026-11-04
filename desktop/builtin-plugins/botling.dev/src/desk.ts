// The developer tools' desk (1.x's Workspace+Developer.swift): the briefing the developer project's manager hears, the
// confirm card for `<install-build>`, starting the install, how it went at the next start, and `<app-screenshot/>`.
// What it needs of the app and the bots comes in `DevBuildDeps` (host.ts gives it the plugin api's `app`), so tests give fakes.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pruneBackups, pruneUpdateLeftovers } from "./prune";
import {
  FAILURE_LIMIT, HEALTHY_AFTER_MS, HEALTH_WAIT_S, buildLabel, failures, failuresFile, finishInstall, installLog, installOutcome, prepareInstall, updateFolder,
  readBuild, sensitiveChanges, setFailures, type BuildInfo,
} from "./swap";

/** What the desk needs of a bot. */
export interface DeskBot {
  readonly id: string;
  readonly profile: { name: string; folder: string };
  appNotice(text: string, choices?: { label: string; recommended?: boolean; detail?: string }[], onPick?: (index: number) => void, more?: { sourceID?: string }): unknown;
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
  /** Where developer work goes (`devWorkRoot`); absent or null: beside the project. */
  devWork?: () => string | null;
  /** The folder holding update leftovers (~/Applications); absent or null: they are not cleaned up. */
  applicationsDir?: () => string | null;
  /** Starts the script detached, then asks main to quit (the core checkpoints running work first: `app.installAndRestart`). */
  launchInstaller: (command: string[], log: string) => void | Promise<void>;
  /** A PNG of the app's window, or null. */
  captureWindow: () => Promise<string | null>;
  log: (line: string) => void;
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
    ], (index) => { void this.answer(build, from.id, what, index === 0); }, { sourceID: from.id });
    from.queueNote(`(App: The user sees a card asking to install ${buildLabel(build)}. Nothing happens until they pick.)`);
  }

  /** Your pick on a build card (`answerBuild`): the script is written and started, and the app quits for it. */
  async answer(build: BuildInfo, requester: string, note: string, install: boolean): Promise<void> {
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
      await this.deps.launchInstaller(command, installLog(this.deps.root));
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
        finishInstall(this.deps.root);
        setFailures(this.deps.root, 0);
        this.cleanAfterUpdate(state);
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

  /**
   * The new build is up: keep only the newest two backups (never this install's rollback copy or a running build) and
   * remove the leftovers in ~/Applications (prune.ts). Failures are logged; they never get in the way of the update.
   */
  private cleanAfterUpdate(state: { from: BuildInfo; to: BuildInfo; backup: string }) {
    const protect = [state.backup, state.from.path, state.to.path, this.deps.runningBuild()?.path].filter((path): path is string => !!path);
    try {
      const backups = pruneBackups(join(updateFolder(this.deps.root), "backups"), { protect });
      if (backups.removed.length) this.deps.log(`removed ${backups.removed.length} old backup(s)`);
      const applications = this.deps.applicationsDir?.();
      if (applications) {
        const leftovers = pruneUpdateLeftovers(applications, { protect });
        if (leftovers.removed.length) this.deps.log(`removed ${leftovers.removed.length} update leftover(s) from ${applications}`);
      }
    } catch (error) { this.deps.log(`cleanup after the update: ${(error as Error).message}`); }
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
