// ADR-006 M2: the Maintainer's read-only introspection queries: the query table is locked, input is schema-validated,
// nothing secret comes out, nothing is written, and the --inspect-plugins command answers from a library on disk.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { INSPECT_QUERIES, parseThemeVariables } from "../../src/core/plugins/introspect";
import { inspectReport } from "../../src/core/plugins/inspect-report";
import { VIEW_SLOTS, STATUS_SLOTS, MENU_SLOTS } from "../../src/core/plugins/contributions";

const CSS = ':root { --ground: #0E0E10; --text: #EDEDF0; --blue: #4C8DFF; }\n:root[data-theme="light"] { --ground: #F5F5F7; --text: #111; }\n.x { color: var(--text); }';

function write(library: string, name: string, ccb: unknown, extra: Record<string, unknown> = {}) {
  const folder = join(library, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb, ...extra }));
  writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}");
  return folder;
}

function world() {
  const root = tempDir("inspect");
  const library = join(root, "plugins");
  mkdirSync(library);
  write(library, "alpha", {
    web: "dist/web.js", permissions: ["composer"],
    contributes: {
      commands: [{ id: "alpha.find", title: "Find", key: "cmd+k" }, { id: "alpha.ok", title: "Fine", key: "cmd+shift+9" }],
      settings: { "alpha.token": { type: "string", title: "Token", secret: true, default: "DEFAULT-SECRET-VALUE" } },
    },
  });
  write(library, "beta", { web: "dist/web.js" });
  write(library, "Broken", { web: "dist/missing.js" });
  const secrets = new MemorySecretStore();
  void secrets.set("alpha", "alpha.token", "SUPER-SECRET-TOKEN");
  const stateFile = join(root, "plugins.json");
  writeFileSync(stateFile, JSON.stringify({ disabled: [], settings: { alpha: { "alpha.token": "SETTING-VALUE-XYZ" } }, failures: {}, installed: { beta: "https://user:TOKEN123@example.com/repo.git" } }));
  return { root, library, stateFile, registry: new PluginRegistry(library, stateFile, secrets, null) };
}

describe("the introspection queries", () => {
  it("locks the query table", () => {
    expect(Object.keys(INSPECT_QUERIES)).toEqual(["slots", "installedPlugins", "checkIssues", "shortcutConflicts", "themeVariables"]);
    const { registry } = world();
    expect(registry.inspectQueries().map((query) => query.query)).toEqual(Object.keys(INSPECT_QUERIES));
  });

  it("validates input: unknown queries, unknown keys and wrong types are refused, not guessed at", () => {
    const { registry } = world();
    expect(registry.inspect("nope", {}).ok).toBe(false);
    expect(registry.inspect("constructor", {}).ok).toBe(false);
    expect(registry.inspect("slots", { extra: 1 }).ok).toBe(false);
    expect(registry.inspect("installedPlugins", { name: 5 }).ok).toBe(false);
    expect(registry.inspect("themeVariables", { theme: "blue" }).ok).toBe(false);
    expect(registry.inspect("themeVariables", { prefix: "../x" }).ok).toBe(false);
    expect(registry.inspect("slots", undefined).ok).toBe(true);
  });

  it("slots: every slot with what it is for", () => {
    const { registry } = world();
    const result = registry.inspect("slots", {});
    expect(result.ok && (result.data as { slots: { slot: string }[] }).slots.map((slot) => slot.slot)).toEqual([...VIEW_SLOTS, ...STATUS_SLOTS, ...MENU_SLOTS]);
  });

  it("installedPlugins: names and state, but no setting values, no secrets, no install source", () => {
    const { registry } = world();
    const result = registry.inspect("installedPlugins", {});
    expect(result.ok).toBe(true);
    const data = result.ok ? (result.data as { name: string; settingKeys: string[]; external: boolean }[]) : [];
    expect(data.map((plugin) => plugin.name)).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(data.find((plugin) => plugin.name === "alpha")?.settingKeys).toEqual(["alpha.token"]);
    expect(data.find((plugin) => plugin.name === "beta")?.external).toBe(true);
    const text = JSON.stringify(result);
    for (const leak of ["SUPER-SECRET-TOKEN", "SETTING-VALUE-XYZ", "DEFAULT-SECRET-VALUE", "TOKEN123", "example.com"]) expect(text).not.toContain(leak);
    expect(registry.inspect("installedPlugins", { name: "beta" }).ok && (registry.inspect("installedPlugins", { name: "beta" }) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("checkIssues: the stable codes and nextSteps of what is broken", () => {
    const { registry } = world();
    const result = registry.inspect("checkIssues", {});
    const issues = result.ok ? (result.data as { issues: { folder: string; code: string; nextStep: string }[] }).issues : [];
    expect(issues.some((issue) => issue.folder === "Broken" && issue.nextStep.length > 0)).toBe(true);
    expect(issues.every((issue) => issue.folder !== "alpha")).toBe(true);
  });

  it("shortcutConflicts: a plugin key held by an app shortcut is reported with what holds it", () => {
    const { registry } = world();
    const result = registry.inspect("shortcutConflicts", {});
    const conflicts = result.ok ? (result.data as { conflicts: { command: string; heldBy: { kind: string; id: string } }[] }).conflicts : [];
    expect(conflicts.map((conflict) => conflict.command)).toEqual(["alpha.find"]);
    expect(conflicts[0]!.heldBy).toEqual({ kind: "shortcut", id: "search" });
  });

  it("themeVariables: dark by default, light on request, filtered by prefix; unavailable without the stylesheet", () => {
    const { registry } = world();
    expect(parseThemeVariables(CSS)).toEqual({ dark: { "--ground": "#0E0E10", "--text": "#EDEDF0", "--blue": "#4C8DFF" }, light: { "--ground": "#F5F5F7", "--text": "#111" } });
    expect(registry.inspect("themeVariables", {}, { themeCss: CSS })).toMatchObject({ ok: true, data: { available: true, variables: { "--ground": "#0E0E10" } } });
    expect(registry.inspect("themeVariables", { theme: "light", prefix: "g" }, { themeCss: CSS })).toMatchObject({ data: { variables: { "--ground": "#F5F5F7" } } });
    expect(registry.inspect("themeVariables", {})).toMatchObject({ ok: true, data: { available: false } });
  });
});

describe("--inspect-plugins", () => {
  it("answers as JSON from a library on disk, refuses bad input, and writes nothing", () => {
    const { root, library, stateFile } = world();
    const before = { files: readdirSync(root).sort(), state: readFileSync(stateFile, "utf8") };
    const css = join(tempDir("inspect-css"), "styles.css");
    writeFileSync(css, CSS);
    const env = { builtIns: null, themeCssFile: css, cwd: library };
    const list = inspectReport(["list"], env);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout).queries).toHaveLength(5);
    const theme = inspectReport(["themeVariables", '{"theme":"light"}'], env);
    expect(JSON.parse(theme.stdout).data.variables["--text"]).toBe("#111");
    expect(inspectReport(["installedPlugins"], { ...env, cwd: root }).code).toBe(0);
    expect(inspectReport(["slots", '{"x":1}'], env).code).toBe(1);
    expect(inspectReport([], env).code).toBe(2);
    expect(inspectReport(["slots", "{nope"], env).code).toBe(2);
    expect(inspectReport(["slots", "{}", "--library", library], { ...env, cwd: "/" }).code).toBe(0);
    expect({ files: readdirSync(root).sort(), state: readFileSync(stateFile, "utf8") }).toEqual(before);
    expect(existsSync(join(library, ".git"))).toBe(false);
  });
});
