// First-party plugins (plugin-platform.md §3.4, step M11): desktop/builtin-plugins/ is built into
// out/builtin-plugins/ and shipped beside app.asar. The registry reads them before the library, as 1.x's
// `builtIns` root: listed first, on until you turn them off, never pending, and a library plugin of the same
// name replaces one. ccb-latex goes through the ordinary web-part path, botling.cards brings the web preview
// card, botling.design keeps /design in the / menu as words, and botling.chat-extras brings image groups, the
// fold of a long message and paste chips to the chat page.
import { beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { checkPlugin } from "../../src/core/plugins/manifest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { commandSurfaces } from "../../src/core/plugins/commands";
import { prepareLibrary } from "../../src/core/maintainer";
import { moveSettingsToPlugins, readSettings, writeSettings } from "../../src/core/settings";
import { pluginGuide } from "../../src/core/maintainer-text";
import { ComponentLibrary } from "../../src/core/components/library";
import { OLDER_PREVIEW_TEMPLATES, PREVIEW_ABOUT, PREVIEW_TEMPLATE } from "../../src/core/components/builtins";
import { keybindingsOf, runsInHost, slashMenu } from "../../src/renderer/plugin-commands";
import type { PluginsView } from "../../src/contract";

let built = "";
beforeAll(async () => {
  const { buildBuiltinPlugins } = await import(join(desktop, "build-builtin-plugins.mjs"));
  built = await buildBuiltinPlugins({ outdir: join(tempDir("builtin-build"), "builtin-plugins") });
}, 60_000);

const registry = (library: string, builtIns: string | null = built) => new PluginRegistry(library, join(library, "..", "plugins.json"), new MemorySecretStore(), builtIns);
const card = (root: string) => join(root, "plugins", "ccb-components", "components", "網頁預覽卡片");

describe("the built-in plugins as shipped", () => {
  it("are ccb-latex, botling.cards, botling.catchup, botling.chat-extras, botling.design and botling.whiteboard, each passing the plugin check without its sources", () => {
    expect(readdirSync(built).sort()).toEqual(["botling.cards", "botling.catchup", "botling.chat-extras", "botling.design", "botling.whiteboard", "ccb-latex"]);
    for (const name of readdirSync(built)) {
      expect(checkPlugin(join(built, name)), name).toEqual([]);
      for (const left of ["src", "test", "build.json"]) expect(existsSync(join(built, name, left)), `${name}/${left}`).toBe(false);
    }
    expect(existsSync(join(built, "ccb-latex", "dist", "web.js"))).toBe(true);
    for (const part of ["dist/host.mjs", "dist/web.js", "catchup.css"]) expect(existsSync(join(built, "botling.catchup", part)), part).toBe(true);
    expect(readdirSync(join(built, "ccb-latex", "dist", "fonts")).some((font) => font.endsWith(".woff2"))).toBe(true);
  });

  it("bring the web preview card the app seeded into the library until now, unchanged", () => {
    const folder = join(built, "botling.cards", "components", "網頁預覽卡片");
    expect(readFileSync(join(folder, "template.html"), "utf8")).toBe(PREVIEW_TEMPLATE);
    expect(readFileSync(join(folder, "about.md"), "utf8")).toBe(PREVIEW_ABOUT);
  });
});

describe("the registry with built-in plugins", () => {
  it("lists them first and on, marked built in; off stays off; a library plugin of the same name replaces one", () => {
    const dir = tempDir("builtin-registry");
    const library = join(dir, "plugins");
    mkdirSync(join(library, "aaa", "dist"), { recursive: true });
    writeFileSync(join(library, "aaa", "package.json"), JSON.stringify({ name: "aaa", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js" } }));
    writeFileSync(join(library, "aaa", "dist", "web.js"), "export function activate() {}");
    const plugins = registry(library);
    expect(plugins.plugins.map((plugin) => [plugin.manifest.name, plugin.builtIn, plugin.enabled])).toEqual([
      ["botling.cards", true, true], ["botling.catchup", true, true], ["botling.chat-extras", true, true], ["botling.design", true, true], ["botling.whiteboard", true, true], ["ccb-latex", true, true], ["aaa", false, true],
    ]);
    expect(plugins.problems).toEqual({});
    plugins.setEnabled("ccb-latex", false);
    expect(plugins.webSpecs().map((spec) => spec.name)).toEqual(["botling.catchup", "botling.chat-extras", "botling.whiteboard", "aaa"]);
    expect(registry(library).plugin("ccb-latex")!.enabled).toBe(false);
    plugins.setEnabled("ccb-latex", true);
    // Maintainer copies a built-in plugin into the library to change it: that copy is the one that runs.
    cpSync(join(built, "ccb-latex"), join(library, "ccb-latex"), { recursive: true });
    const replaced = registry(library);
    expect(replaced.plugin("ccb-latex")).toMatchObject({ builtIn: false, folder: join(library, "ccb-latex") });
    expect(replaced.plugins.filter((plugin) => plugin.manifest.name === "ccb-latex")).toHaveLength(1);
  });

  it("runs botling.chat-extras' web part with its stylesheet, and the paste limits settings.json had", () => {
    const dir = tempDir("builtin-chat-extras");
    const plugins = registry(join(dir, "plugins"));
    const extras = () => registry(join(dir, "plugins")).webSpecs().find((spec) => spec.name === "botling.chat-extras")!;
    expect(extras()).toMatchObject({ styles: ["dist/chat-extras.css"], settings: { "botling.chat-extras.pasteCollapseChars": 1000, "botling.chat-extras.pasteCollapseLines": 15 } });
    expect(extras().source).toContain("activate");
    expect(plugins.webFile("botling.chat-extras", "dist/chat-extras.css")?.type).toBe("text/css; charset=utf-8");
    expect(readFileSync(join(built, "botling.chat-extras", "dist", "chat-extras.css"), "utf8")).toContain(".image-gallery");
    const file = join(dir, "settings.json");
    writeSettings(file, { pasteCollapseChars: 0, pasteCollapseLines: 40 });
    moveSettingsToPlugins(file, (plugin, key, value) => plugins.set(plugin, key, value));
    expect(extras().settings).toEqual({ "botling.chat-extras.pasteCollapseChars": 0, "botling.chat-extras.pasteCollapseLines": 40 });
    expect(readSettings(file)).toEqual({});
  });

  it("runs ccb-latex's web part in the chat page by the library's path: its stylesheet, the fonts beside it, its Mod+Shift+M", () => {
    const plugins = registry(join(tempDir("builtin-latex"), "plugins"));
    const latex = plugins.webSpecs().find((spec) => spec.name === "ccb-latex")!;
    expect(latex).toMatchObject({ styles: ["dist/katex.min.css"], settings: { "ccb-latex.preview": true, "ccb-latex.copyTeX": true }, commands: [{ id: "ccb-latex.insert", title: "Insert inline formula" }] });
    expect(latex.source).toContain("activate");
    expect(plugins.webFile("ccb-latex", "dist/katex.min.css")?.type).toBe("text/css; charset=utf-8");
    const font = readdirSync(join(built, "ccb-latex", "dist", "fonts"))[0]!;
    expect(plugins.webFile("ccb-latex", `dist/fonts/${font}`)?.type).toBe("font/woff2");
    expect(plugins.webFile("ccb-latex", "package.json")).toBeNull();
    expect(commandSurfaces(plugins.contributions()).keybindings).toEqual([{ command: "ccb-latex.insert", key: "Mod+Shift+M", plugin: "ccb-latex", title: "Insert inline formula" }]);
  });

  it("gives the component library botling.cards' folder after the library's own, so a copy there still wins", () => {
    const dir = tempDir("builtin-components");
    const plugins = registry(join(dir, "plugins"));
    expect(plugins.builtInComponentFolders()).toEqual([join(built, "botling.cards", "components")]);
    const own = join(dir, "plugins", "ccb-components", "components");
    const library = new ComponentLibrary(() => [own, ...plugins.builtInComponentFolders()]);
    expect(library.names).toEqual(["網頁預覽卡片"]);
    expect(library.template("網頁預覽卡片")).toBe(PREVIEW_TEMPLATE);
    mkdirSync(join(own, "網頁預覽卡片"), { recursive: true });
    writeFileSync(join(own, "網頁預覽卡片", "template.html"), "<p>Mine</p>");
    library.rescan();
    expect(library.template("網頁預覽卡片")).toBe("<p>Mine</p>");
    plugins.setEnabled("botling.cards", false);
    expect(plugins.builtInComponentFolders()).toEqual([]);
  });
});

describe("the plugin library without seeded cards", () => {
  it("no longer writes the preview card; a copy an app wrote and nobody edited goes, so the built-in one shows", () => {
    const dir = tempDir("builtin-seed");
    prepareLibrary(dir);
    expect(existsSync(card(dir))).toBe(false);
    for (const template of [PREVIEW_TEMPLATE, ...OLDER_PREVIEW_TEMPLATES]) {
      mkdirSync(card(dir), { recursive: true });
      writeFileSync(join(card(dir), "template.html"), template);
      writeFileSync(join(card(dir), "about.md"), PREVIEW_ABOUT);
      prepareLibrary(dir);
      expect(existsSync(card(dir))).toBe(false);
    }
  });

  it("keeps an edited copy byte for byte (its template or its usage), and anything else in its folder", () => {
    const dir = tempDir("builtin-seed-edited");
    const cases: [string, string][] = [
      [PREVIEW_TEMPLATE + "<!-- Maintainer -->", PREVIEW_ABOUT], [OLDER_PREVIEW_TEMPLATES[0]!, PREVIEW_ABOUT + "\nMore."], ["<p>My card</p>", "My own usage"],
    ];
    for (const [template, about] of cases) {
      mkdirSync(card(dir), { recursive: true });
      writeFileSync(join(card(dir), "template.html"), template);
      writeFileSync(join(card(dir), "about.md"), about);
      prepareLibrary(dir);
      expect(readFileSync(join(card(dir), "template.html"), "utf8")).toBe(template);
      expect(readFileSync(join(card(dir), "about.md"), "utf8")).toBe(about);
    }
    writeFileSync(join(card(dir), "template.html"), PREVIEW_TEMPLATE);
    writeFileSync(join(card(dir), "about.md"), PREVIEW_ABOUT);
    writeFileSync(join(card(dir), "template.prev.html"), "<p>Before</p>");
    prepareLibrary(dir);
    expect(readdirSync(card(dir))).toEqual(["template.prev.html"]);
  });

  it("tells Maintainer where the built-in plugins are (PLUGINS.md)", () => {
    const dir = tempDir("builtin-guide");
    prepareLibrary(dir, "sonnet", built);
    expect(readFileSync(join(dir, "plugins", "PLUGINS.md"), "utf8")).toBe(pluginGuide(built));
    prepareLibrary(dir);
    expect(readFileSync(join(dir, "plugins", "PLUGINS.md"), "utf8")).toBe(pluginGuide());
  });
});

describe("the / menu and keys with built-in plugins", () => {
  const view = (): PluginsView => {
    const plugins = registry(join(tempDir("builtin-menu"), "plugins"));
    return {
      plugins: plugins.plugins.map((plugin) => ({ name: plugin.manifest.name, title: plugin.manifest.name, version: "1.0.0", description: null, enabled: true, failure: null, installedFrom: null,
        permissions: [], parts: plugin.manifest.ccb?.web ? ["web"] : [], settings: [], panels: [], builtIn: plugin.builtIn,
        commands: (plugin.manifest.ccb?.contributes?.commands ?? []).map((command) => ({ id: command.id, title: command.title, registered: false })) })),
      broken: [], host: { running: true, problem: null }, secretsProblem: null, ...commandSurfaces(plugins.contributions()),
    };
  };

  it("has botling.design's /design, put in as words as before (no command runs)", () => {
    expect(slashMenu(view())).toEqual([{ name: "design", about: "Make a Claude Design and get its claude.ai link" }]);
  });

  it("keeps the built-in /design ahead of a library plugin's of the same name", () => {
    const plugins = view();
    plugins.plugins.push({ ...plugins.plugins[0]!, name: "aaa", builtIn: false });
    plugins.slash!.push({ name: "design", about: "Another", command: "aaa.design", plugin: "aaa" });
    expect(slashMenu(plugins)).toEqual([
      { name: "design", about: "Make a Claude Design and get its claude.ai link" },
      { name: "design (aaa)", about: "Another", command: "aaa.design" },
    ]);
  });

  it("binds ccb-latex's key from its manifest and runs it in the chat page, as when it was bundled", () => {
    const plugins = view();
    expect(keybindingsOf(plugins)).toEqual([{ command: "ccb-latex.insert", key: "Mod+Shift+M", plugin: "ccb-latex", title: "Insert inline formula" }]);
    expect(runsInHost(plugins, "ccb-latex.insert")).toBe(false);
  });

  it("without a plugins view (Botling Web runs no plugins) still offers /design and ccb-latex's key", () => {
    expect(slashMenu(null)).toEqual(slashMenu(view()));
    expect(keybindingsOf(null)).toEqual(keybindingsOf(view()));
    expect(runsInHost(null, "ccb-latex.insert")).toBe(false);
  });
});
