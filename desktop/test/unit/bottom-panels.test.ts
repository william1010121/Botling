// The Terminal's key was an app shortcut ("toggleTerminal") and is the botling.terminal plugin's toggle command now: a key the user chose
// moves to the command once, on start; the page knows which command shows a bottom panel; a plugin's push to its frames changes no view.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moveShortcutsToPlugins, readSettings, writeSettings } from "../../src/core/settings";
import { bottomPanelToggledBy } from "../../src/renderer/BottomPanels";
import { apply } from "../../src/renderer/store";
import type { PluginsView } from "../../src/contract";
import { tempDir } from "../helpers";

const moved = (raw: Record<string, unknown>) => {
  const file = join(tempDir("moved-shortcuts"), "settings.json");
  writeSettings(file, raw);
  moveShortcutsToPlugins(file);
  return readSettings(file);
};

describe("the Terminal's key", () => {
  it("moves from toggleTerminal to the plugin's command, once, and leaves the other keys alone", () => {
    expect(moved({ languageChoice: "en", shortcutBindings: { toggleTerminal: "Mod+T", search: "Mod+L" } }))
      .toEqual({ languageChoice: "en", shortcutBindings: { "botling.terminal.toggle": "Mod+T", search: "Mod+L" } });
  });
  it("lets a key already chosen for the command win, drops a bad one and does nothing when there is nothing to move", () => {
    expect(moved({ shortcutBindings: { toggleTerminal: "Mod+T", "botling.terminal.toggle": "Mod+Alt+J" } })).toEqual({ shortcutBindings: { "botling.terminal.toggle": "Mod+Alt+J" } });
    expect(moved({ shortcutBindings: { toggleTerminal: 42 } })).toEqual({ shortcutBindings: {} });
    const same = { languageChoice: "en", shortcutBindings: { search: "Mod+L" } };
    expect(moved(same)).toEqual(same);
    expect(moved({ languageChoice: "en" })).toEqual({ languageChoice: "en" });
  });
});

describe("bottom panels on the app page", () => {
  const plugins = { bottomPanels: [{ plugin: "botling.terminal", id: "botling.terminal.panel", title: "Terminal", toggle: "botling.terminal.toggle" }, { plugin: "x", id: "x.p", title: "X" }] } as unknown as PluginsView;
  it("finds the panel a command toggles; none for another command, a panel without one or no plugins view", () => {
    expect(bottomPanelToggledBy(plugins, "botling.terminal.toggle")?.id).toBe("botling.terminal.panel");
    expect(bottomPanelToggledBy(plugins, "x.toggle")).toBeNull();
    expect(bottomPanelToggledBy(plugins, "")).toBeNull();
    expect(bottomPanelToggledBy(null, "botling.terminal.toggle")).toBeNull();
  });
  it("a plugin's push to its frames changes nothing in the view", () => {
    const view = { ready: true } as never;
    expect(apply(view, { type: "plugins.emit", plugin: "botling.terminal", name: "terminal", forBot: "B1", data: { type: "data" } } as never)).toBe(view);
  });
});
