// The developer tools' desk (1.x's Workspace+Developer.swift): the briefing the developer project's manager hears, the
// confirm card for `<install-build>`, starting the install, how it went at the next start, and `<app-screenshot/>`.
// What it needs of the app and the bots comes in `DevBuildDeps` (host.ts gives it the plugin api's `app`), so tests give fakes.
import { existsSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pruneBackups, pruneUpdateLeftovers } from "./prune";
import {
  FAILURE_LIMIT, HEALTHY_AFTER_MS, HEALTH_WAIT_S, HEALTH_WAIT_S_V3, buildLabel, healthyFile, failures, failuresFile, finishInstall, installLog, installLogTail, installOutcome, installScriptRunning,
  prepareInstall, updateFolder, readBuild, sensitiveChanges, setFailures, whichBuild, type BuildInfo, type InstallState,
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
  /** The pid the script waits for to quit (main's; botlingd's in Botling 3) and the app's data folder (the new build opens with it). */
  appPid: number | null;
  appDataDir: string | null;
  /** Botling 3: botlingd's data folder (it runs the core); absent or null in 2.x. */
  serverDir?: string | null;
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

/** How often Botling 3's restart check looks for `healthy`. */
const HEALTHY_POLL_MS = 1_000;

export class DevBuilds {
  constructor(private deps: DevBuildDeps) {}

  /** Botling 3: the app is the window plus botlingd (it runs the core and this plugin). */
  private get v3(): boolean { return !!this.deps.serverDir; }
  private get product(): string { return this.v3 ? "Botling 3" : "Botling 2"; }

  /** What the developer project's manager is told on top of a manager's usual instructions (`developerBriefing`). */
  briefing(bot: DeskBot, appWorktree = false): string {
    if (this.deps.developer()?.id !== bot.id) return "";
    // Development work goes on the work drive when it is there (`devWorkRoot`), else beside the project.
    const work = this.deps.devWork?.() ?? null;
    const worktrees = work ?? join(bot.profile.folder, ".bot", "worktrees");
    const dist = work ? join(work, "builds", "dist") : null;
    const product = this.product;
    // Botling 3 is the same desktop/ built with --v3 (electron-builder.v3.config.cjs), written to <dist>/v3/.
    const build = this.v3 ? "npm run dist:dir -- --v3" : "npm run dist:dir";
    const output = `${dist ?? "desktop/dist"}${this.v3 ? "/v3" : ""}/mac-arm64/${product}.app`;
    return `(App: Developer mode. This folder is Botling's own source, the app you are running in (${product} is in desktop/), and you develop it.
${appWorktree
  ? "- One writer at a time. The app made the git worktree you work in (the Worktree note says where): edit, build and test there and commit there; do not run git worktree yourself. When the tests pass, say so; the user merges it into the main branch from the app, which removes the worktree. If git status in the main folder shows changes you did not make, someone else is working: stop and ask the user."
  : `- One writer at a time. Do each task in a git worktree of its own: git worktree add ${worktrees}/<short-task> -b bot/<short-task>. Edit, build and test there; when the tests pass, merge it into the main branch and remove the worktree. If git status in the main folder shows changes you did not make, someone else is working: stop and ask the user.`}
- Feedback from the user ("not right" on a reply) comes to you with the chat around it. First write a test that shows the problem, then fix it, then say in one sentence what was wrong.
- To try your work: ${appWorktree ? "from your worktree (relative paths; do not cd to the main folder)" : "from the main folder, after merging,"} build the app with cd desktop && ${dist ? `BOTLING_DIST_DIR=${dist} ` : ""}${build}; it is written to ${output} (mac-x64 on Intel).
- To install it: write where you are into your memory file first (you are restarted too), then end your reply with <install-build path="full path of that ${product}.app">what changed, in a sentence or two</install-build>. The user confirms; the app restarts on the new build and tells you whether it came up. A build that does not come up is rolled back by itself.
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
    if (build.bundleID !== running.bundleID) return refuse(`${path} is not ${this.product} (${build.bundleID}).`);
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
    if (this.v3) lines.push("", "The Botling 3 window and botlingd stop for it; the old app is kept, and both start again on the new one.");
    lines.push("", `Bots save their original conversations and unfinished work before restart. Supported work resumes automatically; pending permissions or uncertain execution stay paused for reconciliation. If the new build does not come up within ${this.v3 ? HEALTH_WAIT_S_V3 : HEALTH_WAIT_S} seconds, the running one comes back by itself.`);
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
      const command = prepareInstall(this.deps.root, running, build, requester, note, this.deps.appPid, this.deps.appDataDir ?? "", new Date(), running.path, this.deps.serverDir ?? undefined);
      this.deps.log(`installing ${buildLabel(build)} for ${requester}`);
      await this.deps.launchInstaller(command, installLog(this.deps.root));
    } catch (error) {
      this.deps.mainBot().appNotice(`Couldn't install ${buildLabel(build)}: ${(error as Error).message}. Nothing was installed.`, undefined, undefined, { sourceID: requester });
      asker?.queueNote(`(App: ${buildLabel(build)} was not installed: ${(error as Error).message}.)`);
    }
  }

  /**
   * At start: how an install went (`checkSelfUpdate`). What counts is the build that is running (read from the bundle on disk),
   * not what the install asked for: the requested build is "up" only when it is the one running and has run `healthyAfterMs`;
   * the old build coming back (the script died or never swapped) is told as "not installed", and the bot that asked and you hear it.
   * While the install script is still at work, an old build decides nothing.
   */
  check(healthyAfterMs = HEALTHY_AFTER_MS): NodeJS.Timeout | null {
    const outcome = installOutcome(this.deps.root);
    if (!outcome) return null;
    const { state } = outcome;
    const main = this.deps.mainBot();
    if (outcome.kind === "installed") {
      const told = (running: BuildInfo | null) => {
        finishInstall(this.deps.root);
        setFailures(this.deps.root, 0);
        this.cleanAfterUpdate(state);
        const asker = this.deps.bot(state.requesterID);
        const how = "";
        const now = buildLabel(running ?? state.to);
        main.appNotice(`Botling restarted on ${now} (was ${buildLabel(state.from)}), installed for ${asker?.profile.name ?? "a bot"}${how}.`, undefined, undefined, { sourceID: state.requesterID });
        try {
          asker?.relay(`(App) Botling restarted on ${now}, the build you asked to install${state.note ? ` (${state.note})` : ""}${how}. Read your memory file for where you were, check that your change works (<app-screenshot/> shows the window), then say in one sentence whether it does.`);
        } catch (error) { this.deps.log(`could not tell ${state.requesterID}: ${(error as Error).message}`); }
      };
      /** The running bundle against the install: "up" (the requested build), "wait" (the script still works), "reported" (told it did not install). */
      const judge = (): "up" | "wait" | "reported" => {
        const running = this.deps.runningBuild();
        const which = running ? whichBuild(running, state) : "to";
        if (which === "to") return "up";
        if (installScriptRunning(this.deps.root)) return "wait";
        this.notInstalled(state, running!, which);
        return "reported";
      };
      if (this.v3) {
        // Botling 3: botlingd (and so this plugin) starts before a window attaches; the build is up only once the core wrote
        // `healthy` (a window stayed attached 8 s, core/self-update.ts `confirmHealthyWhen`) and the bundle running is the requested
        // one. Without `healthy` nothing is said for a build that is the requested one: the script rolls it back and the old build
        // tells. A build that is not the requested one is told as not installed once no script is working any more.
        let elapsed = 0;
        const limit = healthyAfterMs + (HEALTH_WAIT_S_V3 + 30) * 1_000;
        const timer = setInterval(() => {
          elapsed += HEALTHY_POLL_MS;
          if (elapsed < healthyAfterMs) return;
          const verdict = judge();
          if (verdict === "reported") { clearInterval(timer); return; }
          if (verdict === "up" && existsSync(healthyFile(this.deps.root))) { clearInterval(timer); told(this.deps.runningBuild()); return; }
          if (elapsed >= limit) clearInterval(timer);
        }, HEALTHY_POLL_MS);
        timer.unref?.();
        return timer;
      }
      const timer = setTimeout(() => { if (judge() === "up") told(this.deps.runningBuild()); }, healthyAfterMs);
      timer.unref?.();
      return timer;
    }
    finishInstall(this.deps.root);
    // The script itself ended before the new build ever ran (it was signalled): that is not a build that failed to come up,
    // so it does not count towards pausing installs, and the same card can be confirmed again. Ended while rolling back means
    // the new build did run and did not come up: that one counts.
    if (outcome.reason.startsWith("the install script ended early") && !outcome.reason.endsWith("step: rolling back")) {
      const stopped = this.deps.runningBuild();
      const old = buildLabel(stopped ?? state.from);
      main.appNotice(`${buildLabel(state.to)} was not installed (${outcome.reason}); ${old} is running again. The install log is ${installLog(this.deps.root)}. The same card can be confirmed again.`, undefined, undefined, { sourceID: state.requesterID });
      try {
        this.deps.bot(state.requesterID)?.relay(`(App) The build you asked to install, ${buildLabel(state.to)}, was not installed: ${outcome.reason}. ${old} is running again. The install log is ${installLog(this.deps.root)}. The new build is still at ${state.to.path}; you can ask again.`);
      } catch (error) { this.deps.log(`could not tell ${state.requesterID}: ${(error as Error).message}`); }
      return null;
    }
    const count = failures(this.deps.root) + 1;
    setFailures(this.deps.root, count);
    const paused = count >= FAILURE_LIMIT ? ` That is ${count} in a row: installing is paused until developer mode is turned off and on again.` : "";
    const running = this.deps.runningBuild();
    const now = buildLabel(running ?? state.from);
    main.appNotice(`The new build ${buildLabel(state.to)} did not come up (${outcome.reason}); ${now} is running again.${paused}`, undefined, undefined, { sourceID: state.requesterID });
    try {
      this.deps.bot(state.requesterID)?.relay(`(App) The build you asked to install, ${buildLabel(state.to)}, did not come up: ${outcome.reason}. Botling put ${now} back. The install log is ${installLog(this.deps.root)}; the failed build was kept beside the app as ${basename(state.from.path)}.failed. Find out why before trying again.${paused}`);
    } catch (error) { this.deps.log(`could not tell ${state.requesterID}: ${(error as Error).message}`); }
    return null;
  }

  /**
   * The build that came up is not the requested one and no install script is working: nothing was installed (the script stopped
   * before it swapped, or something else came up). The state is finished so this is told once; installing is not counted as a
   * failed build (no new build ran), so the same card can be confirmed again.
   */
  private notInstalled(state: InstallState, running: BuildInfo, which: "from" | "other") {
    const root = this.deps.root;
    const tail = installLogTail(root);
    finishInstall(root);
    rmSync(healthyFile(root), { force: true });
    const now = buildLabel(running);
    const wanted = buildLabel(state.to);
    const log = `The install log is ${installLog(root)}${tail ? `; its last line: ${JSON.stringify(tail)}` : ""}.`;
    const what = which === "from"
      ? `Botling is still running ${now}: the install script stopped before it replaced the app, so nothing was replaced.`
      : `Botling is running ${now}, which is neither the old build (${buildLabel(state.from)}) nor the requested one.`;
    const asker = this.deps.bot(state.requesterID);
    this.deps.mainBot().appNotice(`${wanted} was not installed. ${what} ${log} The new build is still at ${state.to.path}; the same card can be confirmed again.`, undefined, undefined, { sourceID: state.requesterID });
    try {
      asker?.relay(`(App) The build you asked to install, ${wanted}, was not installed. ${what} ${log} The build is still at ${state.to.path}; ask for the install again once you know why it stopped.`);
    } catch (error) { this.deps.log(`could not tell ${state.requesterID}: ${(error as Error).message}`); }
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
