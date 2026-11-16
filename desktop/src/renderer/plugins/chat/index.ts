// `botling.chat`, the second in-page built-in plugin (M7-06a; plugin-kernel design §23 step 6, D56). Loaded by the shell's trusted loader
// (shell/inpage-loader.ts) only because the FE build shipped this folder: its name and the hash of the whole folder are in
// fe-build-manifest.json. It owns the chat's places:
//   - the menus `message/context`, `message/preview`, `chat/link` and `composer/plus` (2.x `menu/<name>`): plugins' entries land
//     here as registrations of those plugins (the feed's `{kind: "feed", row}`, shell/plugin-feed.ts). The plugin has no entries of
//     its own in them yet.
//   - the views `composer/bar` and `chat/header` (2.x `view/composerBar`, `view/chatHeader`).
//   - the view `main/tab` (2.x `view/mainTab`, M7-07a): the tabs beside Chat and Storage in the chat header's switch; a plugin's `mainTab` view
//     lands here as the feed's row, and the switch offers the rows the slot holds (chat-slot.ts `chatMainTabs`).
// It also contributes the chat column itself to the shell's root slot `app/main` (M7-07a): one `{kind: "region", region: "main"}` claim (it
// declares `contributes.slots`); the shell draws the column (App's chat header, switch, tab or Storage page and the chat frame) where its page
// has the slot (shell/regions.tsx). Which tab each bot showed last stays in settings.json (`mainTabs`), the core's, not the plugin's.
// The old chat frame still draws the menus; their lists are read from these slots (chat-slot.ts), not from `PluginsView.menus`. The header's
// plugin buttons and the composer bar's view are drawn from `chat/header` and `composer/bar` too (M7-06b: ChatHeaderViews.tsx, ComposerBar.ts).
import type { PluginDeclaration } from "../../../../../Web/src/plugin-kernel";
import { isInPageApi } from "../../shell/inpage-host";
import { REGION_SLOTS, type RegionEntry } from "../../shell/regions";
import { CHAT_PLUGIN, CHAT_SLOTS } from "../../chat-names";

export const chatDeclaration: PluginDeclaration = { name: CHAT_PLUGIN, provides: { slots: [...CHAT_SLOTS] }, contributes: { slots: [REGION_SLOTS.main] } };

export function activate(api: unknown): Promise<() => void> {
  if (!isInPageApi(api)) return Promise.reject(new Error("no in-page api"));
  return api.define(chatDeclaration, (kernel, plugin) => {
    for (const slot of CHAT_SLOTS) kernel.provideSlot(plugin, slot);
    // The column is the shell's slot (`:shell` owns `app/main`): in a kernel where nobody owns it (a test's own) there is nothing to claim, and it is not a failed load.
    if (kernel.slotOwner(REGION_SLOTS.main)) kernel.contribute(plugin, REGION_SLOTS.main, { kind: "region", region: "main" } satisfies RegionEntry);
  });
}
