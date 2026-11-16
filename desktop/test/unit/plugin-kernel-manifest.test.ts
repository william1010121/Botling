// The plugin kernel's manifest fields (manifest.ts readKernelFields, kernel step 1 step 4): `kernel`, `provides`,
// `requires`, `uses` are read for built-in plugins only. The built-in manifests yield the expected graph; a third-party
// manifest with the fields loads as before with them ignored; the Plugin API stays 2.7; `--check-plugin` says the same.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../../../Web/src/plugin-kernel";
import { checkReport } from "../../src/core/plugins/check-report";
import { API_VERSION, KERNEL_FIELDS_VERSION, checkPluginIssues, contributionIssues, readKernelFields } from "../../src/core/plugins/manifest";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { writeFixturePlugins } from "../kernel-goldens";
import { desktop } from "../helpers";

const BUILT_INS = join(desktop, "builtin-plugins");
const builtInNames = () => readdirSync(BUILT_INS).filter((name) => !name.includes(".md") && !name.startsWith(".")).sort();
const manifestOf = (folder: string) => JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as Record<string, unknown>;

const temps: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "kernel-manifest-")); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("reading the kernel fields", () => {
  it("the built-in manifests yield the expected graph: the Note may use composer.insertQuote, nothing requires anything", () => {
    const declared: Record<string, unknown> = {};
    for (const name of builtInNames()) {
      const { fields, problems } = readKernelFields(manifestOf(join(BUILT_INS, name)), true);
      expect(problems, name).toEqual([]);
      if (fields) declared[name] = fields;
    }
    expect(declared).toEqual({
      "botling.note": { kernel: 1, provides: { services: [], slots: [] }, requires: { services: [] }, uses: { services: ["composer.insertQuote"] } },
    });
    // Installed into a kernel beside the app's own surfaces (the chat surface provides the quote, step 7): no edge, no cycle.
    const kernel = new Kernel();
    kernel.install({ name: "botling.core", provides: { services: ["composer.insertQuote"] } });
    for (const name of builtInNames()) {
      const { fields } = readKernelFields(manifestOf(join(BUILT_INS, name)), true);
      kernel.install({ name, ...(fields ? { provides: fields.provides, requires: fields.requires, uses: fields.uses } : {}) });
    }
    const graph = kernel.requiresGraph();
    expect(Object.keys(graph).sort()).toEqual(["botling.core", ...builtInNames()].sort());
    expect(Object.values(graph).every((edges) => edges.length === 0)).toBe(true);
  });

  it("is null for a third-party manifest, whatever it carries, and for a built-in without `kernel`", () => {
    const value = { name: "x", version: "1.0.0", botling: { kernel: 1, provides: { services: ["x.s"] }, requires: { services: ["y.s"] } } };
    expect(readKernelFields(value, false)).toEqual({ fields: null, problems: [] });
    expect(readKernelFields({ name: "x", version: "1.0.0", ccb: { web: "a.js" } }, true)).toEqual({ fields: null, problems: [] });
    expect(readKernelFields("not an object", true)).toEqual({ fields: null, problems: [] });
  });

  it("reads `botling` (which wins) or `ccb`, leaves out wrong entries and names them", () => {
    const both = { botling: { kernel: 1, provides: { services: ["a.s", "a.s"], slots: ["chat/link"] } }, ccb: { kernel: 1, provides: { services: ["old.s"] } } };
    expect(readKernelFields(both, true).fields?.provides).toEqual({ services: ["a.s"], slots: ["chat/link"] });
    expect(readKernelFields({ ccb: { kernel: 1, requires: { services: ["c.s"] } } }, true).fields?.requires).toEqual({ services: ["c.s"] });
    const wrong = readKernelFields({ botling: { kernel: 1, provides: ["a.s"], requires: { services: "b.s" }, uses: { services: ["ok.s", 7, "../x", "b.t"] } } }, true);
    expect(wrong.fields).toEqual({ kernel: 1, provides: { services: [], slots: [] }, requires: { services: [] }, uses: { services: ["ok.s", "b.t"] } });
    expect(wrong.problems).toEqual([
      "botling.provides has the wrong type.", "botling.provides has the wrong type.", "botling.requires.services has the wrong type.",
      "botling.uses.services has a name that is not one: 7.", 'botling.uses.services has a name that is not one: "../x".',
    ]);
    const twice = readKernelFields({ botling: { kernel: 1, requires: { services: ["s"] }, uses: { services: ["s", "t"] } } }, true);
    expect([twice.fields?.requires, twice.fields?.uses]).toEqual([{ services: ["s"] }, { services: ["t"] }]);
    expect(twice.problems).toEqual(['botling: "s" is in both requires and uses (requires wins).']);
    expect(readKernelFields({ botling: { kernel: 2 } }, true)).toEqual({ fields: null, problems: ["botling.kernel must be 1."] });
    expect(KERNEL_FIELDS_VERSION).toBe(1);
  });
});

describe("what does not change", () => {
  it("the Plugin API is 2.8 (M7-O03a moved it from 2.7: workers.*, decided by the coordinator, user to confirm)", () => {
    expect(API_VERSION).toEqual({ major: 2, minor: 8 });
  });

  it("a third-party plugin with the fields loads as before, with them ignored", () => {
    const data = temp();
    const library = join(data, "plugins");
    writeFixturePlugins(library);
    const registry = new PluginRegistry(library, join(data, "plugins.json"), new MemorySecretStore(), null);
    registry.rescan(true);
    expect(registry.plugins.map((plugin) => [plugin.manifest.name, plugin.enabled, plugin.failure ?? null])).toEqual([
      ["acme-board", true, null], ["zed.tools", true, null],
    ]);
    for (const plugin of registry.plugins) {
      expect(readKernelFields(manifestOf(plugin.folder), plugin.builtIn)).toEqual({ fields: null, problems: [] });
      // Its manifest still carries them; the 2.x reading has no place for them.
      expect(JSON.stringify(plugin.manifest)).not.toMatch(/"(kernel|provides|requires|uses)"/);
    }
  });

  it("`--check-plugin` says the same with and without the fields, for the Note and the two fixtures", () => {
    const root = temp();
    const library = join(root, "plugins");
    writeFixturePlugins(library);
    cpSync(join(BUILT_INS, "botling.note"), join(root, "botling.note"), { recursive: true, filter: (path) => !path.includes("node_modules") });
    for (const folder of [join(root, "botling.note"), join(library, "acme-board"), join(library, "zed.tools")]) {
      const before = { report: checkReport(folder), issues: checkPluginIssues(folder), contributions: contributionIssues(folder) };
      const value = manifestOf(folder);
      const field = (value.botling ?? value.ccb) as Record<string, unknown>;
      expect(field.kernel, folder).toBe(1);
      for (const key of ["kernel", "provides", "requires", "uses"]) delete field[key];
      writeFileSync(join(folder, "package.json"), JSON.stringify(value, null, 2));
      const after = { report: checkReport(folder), issues: checkPluginIssues(folder), contributions: contributionIssues(folder) };
      expect(before).toEqual(after);
    }
  });
});
