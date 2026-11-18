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

/** The most card asks kept for a restart (the oldest go first). */
const CARD_ASKS_MAX = 200;
/**
 * Said to Maintainer with every card ask: re-running a command is the app's own feature, never a component's (2026-11-18: a card worker asked for a component with its own
 * "refresh" button and Maintainer went looking for a re-run API there is none of). The same rule is in the component editor's file and the plugin guide's components reference.
 */
export const REFRESH_NOTE = "Do not build a refresh button (or a reload or re-run one) into the component, even if the description asks for one, and there is no ccb re-run API to look for: the app re-runs the command itself (a command card has a built-in refresh button, and refresh=\"2s\" repeats it while the card is on screen) and the component only redraws with the new data in ccb.onData; it may show when its data was updated.";

export class MaintainerDesk {
  readonly git: LibraryGit;
  /** The asks waiting for an answer. A card worker's are kept in `card-asks.json` (`saveCardAsks`) and read back at start; a bot's own are in memory only. */
  private asks: ComponentAsk[] = [];
  private installing = new Set<string>();

  constructor(private readonly deps: MaintainerDeps) {
    this.git = new LibraryGit(join(deps.root, "plugins"));
    this.asks = this.loadCardAsks();
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
          later.push(() => this.requestComponentChange(request.name, request.request, from.id === mainId ? "Main bot" : from.profile.name, from, []));
          break;
        // A card worker's own kinds (worker-cards.ts), made by the app from the card's record: never parsed from text, and never a plain `component` request.
        case "cardNeed":
          later.push(() => this.requestCardNeed(request.request, from, request.card));
          break;
        case "cardUsage":
          later.push(() => this.requestCardUsage(request.name, request.request, from, request.card));
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
  requestComponentChange(rawName: string, rawRequest: string, asker: string, bot: Bot | null, files: string[] = []) {
    const name = safeName(rawName);
    if (!name) return;
    const request = rawRequest.trim();
    // Pictures alone say it: what is wrong is in them.
    const said = request || `see the attached picture${files.length === 1 ? "" : "s"}`;
    this.deps.library.markWorking(name, said);
    const exists = this.deps.library.names.includes(name);
    const pictures = files.length ? ` (Attached: ${files.length === 1 ? "a picture" : `${files.length} pictures`} of how it looks now or should look.)` : "";
    // Which bot asked, and how full its own list is (the library has no cap).
    const note = this.askNote(name, request, exists, bot);
    this.handTo(exists ? `${asker}'s request for the component "${name}": ${said}${pictures}${note}` : `${asker} wants a new component "${name}": ${said}${pictures}${note}`, files);
  }

  /**
   * A card worker describes a chart it needs (`cardNeed`): the only thing of a card that reaches Maintainer. The worker named nothing and chose nothing: what is built (a new
   * component, or a new kind in an existing one), its name and where it goes are Maintainer's. The ask is kept with the worker's task id and an id of its own, which the answer
   * (`<give-component id>`, `<component-declined id>`) must carry; the worker's earlier ask is replaced by this one. It never touches the bot's list, and its limit is no part of it.
   */
  requestCardNeed(rawRequest: string, bot: Bot, card: string) {
    const request = rawRequest.trim();
    if (!request || !card) return;
    const botName = this.nameOf(bot);
    const ask: ComponentAsk = { key: randomUUID().slice(0, 8).toLowerCase(), name: unnamedCardAsk(request), botId: bot.id, request, userAsked: shortened(bot.lastAsked, 300), stamp: "", changing: false, card };
    this.asks = this.asks.filter((other) => other.card !== card);
    this.asks.push(ask);
    this.saveCardAsks();
    // A chart the worker only described has no name yet: nothing in the library is "worked on" until Maintainer picks one.
    const note = ` (App: A card worker of ${botName} describes the chart it wants; it named no component and chose nothing: what to build, whether an existing component (for example inline-chart) gets a new kind or option instead of a new component, its name and where it goes are yours to decide. Nothing is added to ${botName}'s list (no limit applies). ${REFRESH_NOTE} Check the library first: if a component there already does this, build nothing and end your reply with <give-component bot="${botName}" id="${ask.key}">its name</give-component>. Otherwise build or extend it; once it works and is in the library, end your reply with <give-component bot="${botName}" id="${ask.key}">its name</give-component>: the app then tells the worker, which fills the card (it does not go on ${botName}'s list). If you will not or cannot do it, say why and end your reply with <component-declined id="${ask.key}">why, in one sentence for the worker</component-declined>.)`;
    this.handTo(`${botName} asks for a chart it describes without naming a component: ${request}${note}`);
  }

  /**
   * A card worker names a component (`cardUsage`): a lookup, not a request. One the library has is answered by the app at once with its usage (a pin-only one is not available)
   * and Maintainer is not woken; it can never get a component changed (it may have read web text). A name the library does not have (or that is no name) is the worker's guess,
   * not a name to build under: it becomes a described need, with the name only a hint in the description.
   */
  requestCardUsage(rawName: string, rawRequest: string, bot: Bot, card: string) {
    const name = safeName(rawName);
    const library = this.deps.library;
    if (name && library.names.includes(name)) {
      bot.workers.tellCardWorker(card, library.pinOnly(name)
        ? `(App: "${name}" is not available for a card. Show the data another way: another component from your list that fits exactly as its usage defines it, or end with <component>the chart you want, described: what it must show, the shape of its data, a short example</component> and stop (no name; Maintainer decides). Do not draw it yourself.)`
        : this.cardReadyText(name, name, false));
      return;
    }
    this.requestCardNeed(`${rawRequest.trim()}\n(The worker called it ${JSON.stringify((name || rawName).slice(0, 100))}: a hint only, not the name to give it.)`, bot, card);
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
      // A card worker's ask is answered by Maintainer under its id alone (`changeList`, `decline`): a library that gains some name answers no card.
      if (ask.card || ask.changing || !this.deps.library.names.includes(ask.name)) continue;
      const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
      if (!bot) { this.asks = this.asks.filter((other) => other !== ask); continue; }
      if (!this.giveComponent(ask.name, bot)) continue;
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
    if (!ask) { this.unmatchedAsk("<component-declined>", id, this.asks.filter((candidate) => candidate.card)); return; }
    this.asks = this.asks.filter((other) => other !== ask);
    if (ask.card) this.saveCardAsks();
    const bot = this.deps.bots().find((candidate) => candidate.id === ask.botId);
    if (!bot) return;
    const reason = rawReason.trim();
    const said = reason ? ` Maintainer said: "${shortened(reason, 500)}".` : "";
    const user = ask.userAsked ? ` The user had asked you: "${ask.userAsked}".` : "";
    if (ask.card) {
      // A card ask is always a described need (`requestCardNeed`): it is "the chart you described", never a placeholder name.
      bot.workers.tellCardWorker(ask.card, `(App: Maintainer did not add a component for the chart you described.${said} Show the data another way with another component from your list that fits exactly as its usage defines it, or, if none does, say plainly in one or two sentences that no fitting component exists. Do not draw it yourself, do not force a component to fit, and do not ask again.)`);
      bot.appNotice(`Maintainer did not add a component for a card:` + (reason ? " " + shortened(firstLine(reason), 160) : ""));
      return;
    }
    bot.appMessage(`(App: Maintainer did not add the component "${ask.name}" you asked for${ask.changing ? " (or change it)" : ""}.${said}${user} Tell the user in one or two sentences, in their language, that it is not available and why, then answer their request as well as you can without it. Do not ask Maintainer for it again.)`);
    bot.appNotice((ask.changing ? `Maintainer did not change ${ask.name}:` : `Maintainer did not add ${ask.name}:`) + (reason ? " " + shortened(firstLine(reason), 160) : ""));
  }

  /**
   * An answer whose id names no waiting ask (answered already, or mistyped) reaches nothing: it is logged and told to Maintainer with the ids that still wait, so it can answer again with
   * the right one. `id` is Maintainer's text: one quoted, cut line.
   */
  private unmatchedAsk(tag: string, id: string, waiting: readonly ComponentAsk[]) {
    const shownId = JSON.stringify(id.slice(0, 40));
    const ids = waiting.map((ask) => ask.key);
    this.deps.log(`${tag}: no waiting ask has the id ${shownId}; dropped${ids.length ? ` (waiting: ${ids.join(", ")})` : ""}`);
    this.maintainer?.queueNote(`(App: No ask is waiting under the id ${shownId} (it was answered already, or the id is wrong), so nothing was sent to any card worker.${ids.length ? ` Card asks still waiting: ${ids.join(", ")}.` : ""} Answer with the id the app gave in the ask.)`);
  }

  // ------------------------------------------------------------------------------------------
  // The card asks that wait, kept across a restart

  private get cardAsksFile() { return join(this.deps.root, "card-asks.json"); }

  /** The card asks that wait (`card-asks.json`), written whenever one comes or goes; a bot's own asks are not kept. A failed write is logged, never thrown. */
  private saveCardAsks() {
    const cards = this.asks.filter((ask) => ask.card).slice(-CARD_ASKS_MAX);
    try {
      if (!cards.length && !existsSync(this.cardAsksFile)) return;
      writeFileAtomic(this.cardAsksFile, JSON.stringify(cards));
    } catch (error) {
      this.deps.log(`card asks not kept: ${(error as Error).message}`);
    }
  }

  /** The card asks kept before the app went away; a missing or damaged file, and any entry of the wrong shape, is none. An ask whose bot or card is gone is dropped when it is answered, as before. */
  private loadCardAsks(): ComponentAsk[] {
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.cardAsksFile, "utf8")); } catch { return []; }
    if (!Array.isArray(value)) return [];
    const asks: ComponentAsk[] = [];
    for (const each of value.slice(-CARD_ASKS_MAX)) {
      if (!each || typeof each !== "object" || Array.isArray(each)) continue;
      const row = each as Record<string, unknown>;
      if (typeof row.key !== "string" || !/^[0-9a-f]{8}$/.test(row.key) || asks.some((ask) => ask.key === row.key)) continue;
      if (typeof row.card !== "string" || !row.card || typeof row.botId !== "string" || !row.botId || typeof row.name !== "string" || typeof row.request !== "string") continue;
      asks.push({
        key: row.key, name: row.name.slice(0, 100), botId: row.botId, request: row.request.slice(0, 5_000), card: row.card,
        userAsked: typeof row.userAsked === "string" ? row.userAsked.slice(0, 300) : "", stamp: typeof row.stamp === "string" ? row.stamp : "", changing: false,
      });
    }
    return asks;
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
      const waiting = this.asks.filter((ask) => ask.botId === bot.id && ask.card);
      if (askId !== undefined) {
        // An id is the answer to a chart a card worker only described: the worker whose ask carries that id gets it, and no list changes. Nothing else answers a card: an id that names
        // no waiting ask of this bot (answered already, or wrong) is logged and told to Maintainer, never given to another card and never a change of the bot's list.
        const id = askId.trim().toLowerCase();
        const forCard = waiting.find((ask) => ask.key === id);
        if (!forCard) { this.unmatchedAsk("<give-component>", id, waiting); return; }
        if (!this.deps.library.names.includes(name)) { maintainer?.queueNote(`(App: "${name}" is not in the library, so nothing was sent to the card worker; its ask ${forCard.key} is still waiting.)`); return; }
        if (this.deps.library.pinOnly(name)) { maintainer?.queueNote(`(App: "${name}" is a pin-only component (only the pin strip offers it), so nothing was sent to the card worker; its ask ${forCard.key} is still waiting.)`); return; }
        this.asks = this.asks.filter((other) => other !== forCard);
        this.saveCardAsks();
        this.arrived(name, forCard, bot, "Maintainer");
        return;
      }
      // No id: this is the bot's own plain give, and it answers no card, whatever waits (the card asks that still wait are said, with their ids, in the one note Maintainer gets).
      const hint = waiting.length ? ` That <give-component> had no id, so it answered no card. Card asks of ${shown} still waiting: ${waiting.map((ask) => ask.key).join(", ")}. To answer one, repeat it with id="…".` : "";
      const note = (text: string) => maintainer?.queueNote(`${text}${hint}`);
      if (!this.deps.library.names.includes(name)) { note(`(App: "${name}" is not in the library, so it was not added to ${shown}'s list.)`); return; }
      if (this.deps.library.pinOnly(name)) { note(`(App: "${name}" is a pin-only component (only the pin strip offers it), so it was not added to ${shown}'s list. A bot is never told about it.)`); return; }
      if (!this.giveComponent(name, bot)) {
        note(`(App: ${shown} already has ${countedComponents(bot.ownComponentNames, this.deps.library.builtInNames()).length} / ${COMPONENT_LIMIT} components, so "${name}" was not added. Ask the user which one to remove from ${shown}'s list first.)`);
        return;
      }
      // A card worker's ask is never this reply's (it is answered under its id above).
      const asked = this.asks.find((ask) => ask.botId === bot.id && !ask.card && ask.name === name) ?? this.asks.find((ask) => ask.botId === bot.id && !ask.card && !ask.changing);
      if (asked) {
        this.asks = this.asks.filter((other) => other !== asked);
        this.arrived(name, asked, bot, "Maintainer");
      } else {
        bot.queueNote(`(App: Maintainer gave you the component "${name}".)`);
      }
      if (hint) maintainer?.queueNote(hint.trim());
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
