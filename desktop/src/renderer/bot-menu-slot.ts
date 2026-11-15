// The bot menu's reading of `bot/context` as a hook (M7-05b; bot-menu-items.ts holds the rules). Like the column (SidebarRail.tsx
// `RailSlot`) and Settings, it has three states: the slot, "unavailable", and the page's own props when the host never touched the plugin.
import { useMemo, useSyncExternalStore } from "react";
import { readBotMenu, type BotMenuSource } from "./bot-menu-items";
import { rendererKernel, slotsVersion, subscribeSlots } from "./renderer-kernel";
import { inPageHost } from "./shell/inpage-host";
import { SIDEBAR_PLUGIN } from "./sidebar-names";

/** The menu's items now; read again whenever the kernel changes (a plugin's row comes or goes with its plugin). */
export function useBotMenuSource(): BotMenuSource {
  const version = useSyncExternalStore(subscribeSlots, slotsVersion, slotsVersion);
  const away = inPageHost.unavailable(SIDEBAR_PLUGIN);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => readBotMenu(rendererKernel, away), [version, away]);
}
