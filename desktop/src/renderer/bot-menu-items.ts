// The bot row's context menu as a slot (M7-05b): what `botling.sidebar` contributes to `bot/context` for its own items, and how the menu
// reads the slot. Pure data and checks (the menu, Rail.tsx, and the plugin, plugins/sidebar/index.ts, both read it; the plugin's module
// runs only through the trusted loader, so the menu cannot import it).
import type { Kernel } from "../../../Web/src/plugin-kernel";
import { menuRow, type MenuItem } from "./plugin-commands";
import { BOT_CONTEXT_SLOT, SIDEBAR_PLUGIN } from "./sidebar-names";

/** The sidebar's own items; the menu knows what each one does (it needs the page's state), the slot says which exist and where they sit. */
export const BOT_MENU_ITEM_IDS = ["pin", "restart", "remove"] as const;
export type BotMenuItemId = (typeof BOT_MENU_ITEM_IDS)[number];

/** A contribution of the sidebar plugin to `bot/context`: one of its own items. `top` ones come before the plugins' items, `bottom` ones after. */
export interface BotMenuItemEntry { kind: "bot-menu-item"; id: BotMenuItemId; place: "top" | "bottom" }

/** The plugin's items in registration order: today's menu (Pin, Restart, then the plugins' commands, then Remove). */
export const BUILTIN_BOT_MENU: readonly BotMenuItemEntry[] = [
  { kind: "bot-menu-item", id: "pin", place: "top" },
  { kind: "bot-menu-item", id: "restart", place: "top" },
  { kind: "bot-menu-item", id: "remove", place: "bottom" },
];

/** Whether `entry` is a well-formed item of the sidebar (an unknown id or place is not: the menu draws nothing it does not know). */
export function isBotMenuItem(entry: unknown): entry is BotMenuItemEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const { kind, id, place } = entry as Record<string, unknown>;
  return kind === "bot-menu-item" && (BOT_MENU_ITEM_IDS as readonly unknown[]).includes(id) && (place === "top" || place === "bottom");
}

/**
 * What the menu draws, by where the items come from:
 *   - `slot`: the sidebar plugin owns `bot/context` (its items and the plugins' rows, as the kernel holds them);
 *   - `unavailable`: the shell's host refused or lost the plugin (fail closed: no items, one line);
 *   - `direct`: the host never touched the plugin (a component test, a page without the shell): today's items from the page's props.
 */
export type BotMenuSource =
  | { state: "slot"; top: BotMenuItemId[]; bottom: BotMenuItemId[]; rows: MenuItem[] }
  | { state: "unavailable" }
  | { state: "direct" };

/** Reads `bot/context` from `kernel`. `away`: the shell's host refused or lost the sidebar plugin. */
export function readBotMenu(kernel: Kernel, away: boolean): BotMenuSource {
  if (kernel.slotOwner(BOT_CONTEXT_SLOT) !== SIDEBAR_PLUGIN) return away ? { state: "unavailable" } : { state: "direct" };
  const top: BotMenuItemId[] = [];
  const bottom: BotMenuItemId[] = [];
  const rows: MenuItem[] = [];
  const seen = new Set<BotMenuItemId>();
  for (const { plugin, entry } of kernel.entries<unknown>(BOT_CONTEXT_SLOT)) {
    // Only the sidebar's own entries are items of the menu; another plugin's contribution of that kind is ignored.
    if (plugin === SIDEBAR_PLUGIN && isBotMenuItem(entry)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      (entry.place === "top" ? top : bottom).push(entry.id);
      continue;
    }
    // A plugin's `bot/context` row (the plugin feed's entry): drawn as the page always drew it, a command and its words.
    const row = feedRow(entry);
    if (row && row.plugin === plugin) rows.push(menuRow(row));
  }
  return { state: "slot", top, bottom, rows };
}

type FeedRow = Parameters<typeof menuRow>[0];
function feedRow(entry: unknown): FeedRow | null {
  if (typeof entry !== "object" || entry === null || (entry as { kind?: unknown }).kind !== "feed") return null;
  const row = (entry as { row?: unknown }).row;
  if (typeof row !== "object" || row === null) return null;
  const { menu, command, title, plugin } = row as Record<string, unknown>;
  if (menu !== BOT_CONTEXT_SLOT || typeof command !== "string" || typeof title !== "string" || typeof plugin !== "string") return null;
  return row as FeedRow;
}
