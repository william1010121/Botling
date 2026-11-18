// The app's developer mode (settings.json, read at each scan that finds a push) is what lets a pushed built-in plugin run: the core hands
// it to the plugins (CorePluginWorld.pluginOptions().developerMode), and a core with the mode off runs the build's own copy.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { writeSettings } from "../../src/core/settings";
import { Layout } from "../../src/core/store/workspace";
import { tempDir } from "../helpers";

function core(settings: Record<string, unknown> | null) {
  const dir = tempDir("overrides-wiring");
  mkdirSync(dir, { recursive: true });
  if (settings) writeSettings(Layout.settings(dir), settings);
  const made = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit: () => {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { dir, made, options: () => (made as any).corePluginWorld.pluginOptions() };
}

describe("the developer mode the core gives its plugins", () => {
  it("is off with no settings file, off when settings say so, on when settings say so, and read again at each ask", () => {
    expect(core(null).options().developerMode()).toBe(false);
    expect(core({ developerMode: false }).options().developerMode()).toBe(false);
    const on = core({ developerMode: true });
    expect(on.options().developerMode()).toBe(true);
    writeSettings(Layout.settings(on.dir), { developerMode: false });
    expect(on.options().developerMode()).toBe(false);
    writeFileSync(Layout.settings(on.dir), "{ not json");
    expect(on.options().developerMode()).toBe(false);
  });
});
