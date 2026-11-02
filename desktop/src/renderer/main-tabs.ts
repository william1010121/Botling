// The main area's plugin tabs (plan W2): a `mainTab` view (PluginsView `mainTabs`) is a tab beside Chat /
// Board in the chat header of the bots its `forRole` names; which tab each bot showed last is kept in
// settings.json (`mainTabs`, SettingsChange "mainTab"), so it shows again when the bot is opened.
import type { BotView, PluginsView } from "../contract";

export type MainTab = NonNullable<PluginsView["mainTabs"]>[number];

/** How a tab is remembered: "<plugin>/<view id>". */
export const tabKey = (tab: MainTab) => `${tab.plugin}/${tab.id}`;

/** The tabs a bot's header offers: "main" for the main bot, "project" for project bots (and their sub bots), "any" for all. */
export function mainTabsFor(plugins: PluginsView | null | undefined, bot: Pick<BotView, "role" | "parent">): MainTab[] {
  // A sub bot (a bot with a job under a project bot) works in its project's folder.
  const role = bot.role === "main" ? "main" : bot.role === "manager" || bot.parent ? "project" : null;
  return (plugins?.mainTabs ?? []).filter((tab) => tab.forRole === "any" || tab.forRole === role);
}

/** The tab shown: the one remembered for the bot, while it is offered; null: Chat or Board. */
export function shownTab(tabs: MainTab[], remembered: string | undefined): MainTab | null {
  return (remembered && tabs.find((tab) => tabKey(tab) === remembered)) || null;
}

/** The bot a plugin names in botling.openChat / openResult ("main": the main bot, as plugins see it), if it is there. */
export function namedBot(bots: Pick<BotView, "id" | "role">[], botId: string): string | null {
  const bot = botId === "main" ? bots.find((candidate) => candidate.role === "main") : bots.find((candidate) => candidate.id === botId);
  return bot?.id ?? null;
}
