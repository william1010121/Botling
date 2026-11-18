// Maintainer: the built-in bot that looks after the plugin library (<core>/plugins, a git repo), as
// in 1.x (Workspace.swift: `maintainerProject`, `handToMaintainer`, `requestComponentChange`,
// `handle(_:from:)`, `proposeInstall`; Workspace+Components.swift: `componentAskNote`,
// `deliverAskedComponents`, `settleComponentAsks`, `declineComponentAsk`, `changeComponentList`).
//
// - Bots' <component> requests go to Maintainer with which bot asked and how full its list is; a
//   component already in the library goes on the bot's list at once. The bot hears back once Maintainer
//   gives (<give-component>), builds (it lands in the library) or changes it (its files change), or
//   declines (<component-declined id=…>).
// - <plugin> requests go to Maintainer as "X's request for Botling: …".
// - <install> never installs by itself: the plugin is fetched into a staging folder and checked, and
//   the user is asked in the main bot's chat (Install / Don't install); only "Install" puts it into the
//   library (and commits it).
// - Maintainer works in the library with 1.x's instructions (maintainer-text.ts, checked against the
//   Swift strings) and the component editor agent (ccb-core:component-editor, a Claude Code plugin agent
//   handed to claude with --plugin-dir).
//
// - <need-folder> (Phase 4c): Maintainer asks to read a folder outside the library; you are asked once in
//   its chat (Allow / Don't allow); allowed folders are kept in folders.json, given to its head as
//   `--add-dir` (its process starts again in the same session before its next message), and a folder
//   inside one allowed before is allowed at once (`requestFolder`, `answerFolder`).
//
// Since Phase 5a: specs (the built-in plugin botling.component-studio), reports, revert and component shots (main/shot.ts). 2.0 gaps: design flows; installs take a folder or
// a git URL (npm packages and archives: not yet).
import { mkdirSync, cpSync, renameSync, rmSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Bot } from "./bot";
import type { ComponentLibrary } from "./components/library";
import { COMPONENT_LIMIT, countedComponents, safeName } from "./components/library";
import { writeFileAtomic } from "./durable/atomic";
import { title } from "./plugins/manifest";
import type { BotRequest } from "./reply";
import { MAINTAINER_ID } from "./store/records";
import { Layout, TOOLBOX, type BotProfile } from "./store/workspace";
import { LibraryGit, shortened, firstLine, fetchPlugin, installSummary, arrivalLead, folderAnswer, problemReport } from "./maintainer-library";
import { isUnnamedCardAsk, unnamedCardAsk } from "./worker-cards";
import type { ComponentAsk, InstallProposal, MaintainerDeps, ReportCard } from "./maintainer-library";

// The library functions live in maintainer-library.ts; this file keeps exporting every name it exported.
export {
  builtInManifest, claudePluginText, prepareLibrary, locateGit, LibraryGit, classifySource, installSummary, fetchPlugin, readProposal,
  arrivalLead, folderAnswer, reportStamp, problemReport,
} from "./maintainer-library";
export type { InstallSource, InstallProposal, MaintainerDeps, ReportCard } from "./maintainer-library";

export { MAINTAINER_ID };

/** Maintainer's profile (`BotProfile.maintainer`): a manager whose folder is the plugin library. */
export function maintainerProfile(root: string, instructions: string, id = MAINTAINER_ID): BotProfile {
  return {
    id, name: "Maintainer", role: "manager", avatar: "diamond", folder: join(root, "plugins"), memoryPath: ".bot/memory.md",
    storeDir: Layout.bot(root, id), tools: [...TOOLBOX, "Bash"], job: null, problem: null, instructions,
  };
}

/** A path as 1.x reads `<need-folder>`'s (`expandingTildeInPath`, `standardizedFileURL`). */
export function standardFolder(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const folder = resolve("/", expanded);
  return folder.length > 1 ? folder.replace(/\/+$/, "") : folder;
}

/** A manifest's text as one JSON-quoted line (control characters escaped, at most 100 characters) before it goes into a message to Maintainer. */
const quoted = (text: string): string => JSON.stringify(text.slice(0, 100));

export class MaintainerDesk {
  readonly git: LibraryGit;
  private asks: ComponentAsk[] = [];
  private installing = new Set<string>();

  constructor(private readonly deps: MaintainerDeps) {
    this.git = new LibraryGit(join(deps.root, "plugins"));
    // The library asks the plugin library's git about earlier versions (`ComponentLibrary.git`).
    deps.library.git = this.git;
    this.git.onPrepared = () => deps.library.forgetHistory();
  }

  private get maintainerId() { return this.deps.maintainerId ?? MAINTAINER_ID; }
  private get maintainer() { return this.deps.maintainer(); }

  /** Gives Maintainer a job, the way the main bot hands work to a manager (`handToMaintainer`); `files` go with it. */
  handTo(text: string, files: string[] = []) {
    const maintainer = this.maintainer;
    if (!maintainer) { this.deps.log(`no Maintainer for: ${text.slice(0, 200)}`); return; }
    this.git.prepare();
    try {
      maintainer.relay(text, { files });
    } catch (error) {
      this.deps.log(`Maintainer could not take it: ${(error as Error).message}`);
    }
  }

  /** The requests in a bot's reply the app acts on (`Workspace.handle`); what it cannot do yet comes back. Acting waits until the reply is done. */
  handle(from: Bot, requests: BotRequest[]): BotRequest[] {
    const isMaintainer = from.id === this.maintainerId;
    const mainId = this.deps.mainBot()?.id;
    const left: BotRequest[] = [];
    const later: (() => void)[] = [];
    for (const request of requests) {
      switch (request.kind) {
        case "component":
          later.push(() => this.requestComponentChange(request.name, request.request, from.id === mainId ? "Main bot" : from.profile.name, from, [], request.card));
          break;
        case "plugin":
          if (!isMaintainer) later.push(() => this.handTo(`${from.id === mainId ? "Main bot" : from.profile.name}'s request for Botling: ${request.request}`));
          break;
        case "install":
          later.push(() => this.proposeInstall(request.source));
          break;
        case "giveComponent":
        case "takeComponent":
          if (isMaintainer) later.push(() => this.changeList(request.kind === "giveComponent", request.name, request.bot, request.kind === "giveComponent" ? request.id : undefined));
          break;
        case "componentDeclined":
          if (isMaintainer) later.push(() => this.decline(request.id, request.reason));
          break;
        case "folder":
          // Only Maintainer asks for folders (1.x leaves anyone else's tag alone).
          if (isMaintainer) later.push(() => this.requestFolder(request.path));
          break;
        default:
          left.push(request);
      }
    }
    if (later.length) setImmediate(() => { for (const act of later) { try { act(); } catch (error) { this.deps.log(`request: ${(error as Error).message}`); } } });
    return left;
  }

  // ------------------------------------------------------------------------------------------
  // Folders outside the library

  private get foldersFile() { return join(this.deps.root, "folders.json"); }

  /** Folders you let Maintainer read (folders.json: a list of paths, as 1.x keeps it). */
  approvedFolders(): string[] {
    try {
      const value = JSON.parse(readFileSync(this.foldersFile, "utf8"));
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/")) : [];
    } catch {
      return [];
    }
  }

  private allowed(folder: string): boolean {
    return this.approvedFolders().some((approved) => folder === approved || folder.startsWith(approved.endsWith("/") ? approved : approved + "/"));
  }

  /** Maintainer asked to read `path` (`requestFolder`): you are asked once, in its chat; a folder allowed before, or one inside it, at once. */
  requestFolder(path: string) {
    const maintainer = this.maintainer;
    if (!maintainer || !path.trim()) return;
    const folder = standardFolder(path.trim());
    if (this.allowed(folder)) {
      try { maintainer.relay(`(App) ${folder} was already allowed before; you can read it directly.`); } catch (error) { this.deps.log(`folder: ${(error as Error).message}`); }
      return;
    }
    maintainer.appNotice(`Maintainer wants to read "${folder}". It will only read, never change files there. Allow it?`,
      [{ label: "Allow", detail: "Won't ask again" }, { label: "Don't allow" }],
      (index) => this.answerFolder(folder, index === 0),
      { sourceID: this.maintainerId });
  }

  /** Your answer to a folder question (`answerFolder`): kept, and its process starts again with the folder before it carries on. */
  private answerFolder(folder: string, allowed: boolean) {
    const maintainer = this.maintainer;
    if (!maintainer) return;
    if (allowed && !this.allowed(folder)) {
      writeFileAtomic(this.foldersFile, JSON.stringify([...this.approvedFolders(), folder]));
      maintainer.restarts.restartBeforeNextMessage({ told: `may read ${folder}`, shown: `may read ${folder}` });
    }
    try { maintainer.relay(folderAnswer(folder, allowed)); } catch (error) { this.deps.log(`folder: ${(error as Error).message}`); }
  }

  // ------------------------------------------------------------------------------------------
  // Components

  /** Someone asked for a component change (`requestComponentChange`): Maintainer hands it to a component editor. */
  requestComponentChange(rawName: string, rawRequest: string, asker: string, bot: Bot | null, files: string[] = [], card?: string) {
    let name = safeName(rawName);
    if (!name) return;
    let request = rawRequest.trim();
    // A card worker only describes the chart it wants; the name is Maintainer's to give (2026-11-18, the user). A name the worker still wrote for a component the library does not
    // have is a hint in the description, not a name to build under (it would otherwise also decide when the ask counts as answered, `deliverAsked`).
    if (card && bot && !isUnnamedCardAsk(name) && !this.deps.library.names.includes(name)) {
      request = `${request}\n(The worker called it "${name}": a hint only, not the name to give it.)`;
      name = unnamedCardAsk(request);
    }
    // A card worker's ask: a component the library has is only looked up for it, and Maintainer is not woken (`askForCard`).
    const forCard = card && bot ? this.askForCard(name, request, bot, card) : undefined;
    if (forCard === null) return;
    // Pictures alone say it: what is wrong is in them.
    const said = request || `see the attached picture${files.length === 1 ? "" : "s"}`;
    const unnamed = !!card && isUnnamedCardAsk(name);
    // A chart the worker only described has no name yet: nothing in the library is "worked on" until Maintainer picks one.
    if (!unnamed) this.deps.library.markWorking(name, said);
    const exists = this.deps.library.names.includes(name);
    const pictures = files.length ? ` (Attached: ${files.length === 1 ? "a picture" : `${files.length} pictures`} of how it looks now or should look.)` : "";
    // Which bot asked, and how full its own list is (the library has no cap).
    const note = forCard ?? this.askNote(name, request, exists, bot);
    if (unnamed) { this.handTo(`${asker} asks for a chart it describes without naming a component: ${said}${pictures}${note}`, files); return; }
    this.handTo(exists ? `${asker}'s request for the component "${name}": ${said}${pictures}${note}` : `${asker} wants a new component "${name}": ${said}${pictures}${note}`, files);
  }

  /**
   * "Report a problem…" in a component card's ⋯ menu (`reportComponentProblem`): the user's words go to
   * Maintainer by the same road as a bot's <component> request, with whose chat the card is in, how it
   * refreshes, when its data is from, and the screenshot of the card (kept in that bot's attachments).
   * Without words or a picture of the user's own nothing is sent. Returns whether it was sent.
   */
  reportProblem(name: string, rawText: string, bot: Bot, pin: ReportCard | null, screenshot: string | null, pictures: string[]): boolean {
    const text = rawText.trim();
    if (!text && !pictures.length) return false;
    const kept = screenshot ? bot.guests.keepFiles([screenshot])[0]?.path ?? null : null;
    const said = text || `see the attached picture${pictures.length === 1 ? "" : "s"}`;
    this.requestComponentChange(name, problemReport(said, bot.profile.name, pin, kept), "The user", null, [...(kept ? [kept] : []), ...pictures]);
    return true;
  }

  giveComponent(name: string, bot: Bot): boolean {
    const list = bot.components;
    // A pin-only component is no bot's: only the pin strip offers it, the bot is never told about it.
    if (!list || !this.deps.library.names.includes(name) || this.deps.library.pinOnly(name)) return false;
    const own = bot.ownComponentNames;
    if (own.includes(name)) return true;
    if (countedComponents(own, this.deps.library.builtInNames()).length >= COMPONENT_LIMIT) return false;
    bot.setComponentList([...list, name]);
    return true;
  }

  /** Takes a component off a bot's list (the library copy stays); false when it was not on it (Undo, ADR-006 M4). */
  unlistComponent(name: string, bot: Bot): boolean {
    return this.takeComponent(name, bot);
  }

  private takeComponent(name: string, bot: Bot): boolean {
    const list = bot.components;
    if (!list?.includes(name)) return false;
    bot.setComponentList(list.filter((other) => other !== name));
    return true;
  }

  /** What Maintainer is told about the bot that asked (`componentAskNote`), after giving it at once when the library has it. */
  askNote(name: string, request: string, exists: boolean, bot: Bot | null): string {
    if (!bot || bot.components === null) return "";
    const own = bot.ownComponentNames;
    const limit = COMPONENT_LIMIT;
    const botName = this.nameOf(bot);
    const ask: ComponentAsk = {
      key: randomUUID().slice(0, 8).toLowerCase(), name, botId: bot.id, request, userAsked: shortened(bot.lastAsked, 300),
      stamp: this.deps.library.stampOf(name), changing: exists && own.includes(name),
    };
    const answerBack = ` If you will not or cannot do it, say why and end your reply with <component-declined id="${ask.key}">why, in one sentence for ${botName}</component-declined>; the app passes it on to ${botName}.`;
    const full = ` (App: ${botName} already has ${countedComponents(own, this.deps.library.builtInNames()).length} / ${limit} components. Add or build nothing for it: with a choices block of its components, ask the user which one to remove from ${botName}'s list first, then <take-component bot="${botName}">that name</take-component>.)`;
    // A pin-only component is changed as asked, but it never goes on the bot's list (and the bot is not told about it).
    if (exists && this.deps.library.pinOnly(name)) return ` (App: "${name}" is a pin-only component, a status card for the pin strip only: ${botName} is not told about it and it does not go on ${botName}'s list. Change it only as the request asks.${answerBack})`;
    if (exists && !own.includes(name)) {
      if (!this.giveComponent(name, bot)) {
        this.asks.push(ask);
        return full;
      }
      ask.changing = false;
      this.arrived(name, ask, bot, null);
      return ` (App: "${name}" is already in the library, so the app added it to ${botName}'s list and told ${botName}; nothing to build. Change it only if the request asks for a change.)`;
    }
    this.asks = this.asks.filter((other) => !(other.botId === bot.id && other.name === name));
    this.asks.push(ask);
    if (exists) return ` (App: ${botName} asked for this change.${answerBack})`;
    if (countedComponents(own, this.deps.library.builtInNames()).length >= limit) return full;
    return ` (App: ${botName} has ${countedComponents(own, this.deps.library.builtInNames()).length} / ${limit} components. Check the library first: if a component there already does this, build nothing and reply with <give-component bot="${botName}">its name</give-component>. Otherwise build it; once it is in the library the app adds it to ${botName}'s list.${answerBack})`;
  }

  /**
   * What a card worker's component ask comes to (worker-cards.ts). The worker draws its card itself, so the ask never touches the bot's list (and
   * its 20-component limit is no part of it), and it can only get a component made, never one of the library's changed: it may have read web text.
   * One the library has is answered by the app at once with its usage (null: nothing for Maintainer); a pin-only one is not available. A new one is
   * kept as an ask with the worker's task id, answered when the library has it (`deliverAsked`) or Maintainer declines it (`decline`); the text
   * Maintainer is given, otherwise.
   */
  private askForCard(name: string, request: string, bot: Bot, card: string): string | null {
    const library = this.deps.library;
    if (library.names.includes(name)) {
      bot.workers.tellCardWorker(card, library.pinOnly(name)
        ? `(App: "${name}" is not available for a card. Show the data another way: another component from your list that fits exactly as its usage defines it, or end with <component>the chart you want, described: what it must show, the shape of its data, a short example</component> and stop (no name; Maintainer decides). Do not draw it yourself.)`
        : this.cardReadyText(name, name, false));
      return null;
    }
    const botName = this.nameOf(bot);
    const ask: ComponentAsk = { key: randomUUID().slice(0, 8).toLowerCase(), name, botId: bot.id, request, userAsked: shortened(bot.lastAsked, 300), stamp: library.stampOf(name), changing: false, card };
    // A card worker that describes its chart again (another description, so another placeholder name) replaces its own earlier unnamed ask.
    this.asks = this.asks.filter((other) => !(other.card === card && (other.name === name || (isUnnamedCardAsk(name) && isUnnamedCardAsk(other.name)))));
    this.asks.push(ask);
    // The worker described a chart and named nothing: Maintainer decides all of it (an existing component, a new kind in one, or a new component; its name).
    if (isUnnamedCardAsk(name)) return ` (App: A card worker of ${botName} describes the chart it wants; it named no component and chose nothing: what to build, whether an existing component (for example inline-chart) gets a new kind or option instead of a new component, its name and where it goes are yours to decide. Nothing is added to ${botName}'s list (no limit applies). Check the library first: if a component there already does this, build nothing and end your reply with <give-component bot="${botName}" id="${ask.key}">its name</give-component>. Otherwise build or extend it; once it works and is in the library, end your reply with <give-component bot="${botName}" id="${ask.key}">its name</give-component>: the app then tells the worker, which fills the card (it does not go on ${botName}'s list). If you will not or cannot do it, say why and end your reply with <component-declined id="${ask.key}">why, in one sentence for the worker</component-declined>.)`;
    return ` (App: A card worker of ${botName} asks for this; it is not on ${botName}'s list and nothing is added there (no limit applies). Check the library first: if a component there already does this, build nothing and end your reply with <component-declined id="${ask.key}">it already exists: its name</component>. Otherwise build it; once it is in the library the app tells the worker. If you will not or cannot do it, say why and end your reply with <component-declined id="${ask.key}">why, in one sentence for the worker</component>.)`;
  }

  /** What a card worker is told when the component it asked for is in the library (`instead`: what it was named when it asked, if differently). */
  private cardReadyText(name: string, asked: string, changed: boolean): string {
    const instead = asked === name || isUnnamedCardAsk(asked) ? "" : ` in place of the "${asked}" you asked for`;
    return `(App: The component "${name}" is ready${instead}${changed ? " (changed as you asked)" : ""}. Its usage:\n${this.deps.library.catalog([name])}\nFill the card now: end your report with exactly one <show name="${name}">…</show> as the usage says (a component with a Command: needs only <show name="${name}"></show>), and one sentence. Do not ask for it again.)`;
  }

  private nameOf(bot: Bot) {
    return bot.id === this.deps.mainBot()?.id ? "Main bot" : bot.profile.name;
  }

  /** `componentArrived`: the bot now has `name` (by Maintainer, or the app at once); it is woken to answer what the user wanted. */
  private arrived(name: string, ask: ComponentAsk, bot: Bot, maker: string | null, changed = false) {
    const library = this.deps.library;
    const short = library.shortTitle(name);
    const shown = short ? `${short} (${name})` : name;
    const instead = ask.name === name ? "" : ` in place of the "${ask.name}" you asked for`;
    const request = ask.request ? ` (your request: ${shortened(ask.request, 200)})` : "";
    const user = ask.userAsked ? ` The user had asked you: "${ask.userAsked}".` : "";
    if (ask.card) {
      // A card worker asked: the card is filled by that worker, not by the bot (worker-cards.ts).
      bot.workers.tellCardWorker(ask.card, this.cardReadyText(name, ask.name, changed));
      bot.appNotice(changed ? `${maker ?? "Maintainer"} changed ${shown} for a card of ${this.nameOf(bot)}.` : `${maker ?? "Maintainer"} added ${shown} for a card of ${this.nameOf(bot)}.`);
      return;
    }
    bot.appMessage(arrivalLead(name, changed) + `${instead}${request}.${user} Answer that now: draw it with <show name="${name}">…</show> as its usage says, with one short sentence in the user's language. Do not ask Maintainer for it again.)\n${library.catalog([name])}`);
    bot.appNotice(changed ? `${maker ?? "Maintainer"} changed ${shown} as ${this.nameOf(bot)} asked.` : `${maker ?? "Maintainer"} added ${shown} to your components.`);
  }

  /** The library changed: components bots asked for that are in it now go on their lists (`deliverAskedComponents`). */
  deliverAsked() {
    for (const ask of [...this.asks]) {
      if (ask.changing || !this.deps.library.names.includes(ask.name)) continue;
      const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
      if (!bot) { this.asks = this.asks.filter((other) => other !== ask); continue; }
      // A card's component is the worker's to draw: it goes on no list.
      if (!ask.card && !this.giveComponent(ask.name, bot)) continue;
      this.asks = this.asks.filter((other) => other !== ask);
      this.arrived(ask.name, ask, bot, "Maintainer");
    }
  }

  /** Maintainer replied (`settleComponentAsks`): a change a bot asked for that landed goes back to it, once its editors are done. */
  settle(record: { role: string; choices?: unknown[]; chosen?: number; answer?: string }) {
    const maintainer = this.maintainer;
    if (!maintainer || (record.role !== "bot" && record.role !== "error")) return;
    // A component it just committed may not have been seen yet.
    if (this.deps.rescan) this.deps.rescan();
    else this.deps.library.rescan();
    // Its turn ended: the components it was asked to change are no longer worked on (`finishWorking`).
    this.deps.library.finishWorking();
    if (record.choices?.length && record.chosen === undefined && record.answer === undefined) return;
    if (maintainer.views.subagentsAtWork) return;
    for (const ask of [...this.asks]) {
      if (!ask.changing || this.deps.library.stampOf(ask.name) === ask.stamp) continue;
      this.asks = this.asks.filter((other) => other !== ask);
      const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
      if (bot) this.arrived(ask.name, ask, bot, "Maintainer", true);
    }
  }

  /** Maintainer's `<component-declined id="…">` (`declineComponentAsk`). */
  decline(rawId: string, rawReason: string) {
    const id = rawId.trim().toLowerCase();
    const ask = this.asks.find((candidate) => candidate.key === id);
    if (!ask) return;
    this.asks = this.asks.filter((other) => other !== ask);
    const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
    if (!bot) return;
    const reason = rawReason.trim();
    const said = reason ? ` Maintainer said: "${shortened(reason, 500)}".` : "";
    const user = ask.userAsked ? ` The user had asked you: "${ask.userAsked}".` : "";
    if (ask.card) {
      // A card ask is always the nameless one (`requestComponentChange`): it is "the chart you described", never a placeholder name.
      bot.workers.tellCardWorker(ask.card, `(App: Maintainer did not add a component for the chart you described.${said} Show the data another way with another component from your list that fits exactly as its usage defines it, or, if none does, say plainly in one or two sentences that no fitting component exists. Do not draw it yourself, do not force a component to fit, and do not ask again.)`);
      bot.appNotice(`Maintainer did not add a component for a card:` + (reason ? " " + shortened(firstLine(reason), 160) : ""));
      return;
    }
    bot.appMessage(`(App: Maintainer did not add the component "${ask.name}" you asked for${ask.changing ? " (or change it)" : ""}.${said}${user} Tell the user in one or two sentences, in their language, that it is not available and why, then answer their request as well as you can without it. Do not ask Maintainer for it again.)`);
    bot.appNotice((ask.changing ? `Maintainer did not change ${ask.name}:` : `Maintainer did not add ${ask.name}:`) + (reason ? " " + shortened(firstLine(reason), 160) : ""));
  }

  /** The bot a tag names (`componentHolder(named:)`). */
  holder(name: string): Bot | null {
    const wanted = name.trim().toLowerCase();
    const main = this.deps.mainBot();
    if (main && (wanted === "main bot" || wanted === main.profile.name.toLowerCase())) return main;
    return this.deps.bots().find((bot) => bot.profile.name.toLowerCase() === wanted) ?? null;
  }

  /** Maintainer's `<give-component>` / `<take-component>` (`changeComponentList`). */
  changeList(give: boolean, rawName: string, botName: string, askId?: string) {
    const maintainer = this.maintainer;
    const bot = this.holder(botName);
    if (!bot) { maintainer?.queueNote(`(App: There is no bot called "${botName}"; no component list changed.)`); return; }
    const name = this.deps.library.names.find((candidate) => candidate.toLowerCase() === rawName.toLowerCase()) ?? rawName;
    const shown = this.nameOf(bot);
    if (give) {
      // The answer to a chart a card worker only described: the worker gets it, and no list changes.
      // With several cards of one bot waiting, the id the app gave in the ask picks the right worker; without a matching one, the oldest.
      const pending = this.asks.filter((ask) => ask.botId === bot.id && ask.card && isUnnamedCardAsk(ask.name));
      const forCard = (askId ? pending.find((ask) => ask.key === askId) : undefined) ?? pending[0];
      if (forCard && this.deps.library.names.includes(name) && !this.deps.library.pinOnly(name) && !this.asks.some((ask) => ask.botId === bot.id && !ask.card && ask.name === name)) {
        this.asks = this.asks.filter((other) => other !== forCard);
        this.arrived(name, forCard, bot, "Maintainer");
        return;
      }
      if (!this.deps.library.names.includes(name)) { maintainer?.queueNote(`(App: "${name}" is not in the library, so it was not added to ${shown}'s list.)`); return; }
      if (this.deps.library.pinOnly(name)) { maintainer?.queueNote(`(App: "${name}" is a pin-only component (only the pin strip offers it), so it was not added to ${shown}'s list. A bot is never told about it.)`); return; }
      if (!this.giveComponent(name, bot)) {
        maintainer?.queueNote(`(App: ${shown} already has ${countedComponents(bot.ownComponentNames, this.deps.library.builtInNames()).length} / ${COMPONENT_LIMIT} components, so "${name}" was not added. Ask the user which one to remove from ${shown}'s list first.)`);
        return;
      }
      const asked = this.asks.find((ask) => ask.botId === bot.id && ask.name === name) ?? this.asks.find((ask) => ask.botId === bot.id && !ask.changing);
      if (asked) {
        this.asks = this.asks.filter((other) => other !== asked);
        this.arrived(name, asked, bot, "Maintainer");
      } else {
        bot.queueNote(`(App: Maintainer gave you the component "${name}".)`);
      }
    } else if (this.takeComponent(name, bot)) {
      bot.queueNote(`(App: "${name}" was taken off your components; it stays in the shared library.)`);
      this.deliverAsked();
    }
  }

  // ------------------------------------------------------------------------------------------
  // Installs

  /** Fetches a plugin, checks it and asks the user in the main bot's chat before installing it (`proposeInstall`). */
  proposeInstall(rawSource: string) {
    const source = rawSource.trim();
    const main = this.deps.mainBot();
    if (!source || this.installing.has(source)) return;
    this.installing.add(source);
    let proposal: InstallProposal;
    try {
      proposal = fetchPlugin(source, join(this.deps.root, "install-staging"), this.git.git);
    } catch (error) {
      main?.appNotice(`Couldn't install "${source}": ${(error as Error).message}`);
      this.installing.delete(source);
      return;
    } finally {
      // (A git clone is synchronous here; the staging folder is removed whatever the answer.)
    }
    this.installing.delete(source);
    if (proposal.problems.length) {
      main?.appNotice(`"${title(proposal.manifest)}" failed the checks and was not installed: ${proposal.problems.join("; ")}`);
      rmSync(proposal.work, { recursive: true, force: true });
      return;
    }
    this.offerInstall(proposal);
  }

  /**
   * The install card (`proposeInstall`'s question) in the main bot's chat: only "Install" puts the plugin into the library;
   * the staging folder goes whatever the answer. `answered` hears how it ended (installed, or why not; declined: null problem, false).
   */
  offerInstall(proposal: InstallProposal, answered?: (installed: boolean, problem: string | null) => void) {
    const main = this.deps.mainBot();
    if (!main) { rmSync(proposal.work, { recursive: true, force: true }); answered?.(false, null); return; }
    main.appNotice(installSummary(proposal), [{ label: "Install" }, { label: "Don't install" }], (index) => {
      if (index === 0) {
        const problem = this.finishInstall(proposal);
        answered?.(problem === null, problem);
      } else {
        rmSync(proposal.work, { recursive: true, force: true });
        answered?.(false, null);
      }
    });
  }

  /** The one-click update (plugin-store.ts `direct`): the same install as the card's "Install", with no question. Null when done, else why not. */
  installNow(proposal: InstallProposal): string | null {
    return this.finishInstall(proposal);
  }

  private get libraryFolder() { return join(this.deps.root, "plugins"); }
  /** Where the version an install replaced is kept (one per plugin), for Revert. */
  private previousFolder(name: string) { return join(this.deps.root, "plugin-previous", name); }
  private previousRecord(name: string) { return join(this.deps.root, "plugin-previous", `${name}.json`); }

  /** The version an install or update replaced, kept for Revert: its version and where it came from; null: none. */
  previousOf(name: string): { version: string; source: string | null } | null {
    if (!existsSync(join(this.previousFolder(name), "package.json"))) return null;
    try {
      const record = JSON.parse(readFileSync(this.previousRecord(name), "utf8")) as { version?: unknown; source?: unknown };
      return { version: typeof record.version === "string" ? record.version : "?", source: typeof record.source === "string" ? record.source : null };
    } catch {
      return { version: "?", source: null };
    }
  }

  /** The catalog hash kept with the previous version (its record's `sha256`); null: none. */
  private previousSha(name: string): string | null {
    try {
      const record = JSON.parse(readFileSync(this.previousRecord(name), "utf8")) as { sha256?: unknown };
      return typeof record.sha256 === "string" ? record.sha256 : null;
    } catch {
      return null;
    }
  }

  /** "Install": into the library (replacing one it installed before, which is kept for Revert), committed (`finishInstall`, `PluginRegistry.install`). Null when done, else why not. */
  private finishInstall(proposal: InstallProposal): string | null {
    const main = this.deps.mainBot();
    const plugins = this.deps.plugins();
    const name = proposal.manifest.name;
    const shown = title(proposal.manifest);
    try {
      const existing = plugins?.registry.plugin(name);
      // A built-in plugin may be replaced by one of the same name, as 1.x.
      if (existing && !existing.builtIn && !existing.installedFrom) {
        const problem = `The plugin library already has its own "${name}"; it won't be replaced by an outside one.`;
        main?.appNotice(`"${shown}" could not be installed: ${problem}`);
        return problem;
      }
      this.git.prepare();
      const target = join(this.libraryFolder, name);
      if (existsSync(join(target, "package.json"))) {
        // The version it replaces is kept (one), so Revert can put it back.
        let version = "?";
        try { version = String(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version ?? "?"); } catch { /* unreadable */ }
        rmSync(this.previousFolder(name), { recursive: true, force: true });
        mkdirSync(dirname(this.previousFolder(name)), { recursive: true });
        renameSync(target, this.previousFolder(name));
        writeFileAtomic(this.previousRecord(name), JSON.stringify({ version, source: plugins?.registry.installedSource(name) ?? null, sha256: plugins?.registry.revisionOf(name) ?? null }));
      }
      rmSync(target, { recursive: true, force: true });
      cpSync(proposal.folder, target, { recursive: true });
      this.git.run(["add", "-A", "--", name]);
      this.git.run(["commit", "-q", "-m", `Install ${name} ${proposal.manifest.version} (${proposal.source})`, "--", name]);
      plugins?.registry.noteInstalled(name, proposal.source, proposal.verifiedSha256 ?? null);
      main?.appNotice(`Installed: ${shown} ${proposal.manifest.version}. You can turn it off under Plugins (the header's Plugins button).`);
      return null;
    } catch (error) {
      const problem = `Couldn't put it into the plugin library: ${(error as Error).message}`;
      main?.appNotice(`"${shown}" could not be installed: ${problem}`);
      return problem;
    } finally {
      rmSync(proposal.work, { recursive: true, force: true });
    }
  }

  /** Revert: the kept previous version goes back in, and the one it replaces is kept in its place (Revert again undoes it). Null when done, else why not. */
  revertPlugin(name: string): string | null {
    const plugins = this.deps.plugins();
    const plugin = plugins?.registry.plugin(name);
    const previous = this.previousOf(name);
    if (!previous) return `"${name}" has no previous version to go back to.`;
    const previousSha = this.previousSha(name);
    if (plugin && !plugin.builtIn && !plugin.installedFrom) return `The plugin library has its own "${name}" now; it won't be replaced.`;
    const target = join(this.libraryFolder, name);
    let currentVersion = "?";
    try { currentVersion = String(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version ?? "?"); } catch { /* none */ }
    const currentSource = plugins?.registry.installedSource(name) ?? null;
    const currentSha = plugins?.registry.revisionOf(name) ?? null;
    const swap = join(this.deps.root, "plugin-previous", `.${name}-swap`);
    try {
      this.git.prepare();
      rmSync(swap, { recursive: true, force: true });
      const hadCurrent = existsSync(target);
      if (hadCurrent) renameSync(target, swap);
      renameSync(this.previousFolder(name), target);
      if (hadCurrent) {
        renameSync(swap, this.previousFolder(name));
        writeFileAtomic(this.previousRecord(name), JSON.stringify({ version: currentVersion, source: currentSource, sha256: currentSha }));
      } else {
        rmSync(this.previousRecord(name), { force: true });
      }
      this.git.run(["add", "-A", "--", name]);
      this.git.run(["commit", "-q", "-m", `Revert ${name} to ${previous.version}`, "--", name]);
      if (previous.source) plugins?.registry.noteInstalled(name, previous.source, previousSha);
      else plugins?.registry.rescan(true);
      return null;
    } catch (error) {
      return `Couldn't revert "${name}": ${(error as Error).message}`;
    }
  }

  /**
   * Remove: deletes an installed plugin's copy from the library (and the previous version kept for Revert). Only a plugin
   * installed from outside (the catalog, <install>); the library's own and built-in ones stay. Its data folder
   * (<data>/plugin-data/<name>) and settings are kept. Null when done, else why not.
   */
  removePlugin(name: string): string | null {
    const plugins = this.deps.plugins();
    const plugin = plugins?.registry.plugin(name);
    // A built-in's catalog update (`replacesBuiltIn`) is removable: the built-in version returns.
    if (!plugin || (plugin.builtIn && !plugin.replacesBuiltIn) || !plugin.installedFrom) return `"${name}" is not a plugin installed from outside, so it can't be removed here.`;
    try {
      this.git.prepare();
      rmSync(join(this.libraryFolder, name), { recursive: true, force: true });
      rmSync(this.previousFolder(name), { recursive: true, force: true });
      rmSync(this.previousRecord(name), { force: true });
      this.git.run(["add", "-A", "--", name]);
      this.git.run(["commit", "-q", "-m", `Remove ${name}`, "--", name]);
      plugins?.registry.noteRemoved(name);
      return null;
    } catch (error) {
      return `Couldn't remove "${name}": ${(error as Error).message}`;
    }
  }

  /** A plugin broke: Maintainer is asked to fix it (`onBroken`). */
  broken(plugin: string, problem: string) {
    this.handTo(`(App: Hot-update check) The plugin "${plugin}" is broken; Botling fell back to the previous version or disabled it for now. Please fix it: ${problem}`);
  }

  /** A plugin update took effect (`onUpdated`): Maintainer is told whether the user has allowed it, so it does not ask for an Allow already given. */
  pluginLive(name: string, version: string, allowed: boolean) {
    this.handTo(`(App: Plugin ${quoted(name)} ${quoted(version).slice(1, -1)} is live; state: ${allowed ? "allowed" : "not allowed yet (the user must press Allow in Settings › Plugins)"})`);
  }

  /** The user pressed Allow for a plugin (`plugin.grant`). */
  pluginGranted(name: string) {
    this.handTo(`(App: The user allowed plugin ${quoted(name)})`);
  }
}
