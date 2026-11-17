// `contributes.componentTokens` (manifest.ts, registry.ts `componentTokens`): a plugin's own setting chooses the CSS variables every
// component frame gets. What is checked: the manifest reading, the set the setting picks, what is refused, which plugins count
// (on, not broken), the merge, that the core ships none of its own, and that the plugin list the page reads carries the result
// and changes when the setting does.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness } from "../core-harness";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { loadPlugin } from "../../src/core/plugins/manifest";

const comfortable = { "--ccb-density-space": "4px", "--ccb-density-radius": "8px", "--ccb-density-line": "1.4" };
const compact = { "--ccb-density-space": "2px", "--ccb-density-radius": "4px", "--ccb-density-line": "1.25" };

/** A library plugin with an enum setting and the token sets it chooses between. */
function plugin(library: string, name: string, contributes: Record<string, unknown>): string {
  const folder = join(library, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { contributes } }));
  return folder;
}
const density = (sets: Record<string, unknown> = { comfortable, compact }, extra: Record<string, unknown> = {}) => ({
  settings: { density: { type: "enum", title: "組件樣式", options: ["comfortable", "compact"], default: "comfortable" } },
  componentTokens: { setting: "density", sets },
  ...extra,
});
const open = (dir: string) => new PluginRegistry(join(dir, "plugins"), join(dir, "plugins.json"), new MemorySecretStore());

describe("manifest", () => {
  it("reads setting and sets, spelling a number as written", () => {
    const dir = tempDir("tokens-manifest");
    const folder = plugin(dir, "maint-lib", density({ compact: { "--ccb-density-line": 1.25, "--ccb-density-space": "2px" } }));
    const loaded = loadPlugin(folder);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.manifest.ccb?.contributes?.componentTokens).toEqual({ setting: "density", sets: { compact: { "--ccb-density-line": "1.25", "--ccb-density-space": "2px" } } });
  });

  it("refuses wrong types and a missing setting or sets, as the other contributions do", () => {
    const dir = tempDir("tokens-manifest-bad");
    for (const [index, componentTokens] of [{ sets: {} }, { setting: "density" }, { setting: 4, sets: {} }, { setting: "d", sets: [] }, { setting: "d", sets: { a: "x" } }, { setting: "d", sets: { a: { "--ccb-x": true } } }, "x"].entries()) {
      const loaded = loadPlugin(plugin(dir, `p${index}`, { componentTokens }));
      expect(loaded.ok && loaded.manifest.ccb?.contributes?.componentTokens, JSON.stringify(componentTokens)).toBeFalsy();
    }
  });
});

describe("PluginRegistry.componentTokens", () => {
  it("is empty when no plugin gives any: the core ships no values of its own", () => {
    const dir = tempDir("tokens-none");
    plugin(join(dir, "plugins"), "plain", { settings: { density: { type: "enum", title: "x", default: "compact" } } });
    expect(open(dir).componentTokens()).toEqual({});
  });

  it("gives the set the plugin's setting chooses, and the new one as soon as the setting changes", () => {
    const dir = tempDir("tokens-choose");
    plugin(join(dir, "plugins"), "maint-lib", density());
    const registry = open(dir);
    expect(registry.componentTokens()).toEqual(comfortable);
    registry.set("maint-lib", "density", "compact");
    expect(registry.componentTokens()).toEqual(compact);
    registry.set("maint-lib", "density", "comfortable");
    expect(registry.componentTokens()).toEqual(comfortable);
  });

  it("adds nothing for a setting value with no set, a setting that does not exist, or one that is not a string", () => {
    const dir = tempDir("tokens-unknown");
    plugin(join(dir, "plugins"), "maint-lib", density({ compact }));
    const registry = open(dir);
    expect(registry.componentTokens()).toEqual({});
    registry.set("maint-lib", "density", "constructor");
    expect(registry.componentTokens()).toEqual({});
    registry.set("maint-lib", "density", "__proto__");
    expect(registry.componentTokens()).toEqual({});
    registry.set("maint-lib", "density", 3);
    expect(registry.componentTokens()).toEqual({});
    plugin(join(dir, "plugins"), "other", { componentTokens: { setting: "missing", sets: { a: compact } } });
    registry.rescan(true);
    expect(registry.componentTokens()).toEqual({});
  });

  it("drops a name that does not start --ccb- and a value that is not a plain CSS value, keeping the rest", () => {
    const dir = tempDir("tokens-refused");
    plugin(join(dir, "plugins"), "maint-lib", density({
      comfortable: {
        "--ccb-density-space": "4px", "color": "red", "--density-x": "1px", "--ccb-x": "1px;}body{display:none", "--ccb-y": "</style><script>x</script>",
        "--ccb-z": "url(https://x.test/a.png)", "--ccb-w": "9".repeat(200), "--ccb-ok": " 8px ",
      },
    }));
    expect(open(dir).componentTokens()).toEqual({ "--ccb-density-space": "4px", "--ccb-ok": "8px" });
  });

  it("counts a plugin that is on and not broken only", () => {
    const dir = tempDir("tokens-state");
    plugin(join(dir, "plugins"), "maint-lib", density());
    const registry = open(dir);
    expect(registry.componentTokens()).toEqual(comfortable);
    registry.setEnabled("maint-lib", false);
    expect(registry.componentTokens()).toEqual({});
    registry.setEnabled("maint-lib", true);
    expect(registry.componentTokens()).toEqual(comfortable);
    registry.markFailed("maint-lib", "boom");
    expect(registry.componentTokens()).toEqual({});
  });

  it("merges plugins in name order, the later name winning a clash, and holds the cap", () => {
    const dir = tempDir("tokens-merge");
    const library = join(dir, "plugins");
    plugin(library, "a-first", { settings: { s: { type: "enum", title: "s", default: "x" } }, componentTokens: { setting: "s", sets: { x: { "--ccb-density-space": "1px", "--ccb-only-a": "1" } } } });
    plugin(library, "b-second", { settings: { s: { type: "enum", title: "s", default: "x" } }, componentTokens: { setting: "s", sets: { x: { "--ccb-density-space": "9px", "--ccb-only-b": "2" } } } });
    expect(open(dir).componentTokens()).toEqual({ "--ccb-density-space": "9px", "--ccb-only-a": "1", "--ccb-only-b": "2" });
    const big = tempDir("tokens-cap");
    plugin(join(big, "plugins"), "many", density({ comfortable: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`--ccb-n${String(index).padStart(3, "0")}`, "1px"])) }));
    expect(Object.keys(open(big).componentTokens())).toHaveLength(64);
  });
});

describe("the plugin list the page reads", () => {
  const harnesses: CoreHarness[] = [];
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
  });

  it("carries the tokens, and shows the other set once the plugin's setting changes", async () => {
    const dir = tempDir("tokens-view");
    plugin(join(dir, "plugins"), "maint-lib", density());
    const core = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0" });
    harnesses.push(core);
    const shown = () => core.call({ type: "plugins.list" }).then((view: any) => view.componentTokens);
    expect(await until(async () => (await shown()) ?? undefined)).toEqual(comfortable);
    await core.call({ type: "plugins.setting", name: "maint-lib", key: "density", value: "compact" });
    expect(await until(async () => { const tokens = await shown(); return tokens?.["--ccb-density-space"] === "2px" ? tokens : undefined; })).toEqual(compact);
  });
});
