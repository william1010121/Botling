// The names the shell and the sidebar plugin (plugins/sidebar/index.ts) agree on (M7-05a). Pure: the shell reads them without
// importing the plugin's module (that one runs only through the trusted loader).

export const SIDEBAR_PLUGIN = "botling.sidebar";
/** The shell's left column: the root slot the sidebar draws into (`:shell` owns it; the plugin contributes to it). */
export const RAIL_SLOT = "app/rail";
/** A bot row's status items: owned by the sidebar plugin (the 2.x status place `botRow`; the kernel finds it as `statusItem/botRow` too). */
export const BOT_ROW_SLOT = "bot/row";
/** The key the rail's layout is kept under in the plugin's shell-storage namespace (the namespace is the plugin's name). */
export const LAYOUT_STORAGE_KEY = "layout";
