import { describe, expect, it } from "vitest";
import { SettingsChange } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";

describe("paste collapse settings", () => {
  it("default to 1000 characters and 15 lines, and ignore bad values", () => {
    expect(settingsView({})).toMatchObject({ pasteCollapseChars: 1000, pasteCollapseLines: 15 });
    expect(settingsView({ pasteCollapseChars: -5, pasteCollapseLines: "9" })).toMatchObject({ pasteCollapseChars: 1000, pasteCollapseLines: 15 });
  });
  it("keep 0, which turns a limit off", () => {
    const raw = applySetting(applySetting({}, { key: "pasteCollapseChars", value: 0 }), { key: "pasteCollapseLines", value: 40 });
    expect(settingsView(raw)).toMatchObject({ pasteCollapseChars: 0, pasteCollapseLines: 40 });
  });
  it("only bounded whole numbers cross the command boundary", () => {
    for (const key of ["pasteCollapseChars", "pasteCollapseLines"]) {
      expect(SettingsChange.safeParse({ key, value: 0 }).success).toBe(true);
      for (const value of [-1, 1.5, "5", NaN, null]) expect(SettingsChange.safeParse({ key, value }).success).toBe(false);
    }
  });
});
