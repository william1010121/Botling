// What the core lends the component studio seam (plugins/studio-seam.ts): the chats' specs and lines, the component library, Maintainer,
// bots' component lists and the card command runner, as the plugin botling.component-studio asks for them. No studio logic is here:
// the state machine (which spec is being built, what Maintainer is told) is the plugin's.
import type { Bot } from "./bot";
import { preview as previewOf } from "./bot";
import type { ComponentCommands } from "./components/commands";
import { detailKey } from "./components/commands";
import { BUILT_INS, type ComponentLibrary } from "./components/library";
import type { Display } from "./reply";
import type { MaintainerDesk } from "./maintainer";
import type { StudioChat, StudioLibrary, StudioLibraryEntry, StudioLine, StudioWorld } from "./plugins/studio-seam";
import type { ChatRecord } from "./store/records";

export interface StudioDeps {
  /** Every chat a spec can be in (`chatsWithPins`), in the left column's order. */
  chats: () => Bot[];
  /** A bot by the core's id (null: gone). */
  bot: (id: string) => Bot | null;
  library: ComponentLibrary;
  commands: ComponentCommands;
  maintainer: MaintainerDesk;
  maintainerBot: () => Bot | null;
  /** The bots a component can go to (Maintainer left out). */
  componentBots: () => Bot[];
  /** The library's working state changed: the app shows it. */
  componentsChanged: () => void;
  mainId: string;
}

/** The library component a bot's reply already is (a `<show>` of one that is not built in): what "Add to another bot…" is offered for (`lineExtras`). */
export function ownComponent(record: { role: string; displays?: unknown }, names: readonly string[]): string | undefined {
  if (record.role !== "bot") return undefined;
  return ((record.displays ?? []) as Display[]).find((display) => !BUILT_INS.includes(display.name) && names.includes(display.name))?.name;
}

export function studioWorld(deps: StudioDeps): StudioWorld {
  const idOf = (bot: Bot) => (bot.id === deps.mainId ? "main" : bot.id);
  const botOf = (id: string) => deps.bot(id === "main" ? deps.mainId : id);
  const must = (id: string): Bot => {
    const bot = botOf(id);
    if (!bot) throw new Error("No such bot.");
    return bot;
  };
  const chatOf = (bot: Bot): StudioChat => ({
    id: idOf(bot), name: bot.profile.name, folder: bot.profile.folder, working: bot.view().working, components: bot.components, own: bot.ownComponentNames,
  });
  const entryOf = (name: string, withInfo: boolean): StudioLibraryEntry => {
    const library = deps.library;
    const lines = library.about(name).trim().split("\n");
    return {
      version: library.versionOf(name), command: library.command(name), detailCommand: library.detailCommand(name),
      summary: lines[0] ?? "", catalog: library.catalog([name]),
      ...(withInfo ? { info: library.info(name) } : {}),
    };
  };
  return {
    chats: () => deps.chats().map(chatOf),
    chat: (id) => { const bot = botOf(id); return bot ? chatOf(bot) : null; },
    componentBots: () => deps.componentBots().map((bot) => bot.profile.name),
    maintainer: () => { const bot = deps.maintainerBot(); return bot ? { id: idOf(bot), working: bot.view().working } : null; },
    line(botId, query): StudioLine | null {
      const bot = botOf(botId);
      if (!bot) return null;
      const lines = bot.lines();
      const record: ChatRecord | undefined = "id" in query ? lines.find((line) => line.id === query.id) : lines.findLast((line) => line.role === "bot");
      if (!record) return null;
      const at = lines.indexOf(record);
      return {
        record: structuredClone(record) as unknown as Record<string, unknown>,
        asked: lines.slice(0, at).findLast((line) => line.role === "user" && line.text.trim())?.text ?? null,
        previews: bot.previews(record),
        preview: previewOf(record),
        turn: lines.slice(lines.findLastIndex((line) => line.role === "user") + 1).map((line) => line.id),
      };
    },
    specs() {
      const all: Record<string, unknown[]> = {};
      for (const bot of deps.chats()) if (bot.specs.length) all[idOf(bot)] = structuredClone(bot.specs) as unknown[];
      return all;
    },
    writeSpecs: (botId, specs) => must(botId).editSpecs((list) => { list.splice(0, list.length, ...(structuredClone(specs) as typeof list)); }),
    library(withInfo): StudioLibrary {
      const entries: Record<string, StudioLibraryEntry> = {};
      for (const name of deps.library.names) entries[name] = entryOf(name, withInfo.includes(name));
      return { names: [...deps.library.names], entries };
    },
    working(name, change) {
      if (change === null) deps.library.doneWorking(name); else deps.library.markWorking(name, change);
      deps.componentsChanged();
    },
    lineExtras: (record) => { const component = ownComponent(record, deps.library.names); return component ? { component } : {}; },
    handTo: (text) => deps.maintainer.handTo(text),
    holder: (name) => { const bot = deps.maintainer.holder(name); return bot ? chatOf(bot) : null; },
    give: (name, botId) => deps.maintainer.giveComponent(name, must(botId)),
    unlist: (name, botId) => deps.maintainer.unlistComponent(name, must(botId)),
    note: (botId, text) => must(botId).queueNote(text),
    notice: (botId, text) => must(botId).appNotice(text),
    ask: (botId, text, waitMs, answerMs) => must(botId).groupTurn(text, waitMs, answerMs),
    commands: {
      isApproved: (command, folder) => deps.commands.isApproved(command, folder),
      isDetailApproved: (detail, folder) => deps.commands.isDetailApproved(detail, folder),
      run: (card, command, folder, force) => deps.commands.run(card, command, folder, force),
      state: (card, command, detail, folder) => deps.commands.state(card, command, detail, folder),
      runOf: (card, command, folder) => deps.commands.runOf(card, command, folder),
      lastRan: (card) => deps.commands.lastRan(card),
      approve: (command, folder, detail) => {
        deps.commands.approve(command, folder);
        if (detail) deps.commands.approve(detailKey(detail), folder);
      },
    },
  };
}
