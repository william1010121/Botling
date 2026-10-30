// Engine defaults: the primary engine per bot (bot's own choice > the app's default > the first engine it
// has), the app-wide engine set / models / effort a new bot starts with, and "apply to all bots".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHeads, readHeads, headsJSON, resolvePrimary } from "../../src/core/heads";
import { applySetting, settingsView, seedEngineDefaults } from "../../src/core/settings";
import { engineDefaultsFor, botChoicesFromDefaults } from "../../src/core/engine-defaults";
import { SettingsChange, Command } from "../../src/contract";
import { CoreHarness } from "../core-harness";
import { tempDir } from "../helpers";

describe("primary engine resolution", () => {
  it("prefers the bot's own choice over the app default", () => {
    const heads = makeHeads(["claude", "codex", "agy"], "codex");
    expect(resolvePrimary(heads, "agy")).toBe("codex");
  });
  it("uses the app default when the bot has no choice of its own", () => {
    const heads = makeHeads(["claude", "codex"], null);
    expect(heads.answerWith).toBeNull();
    expect(resolvePrimary(heads, "codex")).toBe("codex");
  });
  it("falls back to the bot's first engine when neither applies", () => {
    expect(resolvePrimary(makeHeads(["codex", "agy"], null), null)).toBe("codex");
    expect(resolvePrimary(makeHeads(["claude", "codex"], "both"), null)).toBe("claude");
  });
  it("never picks an engine the bot does not have", () => {
    expect(resolvePrimary(makeHeads(["claude", "codex"], null), "agy")).toBe("claude");
    const stale = { ...makeHeads(["claude"], "claude"), answerWith: "agy" as const };
    expect(resolvePrimary(stale, "codex")).toBe("claude");
  });
  it("keeps 'no choice' through bot.json, and reads old files as before", () => {
    const none = makeHeads(["claude", "codex"], null);
    expect(headsJSON(none)).not.toHaveProperty("answerWith");
    expect(readHeads(headsJSON(none), "claude").answerWith).toBeNull();
    expect(readHeads({ engines: ["claude", "codex"], answerWith: "codex" }, "claude").answerWith).toBe("codex");
    expect(readHeads({ engines: ["claude", "codex"], answerWith: "both" }, "codex").answerWith).toBe("codex");
  });
});

describe("the app's engine defaults (settings.json)", () => {
  const view = (raw: Record<string, unknown>) => settingsView(raw).engineDefaults;
  it("starts as before: Claude only, nothing chosen", () => {
    expect(view({})).toEqual({ engines: ["claude"], primary: null, models: { claude: null, codex: null, agy: null }, efforts: { claude: null, codex: null, agy: null } });
  });
  it("saves the engine set, keeping Claude, Codex, Antigravity order and at least one", () => {
    let raw = applySetting({}, { key: "defaultEngines", value: ["agy", "claude"] });
    expect(view(raw).engines).toEqual(["claude", "agy"]);
    raw = applySetting(raw, { key: "defaultEngines", value: [] as never });
    expect(view(raw).engines).toEqual(["claude", "agy"]);
  });
  it("never lets a disabled engine be the primary", () => {
    let raw = applySetting({}, { key: "defaultEngines", value: ["claude", "codex"] });
    raw = applySetting(raw, { key: "defaultPrimaryEngine", value: "codex" });
    expect(view(raw).primary).toBe("codex");
    // Choosing one that is off is refused (kept as it was).
    expect(view(applySetting(raw, { key: "defaultPrimaryEngine", value: "agy" })).primary).toBe("codex");
    // Turning the primary off drops it.
    expect(view(applySetting(raw, { key: "defaultEngines", value: ["claude", "agy"] })).primary).toBeNull();
    // A hand-edited file cannot sneak one in either.
    expect(view({ defaultEngines: ["claude"], defaultPrimaryEngine: "agy" }).primary).toBeNull();
  });
  it("saves a model and an effort per engine, empty meaning the engine's own default", () => {
    let raw = applySetting({}, { key: "defaultEngineModel", value: { engine: "codex", model: "gpt-x" } });
    raw = applySetting(raw, { key: "defaultEngineModel", value: { engine: "claude", model: "opus" } });
    raw = applySetting(raw, { key: "defaultEffort", value: { engine: "claude", effort: "max" } });
    raw = applySetting(raw, { key: "defaultEffort", value: { engine: "codex", effort: "low" } });
    // A level the engine does not support is refused (kept as it was).
    raw = applySetting(raw, { key: "defaultEffort", value: { engine: "agy", effort: "max" } });
    expect(view(raw)).toMatchObject({ models: { claude: "opus", codex: "gpt-x", agy: null }, efforts: { claude: "max", codex: "low", agy: null } });
    raw = applySetting(raw, { key: "defaultEngineModel", value: { engine: "codex", model: null } });
    raw = applySetting(raw, { key: "defaultEffort", value: { engine: "claude", effort: null } });
    expect(view(raw)).toMatchObject({ models: { claude: "opus", codex: null }, efforts: { claude: null, codex: "low" } });
  });
  it("is validated by the contract", () => {
    expect(SettingsChange.safeParse({ key: "defaultEngines", value: ["claude", "codex"] }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "defaultEngines", value: [] }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "defaultPrimaryEngine", value: "both" }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "defaultEffort", value: { engine: "codex", effort: "high" } }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "defaultEffort", value: "high" }).success).toBe(false);
    expect(Command.safeParse({ type: "engineDefaults.applyAll" }).success).toBe(false);
    expect(Command.safeParse({ type: "engineDefaults.applyAll", confirmed: false }).success).toBe(false);
    expect(Command.safeParse({ type: "engineDefaults.applyAll", confirmed: true }).success).toBe(true);
  });
});

describe("new bots take the app's defaults", () => {
  it("seeds engines, primary, models and effort into the new bot's bot.json", () => {
    let raw: Record<string, unknown> = {};
    raw = applySetting(raw, { key: "defaultEngines", value: ["claude", "codex"] });
    raw = applySetting(raw, { key: "defaultPrimaryEngine", value: "codex" });
    raw = applySetting(raw, { key: "defaultEngineModel", value: { engine: "claude", model: "sonnet" } });
    raw = applySetting(raw, { key: "defaultEngineModel", value: { engine: "codex", model: "gpt-x" } });
    raw = applySetting(raw, { key: "defaultEffort", value: { engine: "claude", effort: "medium" } });
    raw = applySetting(raw, { key: "defaultEffort", value: { engine: "codex", effort: "xhigh" } });
    const saved: Record<string, unknown> = {};
    seedEngineDefaults(raw, (key, value) => { saved[key] = value; });
    const heads = readHeads(saved.heads, saved.engine);
    expect(heads.engines).toEqual(["claude", "codex"]);
    // It follows the app's primary rather than keeping a copy of it.
    expect(heads.answerWith).toBeNull();
    expect(resolvePrimary(heads, engineDefaultsFor(raw).primary)).toBe("codex");
    expect(heads.codexModel).toBe("gpt-x");
    expect(saved).toMatchObject({ engine: "codex", model: "sonnet", efforts: { claude: "medium", codex: "xhigh" } });
    expect(saved.effort).toBeUndefined();
  });
  it("seeds nothing new when the app has no defaults (a new bot is Claude as before)", () => {
    const saved: Record<string, unknown> = {};
    seedEngineDefaults({}, (key, value) => { saved[key] = value; });
    expect(saved.heads).toBeUndefined();
    expect(saved.model).toBeUndefined();
  });
  it("maps the defaults to a bot's choices (what apply-to-all writes), clearing what the app leaves empty", () => {
    const defaults = engineDefaultsFor({ defaultEngines: ["codex", "agy"], defaultPrimaryEngine: "agy", defaultEfforts: { agy: "low", codex: "xhigh" } });
    const choices = botChoicesFromDefaults(defaults);
    expect(choices.engines).toEqual(["codex", "agy"]);
    expect(choices.primary).toBe("agy");
    expect(choices).toMatchObject({ model: null, codexModel: null, agyModel: null, efforts: { claude: null, codex: "xhigh", agy: "low" } });
  });
});

describe("through the core", () => {
  const env = (dir: string) => ({ BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_IMPORT_FROM: join(dir, "no-import"), HOME: dir });
  it("a project added after the defaults are set starts with them; apply-to-all resets older bots; the primary is the bot's own, else the app's", async () => {
    const dir = tempDir("engine-defaults");
    const c = new CoreHarness(dir, env(dir));
    try {
      await c.call({ type: "boot.commit" });
      const old = await c.call({ type: "projects.add", folder: tempDir("engine-defaults-old") });
      expect(await c.call({ type: "bot.settings", botId: old.botId })).toMatchObject({ engines: ["claude"], model: null, efforts: { claude: null, codex: null, agy: null } });

      await c.call({ type: "settings.set", change: { key: "defaultEngines", value: ["claude", "codex"] } });
      await c.call({ type: "settings.set", change: { key: "defaultPrimaryEngine", value: "codex" } });
      await c.call({ type: "settings.set", change: { key: "defaultEngineModel", value: { engine: "claude", model: "opus" } } });
      await c.call({ type: "settings.set", change: { key: "defaultEffort", value: { engine: "claude", effort: "high" } } });
      await c.call({ type: "settings.set", change: { key: "defaultEffort", value: { engine: "codex", effort: "low" } } });
      // Changing the defaults alone leaves existing bots as they are.
      expect(await c.call({ type: "bot.settings", botId: old.botId })).toMatchObject({ engines: ["claude"], model: null });

      const fresh = await c.call({ type: "projects.add", folder: tempDir("engine-defaults-new") });
      expect(await c.call({ type: "bot.settings", botId: fresh.botId })).toMatchObject({ engines: ["claude", "codex"], model: "opus", efforts: { claude: "high", codex: "low", agy: null }, primary: null, primaryEffective: "codex" });

      // Apply to all asks for confirmation: without it nothing happens.
      await expect(c.call({ type: "engineDefaults.applyAll" })).rejects.toThrow();
      expect(await c.call({ type: "bot.settings", botId: old.botId })).toMatchObject({ engines: ["claude"] });

      // A bot's own primary beats the app's; "no choice" follows it again.
      expect(await c.call({ type: "bot.configure", botId: fresh.botId, primary: "claude" })).toMatchObject({ primary: "claude", primaryEffective: "claude" });
      expect(await c.call({ type: "bot.configure", botId: fresh.botId, primary: null })).toMatchObject({ primary: null, primaryEffective: "codex" });
      await c.call({ type: "bot.configure", botId: fresh.botId, primary: "claude", model: "haiku" });

      const result = await c.call({ type: "engineDefaults.applyAll", confirmed: true });
      expect(result.failed).toEqual([]);
      expect(result.applied).toBeGreaterThanOrEqual(2);
      for (const botId of [old.botId, fresh.botId]) {
        expect(await c.call({ type: "bot.settings", botId })).toMatchObject({ engines: ["claude", "codex"], model: "opus", efforts: { claude: "high", codex: "low", agy: null }, primary: null, primaryEffective: "codex" });
      }
      expect(existsSync(join(dir, "settings.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).defaultPrimaryEngine).toBe("codex");
    } finally { await c.kill(); }
  }, 60_000);
});
