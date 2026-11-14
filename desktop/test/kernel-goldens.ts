// Golden records of the 2.x plugin platform's outputs (kernel step 1, brief §4 step 1). They were recorded on the code
// before the plugin kernel went under it, and every later step must leave them byte-identical: they guard what Botling 3
// depends on (botlingd runs the same Web/host; main-v3 reads the PluginsView contract) and what 2.7 plugins see.
//
// A golden changes only in a change that means to change that output: run the test with UPDATE_KERNEL_GOLDENS=1 and
// commit the new file with that change (never in a kernel refactor). Paths of temporary folders are written as <tmp>,
// the built-in plugins' folder as <builtins>, and a web part's source as <source of NAME> once it was checked to be
// the file on disk, so a built-in plugin's code change does not churn the goldens (its manifest change does).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktop } from "./helpers";

export const GOLDEN_DIR = join(desktop, "test", "fixtures", "kernel-goldens");

/** The text a golden holds: pretty JSON with a final newline. */
export const goldenText = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** The sha256 of a golden's text (the evidence file lists them before and after). */
export const goldenHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** `value` as golden `name`: the same bytes as the file, or the file is written when UPDATE_KERNEL_GOLDENS=1. Returns [expected, actual]. */
export function golden(name: string, value: unknown): [string, string] {
  const file = join(GOLDEN_DIR, `${name}.json`);
  const text = goldenText(value);
  if (process.env.UPDATE_KERNEL_GOLDENS === "1" || !existsSync(file)) {
    if (process.env.UPDATE_KERNEL_GOLDENS !== "1") throw new Error(`No golden ${name}.json: run with UPDATE_KERNEL_GOLDENS=1 to record it.`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return [readFileSync(file, "utf8"), text];
}

/** Replaces every occurrence of each path (longest first) in a JSON-able value's strings. */
export function normalized<T>(value: T, paths: Record<string, string>): T {
  const pairs = Object.entries(paths).filter(([path]) => path).sort((a, b) => b[0].length - a[0].length);
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return item;
    let text = item;
    for (const [path, name] of pairs) text = text.split(path).join(name);
    return text;
  })) as T;
}

/**
 * Two third-party plugins in a library folder, between them using every contribution kind of the 2.7 list: `acme-board`
 * in the old `ccb` shape (commands with keys, settings with a secret, panels, a component folder, a program part), and
 * `zed.tools` in the `botling` shape (every view slot, every menu, hooks, routines, reply tags, prompt sections, tiles,
 * cards, status items, slash, keybindings, and one entry this Botling skips). Both also carry the kernel fields
 * (`kernel`, `provides`, `requires`, `uses`), which a third-party manifest may have and which are ignored for it.
 */
export function writeFixturePlugins(library: string): void {
  const write = (folder: string, path: string, text: string) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  };
  const acme = join(library, "acme-board");
  write(acme, "package.json", JSON.stringify({
    name: "acme-board", displayName: "Acme Board", version: "1.2.0", description: "A fixture in the old ccb shape.", engines: { ccb: "^2.0.0" },
    ccb: {
      permissions: ["composer"], web: "dist/web.js", host: "dist/host.mjs", styles: ["dist/acme.css"],
      kernel: 1, provides: { services: ["acme.lookup"] }, requires: { services: ["composer.insertQuote"] },
      contributes: {
        commands: [{ id: "acme-board.open", title: "Open the board", key: "cmd+shift+b" }, { id: "acme-board.refresh", title: "Refresh" }],
        settings: {
          "acme-board.columns": { type: "number", title: "Columns", default: 3 },
          "acme-board.mode": { type: "enum", title: "Mode", options: ["grid", "list"], default: "grid" },
          "acme-board.token": { type: "string", title: "Token", secret: true, env: "ACME_TOKEN" },
        },
        components: "components",
        panels: [{ id: "acme-board.panel", title: "Acme panel", icon: "square.grid.2x2" }],
      },
    },
  }, null, 2));
  write(acme, "dist/web.js", "export function activate(ccb) { ccb.panels?.register?.('acme-board.panel', () => {}); }\n");
  write(acme, "dist/host.mjs", "export function activate(api) { api.commands.register('acme-board.open', () => 1); }\n");
  write(acme, "dist/acme.css", ".acme { color: red; }\n");
  write(acme, "components/acme-card/template.html", "<div>{{title}}</div>\n");
  write(acme, "components/acme-card/about.md", "An acme card. Sizes: 2x1, 2x2.\n");

  const zed = join(library, "zed.tools");
  write(zed, "package.json", JSON.stringify({
    name: "zed.tools", displayName: "Zed Tools", version: "0.9.1", publisher: "zed", engines: { ccb: "^2.7.0", botling: "^2.7.0" },
    // 2.7 loads a plugin by its ccb field (web, host, permissions) and reads its contributions from botling when it has both.
    ccb: { web: "dist/ui.js", host: "dist/host.mjs", permissions: ["messages"] },
    botling: {
      main: "dist/host.mjs", ui: "dist/ui.js", chat: "dist/ui.js", capabilities: ["messages"], activation: "startup",
      kernel: 1, provides: { services: ["zed.search"], slots: ["zed/rail"] }, requires: { services: ["acme.lookup"] }, uses: { services: ["reader.at"] },
      contributes: {
        commands: [{ id: "zed.tools.run", title: "Run" }, { id: "zed.tools.toggle", title: "Toggle panel" }, { id: "zed.tools.clip", title: "Clip" }],
        keybindings: [{ command: "zed.tools.run", key: "cmd+alt+r" }],
        slash: [{ name: "zed", about: "Ask Zed", command: "zed.tools.run" }, { name: "zedwords", about: "Words only" }],
        views: [
          { id: "zed.tools.tab", title: "Zed", icon: "bolt", where: "mainTab", forRole: "marked", chat: "float" },
          { id: "zed.tools.settings", title: "Zed settings", where: "settings.section", terms: "zed tools", after: "engines", link: "Zed by bot" },
          { id: "zed.tools.quick", title: "Zed quick", where: "quickSettings" },
          { id: "zed.tools.section", title: "Zed section", where: "rightPanel.section", forRole: "bots" },
          { id: "zed.tools.bottom", title: "Zed bottom", where: "bottomPanel", toggle: "zed.tools.toggle" },
          { id: "zed.tools.header", title: "Zed header", where: "chatHeader" },
          { id: "zed.tools.takeover", title: "Zed takeover", where: "rightPanel.takeover" },
          { id: "zed.tools.bar", title: "Zed bar", where: "composerBar", forRole: "main", width: 300 },
          { id: "zed.tools.side", title: "Zed side", where: "rightPanel" },
          { id: "zed.tools.main", title: "Zed main", where: "main" },
          { id: "zed.tools.window", title: "Zed window", where: "window" },
          { id: "zed.tools.nowhere", title: "Skipped", where: "ceiling" },
        ],
        tiles: [{ id: "zed.tools.tile", title: "Zed tile", sizes: ["2x1", "4x2"], surfaces: ["board", "pin"] }],
        cards: [{ id: "zed.tools.card", title: "Zed card" }],
        statusItems: [{ id: "zed.tools.status", where: "botRow" }],
        settings: { "zed.tools.on": { type: "boolean", title: "On", default: true } },
        menus: {
          "message/context": [{ command: "zed.tools.clip", title: "Clip it", icon: "scissors", quick: true, alt: "Clip again", hint: "Keeps it", locales: { "zh-Hant": { title: "剪下", hint: "保留" } } }],
          "bot/context": { command: "zed.tools.run" },
          "composer/plus": [{ command: "zed.tools.run", title: "Zed" }],
          commandPalette: [{ command: "zed.tools.toggle" }],
          "message/preview": [{ command: "zed.tools.clip", quick: true, icon: "doc" }],
          "browser/tab": [{ command: "zed.tools.run", when: { scheme: "https", host: "*.example.org" } }],
          "chat/link": [{ command: "zed.tools.run", title: "Read with Zed", when: { ext: ["pdf", "md"] } }],
          "not/a-menu": [{ command: "zed.tools.run" }],
        },
        hooks: ["beforeSend", "afterReply", "toolCall"],
        routines: [{ id: "zed.tools.daily", cron: "0 9 * * *", command: "zed.tools.run" }],
        replyTags: [{ tag: "zed-status" }],
        promptSections: [{ id: "zed.tools.rules", text: "Use Zed for searches.", after: "results", roles: ["main", "bot"] }],
      },
    },
  }, null, 2));
  write(zed, "dist/host.mjs", "export function activate() {}\n");
  write(zed, "dist/ui.js", "export function activate() {}\n");
}
