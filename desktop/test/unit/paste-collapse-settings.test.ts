// The paste limits are botling.chat-extras' settings now (core-shrink-2 N1): what settings.json held moves
// to the plugin once, on start, and the Settings page's own command no longer takes them.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsChange } from "../../src/contract";
import { moveSettingsToPlugins, readSettings, settingsView, writeSettings } from "../../src/core/settings";
import { tempDir } from "../helpers";

const moved = (raw: Record<string, unknown>) => {
  const file = join(tempDir("paste-settings"), "settings.json");
  writeSettings(file, raw);
  const set: [string, string, number][] = [];
  moveSettingsToPlugins(file, (plugin, key, value) => set.push([plugin, key, value]));
  return { set, after: readSettings(file) };
};

describe("paste collapse settings", () => {
  it("move to botling.chat-extras, 0 kept, and leave settings.json", () => {
    const { set, after } = moved({ pasteCollapseChars: 0, pasteCollapseLines: 40, languageChoice: "en" });
    expect(set).toEqual([
      ["botling.chat-extras", "botling.chat-extras.pasteCollapseChars", 0],
      ["botling.chat-extras", "botling.chat-extras.pasteCollapseLines", 40],
    ]);
    expect(after).toEqual({ languageChoice: "en" });
  });
  it("move once; a bad value is dropped and the plugin's default stays; a big one is capped", () => {
    expect(moved({ languageChoice: "en" }).set).toEqual([]);
    const { set, after } = moved({ pasteCollapseChars: -5, pasteCollapseLines: "9" });
    expect(set).toEqual([]);
    expect(after).toEqual({});
    expect(moved({ pasteCollapseChars: 5e9 }).set).toEqual([["botling.chat-extras", "botling.chat-extras.pasteCollapseChars", 1_000_000]]);
  });
  it("are no longer Botling's own settings", () => {
    expect(settingsView({ pasteCollapseChars: 5 })).not.toHaveProperty("pasteCollapseChars");
    for (const key of ["pasteCollapseChars", "pasteCollapseLines"]) expect(SettingsChange.safeParse({ key, value: 0 }).success).toBe(false);
  });
});
