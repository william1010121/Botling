// The settings behind the redesigned Settings: Antigravity workers' model and effort defaults (settings.json
// agyWorkerModelDefault / agyWorkerEffortDefault, given to new bots), what the engines' own config files say (read-only),
// Specs writers, and the report theme's "Match app" default.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applySetting, seedEngineDefaults, settingsView } from "../../src/core/settings";
import { claudeAutoCompactWindow, codexConfigFile, parseCodexConfig } from "../../src/core/engine-files";

describe("Antigravity workers' defaults", () => {
  it("are none until chosen, and are saved under their own settings.json keys", () => {
    expect(settingsView({})).toMatchObject({ agyWorkerModel: null, agyWorkerEffort: null });
    const raw = applySetting(applySetting({}, { key: "agyWorkerModel", value: "gemini-flash" }), { key: "agyWorkerEffort", value: "low" });
    expect(raw).toMatchObject({ agyWorkerModelDefault: "gemini-flash", agyWorkerEffortDefault: "low" });
    expect(settingsView(raw)).toMatchObject({ agyWorkerModel: "gemini-flash", agyWorkerEffort: "low" });
    // Back to "Same as head".
    const cleared = applySetting(applySetting(raw, { key: "agyWorkerModel", value: null }), { key: "agyWorkerEffort", value: null });
    expect(settingsView(cleared)).toMatchObject({ agyWorkerModel: null, agyWorkerEffort: null });
  });

  it("only take Antigravity's effort levels", () => {
    // Another level is refused: the setting stays as it was.
    expect(applySetting({ agyWorkerEffortDefault: "low" }, { key: "agyWorkerEffort", value: "xhigh" }).agyWorkerEffortDefault).toBe("low");
    expect(settingsView({ agyWorkerEffortDefault: "max" }).agyWorkerEffort).toBeNull();
    expect(settingsView({ agyWorkerModelDefault: 42 }).agyWorkerModel).toBeNull();
  });

  it("are given to a new bot, and nothing when none is chosen", () => {
    const given: Record<string, unknown> = {};
    seedEngineDefaults({ agyWorkerModelDefault: "gemini-flash", agyWorkerEffortDefault: "high" }, (key, value) => { given[key] = value; });
    expect(given).toMatchObject({ agyWorkerModel: "gemini-flash", agyWorkerEffort: "high" });
    const none: Record<string, unknown> = {};
    seedEngineDefaults({}, (key, value) => { none[key] = value; });
    expect("agyWorkerModel" in none || "agyWorkerEffort" in none).toBe(false);
  });
});

describe("other settings shown on the new pages", () => {
  it("report pages match the app unless Light or Dark is chosen", () => {
    expect(settingsView({}).reportTheme).toBe("system");
    expect(settingsView({ reportTheme: "light" }).reportTheme).toBe("light");
    expect(applySetting({ reportTheme: "dark" }, { key: "reportTheme", value: "system" }).reportTheme).toBeUndefined();
  });

  it("lists who may change spec/ (settings.json specWriters, opus by default)", () => {
    expect(settingsView({ specWriters: ["opus", "sonnet", 3] }).specWriters).toEqual(["opus", "sonnet"]);
  });
});

describe("the engines' own config files", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "botling-engine-files-"));

  it("reads Claude Code's auto-compact window, a positive whole number only", () => {
    const home = dir(), config = join(home, ".claude");
    expect(claudeAutoCompactWindow(home, config)).toBeNull();
    mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ autoCompactWindow: 300000 }));
    expect(claudeAutoCompactWindow(home, config)).toBe(300000);
    for (const bad of ['{"autoCompactWindow":"300000"}', '{"autoCompactWindow":-1}', '{"autoCompactWindow":1.5}', "not json", "null", "{}"]) {
      writeFileSync(join(config, "settings.json"), bad);
      expect(claudeAutoCompactWindow(home, config)).toBeNull();
    }
  });

  it("reads config.toml's top-level model, effort and service tier, not a profile's", () => {
    expect(parseCodexConfig([
      '# Codex', 'model = "gpt-6-sol"  # main', "model_reasoning_effort = 'high'", 'service_tier = "priority"', "",
      "[profiles.fast]", 'model = "other"',
    ].join("\n"))).toEqual({ model: "gpt-6-sol", effort: "high", fast: true });
    expect(parseCodexConfig('service_tier = "flex"\n')).toEqual({ model: null, effort: null, fast: false });
    expect(parseCodexConfig('service_tier = "fast"\n').fast).toBe(true);
    expect(parseCodexConfig("[profiles.x]\nmodel = \"x\"\n")).toEqual({ model: null, effort: null, fast: null });
    expect(parseCodexConfig("model = [1, 2]\n").model).toBeNull();
  });

  it("has no config.toml values when the file is missing", () => {
    const home = dir(), codex = join(home, ".codex");
    expect(codexConfigFile(home, codex)).toBeNull();
    mkdirSync(codex);
    writeFileSync(join(codex, "config.toml"), 'model = "gpt-6-luna"\n');
    expect(codexConfigFile(home, codex)).toEqual({ model: "gpt-6-luna", effort: null, fast: null });
  });
});
