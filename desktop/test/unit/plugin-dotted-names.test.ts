// Botling 3 follow-up of M5-15 F2: a plugin name with a dot is refused on its way in (the shared check, so every
// install path), the built-in `botling.*` plugins keep their names (decided by the folder they are loaded from,
// never by the name a manifest claims), and a dotted plugin that is already installed stays, with a warning.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { checkPlugin, checkPluginIssues, CHECK_NEXT_STEPS, incomingNameIssues, loadPlugin, presentNameWarning } from "../../src/core/plugins/manifest";
import { checkReport } from "../../src/core/plugins/check-report";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { readProposal } from "../../src/core/maintainer";
import { importPlugins } from "../../src/server/import/plugins";

/** A plugin folder `<root>/<folder>` whose manifest says `name` (the folder name and the claimed name may differ). */
function plugin(root: string, name: string, options: { folder?: string; version?: string } = {}): string {
  const folder = join(root, options.folder ?? name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: options.version ?? "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js" } }));
  writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
  return folder;
}

const DOTTED = 'name "my.plugin" may not contain a dot: a dot separates a plugin\'s name from its command names, so a command such as "my.plugin.go" could be taken for a command of another plugin.';
const RESERVED = (name: string) => `name "${name}" is reserved: "botling" and every name that starts with "botling." belong to the plugins that ship with Botling.`;

describe("the name rule for a plugin on its way in", () => {
  it("refuses a dot, with the exact words (for the wording review), and a next step", () => {
    const root = tempDir("dotted");
    const folder = plugin(root, "my.plugin");
    expect(checkPlugin(folder)).toEqual([DOTTED]);
    const [issue] = checkPluginIssues(folder);
    expect(issue.code).toBe("NAME_DOTTED");
    expect(issue.nextStep).toBe(CHECK_NEXT_STEPS.NAME_DOTTED);
    expect(checkReport(folder).stdout).toContain(`✗ ${DOTTED}\n`);
    expect(checkReport(folder).code).toBe(1);
    // a dot anywhere, not only in the middle
    for (const name of ["a.b", "a.", "a..b", "x1.y2.z3", "a-b.c_d"]) expect(checkPluginIssues(plugin(root, name)).map((i) => i.code), name).toEqual(["NAME_DOTTED"]);
  });

  it("refuses a third-party plugin named botling.evil, and botling itself, as reserved (not as a plain dot)", () => {
    const root = tempDir("reserved");
    expect(checkPlugin(plugin(root, "botling.evil"))).toEqual([RESERVED("botling.evil")]);
    expect(checkPlugin(plugin(root, "botling"))).toEqual([RESERVED("botling")]);
    expect(checkPluginIssues(plugin(root, "botling.board")).map((i) => i.code)).toEqual(["NAME_RESERVED"]);
    // `botling-tools` and `botlings` are different names and stay free
    expect(checkPlugin(plugin(root, "botling-tools"))).toEqual([]);
    expect(checkPlugin(plugin(root, "botlings"))).toEqual([]);
  });

  it("changes nothing else: every name the old rule accepts without a dot still passes, and the old refusals are unchanged", () => {
    const root = tempDir("same");
    const long = `a${"b".repeat(213)}`;
    for (const name of ["my_plugin", "9lives", "a-b", "a", "x_y-z9", long, "ccb-latex", "_"].filter((n) => /^[a-z0-9]/.test(n))) {
      expect(checkPlugin(plugin(root, name)), name).toEqual([]);
    }
    // Uppercase was never valid (NAME_INVALID) and still gives exactly that one problem, with the old words.
    expect(checkPlugin(plugin(root, "Upper"))).toEqual(['name "Upper" may only use lowercase letters, digits, - . _.']);
    expect(checkPluginIssues(plugin(root, "-lead")).map((i) => i.code)).toEqual(["NAME_INVALID"]);
  });

  it("escapes control characters and cuts a very long name in its words", () => {
    const words = incomingNameIssues(`a.b\nline two\u001b[31m${"x".repeat(300)}`)[0].message;
    expect(words).not.toMatch(/[\u0000-\u001f]/);
    expect(words.length).toBeLessThan(400);
  });

  it("is judged by the origin the caller names: a plugin read from the built-ins folder or already in the library keeps its dot, anything else is strict", () => {
    const root = tempDir("origin");
    const folder = plugin(root, "botling.board");
    expect(checkPluginIssues(folder, "builtIn")).toEqual([]);
    expect(checkPluginIssues(folder, "library")).toEqual([]);
    expect(checkPluginIssues(folder, "incoming").map((i) => i.code)).toEqual(["NAME_RESERVED"]);
    // no origin given: strict (a caller that forgets does not get the loose rule)
    expect(checkPluginIssues(folder).map((i) => i.code)).toEqual(["NAME_RESERVED"]);
    expect(loadPlugin(folder).ok).toBe(false);
    expect(loadPlugin(folder, "builtIn").ok).toBe(true);
  });

  it("says why an installed plugin with a dotted or reserved name is only warned about", () => {
    expect(presentNameWarning("my.plugin")).toContain("contains a dot");
    expect(presentNameWarning("botling")).toContain("reserved");
    expect(presentNameWarning("fine-name")).toBeNull();
  });
});

describe("every install path goes through the shared check", () => {
  it("git, folder, npm and the store: readProposal (the card's problems) refuses a dotted or reserved name", () => {
    const root = tempDir("proposal");
    const work = join(root, "work");
    const dotted = readProposal(plugin(root, "my.plugin"), work, "folder");
    expect(dotted.problems).toEqual([DOTTED]);
    expect(readProposal(plugin(root, "botling.evil"), work, "folder").problems).toEqual([RESERVED("botling.evil")]);
    expect(readProposal(plugin(root, "my-plugin"), work, "folder").problems).toEqual([]);
  });

  it("the check Maintainer runs on its own work (plugin check) refuses a name that is not a built-in's", () => {
    const root = tempDir("maintainer");
    const report = checkReport(plugin(root, "botling.evil"));
    expect(report.code).toBe(1);
    expect(report.stdout).toContain(RESERVED("botling.evil"));
    expect(report.stdout).toContain(`→ next [NAME_RESERVED]: ${CHECK_NEXT_STEPS.NAME_RESERVED}`);
  });

  it("the 2.x import: a dotted or reserved plugin is not copied and the source is untouched; valid names still import", () => {
    const root = tempDir("import");
    const src = join(root, "v2"), dst = join(root, "v3");
    for (const name of ["my.plugin", "botling.evil", "botling", "good_one", "9fine-name"]) plugin(join(src, "plugins"), name);
    const result = importPlugins(src, dst, { builtInsDir: null });
    expect(result.plugins.map((p) => p.name).sort()).toEqual(["9fine-name", "good_one"]);
    expect(readdirSync(join(dst, "plugins")).sort()).toEqual(["9fine-name", "good_one"]);
    expect(readdirSync(join(src, "plugins")).sort()).toEqual(["9fine-name", "botling", "botling.evil", "good_one", "my.plugin"]);
    expect(result.skipped.some((line) => line.includes("plugins/my.plugin") && line.includes(DOTTED))).toBe(true);
    expect(result.skipped.some((line) => line.includes("plugins/botling.evil") && line.includes(RESERVED("botling.evil")))).toBe(true);
    expect(result.skipped.some((line) => line.includes("plugins/botling\"") && line.includes(RESERVED("botling")))).toBe(true);
  });
});

describe("a plugin already installed with a dotted name", () => {
  it("stays loaded and on disk, is warned about once per name, and a new plugin with that name is still refused", () => {
    const dir = tempDir("present");
    const library = join(dir, "plugins");
    const dottedFolder = plugin(library, "my.plugin");
    plugin(library, "plain");
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore());
    const warned: string[] = [];
    registry.onNameWarning = (name, warning) => { warned.push(name); expect(warning).toContain("keeps working"); };
    expect(registry.plugins.map((p) => p.manifest.name)).toEqual(["my.plugin", "plain"]);
    expect(registry.problems).toEqual({});
    registry.rescan(true);
    // another dotted plugin shows up in the library: warned, loaded
    plugin(library, "other.dotted");
    registry.rescan(true);
    registry.rescan(true);
    expect(warned).toEqual(["other.dotted"]);
    expect(registry.plugins.map((p) => p.manifest.name)).toEqual(["my.plugin", "other.dotted", "plain"]);
    expect(existsSync(join(dottedFolder, "package.json"))).toBe(true);
    // ... while the same folder offered as a new install is refused
    expect(checkPlugin(dottedFolder)).toEqual([DOTTED]);
    expect(PluginRegistry.check(dottedFolder)).toEqual([DOTTED]);
  });

  it("a built-in is recognised by the folder it is read from: botling.* loads from the built-ins root, and the same claim in the library is no built-in", () => {
    const dir = tempDir("builtin-root");
    const builtIns = join(dir, "builtins");
    const library = join(dir, "plugins");
    plugin(builtIns, "botling.board");
    plugin(library, "botling.evil");
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), builtIns);
    const board = registry.plugin("botling.board");
    expect(board?.builtIn).toBe(true);
    expect(registry.problems).toEqual({});
    expect(registry.plugin("botling.evil")?.builtIn).toBe(false);
    // the real shipped folder (source tree) loads as a built-in with its dotted name and no problem
    const shipped = join(__dirname, "..", "..", "builtin-plugins");
    const dotted = readdirSync(shipped).filter((n) => n.startsWith("botling."));
    expect(dotted.length).toBeGreaterThanOrEqual(14);
    for (const name of dotted) {
      expect(checkPluginIssues(join(shipped, name), "builtIn").some((i) => i.code === "NAME_DOTTED" || i.code === "NAME_RESERVED"), name).toBe(false);
    }
  });
});
