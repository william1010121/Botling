// `botling.sidebar`, the second in-page built-in plugin (M7-05a; plugin-kernel design §23 step 5, D56). Loaded by the shell's trusted loader
// (shell/inpage-loader.ts) only because the FE build shipped this folder: its name and the hash of the whole folder are in
// fe-build-manifest.json. It does three things:
//   - occupies `app/rail`: it contributes the left column (SidebarRail.tsx: the bots, their workers, the Idle group, the folded strip,
//     the footer) to the shell's root slot. The page draws the slot where the column always was; while this plugin is not loaded the
//     shell shows its "unavailable" line (or, with no shell, the column directly);
//   - owns `bot/context` (M7-05b; the bot row's menu, 2.x `menu/bot/context`): its own items (Pin, Restart bot, Remove) are its contributions
//     (bot-menu-items.ts), and a plugin's `bot/context` row is accepted while this plugin is up. The menu (Rail.tsx `BotMenu`) draws the slot:
//     the items it holds, the plugins' commands between them, each pressed through `plugins.command` as before;
//   - owns `bot/row` (the 2.x status place `botRow`; canonical id `statusItem/botRow`): a plugin's status item for a bot's row is accepted
//     while this plugin is up. Nothing draws them yet (the left column has never shown a plugin's status item).
// It also keeps the column's per-device layout (folded, pinned, Idle) in the shell's storage service under its own namespace
// (sidebar-layout.ts): it hands the store its storage handle while the rail is registered and takes it back with the rail.
import { createElement } from "react";
import type { PluginDeclaration } from "../../../../../Web/src/plugin-kernel";
import { SHELL_STORAGE } from "../../renderer-kernel";
import { isInPageApi } from "../../shell/inpage-host";
import type { SlotEntry } from "../../shell/KernelSlot";
import { shellStorage } from "../../shell/storage";
import { SidebarRail } from "../../SidebarRail";
import { railLayout } from "../../sidebar-layout";
import { BOT_CONTEXT_SLOT, BOT_ROW_SLOT, RAIL_SLOT, SIDEBAR_PLUGIN } from "../../sidebar-names";
import { BUILTIN_BOT_MENU } from "../../bot-menu-items";

export const sidebarDeclaration: PluginDeclaration = {
  name: SIDEBAR_PLUGIN,
  provides: { slots: [BOT_ROW_SLOT, BOT_CONTEXT_SLOT] },
  contributes: { slots: [RAIL_SLOT] },
  requires: { services: [SHELL_STORAGE] },
};

export function activate(api: unknown): Promise<() => void> {
  if (!isInPageApi(api)) return Promise.reject(new Error("no in-page api"));
  return api.define(sidebarDeclaration, (kernel, plugin) => {
    kernel.provideSlot(plugin, BOT_ROW_SLOT);
    kernel.provideSlot(plugin, BOT_CONTEXT_SLOT);
    // The menu's own items, in the order the menu always had them; a refusal fails the load (nothing half-registered stays).
    for (const item of BUILTIN_BOT_MENU) if (!kernel.contribute(plugin, BOT_CONTEXT_SLOT, item)) throw new Error(`the kernel refused the ${item.id} item`);
    // The plugin's own namespace: it can read and write nothing of another plugin's.
    const storage = shellStorage(plugin);
    const entry: SlotEntry = { kind: "component", render: () => createElement(SidebarRail) };
    // Taken back with the rail (the kernel's undo of the contribution): the layout store goes back to the old settings keys.
    if (!kernel.contribute(plugin, RAIL_SLOT, entry, () => railLayout.detach(storage))) throw new Error("the kernel refused the rail");
    railLayout.attach(storage);
  });
}
