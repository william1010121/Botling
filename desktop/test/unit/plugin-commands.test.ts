// Plugin commands on keys, in the / menu and in the app's menus (plugin-platform.md §3.3, steps M4 and M6):
// one list from the contribution registry, so the shortcut dispatcher, the Settings page, the / menu and
// the menus all read the same thing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, type FolderView } from "../../src/core/plugins/manifest";
import { commandSurfaces } from "../../src/core/plugins/commands";
import { PluginsView } from "../../src/contract";

const none: FolderView = { exists: () => false, read: () => null, list: () => [] };
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "plugin-manifests", `${name}.json`), "utf8"));
const contributions = (manifest: unknown) => readManifest(manifest, none).contributions;

describe("command surfaces from the contribution registry", () => {
  it("an old command's key is a plugin keybinding, titled from the command", () => {
    expect(commandSurfaces(contributions(fixture("ccb-latex")))).toEqual({
      keybindings: [{ command: "ccb-latex.insert", key: "Mod+Shift+M", plugin: "ccb-latex", title: "Insert inline formula" }],
      slash: [], menus: [],
    });
  });

  it("reads keybindings, slash commands and menus of a v3 manifest", () => {
    const manifest = { name: "todo-panel", version: "1.0.0", engines: { botling: "^3.0.0" }, botling: { main: "main.js", contributes: {
      commands: [{ id: "todo-panel.open", title: "Open TODO panel" }, { id: "todo-panel.add", title: "Add a TODO" }],
      keybindings: [{ command: "todo-panel.open", key: "Mod+Alt+T" }],
      slash: [{ name: "todo", about: "Open the TODO panel", command: "todo-panel.open" }],
      menus: { "bot/context": [{ command: "todo-panel.add" }], "message/context": [{ command: "todo-panel.add" }] },
    } } };
    const surfaces = commandSurfaces(contributions(manifest));
    expect(surfaces).toEqual({
      keybindings: [{ command: "todo-panel.open", key: "Mod+Alt+T", plugin: "todo-panel", title: "Open TODO panel" }],
      slash: [{ name: "todo", about: "Open the TODO panel", command: "todo-panel.open", plugin: "todo-panel" }],
      menus: [{ menu: "bot/context", command: "todo-panel.add", plugin: "todo-panel", title: "Add a TODO" },
        { menu: "message/context", command: "todo-panel.add", plugin: "todo-panel", title: "Add a TODO" }],
    });
    expect(PluginsView.safeParse({ plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null, ...surfaces }).success).toBe(true);
  });

  it("a plugin puts only its own commands on keys, slash and menus, with usable keys and slash names", () => {
    const manifest = { name: "sly", version: "1.0.0", botling: { contributes: {
      commands: [{ id: "sly.run", title: "Run" }],
      keybindings: [{ command: "other.run", key: "Mod+Alt+O" }, { command: "sly.run", key: "shift+x" }, { command: "sly.run", key: "Mod+Alt+S" }],
      slash: [{ name: "steal", about: "x", command: "other.run" }, { name: "two words", about: "x", command: "sly.run" }, { name: "sly", about: "Run it", command: "sly.run" }],
      menus: { "commandPalette": [{ command: "other.run" }, { command: "sly.run" }] },
    } } };
    expect(commandSurfaces(contributions(manifest))).toEqual({
      keybindings: [{ command: "sly.run", key: "Mod+Alt+S", plugin: "sly", title: "Run" }],
      slash: [{ name: "sly", about: "Run it", command: "sly.run", plugin: "sly" }],
      menus: [{ menu: "commandPalette", command: "sly.run", plugin: "sly", title: "Run" }],
    });
  });
});
