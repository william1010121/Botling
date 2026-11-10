// The Note tab's quick chat (like the in-app browser's full screen bubble): the bot's bubble sits at the bottom right
// of the Note, and clicking it docks the bot's real chat beside the Note, so you can ask while you read or edit it
// without going back to Chat. The dock belongs to one bot's Note: switching to another tab or bot closes it, and
// coming back shows the Note alone again.
import { tabKey, type MainTab } from "./main-tabs";

/** The first-party plugin whose tab (the Note) offers the docked chat. */
export const NOTE_PLUGIN = "botling.note";

/** Whether a main-area tab offers the bubble and the docked chat. */
export function dockable(tab: Pick<MainTab, "plugin"> | null | undefined): boolean {
  return tab?.plugin === NOTE_PLUGIN;
}

/** What the dock is open for: "<bot>/<plugin>/<view>" while a dockable tab shows (not a worker's page); null: no bubble. */
export function dockKey(botId: string | null | undefined, tab: MainTab | null | undefined, watching: boolean): string | null {
  return botId && tab && dockable(tab) && !watching ? `${botId}/${tabKey(tab)}` : null;
}

/** Whether the chat is docked: it was opened for exactly what shows now. */
export function docked(open: string | null, key: string | null): boolean {
  return !!key && open === key;
}

/** The bubble's click: opens the dock for what shows, or closes it. */
export function toggleDock(open: string | null, key: string | null): string | null {
  return key && open !== key ? key : null;
}

/** What the dock state becomes when what shows changes: it stays only while it was opened for that. */
export function keepDock(open: string | null, key: string | null): string | null {
  return docked(open, key) ? open : null;
}
