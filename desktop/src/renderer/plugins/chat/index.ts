// `botling.chat`, the second in-page built-in plugin (M7-06a; plugin-kernel design §23 step 6, D56). Loaded by the shell's trusted loader
// (shell/inpage-loader.ts) only because the FE build shipped this folder: its name and the hash of the whole folder are in
// fe-build-manifest.json. It owns the chat's places:
//   - the menus `message/context`, `message/preview`, `chat/link` and `composer/plus` (2.x `menu/<name>`): plugins' entries land
//     here as registrations of those plugins (the feed's `{kind: "feed", row}`, shell/plugin-feed.ts). The plugin has no entries of
//     its own in them yet.
//   - the views `composer/bar` and `chat/header` (2.x `view/composerBar`, `view/chatHeader`).
// The old chat frame still draws them; its menu lists are read from these slots (chat-slot.ts), not from `PluginsView.menus`.
import type { PluginDeclaration } from "../../../../../Web/src/plugin-kernel";
import { isInPageApi } from "../../shell/inpage-host";
import { CHAT_PLUGIN, CHAT_SLOTS } from "../../chat-names";

export const chatDeclaration: PluginDeclaration = { name: CHAT_PLUGIN, provides: { slots: [...CHAT_SLOTS] } };

export function activate(api: unknown): Promise<() => void> {
  if (!isInPageApi(api)) return Promise.reject(new Error("no in-page api"));
  return api.define(chatDeclaration, (kernel, plugin) => {
    for (const slot of CHAT_SLOTS) kernel.provideSlot(plugin, slot);
  });
}
