// The in-page built-in plugins the shell draws a surface for (M7-08): the rail, the chat column, the right panel, Settings and the browser pane.
// A build that ships a page asks the loader for each of these names (inpage-host.ts), so one the build's manifest does not list is REFUSED and
// shown as unavailable (the shell's own line or the fallback screen in its place), not skipped: with an empty manifest the page is the shell
// alone, never the old column drawn "as it was". Names only (pure), so the shell reads them without importing a plugin's module. A new in-page
// plugin that owns a surface the shell draws itself adds its name here; test/unit/shell-alone.test.ts checks that every name has its folder.
import { BOT_PANEL_PLUGIN } from "../panel-names";
import { BROWSER_PANE_PLUGIN } from "../browser-names";
import { CHAT_PLUGIN } from "../chat-names";
import { SETTINGS_PLUGIN } from "../settings-names";
import { SIDEBAR_PLUGIN } from "../sidebar-names";

export const SHELL_PLUGINS: readonly string[] = [SIDEBAR_PLUGIN, CHAT_PLUGIN, BOT_PANEL_PLUGIN, SETTINGS_PLUGIN, BROWSER_PANE_PLUGIN];
