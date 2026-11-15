// The names the shell and the bot-panel plugin (plugins/bot-panel/index.ts) agree on (M7-03a). Pure: the shell reads them without
// importing the plugin's module (that one runs only through the trusted loader).

export const BOT_PANEL_PLUGIN = "botling.bot-panel";
/** The plugin's slots, by their new names (the kernel finds them under the 2.x ids `view/rightPanel`, `view/rightPanel.section`, `view/rightPanel.takeover` too). */
export const MAIN_SLOT = "panel/main";
export const SECTION_SLOT = "panel/section";
export const TAKEOVER_SLOT = "panel/takeover";

/** The right panel's overview blocks under the Now card, in the order the panel draws them (1.x's DetailPanel). */
export type PanelBlock = "waiting" | "results" | "settled";
export const PANEL_BLOCKS: readonly PanelBlock[] = ["waiting", "results", "settled"];

/** What the plugin registers in `panel/main` for one overview block. */
export interface PanelBlockEntry { kind: "panel-block"; block: PanelBlock }

/** The shell's line where the plugin's part of the panel would be, when the plugin is refused, failed or unloaded. */
export const PANEL_UNAVAILABLE = "The panel is unavailable.";
