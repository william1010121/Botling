// botling.dev's program part (runs in the plugin host): the developer tools for Botling's own source project. The tags
// bots write (`<install-build>`, `<app-screenshot/>`) and the briefing the developer project's manager hears come here;
// the install itself (the script, the card, rolling back) is desk.ts and swap.ts, unchanged from when the core had it.
// What only the app can do is asked of it through the privileged `app` api (core/plugins/app-seam.ts): checkpoint the work
// under way and quit so the script can swap the build, a picture of the window, a card in the main bot's chat.
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppState, BotInfo, BotlingApi, ReplyTag } from "../../../../Web/host/src/api";
import { DevBuilds, type DeskBot } from "./desk";
import { HEALTHY_AFTER_MS, devWorkRoot, readBuild } from "./swap";

/** The developer project's manager is told this when developer mode stops covering it (`setDeveloperMode`). */
export const DEVELOPER_OFF_NOTE = "(App: Developer mode is off for this project now: you can no longer install builds of Botling or take screenshots of it.)";

export type ProgramApi = Pick<BotlingApi, "app" | "bots" | "events" | "replyTags" | "subscriptions">;

export class Program {
  private state: AppState | null = null;
  private bots = new Map<string, BotInfo>();
  private readonly builds: DevBuilds;

  constructor(private readonly api: ProgramApi, private readonly options: { log?: (line: string) => void; healthyAfterMs?: number; devWork?: () => string | null } = {}) {
    const program = this;
    this.builds = new DevBuilds({
      get root() { return program.state?.dataDir ?? ""; },
      // Read each time: a hot install changes the bundle on disk under a running core.
      runningBuild: () => (program.state?.bundle ? readBuild(program.state.bundle) : null),
      developer: () => (program.state?.developer ? program.proxy(program.state.developer.id, program.state.developer.name, program.state.developer.folder) : null),
      mainBot: () => program.proxy("main", "Main bot", ""),
      bot: (id) => { const info = program.bots.get(id); return info ? program.proxy(info.id, info.name, "") : null; },
      get appPid() { return program.state?.pid ?? null; },
      get appDataDir() { return program.state?.appDataDir ?? null; },
      devWork: options.devWork ?? (() => devWorkRoot()),
      applicationsDir: () => join(homedir(), "Applications"),
      launchInstaller: (command, log) => api.app.installAndRestart(command, log),
      captureWindow: () => api.app.captureWindow().catch(() => null),
      log: (line) => this.log(line),
    });
  }

  private log(line: string) { this.options.log?.(line); }

  /** A bot as the desk uses it: sync calls that go to the app. */
  private proxy(id: string, name: string, folder: string): DeskBot {
    const fail = (what: string) => (error: unknown) => this.log(`${what}: ${(error as Error).message}`);
    const api = this.api;
    return {
      id, profile: { name, folder },
      appNotice: (text, choices, onPick, more) => {
        void api.app.card(text, { ...(choices ? { choices: choices.map((choice) => ({ label: choice.label, ...(choice.recommended ? { recommended: true } : {}) })) } : {}), ...(more?.sourceID ? { source: more.sourceID } : {}) })
          .then((index) => { if (index !== null) onPick?.(index); }, fail("card"));
        return "";
      },
      relay: (text, more) => { void api.app.tell(id, "relay", text, more?.files).catch(fail("relay")); return null; },
      queueNote: (note) => { void api.app.tell(id, "note", note).catch(fail("note")); },
    };
  }

  /** The app and the bots as they are now (cheap: the core answers from memory). */
  async refresh() {
    this.state = await this.api.app.state();
    this.bots = new Map((await this.api.bots.list()).map((bot) => [bot.id, bot]));
  }

  /** Listens for the tags and for the developer project changing; then looks at how an earlier install went. */
  start(): Promise<void> {
    const { api } = this;
    api.subscriptions.push(
      api.replyTags.on("install-build", (tag) => { void this.installBuild(tag).catch((error) => this.log(`install-build: ${(error as Error).message}`)); }),
      api.replyTags.on("app-screenshot", (tag) => { void this.screenshot(tag).catch((error) => this.log(`app-screenshot: ${(error as Error).message}`)); }),
      api.events.on("developerChanged", (change) => { void this.developerChanged(change).catch((error) => this.log(`developer: ${(error as Error).message}`)); }),
    );
    return this.boot();
  }

  /** At load: the briefing for the developer project, and how an install went (`checkSelfUpdate`). */
  async boot() {
    await this.refresh();
    await this.publishBriefing();
    const timer = this.builds.check(this.options.healthyAfterMs ?? HEALTHY_AFTER_MS);
    if (timer) this.api.subscriptions.push(() => clearTimeout(timer));
  }

  /** A manager asked to install a build (`proposeBuild`): the desk checks it is the developer project. */
  async installBuild(tag: ReplyTag) {
    // From the main bot and project bots that are no manager they do nothing, as in 1.x.
    if (tag.bot.role !== "manager") return;
    const path = (tag.attributes.path ?? "").trim();
    if (!path) return;
    await this.refresh();
    this.builds.propose(path, tag.body, this.proxy(tag.bot.id, tag.bot.name, this.state?.developer?.id === tag.bot.id ? this.state.developer.folder : ""));
  }

  async screenshot(tag: ReplyTag) {
    if (tag.bot.role !== "manager") return;
    await this.refresh();
    this.builds.screenshot(this.proxy(tag.bot.id, tag.bot.name, ""));
  }

  /** What the developer project's manager is told at each wake; the core keeps it (a wake never waits for this plugin). */
  async publishBriefing() {
    const developer = this.state?.developer;
    if (!developer) { await this.api.app.briefing(null); return; }
    const bot = this.proxy(developer.id, developer.name, developer.folder);
    await this.api.app.briefing({ bot: developer.id, plain: this.builds.briefing(bot, false), worktree: this.builds.briefing(bot, true) });
  }

  /** Settings → Developer changed (`setDeveloperMode`): builds start afresh after failures, and the manager hears what changed. */
  async developerChanged(change: { before: string | null; now: string | null; turnedOn: boolean }) {
    if (change.turnedOn) this.builds.developerModeOn();
    await this.refresh();
    await this.publishBriefing();
    const developer = this.state?.developer;
    if (developer && developer.id !== change.before) this.proxy(developer.id, developer.name, developer.folder).queueNote(this.builds.briefing(this.proxy(developer.id, developer.name, developer.folder)));
    if (change.before && change.before !== developer?.id) this.proxy(change.before, "", "").queueNote(DEVELOPER_OFF_NOTE);
  }
}
