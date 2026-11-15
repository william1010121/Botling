// The slots the renderer's plugin feed fills (M7-02b; plugin-feed.ts) and the PluginsView array each view place is read from.
// Pure: renderer-kernel.ts reads `FEED_SLOTS` (the `:shell` instance owns them, so a plugin's contribution to one is accepted),
// plugin-feed.ts reads the rest. Every slot is given by its 2.x id; the kernel finds it under the new name too (slot-names.ts).
import { SLOT_ALIASES, ROOT_SLOTS, canonicalSlot, legacySlotId } from "../../../../Web/src/plugin-kernel";

/** The PluginsView arrays that hold view entries, and the view place each one is. */
export const FEED_VIEWS = [
  ["mainTabs", "view/mainTab"],
  ["settingsSections", "view/settings.section"],
  ["quickSettings", "view/quickSettings"],
  ["rightPanelSections", "view/rightPanel.section"],
  ["takeovers", "view/rightPanel.takeover"],
  ["bottomPanels", "view/bottomPanel"],
  ["chatHeaderViews", "view/chatHeader"],
  ["composerBarViews", "view/composerBar"],
] as const;
export type FeedViewKey = (typeof FEED_VIEWS)[number][0];

/** Every menu slot (`PluginsView.menus` rows go to `menu/<menu>`), by 2.x id. */
export const FEED_MENU_SLOTS: readonly string[] = SLOT_ALIASES.filter((alias) => alias.group === "menu").map(legacySlotId);

const ROOT_IDS = new Set(ROOT_SLOTS.map(canonicalSlot));
/** The places a built-in plugin owns now, so `:shell` does not, by 2.x id, one block per plugin. */
export const PLUGIN_OWNED_SLOTS: readonly string[] = [
  // botling.settings (M7-02c): settings/section, settings/quick
  "view/settings.section",
  "view/quickSettings",

  // botling.sidebar (M7-05a): bot/row, not in FEED_SLOTS: no feed rows go there yet
  "statusItem/botRow",
  // botling.sidebar (M7-05b): bot/context, the bot row's menu
  "menu/bot/context",

  // botling.chat (M7-06a): message/context, message/preview, chat/link, composer/plus, composer/bar, chat/header
  "menu/message/context",
  "menu/message/preview",
  "menu/chat/link",
  "menu/composer/plus",
  "view/composerBar",
  "view/chatHeader",

  // botling.bot-panel (M7-03a): panel/main, panel/section, panel/takeover
  "view/rightPanel",
  "view/rightPanel.section",
  "view/rightPanel.takeover",

  // botling.bot-panel (M7-03b): panel/tile/board, panel/tile/whiteboard, panel/tile/pin
  "tile/board",
  "tile/whiteboard",
  "tile/pin",
];
const OWNED_ELSEWHERE = new Set(PLUGIN_OWNED_SLOTS.map(canonicalSlot));

/**
 * What `:shell` owns besides the root slots (renderer-kernel.ts): the places the feed fills that are not a root slot already
 * (`view/bottomPanel` is `app/bottom`, a root slot: it is not listed twice). A card that gives one of these a real owner (the
 * settings plugin for `view/settings.section`, …) takes it off this list in the same change, by listing it in `PLUGIN_OWNED_SLOTS`.
 */
export const FEED_SLOTS: readonly string[] = [...new Set([...FEED_VIEWS.map(([, slot]) => slot), ...FEED_MENU_SLOTS])].filter((slot) => !ROOT_IDS.has(slot) && !OWNED_ELSEWHERE.has(slot));
