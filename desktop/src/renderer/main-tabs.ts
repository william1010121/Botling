// The main area's plugin tabs (plan W2): a `mainTab` view (PluginsView `mainTabs`) is a tab beside Chat
// in the chat header of the bots its `forRole` names; which tab each bot showed last is kept in
// settings.json (`mainTabs`, SettingsChange "mainTab"), so it shows again when the bot is opened.
// Dynamic tabs: only Note and the main bot's Whiteboard (with Chat and Storage) are always in the header; every other plugin tab is
// offered by the "More tabs" menu and is in the header only while it is in use (`visibleTabs`), or pinned (settings.json `pinnedTabs`).
import type { BotView, PluginsView } from "../contract";

/** The first-party plugin whose tab takes the place of this page's own whiteboard (plan W5). */
export const WHITEBOARD_PLUGIN = "botling.whiteboard";

/**
 * The app's own Storage tab (檔案庫, StorageTab.tsx), right of the plugins' tabs: remembered in `mainTabs` like a plugin's
 * tab, under a key no plugin view can have (a plugin's name has a dot).
 */
export const STORAGE_TAB = "botling/storage";

/** The first-party plugin whose tab is Note: always in the header (with Chat, Storage and the main bot's Whiteboard). */
export const NOTE_PLUGIN = "botling.note";

export type MainTab = NonNullable<PluginsView["mainTabs"]>[number];

/** How a tab is remembered: "<plugin>/<view id>". */
export const tabKey = (tab: MainTab) => `${tab.plugin}/${tab.id}`;

/**
 * The tabs a bot's header offers: "main" for the main bot, "project" for project bots (and their sub bots), "bots" for every bot but
 * the main bot, "any" for all, "marked" for the bots its plugin marked (`ui.showTab`, the tab's `bots`).
 */
export function mainTabsFor(plugins: PluginsView | null | undefined, bot: Pick<BotView, "role" | "parent"> & { id?: string }): MainTab[] {
  // A sub bot (a bot with a job under a project bot) works in its project's folder.
  const role = bot.role === "main" ? "main" : bot.role === "manager" || bot.parent ? "project" : null;
  return (plugins?.mainTabs ?? []).filter((tab) => tab.forRole === "any" || tab.forRole === role || (tab.forRole === "bots" && bot.role !== "main")
    || (tab.forRole === "marked" && !!bot.id && !!tab.bots?.includes(bot.id)));
}

/** The right panel blocks plugins add for a bot (`rightPanel.section` views), by the same `forRole`. */
export function rightPanelSectionsFor(plugins: PluginsView | null | undefined, bot: Pick<BotView, "role" | "parent">): NonNullable<PluginsView["rightPanelSections"]> {
  const role = bot.role === "main" ? "main" : bot.role === "manager" || bot.parent ? "project" : null;
  return (plugins?.rightPanelSections ?? []).filter((section) => section.forRole === "any" || section.forRole === role || (section.forRole === "bots" && bot.role !== "main"));
}

/** The one view at the right end of the row above a bot's input box (`composerBar` views): the first for its role, by the same `forRole`; null: none. */
export function composerBarFor(plugins: PluginsView | null | undefined, bot: Pick<BotView, "role" | "parent">): NonNullable<PluginsView["composerBarViews"]>[number] | null {
  const role = bot.role === "main" ? "main" : bot.role === "manager" || bot.parent ? "project" : null;
  return (plugins?.composerBarViews ?? []).find((view) => view.forRole === "any" || view.forRole === role || (view.forRole === "bots" && bot.role !== "main")) ?? null;
}

/** The tab shown: the one remembered for the bot, while it is offered; null: Chat (or the app's own Storage tab). */
export function shownTab(tabs: MainTab[], remembered: string | undefined): MainTab | null {
  return (remembered && tabs.find((tab) => tabKey(tab) === remembered)) || null;
}

/** What the main window tells the core it shows (`chat.shown`, for plugins' `workspace.current`). */
export function shownChat(botId: string | null, shown: { subagent: boolean; tab: MainTab | null; storage?: boolean }): { type: "chat.shown"; botId: string | null; view: "chat" | "storage" | "tab" | "subagent"; tab: string | null } {
  if (!botId) return { type: "chat.shown", botId: null, view: "chat", tab: null };
  if (shown.subagent) return { type: "chat.shown", botId, view: "subagent", tab: null };
  if (shown.tab) return { type: "chat.shown", botId, view: "tab", tab: tabKey(shown.tab) };
  return { type: "chat.shown", botId, view: shown.storage ? "storage" : "chat", tab: null };
}

/** The bot a plugin names in botling.openChat / openResult ("main": the main bot, as plugins see it), if it is there. */
export function namedBot(bots: Pick<BotView, "id" | "role">[], botId: string): string | null {
  const bot = botId === "main" ? bots.find((candidate) => candidate.role === "main") : bots.find((candidate) => candidate.id === botId);
  return bot?.id ?? null;
}

/** A tab that is always in the header: Note, and the Whiteboard (the main bot's default view). */
export const alwaysShown = (tab: MainTab): boolean => tab.plugin === NOTE_PLUGIN || tab.plugin === WHITEBOARD_PLUGIN;

/** A bot's pinned tab keys; the bot id is looked up as an own key (a bot id comes from data). */
export function pinnedFor(pins: Record<string, string[]> | undefined, botId: string): string[] {
  return pins && Object.hasOwn(pins, botId) ? pins[botId]! : NO_PINS;
}
const NO_PINS: string[] = [];

/**
 * Which of the offered tabs the header draws. A tab is "in use", so it shows, when it is
 *   - Note or the Whiteboard (always);
 *   - pinned for this bot (the user's own pin, `pinnedTabs`);
 *   - the tab on screen now (`current`: opened from the "More tabs" menu, by a plugin's `ui.showTab(…, { open: true })` / frame `openTab`, or the
 *     one the bot showed when Botling last quit), which hides again when the bot goes to another view;
 *   - one its plugin marked this bot for (`forRole: "marked"`, `ui.showTab(bot, view, true)`): the plugin says the bot uses it.
 * Every other tab is `hidden` (the menu lists it). Both lists keep the plugins' order.
 */
export function visibleTabs(tabs: MainTab[], { pinned, current }: { pinned: string[]; current: MainTab | null }): { shown: MainTab[]; hidden: MainTab[] } {
  const shown: MainTab[] = [];
  const hidden: MainTab[] = [];
  for (const tab of tabs) {
    const inUse = alwaysShown(tab) || tab.forRole === "marked" || pinned.includes(tabKey(tab)) || (!!current && tabKey(current) === tabKey(tab));
    (inUse ? shown : hidden).push(tab);
  }
  return { shown, hidden };
}
