// Which copy of a plugin runs when Botling ships one and the plugin library has one of the same name
// (src/core/plugins/versions.ts, registry.ts `rescan`): the library's at the built-in's version or newer, else the
// built-in one, with the ignored copy shown on the Plugins page.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { compareVersions, libraryCopyWins } from "../../src/core/plugins/versions";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { PluginsPanel } from "../../src/renderer/Plugins";
import type { Client } from "../../src/renderer/client";
import type { PluginsView } from "../../src/contract";

describe("compareVersions (semver precedence)", () => {
  it("orders by major, minor and patch, numerically", () => {
    expect(compareVersions("1.19.0", "1.18.1")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
  });
  it("equal versions are equal, build metadata ignored", () => {
    expect(compareVersions("1.19.0", "1.19.0")).toBe(0);
    expect(compareVersions("1.19.0+lib.3", "1.19.0")).toBe(0);
    expect(compareVersions("1.19.0-dev+a", "1.19.0-dev+b")).toBe(0);
  });
  it("a pre-release is below its release and above the release before", () => {
    expect(compareVersions("1.19.0-dev", "1.19.0")).toBe(-1);
    expect(compareVersions("1.19.0", "1.19.0-dev")).toBe(1);
    expect(compareVersions("1.20.0-dev", "1.19.0")).toBe(1);
  });
  it("pre-release identifiers: numbers by value, numbers below words, a longer list above its prefix (semver.org §11)", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < ordered.length; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBe(1);
    }
  });
  it("is null when either is not a semver", () => {
    for (const bad of ["1.2", "1", "v1.2.3", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3-01", "", "latest", "1.2.x"]) {
      expect(compareVersions(bad, "1.0.0"), bad).toBeNull();
      expect(compareVersions("1.0.0", bad), bad).toBeNull();
    }
  });
});

describe("libraryCopyWins", () => {
  it("the library's copy at the same or a newer version runs; an older one, or one that is not a semver, yields", () => {
    expect(libraryCopyWins("1.19.0", "1.19.0")).toBe(true);
    expect(libraryCopyWins("1.19.1", "1.19.0")).toBe(true);
    expect(libraryCopyWins("1.20.0-dev", "1.19.0")).toBe(true);
    expect(libraryCopyWins("1.18.1", "1.19.0")).toBe(false);
    expect(libraryCopyWins("1.19.0-dev", "1.19.0")).toBe(false);
    expect(libraryCopyWins("1.19.0.1", "1.19.0")).toBe(false);
  });
});

/** A plugin folder with a web part, at `version`. */
function plugin(root: string, name: string, version: string) {
  mkdirSync(join(root, name, "dist"), { recursive: true });
  writeFileSync(join(root, name, "package.json"), JSON.stringify({ name, version, engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js" } }));
  writeFileSync(join(root, name, "dist", "web.js"), `export function activate() {} // ${version}`);
}

describe("the registry with a built-in plugin and a library copy of it", () => {
  const setup = (builtIn: string, library: string | null) => {
    const dir = tempDir("plugin-copies");
    const shipped = join(dir, "builtin"), lib = join(dir, "plugins");
    plugin(shipped, "botling.note", builtIn);
    mkdirSync(lib, { recursive: true });
    if (library) plugin(lib, "botling.note", library);
    return { dir, shipped, lib, registry: () => new PluginRegistry(lib, join(dir, "plugins.json"), new MemorySecretStore(), shipped) };
  };

  it("an older library copy yields to the built-in one, which says so", () => {
    const { shipped, lib, registry } = setup("1.19.0", "1.18.1");
    const plugins = registry();
    expect(plugins.plugins).toHaveLength(1);
    expect(plugins.plugin("botling.note")).toMatchObject({ builtIn: true, folder: join(shipped, "botling.note"), manifest: { version: "1.19.0" }, ignoredLibraryCopy: { folder: join(lib, "botling.note"), version: "1.18.1" } });
    expect(plugins.plugin("botling.note")!.replacesBuiltIn).toBeUndefined();
    expect(plugins.webSpecs()[0]).toMatchObject({ version: "1.19.0", builtIn: true });
    expect(plugins.problems).toEqual({});
  });

  it("a library copy at the same or a newer version replaces it (a developer's copy), and says which version it replaces", () => {
    for (const version of ["1.19.0", "1.19.1", "1.20.0-dev"]) {
      const { lib, registry } = setup("1.19.0", version);
      const running = registry().plugin("botling.note")!;
      expect(running, version).toMatchObject({ builtIn: false, folder: join(lib, "botling.note"), manifest: { version }, replacesBuiltIn: "1.19.0" });
      expect(running.ignoredLibraryCopy).toBeUndefined();
    }
  });

  it("no library copy: the built-in one, with neither mark", () => {
    const running = setup("1.19.0", null).registry().plugin("botling.note")!;
    expect(running.builtIn).toBe(true);
    expect(running.ignoredLibraryCopy).toBeUndefined();
    expect(running.replacesBuiltIn).toBeUndefined();
  });

  it("switches on the next scan when the library copy's version moves past the built-in's", () => {
    const { lib, registry } = setup("1.19.0", "1.18.1");
    const plugins = registry();
    const updated: [string, string][] = [];
    plugins.onUpdated = (running, from) => updated.push([running.manifest.version, from]);
    plugin(lib, "botling.note", "1.19.2");
    expect(plugins.rescan()).toBe(true);
    expect(plugins.plugin("botling.note")).toMatchObject({ builtIn: false, replacesBuiltIn: "1.19.0" });
    expect(updated).toEqual([["1.19.2", "1.19.0"]]);
  });
});

describe("the Plugins page", () => {
  const view = (over: Partial<PluginsView["plugins"][number]>): PluginsView => ({
    plugins: [{ name: "botling.note", title: "Note", version: "1.19.0", description: null, enabled: true, failure: null, installedFrom: null, permissions: ["files"], parts: ["web", "host"], settings: [], commands: [], panels: [], ...over }],
    broken: [], host: { running: true, problem: null }, secretsProblem: null,
  } as PluginsView);
  const draw = (plugins: PluginsView) => renderToStaticMarkup(createElement(PluginsPanel, { client: {} as Client, plugins, onPanel() {}, onClose() {}, embedded: true }));

  it("says the built-in copy is in use and the library's older copy is ignored", () => {
    const markup = draw(view({ builtIn: true, ignoredLibraryVersion: "1.18.1" }));
    expect(markup).toContain("Built into Botling (in use)");
    expect(markup).toContain("Your plugin library&#x27;s copy (1.18.1) is older and is ignored");
  });

  it("says the library's copy is in use in place of the built-in one", () => {
    const markup = draw(view({ version: "1.20.0", replacesBuiltIn: "1.19.0" }));
    expect(markup).toContain("Your plugin library&#x27;s copy (in use) replaces the built-in 1.19.0");
    expect(markup).not.toContain("Built into Botling");
  });

  it("a built-in plugin alone is just built in", () => {
    const markup = draw(view({ builtIn: true }));
    expect(markup).toContain(">Built into Botling<");
    expect(markup).not.toContain("ignored");
  });
});
