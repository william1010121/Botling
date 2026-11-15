// The names the shell and the browser-pane plugin (plugins/browser-pane/index.ts) agree on (M7-06c). Pure: the shell reads them without
// importing the plugin's module (that one runs only through the trusted loader).

export const BROWSER_PANE_PLUGIN = "botling.browser-pane";

/** The menu of plugins' buttons in the browser pane's toolbar, by its name (2.x id `menu/browser/tab`; the name has not changed, slot-names.ts). */
export const BROWSER_TAB_MENU = "browser/tab";

/** Every slot `botling.browser-pane` provides. */
export const BROWSER_PANE_SLOTS: readonly string[] = [BROWSER_TAB_MENU];
