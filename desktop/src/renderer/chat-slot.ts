// Where the chat gets its plugin menus (M7-06a): from the kernel slots `botling.chat` owns (plugins/chat/index.ts), not from
// `PluginsView.menus`. `chatPlugins(view)` is the view the old chat frame builds its payload from (chat-frame/ChatFrame.tsx → payload.ts):
// the four chat menus (`message/context`, `message/preview`, `chat/link`, `composer/plus`) are the rows the slots hold; every other
// menu and the rest of the view are as they were. The rows are the feed's (shell/plugin-feed.ts), made from the very view the page
// received, so the lists equal today's. Three rules:
//   - a row counts only when the slot holds it AND the view still has it (the feed catches up a moment after a new view: a row the
//     view dropped is never shown stale, and one the slot lacks is never shown early). The `chat/link` rule of a peer's bot
//     (main-v3/peer-link-menu.ts) is applied to the view before it gets here, so it holds through the slot unchanged;
//   - the order is the view's array order (a plugin the feed reloaded sits last in the slot, which would shuffle the menu);
//   - the owner away: the shell's host refused it, it failed to load or was unloaded → none of the four menus (fail closed, the chat
//     itself still works); a host that never touched it (a component test, a page drawn without a shell) → the view as it is.
import { useSyncExternalStore } from "react";
import type { Kernel } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../contract";
import { CHAT_MENUS, CHAT_PLUGIN } from "./chat-names";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
import { inPageHost, type InPageHost } from "./shell/inpage-host";
import type { FeedEntry } from "./shell/plugin-feed";

type Menus = NonNullable<PluginsView["menus"]>;
const OWNED = new Set<string>(CHAT_MENUS);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The chat menus' rows the slots hold now (a feed row of any plugin), as `PluginsView.menus` rows. */
function slotRows(kernel: Kernel): Menus {
  const rows: Menus = [];
  for (const menu of CHAT_MENUS) {
    for (const { entry } of kernel.entries<Partial<FeedEntry<Menus[number]>>>(menu)) {
      if (entry.kind === "feed" && entry.row && entry.row.menu === menu) rows.push(entry.row);
    }
  }
  return rows;
}

export function chatPlugins(view: PluginsView | null | undefined, kernel: Kernel = rendererKernel, host: Pick<InPageHost, "unavailable"> = inPageHost): PluginsView | null | undefined {
  if (!view) return view;
  const up = kernel.state(CHAT_PLUGIN) === "active";
  if (!up && !host.unavailable(CHAT_PLUGIN)) return view;
  const held = up ? slotRows(kernel) : [];
  const menus = (view.menus ?? []).filter((row) => !OWNED.has(row.menu) || held.some((one) => same(one, row)));
  return menus.length === (view.menus ?? []).length ? view : { ...view, menus };
}

/** The version of the slots, to draw again when one changes (a useSyncExternalStore snapshot of the kernel's slots). */
export function useChatSlotsVersion(): number {
  return useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
}
