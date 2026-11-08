// The renderer's model of the redesigned Settings: its pages in four groups (older page ids still open the page that
// took their settings), and a bot's choices against the app's defaults ("App default" / "Own"), with the change that
// gives a bot the defaults again.
import { describe, expect, it } from "vitest";
import type { BotSettingsView, PluginsView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import { resolveSection, settingsNav } from "../../src/renderer/settings-pages";
import { defaultsChange, engineChoices, ownChoices, tokensLabel } from "../../src/renderer/bot-defaults";

describe("Settings' pages", () => {
  it("are four groups, with plugins' pages under Plugins", () => {
    const plugins = { settingsSections: [{ plugin: "meter", id: "meter.page", title: "Meter", terms: "quota rings", after: "engines", link: null }] } as unknown as PluginsView;
    expect(settingsNav(plugins).map((group) => [group.title, group.pages.map((page) => page.title)])).toEqual([
      ["App", ["General", "Appearance", "Shortcuts"]],
      ["Bots", ["Models & workers", "Permissions", "Chat & reports"]],
      ["Connect", ["Engine setup", "Plugins", "Meter", "Phone"]],
      ["Advanced", ["Updates", "Developer"]],
    ]);
    expect(settingsNav(plugins).flatMap((group) => group.pages).find((page) => page.title === "Meter")).toMatchObject({ id: "meter/meter.page", indent: true });
  });

  it("are found by the words of the settings on them; a group with none left is left out", () => {
    const found = (words: string) => settingsNav(null, words).flatMap((group) => group.pages.map((page) => page.id));
    expect(found("subagents")).toEqual(["models"]);
    expect(found("doctor")).toEqual(["setup"]);
    expect(found("yolo")).toEqual(["permissions"]);
    expect(found("dark")).toEqual(["appearance"]);
    expect(settingsNav(null, "nothing like this")).toEqual([]);
  });

  it("older page ids open the page that has their settings now", () => {
    expect(resolveSection("engines")).toBe("models");
    expect(resolveSection("doctor")).toBe("setup");
    expect(resolveSection("phone")).toBe("phone");
    expect(resolveSection("meter/meter.page")).toBe("meter/meter.page");
  });
});

const view = (over: Partial<BotSettingsView> = {}): BotSettingsView => ({ botId: "B", engines: ["claude", "codex", "agy"], model: null, effort: null, efforts: { claude: null, codex: null, agy: null }, subagentModel: null, codexModel: null, ...over } as BotSettingsView);

describe("a bot's choices against the app's defaults", () => {
  const app = settingsView({
    defaultEngineModels: { claude: "opus" }, defaultEfforts: { claude: "high" }, subagentModelDefault: "sonnet",
    codexWorkersFollow: false, codexWorkerChoice: { model: "gpt-6-luna", effort: "low", fast: true },
    agyWorkerModelDefault: "gemini-flash",
  });

  it("follows the defaults where its value is the default's, and is its own where not", () => {
    const same = view({ model: "opus", efforts: { claude: "high", codex: null, agy: null }, subagentModel: "sonnet", codexWorkers: { model: "gpt-6-luna", effort: "low", fast: true }, agyWorkerModel: "gemini-flash" });
    for (const engine of ["claude", "codex", "agy"] as const) expect(engineChoices(same, app, engine).filter((row) => row.own)).toEqual([]);
    expect(ownChoices(same, app)).toEqual([]);
    const own = view({ model: "haiku", efforts: { claude: "high", codex: null, agy: null }, subagentModel: "sonnet", codexWorkers: { model: "gpt-6-luna", effort: "low", fast: true }, agyWorkerModel: null, agyWorkerEffort: "low", primary: "codex" });
    expect(engineChoices(own, app, "claude").filter((row) => row.own)).toEqual([{ engine: "claude", field: "model", value: "haiku", appDefault: "opus", own: true }]);
    expect(engineChoices(own, app, "agy").filter((row) => row.own).map((row) => row.field)).toEqual(["workerModel", "workerEffort"]);
    expect(ownChoices(own, app)).toEqual(["Primary: Codex", "Claude head model: Haiku", "Antigravity workers’ model: Same as head", "Antigravity workers’ effort: Low"]);
  });

  it("compares Codex workers with none while the app follows config.toml", () => {
    const following = settingsView({ codexWorkersFollow: true, codexWorkerChoice: { model: "gpt-6-luna", effort: null, fast: null } });
    expect(engineChoices(view(), following, "codex").filter((row) => row.own)).toEqual([]);
    expect(engineChoices(view({ codexWorkers: { model: "gpt-6-luna", effort: null, fast: null } }), following, "codex").filter((row) => row.own).map((row) => row.field)).toEqual(["workerModel"]);
  });

  it("an old single effort counts as each engine's effort", () => {
    const old = view({ effort: "high" });
    expect(engineChoices(old, app, "claude").find((row) => row.field === "effort")).toMatchObject({ value: "high", own: false });
    expect(engineChoices(old, app, "codex").find((row) => row.field === "effort")).toMatchObject({ value: "high", own: true });
  });

  it("before the app's settings are known, nothing is marked own", () => {
    expect(engineChoices(view({ model: "haiku" }), null, "claude").some((row) => row.own)).toBe(false);
  });

  it("'Use app defaults' gives one engine the defaults; for every engine it also follows the app's primary", () => {
    expect(defaultsChange(view(), app, "claude")).toEqual({ efforts: { claude: "high" }, model: "opus", subagentModel: "sonnet", subagentEffort: null });
    expect(defaultsChange(view(), app, "codex")).toEqual({ efforts: { codex: null }, codexModel: null, codexWorkers: { model: "gpt-6-luna", effort: "low", fast: true } });
    expect(defaultsChange(view(), app, "agy")).toEqual({ efforts: { agy: null }, agyModel: null, agyWorkerModel: "gemini-flash", agyWorkerEffort: null });
    expect(defaultsChange(view(), app)).toMatchObject({ primary: null, efforts: { claude: "high", codex: null, agy: null }, model: "opus", codexWorkers: { model: "gpt-6-luna" }, agyWorkerModel: "gemini-flash" });
    // Codex workers with nothing chosen clear the bot's own choice.
    expect(defaultsChange(view(), settingsView({ codexWorkersFollow: true }), "codex").codexWorkers).toBeNull();
  });

  it("a bot still on the old single effort keeps the other engines' effort as their own", () => {
    expect(defaultsChange(view({ effort: "medium", efforts: { claude: null, codex: "xhigh", agy: null } }), app, "claude").efforts)
      .toEqual({ claude: "high", codex: "xhigh", agy: "medium" });
    expect(defaultsChange(view({ effort: "medium" }), app, "claude").effort).toBeNull();
  });

  it("names a token window as it is usually named", () => {
    expect(tokensLabel(300_000)).toBe("300K");
    expect(tokensLabel(1_000_000)).toBe("1M");
    expect(tokensLabel(1_500_000)).toBe("1.5M");
    expect(tokensLabel(800)).toBe("800");
  });
});
