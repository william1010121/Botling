// The kernel's slot names (M7-02a; plugin-kernel design §19, D57): the new names, and the 2.x names that stay as aliases.
//
// Pure, and the only table: the main process's contribution list (desktop/src/core/plugins/kernel-list.ts) and the renderer's
// kernel (desktop/src/renderer/renderer-kernel.ts) both read it. A slot and its alias are one slot: the kernel passes every slot
// name through `canonicalSlot` (the `slotName` option of Kernel), so a registration is held once, under the 2.x id, and found
// under either name. A name this table does not know is its own (the 2.x kinds without a new name: `hook/*`, `command`, …).
//
// The 2.x id of a slot is what kernel-list.ts has always used: `view/<where>`, `menu/<menu>`, `statusItem/<where>`.

/** The three groups of 2.x slots that have new names (contributions.ts: VIEW_SLOTS, MENU_SLOTS, STATUS_SLOTS). */
export type SlotGroup = "view" | "menu" | "statusItem";

export interface SlotAlias {
  group: SlotGroup;
  /** The 2.x name: the place (`mainTab`), the menu (`chat/link`) or the status place (`botRow`). */
  legacy: string;
  /** The new name. */
  name: string;
}

/**
 * Every 2.x view place, menu and status place and the name it has now. Menus keep their names except `commandPalette`
 * (Q-M7-C9); `statusItem` places get names of their own (`chat/status`, `bot/row`) because `chat/header` is the header's view slot.
 */
export const SLOT_ALIASES: readonly SlotAlias[] = [
  { group: "view", legacy: "rightPanel", name: "panel/main" },
  { group: "view", legacy: "main", name: "app/main" },
  { group: "view", legacy: "window", name: "app/overlay" },
  { group: "view", legacy: "mainTab", name: "main/tab" },
  { group: "view", legacy: "settings.section", name: "settings/section" },
  { group: "view", legacy: "quickSettings", name: "settings/quick" },
  { group: "view", legacy: "rightPanel.section", name: "panel/section" },
  { group: "view", legacy: "bottomPanel", name: "app/bottom" },
  { group: "view", legacy: "chatHeader", name: "chat/header" },
  { group: "view", legacy: "rightPanel.takeover", name: "panel/takeover" },
  { group: "view", legacy: "composerBar", name: "composer/bar" },
  { group: "menu", legacy: "message/context", name: "message/context" },
  { group: "menu", legacy: "bot/context", name: "bot/context" },
  { group: "menu", legacy: "composer/plus", name: "composer/plus" },
  { group: "menu", legacy: "commandPalette", name: "app/palette" },
  { group: "menu", legacy: "message/preview", name: "message/preview" },
  { group: "menu", legacy: "browser/tab", name: "browser/tab" },
  { group: "menu", legacy: "chat/link", name: "chat/link" },
  { group: "statusItem", legacy: "chatHeader", name: "chat/status" },
  { group: "statusItem", legacy: "botRow", name: "bot/row" },
];

/**
 * The shell's root slots, in layout order: the rail, the main area, the side (right) column, the bottom area and the overlay
 * layer. `app/rail` and `app/side` are new; the other three are the 2.x `main`, `bottomPanel` and `window` view places.
 */
export const ROOT_SLOTS = ["app/rail", "app/main", "app/side", "app/bottom", "app/overlay"] as const;
export type RootSlot = (typeof ROOT_SLOTS)[number];

/** The 2.x id of an alias: the slot's id in the main process's kernel (`view/mainTab`). */
export const legacySlotId = (alias: SlotAlias): string => `${alias.group}/${alias.legacy}`;

const byName = new Map(SLOT_ALIASES.map((alias) => [alias.name, alias]));
const byLegacy = new Map(SLOT_ALIASES.map((alias) => [legacySlotId(alias), alias]));

/** The one name a slot is held under: the 2.x id when the slot has one, else the name itself. Names the table does not know are their own. */
export function canonicalSlot(slot: string): string {
  const alias = byName.get(slot);
  return alias ? legacySlotId(alias) : slot;
}

/** The new name of a slot given by either name (the name itself for a slot with no new name, or a new-only one like `app/rail`). */
export function slotName(slot: string): string {
  const alias = byLegacy.get(slot);
  return alias ? alias.name : slot;
}

/** Both names of a slot (the 2.x id first; one name when there is only one). */
export function slotForms(slot: string): string[] {
  const canonical = canonicalSlot(slot);
  const name = slotName(canonical);
  return name === canonical ? [canonical] : [canonical, name];
}
