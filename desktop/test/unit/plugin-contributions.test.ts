// Manifest v3 and contribution points (plugin-platform.md §3, step M3): `readManifest` reads the new
// `botling` field and the older `ccb` one into one list of contributions. The old manifests are copies
// of the real ones in the plugin library (test/fixtures/plugin-manifests/) and must read as they behave
// today; the new ones are the design's examples (a), (b) and (c).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers";
import { diskFolder, readManifest, type FolderView } from "../../src/core/plugins/manifest";
import { ofKind } from "../../src/core/plugins/contributions";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { ComponentLibrary } from "../../src/core/components/library";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "plugin-manifests", `${name}.json`), "utf8"));

/** A plugin folder held in memory: file paths (relative, "/"-separated) to their text. */
function memoryFolder(files: Record<string, string>): FolderView {
  const paths = Object.keys(files);
  return {
    exists: (path) => path in files || paths.some((file) => file.startsWith(path.replace(/\/+$/, "") + "/")),
    read: (path) => files[path] ?? null,
    list: (path) => {
      const prefix = path.replace(/\/+$/, "") + "/";
      return [...new Set(paths.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split("/")[0]!))].sort();
    },
  };
}
const empty = memoryFolder({});

function write(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

describe("old ccb manifests (the real plugin library)", () => {
  it("ccb-latex: the web part is both the chat extension and the UI bundle; its shortcut is a keybinding", () => {
    const read = readManifest(fixture("ccb-latex"), memoryFolder({ "dist/web.js": "", "dist/katex.min.css": "" }));
    expect(read).toMatchObject({
      format: "ccb", name: "ccb-latex", version: "1.0.0", displayName: "LaTeX", engine: "^2.0.0",
      chat: "dist/web.js", ui: "dist/web.js", styles: ["dist/katex.min.css"], capabilities: ["composer", "messages"], problems: [],
    });
    expect(read.main).toBeUndefined();
    expect(read.contributions).toEqual([
      { kind: "command", plugin: "ccb-latex", id: "ccb-latex.insert", title: "Insert inline formula" },
      { kind: "keybinding", plugin: "ccb-latex", command: "ccb-latex.insert", key: "cmd+shift+m" },
      { kind: "setting", plugin: "ccb-latex", key: "ccb-latex.preview", setting: { type: "boolean", default: true, title: "Preview formulas while typing" } },
      { kind: "setting", plugin: "ccb-latex", key: "ccb-latex.copyTeX", setting: { type: "boolean", default: true, title: "Copy formulas as TeX" } },
    ]);
  });

  it("ccb-laas: settings without the plugin's prefix are fine in an old manifest (they work today)", () => {
    const read = readManifest(fixture("ccb-laas"), empty);
    expect(read.problems).toEqual([]);
    expect(ofKind(read.contributions, "setting").map((setting) => setting.key)).toEqual(["laas.on", "laas.everywhere", "laas.cdlatex", "laas.svg"]);
  });

  it("ccb-components: every component folder is a card and a tile, with the sizes its about.md names", () => {
    const folder = memoryFolder({
      "components/choices/template.html": "<div></div>", "components/choices/about.md": "Multiple choice.",
      "components/cpu-load/template.html": "<div></div>", "components/cpu-load/about.md": "CPU load card.\nSizes: 2x2, 4x2\nIcon: cpu",
      "components/notes/readme.txt": "not a component: no template.html",
      "components/.git/template.html": "hidden",
    });
    const read = readManifest(fixture("ccb-components"), folder);
    expect(read.problems).toEqual([]);
    expect(read.contributions).toEqual([
      { kind: "card", plugin: "ccb-components", id: "ccb-components.choices", title: "choices", component: { name: "choices", dir: "components/choices" } },
      { kind: "tile", plugin: "ccb-components", id: "ccb-components.choices", title: "choices", sizes: ["2x2"], surfaces: ["board", "whiteboard", "pin"], component: { name: "choices", dir: "components/choices" } },
      { kind: "card", plugin: "ccb-components", id: "ccb-components.cpu-load", title: "cpu-load", component: { name: "cpu-load", dir: "components/cpu-load" } },
      { kind: "tile", plugin: "ccb-components", id: "ccb-components.cpu-load", title: "cpu-load", sizes: ["2x2", "4x2"], surfaces: ["board", "whiteboard", "pin"], component: { name: "cpu-load", dir: "components/cpu-load" } },
    ]);
  });

  it("finds the same components the component library does", () => {
    const root = tempDir("contrib");
    write(root, {
      "components/choices/template.html": "x", "components/網頁預覽卡片/template.html": "x", "components/web-preview/template.html": "x",
      "components/scripts/run.py": "not a component", "components/.hidden/template.html": "x",
    });
    const library = new ComponentLibrary(() => [join(root, "components")]);
    const cards = ofKind(readManifest(fixture("ccb-components"), diskFolder(root)).contributions, "card");
    expect(cards.map((card) => card.component?.name)).toEqual(library.names);
  });

  it("ccb-teams and ccb-core: the Claude part is an agent contribution with its agents, skills and MCP servers", () => {
    const teams = readManifest(fixture("ccb-teams"), memoryFolder({
      "claude/.claude-plugin/plugin.json": "{}", "claude/agents/research.md": "", "claude/agents/prototype.md": "", "claude/agents/notes.txt": "",
    }));
    expect(teams.capabilities).toEqual(["claude"]);
    expect(teams.contributions).toEqual([{
      kind: "agent", plugin: "ccb-teams", claude: "claude", mcp: null, skills: [],
      agents: [{ name: "prototype", file: "claude/agents/prototype.md" }, { name: "research", file: "claude/agents/research.md" }],
    }]);
    const core = readManifest(fixture("ccb-core"), memoryFolder({
      "claude/.claude-plugin/plugin.json": "{}", "claude/agents/component-editor.md": "",
      "claude/skills/tidy/SKILL.md": "", "claude/skills/draft/notes.md": "no SKILL.md", "claude/.mcp.json": "{}",
    }));
    expect(core.contributions).toEqual([{
      kind: "agent", plugin: "ccb-core", claude: "claude", mcp: "claude/.mcp.json",
      skills: [{ name: "tidy", dir: "claude/skills/tidy" }], agents: [{ name: "component-editor", file: "claude/agents/component-editor.md" }],
    }]);
  });

  it("ccb-web-extractors contributes nothing; a program part starts with the host, as today", () => {
    expect(readManifest(fixture("ccb-web-extractors"), empty)).toMatchObject({ format: "ccb", contributions: [], problems: [], capabilities: [] });
    expect(readManifest({ name: "p", version: "1.0.0", ccb: { host: "dist/host.mjs" } }, empty)).toMatchObject({ main: "dist/host.mjs", activation: "startup" });
  });

  it("old panels are views in the right panel", () => {
    const read = readManifest({ name: "p", version: "1.0.0", ccb: { web: "w.js", contributes: { panels: [{ id: "p.log", title: "Log", icon: "list" }] } } }, empty);
    expect(read.contributions).toEqual([{ kind: "view", plugin: "p", id: "p.log", title: "Log", icon: "list", where: "rightPanel" }]);
  });
});

describe("botling manifests", () => {
  it("(a) a whiteboard tile with a program part", () => {
    const read = readManifest({
      name: "disk-tile", version: "1.0.0", engines: { botling: "^3.0.0" },
      botling: { main: "main.js", ui: "ui.js", capabilities: ["exec"], contributes: { tiles: [{ id: "disk-tile.free", title: "Disk", sizes: ["1x1"], surfaces: ["whiteboard", "board"] }] } },
    }, empty);
    expect(read).toMatchObject({ format: "botling", engine: "^3.0.0", main: "main.js", ui: "ui.js", activation: "lazy", capabilities: ["exec"], problems: [] });
    expect(read.chat).toBeUndefined();
    expect(read.contributions).toEqual([{ kind: "tile", plugin: "disk-tile", id: "disk-tile.free", title: "Disk", sizes: ["1x1"], surfaces: ["whiteboard", "board"] }]);
  });

  it("(b) a command with a keybinding and a setting", () => {
    const read = readManifest({
      name: "standup-key", version: "1.0.0", engines: { botling: "^3.0.0" },
      botling: { main: "main.js", capabilities: ["bots"], contributes: {
        commands: [{ id: "standup-key.run", title: "Ask for today's standup" }],
        keybindings: [{ command: "standup-key.run", key: "Mod+Alt+U" }],
        settings: { "standup-key.bot": { type: "string", default: "", title: "Bot (empty: ask)" } },
      } },
    }, empty);
    expect(read.problems).toEqual([]);
    expect(read.contributions).toEqual([
      { kind: "command", plugin: "standup-key", id: "standup-key.run", title: "Ask for today's standup" },
      { kind: "keybinding", plugin: "standup-key", command: "standup-key.run", key: "Mod+Alt+U" },
      { kind: "setting", plugin: "standup-key", key: "standup-key.bot", setting: { type: "string", default: "", title: "Bot (empty: ask)" } },
    ]);
  });

  it("(c) a slash command that opens a view", () => {
    const read = readManifest({
      name: "todo-panel", version: "1.0.0", engines: { botling: "^3.0.0" },
      botling: { main: "main.js", ui: "ui.js", contributes: {
        commands: [{ id: "todo-panel.open", title: "Open TODO panel" }],
        slash: [{ name: "todo", about: "Open the TODO panel", command: "todo-panel.open" }],
        views: [{ id: "todo-panel.view", title: "TODO", where: "rightPanel" }],
      } },
    }, empty);
    expect(read.problems).toEqual([]);
    expect(ofKind(read.contributions, "slash")).toEqual([{ kind: "slash", plugin: "todo-panel", name: "todo", about: "Open the TODO panel", command: "todo-panel.open" }]);
    expect(ofKind(read.contributions, "view")).toEqual([{ kind: "view", plugin: "todo-panel", id: "todo-panel.view", title: "TODO", where: "rightPanel" }]);
  });

  it("a view can take the main area (the slot a Whiteboard summary page would use)", () => {
    const read = readManifest({ name: "board", version: "1.0.0", botling: { ui: "ui.js", contributes: { views: [{ id: "board.summary", title: "Whiteboard", where: "main" }, { id: "board.pop", title: "Pop", where: "window" }] } } }, empty);
    expect(read.problems).toEqual([]);
    expect(ofKind(read.contributions, "view").map((view) => view.where)).toEqual(["main", "window"]);
  });

  it("a view can be a tab in the chat header's main area, for the main bot, project bots or any (plan W2)", () => {
    const read = readManifest({ name: "board", version: "1.0.0", botling: { ui: "ui.js", contributes: { views: [
      { id: "board.wall", title: "Wall", where: "mainTab", forRole: "main", icon: "people" },
      { id: "board.git", title: "Git", where: "mainTab", forRole: "project" },
      { id: "board.any", title: "Any", where: "mainTab" },
      { id: "board.odd", title: "Odd", where: "mainTab", forRole: "everyone" },
      { id: "board.side", title: "Side", where: "rightPanel", forRole: "main" },
    ] } } }, empty);
    expect(ofKind(read.contributions, "view")).toEqual([
      { kind: "view", plugin: "board", id: "board.wall", title: "Wall", icon: "people", where: "mainTab", forRole: "main" },
      { kind: "view", plugin: "board", id: "board.git", title: "Git", where: "mainTab", forRole: "project" },
      { kind: "view", plugin: "board", id: "board.any", title: "Any", where: "mainTab", forRole: "any" },
    ]);
    expect(read.problems).toEqual([
      'View "board.odd": forRole "everyone" must be main, project, bots or any.',
      'View "board.side": forRole is only for where "mainTab" or "rightPanel.section".',
    ]);
  });

  it("a view can be a page of Settings (with the words its search finds it by, the core page it follows and the popover link that opens it) or a block in the gear popover", () => {
    const read = readManifest({ name: "meter", version: "1.0.0", botling: { ui: "ui.js", contributes: { views: [
      { id: "meter.page", title: "Meter", where: "settings.section", terms: "quota rings", after: "engines", link: "Meter by bot" },
      { id: "meter.plain", title: "Plain", where: "settings.section" },
      { id: "meter.rings", title: "Rings", where: "quickSettings" },
      { id: "meter.odd", title: "Odd", where: "quickSettings", terms: "nope" },
      { id: "meter.side", title: "Side", where: "rightPanel", after: "engines" },
    ] } } }, empty);
    expect(ofKind(read.contributions, "view")).toEqual([
      { kind: "view", plugin: "meter", id: "meter.page", title: "Meter", where: "settings.section", terms: "quota rings", after: "engines", link: "Meter by bot" },
      { kind: "view", plugin: "meter", id: "meter.plain", title: "Plain", where: "settings.section" },
      { kind: "view", plugin: "meter", id: "meter.rings", title: "Rings", where: "quickSettings" },
    ]);
    expect(read.problems).toEqual([
      'View "meter.odd": terms, after and link are only for where "settings.section".',
      'View "meter.side": terms, after and link are only for where "settings.section".',
    ]);
  });

  it("status items, menus, hooks, routines and agent folders", () => {
    const read = readManifest({ name: "up", version: "1.0.0", botling: { activation: "startup", contributes: {
      commands: [{ id: "up.report", title: "Report" }],
      statusItems: [{ id: "up.status", where: "chatHeader" }],
      menus: { "message/context": [{ command: "up.report" }], commandPalette: [{ command: "up.report" }] },
      hooks: ["beforeSend", "toolCall"],
      routines: [{ id: "up.daily", cron: "0 9 * * *", command: "up.report" }],
      skills: "skills/", agents: "agents", mcp: ".mcp.json",
    } } }, memoryFolder({ "skills/review/SKILL.md": "", "agents/helper.md": "", ".mcp.json": "{}" }));
    expect(read.problems).toEqual([]);
    expect(read.activation).toBe("startup");
    expect(read.contributions.slice(1)).toEqual([
      { kind: "statusItem", plugin: "up", id: "up.status", where: "chatHeader" },
      { kind: "menu", plugin: "up", menu: "message/context", command: "up.report" },
      { kind: "menu", plugin: "up", menu: "commandPalette", command: "up.report" },
      { kind: "hook", plugin: "up", hook: "beforeSend" },
      { kind: "hook", plugin: "up", hook: "toolCall" },
      { kind: "routine", plugin: "up", id: "up.daily", cron: "0 9 * * *", command: "up.report" },
      { kind: "agent", plugin: "up", claude: null, mcp: ".mcp.json", skills: [{ name: "review", dir: "skills/review" }], agents: [{ name: "helper", file: "agents/helper.md" }] },
    ]);
  });

  it("ids must start with the plugin's name; what is wrong is left out and said", () => {
    const read = readManifest({ name: "mine", version: "1.0.0", botling: { contributes: {
      commands: [{ id: "mine.ok", title: "OK" }, { id: "other.steal", title: "Steal" }, { id: "mine.ok", title: "Again" }, { title: "No id" }],
      views: [{ id: "mine.v", title: "V", where: "sidebar" }],
      tiles: [{ id: "mine.t", title: "T", sizes: ["9x9"] }],
      settings: { "on": { type: "boolean", title: "On" } },
      menus: { "toolbar": [{ command: "mine.ok" }] },
      hooks: ["onEverything"],
      skills: "../outside",
    } } }, empty);
    expect(read.contributions).toEqual([{ kind: "command", plugin: "mine", id: "mine.ok", title: "OK" }]);
    expect(read.problems).toEqual([
      'Command "other.steal" must start with "mine.".',
      'Command "mine.ok" is declared twice.',
      "contributes.commands.3 is missing id.",
      'View "mine.v": where "sidebar" must be rightPanel, main, window, mainTab, settings.section, quickSettings or rightPanel.section.',
      'Tile "mine.t": size "9x9" is not a Board size (for example 2x1).',
      'Setting "on" must start with "mine.".',
      'Menu "toolbar" is not one of message/context, bot/context, composer/plus, commandPalette.',
      'Hook "onEverything" must be beforeSend, afterReply or toolCall.',
      'contributes.skills "../outside" must be a relative path inside the plugin folder.',
    ]);
  });

  it("botling wins over ccb when a manifest has both", () => {
    const read = readManifest({ name: "both", version: "1.0.0", engines: { ccb: "^2.0.0", botling: "^3.0.0" },
      ccb: { web: "old.js", contributes: { commands: [{ id: "both.old", title: "Old" }] } },
      botling: { chat: "new.js", contributes: { commands: [{ id: "both.new", title: "New" }] } } }, empty);
    expect(read).toMatchObject({ format: "botling", engine: "^3.0.0", chat: "new.js", contributions: [{ kind: "command", plugin: "both", id: "both.new", title: "New" }] });
    expect(read.ui).toBeUndefined();
  });

  it("a manifest that is not one says so instead of throwing", () => {
    expect(readManifest("nope", empty).problems).toEqual(["package.json is not a JSON object."]);
    expect(readManifest({ name: "x", version: "1.0.0" }, empty)).toMatchObject({ format: null, contributions: [], problems: ["The botling field is missing."] });
    expect(readManifest({ name: "x", version: "1.0.0", botling: { contributes: { commands: "all" } } }, empty).problems).toEqual(["contributes.commands has the wrong type."]);
  });
});

describe("the registry's contributions", () => {
  it("lists what enabled plugins contribute, read from their folders", () => {
    const dir = tempDir("contrib");
    const library = join(dir, "plugins");
    write(join(library, "ccb-components"), { "package.json": JSON.stringify(fixture("ccb-components")), "components/choices/template.html": "x" });
    write(join(library, "ccb-teams"), { "package.json": JSON.stringify(fixture("ccb-teams")), "claude/.claude-plugin/plugin.json": "{}", "claude/agents/research.md": "" });
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore());
    expect(registry.contributions().map((c) => `${c.plugin}:${c.kind}`)).toEqual(["ccb-components:card", "ccb-components:tile", "ccb-teams:agent"]);
    registry.setEnabled("ccb-teams", false);
    expect(registry.contributions().map((c) => `${c.plugin}:${c.kind}`)).toEqual(["ccb-components:card", "ccb-components:tile"]);
  });
});
