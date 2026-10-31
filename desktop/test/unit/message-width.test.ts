import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsChange, SettingsView } from "../../src/contract";
import { messageWidth } from "../../src/contract/message-width";
import { applySetting, readSettings, settingsView, writeSettings } from "../../src/core/settings";
import { tempDir } from "../helpers";
import { CoreHarness } from "../core-harness";

describe("Botling 2 message column width", () => {
  it("old settings use the default, and malformed values do not break other settings", () => {
    for (const value of [undefined, null, "800", {}, NaN, Infinity]) {
      expect(messageWidth(value)).toBeNull();
      expect(settingsView({ messageColumnWidth: value, languageChoice: "zh-Hant" })).toMatchObject({ messageColumnWidth: null, effectiveLanguage: "zh-Hant" });
    }
    expect(SettingsView.parse(settingsView({})).messageColumnWidth).toBeNull();
  });
  it("tolerant disk reads clamp and round numeric preferences", () => {
    expect([-1, 359, 720.6, 1201].map(messageWidth)).toEqual([360, 360, 721, 1200]);
  });
  it("only bounded integer widths or a default reset cross the command boundary", () => {
    for (const value of [360, 640, 1200, null]) expect(SettingsChange.safeParse({ key: "messageColumnWidth", value }).success).toBe(true);
    for (const value of [0, 359, 1201, 700.5, "800", NaN, Infinity]) expect(SettingsChange.safeParse({ key: "messageColumnWidth", value }).success).toBe(false);
  });
  it("writes and resets the preference without losing unrelated settings", () => {
    const file = join(tempDir("message-width-settings"), "settings.json");
    const raw = { someFutureKey: { keep: true }, languageChoice: "ja" };
    writeSettings(file, applySetting(raw, { key: "messageColumnWidth", value: 920 }));
    expect(settingsView(readSettings(file)).messageColumnWidth).toBe(920);
    writeSettings(file, applySetting(readSettings(file), { key: "messageColumnWidth", value: null }));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(raw);
  });
  it("core saves and broadcasts one global width, rejects bad writes, and reloads it", async () => {
    const dir = tempDir("message-width-core");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ someFutureKey: true }));
    const env = { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0" };
    let core = new CoreHarness(dir, env);
    try {
      expect((await core.call({ type: "settings.set", change: { key: "messageColumnWidth", value: 880 } })).messageColumnWidth).toBe(880);
      expect(core.of("settings.updated").at(-1)?.event).toMatchObject({ settings: { messageColumnWidth: 880 } });
      await expect(core.call({ type: "settings.set", change: { key: "messageColumnWidth", value: 1201 } })).rejects.toThrow("bad_request");
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ someFutureKey: true, messageColumnWidth: 880 });
      await core.kill();
      core = new CoreHarness(dir, env);
      expect((await core.call({ type: "chat.snapshot" })).settings.messageColumnWidth).toBe(880);
      await core.call({ type: "settings.set", change: { key: "messageColumnWidth", value: null } });
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ someFutureKey: true });
    } finally {
      if (core.child.exitCode === null && core.child.signalCode === null) await core.kill();
    }
  });
});
