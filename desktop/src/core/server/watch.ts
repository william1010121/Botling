// M7-S62: the first three collaborators cut out of `Core` (core/server.ts): `CoreWatch` here, `CorePeerInbox` (peer-inbox.ts) and
// `CoreProjects` (projects.ts). The bridge convention for every class under core/server/ (the equivalent of M7-S41's `BotContext` for
// core/bot/), written down once, here:
//
//   * A collaborator class holds `host`, the `Core` that made it, and begins with a block of one-line forwarders, one per name it
//     borrows from `Core` (`private get options() { return this.host.options; }`, `private log(...a: Parameters<Core["log"]>) {
//     return this.host.log(...a); }`). The moved method bodies then compile byte for byte: `this.log(...)` is still `this.log(...)`.
//     The block is the collaborator's whole interface to the rest of the core, in one screen; it holds no logic.
//   * A forwarder that sets another owner's field (`private set x(v) { this.host.x = v; }`) is allowed only until the refinement cards
//     replace it with a named transition on the owner; `check-lines.mjs` counts them. This card has none.
//   * A field is declared in exactly one class, the one whose methods write it most. `Core` keeps a forwarding accessor
//     (`private get routineClock() { return this.coreWatch.routineClock; }`, and a setter where `Core` itself writes it) for every moved
//     field that its own code, a test or a spec adapter reaches, and a one-line delegate for every moved method that it calls or that
//     is reached from outside (`private checkRoutines(...a) { return this.coreWatch.checkRoutines(...a); }`). So `core.handle(...)`
//     and the private names tests reach by casting (`core-private-names.test.ts`) stay where they were.
//   * The members `Core` and the other collaborators reach are public in the collaborator (the `private` of the old class is dropped);
//     what the collaborator borrows from `Core` is public on `Core` for the same reason, because a type cannot reach a private member.
//   * A collaborator does not touch `host` while it is being built (`Core` makes it on first use, which may be before its own constructor
//     body runs): the forwarders read `host` only when a method runs.
//
// `CoreWatch`: what the core looks at on a clock or a file watch: the plugin and component library, the plugins' Claude parts,
// the stall and network checks, the developer project, feedback, and the bots' routines.
import type { Core } from "../server";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { writeIncoming } from "../attachments";
import { safeName } from "../components/library";
import { appendFeedback, FEEDBACK_NO_WORDS } from "../feedback";
import { archiveEntry } from "../briefing";
import { fileURLToPath } from "node:url";
import { readSettings, settingsView } from "../settings";
import { MemoryFiles } from "../projects";
import { type Command, type ResultOf } from "../../contract";
import { Bot } from "../bot";
import { Layout } from "../store/workspace";
import { ComponentsContext } from "../components/service";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { FolderWatch, type WatchTarget } from "../folder-watch";
import { probeNetwork } from "../network-resume";
import { agentStamp } from "../plugins/agent-contributions";
import { Plugins } from "../plugins";

export class CoreWatch {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private bot(...a: Parameters<Core["bot"]>) { return this.host.bot(...a); }
  private get bots() { return this.host.bots; }
  private event(...a: Parameters<Core["event"]>) { return this.host.event(...a); }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private get maintainer() { return this.host.maintainer; }
  private get maintainerId() { return this.host.maintainerId; }
  private get options() { return this.host.options; }
  private get plugins() { return this.host.plugins; }
  private get profiles() { return this.host.profiles; }
  private get removed() { return this.host.removed; }

  routineClock: NodeJS.Timeout | null = null;

  watchClock: NodeJS.Timeout | null = null;

  components!: ComponentsContext;

  componentStamp = 0;

  /** The plugin and component library, watched (`scanComponents` on a change, and every `componentScanMs`). */
  libraryWatch: FolderWatch | null = null;

  /** Bots' memory files, watched (`refreshWaiting` on a change, and every `waitingScanMs`). */
  memoryWatch: FolderWatch | null = null;

  /** memory.md files, read again only when they change (what waits on you). */
  readonly memoryFiles = new MemoryFiles();

  lastPlugins = "";

  /** The plugin list as text is the one shown now: false when it already was (nothing to announce), true when it changed. */
  markPluginsShown(text: string): boolean {
    if (text === this.lastPlugins) return false;
    this.lastPlugins = text;
    return true;
  }

  /** The plugins' Claude parts as bots last heard of them (`followClaudeParts`). */
  loadedClaudeParts = "[]";

  /** What the library watch looks at: the plugin library (with every plugin's components), and plugins linked in from elsewhere. */
  libraryTargets(): WatchTarget[] {
    const plugins = join(this.options.dataDir, "plugins");
    const targets: WatchTarget[] = [{ path: plugins, recursive: true }];
    let names: string[] = [];
    try { names = readdirSync(plugins); } catch { return targets; }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      try {
        // A recursive watch does not follow a symbolic link: its target is watched on its own.
        if (lstatSync(join(plugins, name)).isSymbolicLink()) targets.push({ path: realpathSync(join(plugins, name)), recursive: true });
      } catch { /* a dangling link: nothing to watch */ }
    }
    return targets;
  }

  /** What the memory watch looks at: each bot's memory.md (not the main bot's: its memory is not on the list). */
  memoryTargets(): WatchTarget[] {
    return this.profiles.filter((profile) => profile.role !== "main" && !profile.parent && !profile.problem).map((profile) => ({ path: join(profile.folder, profile.memoryPath), file: true }));
  }

  /** The library's state changed in the app (being worked on, reverted): the page hears it now. */
  componentsTick() {
    if (this.components.library.stamp === this.componentStamp) return;
    this.componentStamp = this.components.library.stamp;
    this.event({ type: "components.updated", components: this.componentInfos() });
    this.plugins.event("componentsChanged", {});
  }

  /** A template or about.md changed on disk: the page draws it anew; bots hear what changed with their next message. */
  scanComponents() {
    this.plugins.scan();
    const before = this.components.library.names.join("\n");
    const catalogChanged = this.components.library.rescan();
    if (catalogChanged) for (const bot of this.bots.values()) bot.componentsChanged();
    // Components bots asked Maintainer for that are in the library now go on their lists.
    if (catalogChanged || before !== this.components.library.names.join("\n")) {
      this.maintainer.deliverAsked();
      this.plugins.event("libraryChanged", {});
    }
    if (this.components.library.stamp !== this.componentStamp) {
      this.componentStamp = this.components.library.stamp;
      this.event({ type: "components.updated", components: this.componentInfos() });
    }
  }

  /** A pin's owner, as botling.board says it (`pin.owner`): its bot, the author its links are its, how it refreshes and when its data is from; null: none (or the plugin is off). */
  async pinOwner(botId: string, pinId: string | undefined, name: string | null): Promise<{ botId: string; linkAuthor: string; words: string; when: number | null } | null> {
    const answer = await this.plugins.askBuiltIn("botling.board", "pin.owner", { botId, ...(pinId ? { id: pinId } : {}), ...(name ? { name } : {}) });
    if (!answer || typeof answer !== "object") return null;
    const { botId: owner, linkAuthor, words, when } = answer as Record<string, unknown>;
    return typeof owner === "string" && typeof linkAuthor === "string" && typeof words === "string" ? { botId: owner, linkAuthor, words, when: typeof when === "number" ? when : null } : null;
  }

  /**
   * A component card's report (1.x's ChatSurface `componentReport`): "Report a problem…" goes to Maintainer
   * as the card's own bot's (a floating card may be another bot's), with its pin and the screenshot kept with
   * that bot; otherwise the user's change request, the screenshot first among the pictures.
   */
  async reportComponent(cmd: Extract<Command, { type: "component.report" }>): Promise<boolean> {
    const incoming = join(this.options.dataDir, "incoming");
    const pictures = cmd.images.flatMap((image) => writeIncoming(incoming, image.name, image.base64) ?? []);
    const shot = cmd.screenshot ? writeIncoming(incoming, `${safeName(cmd.name) || "component"}.png`, cmd.screenshot) : null;
    try {
      if (cmd.problem) {
        // A pin is botling.board's: whose it is, how it refreshes and when its data is from (its card by that id, else by the component's name).
        const pin = await this.pinOwner(cmd.botId, cmd.pinId, cmd.name);
        const owner = (pin ? this.bots.get(pin.botId) : undefined) ?? this.bot(cmd.botId);
        return this.maintainer.reportProblem(cmd.name, cmd.text, owner, pin ? { words: pin.words, when: pin.when } : null, shot, pictures);
      }
      const files = [...(shot ? [shot] : []), ...pictures];
      if (!cmd.text.trim() && !files.length) return false;
      this.maintainer.requestComponentChange(cmd.name, cmd.text, "The user", null, files);
      return true;
    } finally {
      for (const file of [...pictures, ...(shot ? [shot] : [])]) rmSync(file, { force: true });
      this.componentsTick();
    }
  }

  /**
   * Plugins' Claude parts changed (1.x's `followClaudeParts`): awake bots restart (once they are free: no
   * turn and no subagent at work) so they get the new skills, agents and MCP servers.
   */
  followClaudeParts() {
    const now = JSON.stringify(agentStamp(this.plugins.registry));
    if (now === this.loadedClaudeParts) return;
    this.loadedClaudeParts = now;
    for (const bot of this.bots.values()) bot.reloadPlugins();
  }

  /** 1.x's `checkStalls`: each bot (not a partner head) is reminded of a quiet run once per quiet spell. */
  checkStalls(now = Date.now()) {
    const minutes = settingsView(readSettings(Layout.settings(this.options.dataDir))).stallReminderMinutes;
    for (const bot of this.bots.values()) bot.checkStall(now, minutes * (this.options.stallMinuteMs ?? 60_000));
  }

  watchRuns() {
    void this.checkNetwork();
    this.checkStalls();
  }

  private probing = false;

  /** 1.x's `checkNetwork`: asks the probe only while a bot waits for the network; once it answers, they carry on. */
  async checkNetwork(now?: number) {
    const waiting = [...this.bots.values()].filter((bot) => bot.outage || bot.peers.some(peer => peer.outage));
    if (!waiting.length || this.probing) return;
    this.probing = true;
    try {
      if (!(await (this.options.networkProbe ?? probeNetwork)())) return;
    } finally {
      this.probing = false;
    }
    const date = now ?? Date.now();
    for (const bot of waiting) bot.networkRestored(date);
  }

  /** What the developer project's manager is told on top of a manager's usual instructions (`developerBriefing`; botling.dev wrote it). */
  developerBriefing(botId: string): string {
    if (this.developerProject()?.id !== botId) return "";
    return this.plugins.devBriefing(botId, this.plugins.sessionFolder(botId) !== null);
  }

  /** The project that is Botling's own source, while developer mode is on (`developerProject`). */
  developerProject(): Bot | null {
    const view = settingsView(readSettings(Layout.settings(this.options.dataDir)));
    if (!view.developerMode || !view.developerProject) return null;
    const profile = this.profiles.find((candidate) => candidate.id === view.developerProject && candidate.role === "manager" && candidate.id !== this.maintainerId);
    return profile && !this.removed.has(profile.id) ? this.bots.get(profile.id) ?? null : null;
  }

  /**
   * You flagged a reply as not right (`reportFeedback`): it goes to the developer project with the chat around
   * it, to become a test and a fix; the screenshot (the chat as you saw it) and your pictures are kept in its
   * attachments and listed. Every report is also kept in <data>/feedback.md.
   */
  reportFeedback(text: string, messageId: string, chat: Bot, screenshot: string | null, files: string[]): boolean {
    const developer = this.developerProject();
    const lines = chat.lines();
    const index = lines.findIndex((line) => line.id === messageId);
    if (!developer || index < 0) return false;
    const message = lines[index]!;
    const around = lines.slice(Math.max(0, index - 12), index + 1).flatMap((line) => archiveEntry(line) ?? []).join("\n");
    const steps = message.steps ? "\n\nWhat it did on the way: " + (message.steps as { title?: string }[]).map((step) => step.title ?? "").join(" → ") : "";
    const words = text.trim();
    const pictures: string[] = [];
    if (screenshot) pictures.push("The first attachment is a screenshot of the chat as the user saw it, centered on that reply.");
    if (files.length) pictures.push(`With it the user added ${files.length} picture${files.length === 1 ? "" : "s"} of their own.`);
    const seen = pictures.length ? "\n\n" + pictures.join(" ") : "";
    const name = chat.profile.name;
    const report = `Feedback: the user flagged a reply of ${name} as not right.
What is wrong, in their words: ${words || FEEDBACK_NO_WORDS}

The chat up to that reply, oldest first:
${around}${steps}${seen}

First write a test that shows this, then fix it.`;
    developer.relay(report, { files: [...(screenshot ? [screenshot] : []), ...files], feedback: { about: name, words } });
    const kept = (developer.lines().findLast((line) => line.role === "relay")?.attachments ?? []).map((file) => { try { return fileURLToPath(file.url); } catch { return file.url; } });
    appendFeedback(kept.length ? report + "\n\nAttachments:\n" + kept.map((path) => "- " + path).join("\n") : report, this.options.dataDir);
    chat.appNotice(`Sent to ${developer.profile.name} as feedback.`, undefined, undefined, { sourceID: developer.id });
    return true;
  }

  /** Every library component as the page draws it. */
  componentInfos(): ResultOf<"chat.snapshot">["components"] {
    const out: ResultOf<"chat.snapshot">["components"] = {};
    for (const name of this.components.library.names) {
      const info = this.components.library.info(name);
      if (info) out[name] = { ...info, template: info.template.slice(0, 1_000_000), sizes: info.sizes.slice(0, 16), title: info.title?.slice(0, 200) ?? null };
    }
    return out;
  }

  /** Every bot's routines that are due run now (`Workspace.checkRoutines`). */
  checkRoutines(now = Date.now()) {
    for (const bot of this.bots.values()) {
      try { bot.checkRoutines(now); } catch (error) { this.log(`routines of ${bot.profile.name}: ${(error as Error).message}`); }
    }
  }
}
