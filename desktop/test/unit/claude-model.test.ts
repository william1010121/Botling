// The one check for "is a Claude model" (src/contract/claude-model.ts) and where it is used: the contract's settings
// changes, settings.json's round trip, and the component editor's saved model. A new full id needs no code change.
import { describe, expect, it } from "vitest";
import { CLAUDE_MODEL_ALIASES, claudeModelOrNull, isClaudeModel } from "../../src/contract/claude-model";
import { SettingsChange, SettingsView } from "../../src/contract/views-settings";
import { applySetting, DEFAULT_COMPONENT_EDITOR_MODEL, settingsView } from "../../src/core/settings";

describe("isClaudeModel", () => {
  it("takes the three aliases and any full claude-* id, so a new model needs no code change", () => {
    expect(CLAUDE_MODEL_ALIASES).toEqual(["haiku", "sonnet", "opus"]);
    for (const model of ["haiku", "sonnet", "opus", "claude-fable-5-2", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-3.5-sonnet"]) expect(isClaudeModel(model), model).toBe(true);
  });

  it("refuses anything else: other engines' ids, odd spellings, injection, non-strings", () => {
    for (const model of ["", " ", "gpt-6-luna", "Opus", "claude", "claude-", "claude-Opus", "claude-opus 5", "claude-opus\nmodel: x", "sonnet ", "claude-" + "a".repeat(101), "-claude-x"]) {
      expect(isClaudeModel(model), JSON.stringify(model)).toBe(false);
    }
    for (const value of [null, undefined, 3, {}, ["opus"], true]) expect(isClaudeModel(value)).toBe(false);
    // The id after "claude-" is at most 100 characters.
    expect(isClaudeModel("claude-" + "a".repeat(100))).toBe(true);
    expect(isClaudeModel("claude-" + "a".repeat(101))).toBe(false);
  });

  it("claudeModelOrNull keeps a model and drops the rest", () => {
    expect(claudeModelOrNull("claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(claudeModelOrNull("gpt-6")).toBeNull();
    expect(claudeModelOrNull(undefined)).toBeNull();
  });
});

describe("settings take any Claude model", () => {
  it("the contract accepts a custom id for the workers' and the component editor's model, and refuses a bad one", () => {
    expect(SettingsChange.safeParse({ key: "subagentModel", value: "claude-fable-5-2" }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "subagentModel", value: "haiku" }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "subagentModel", value: null }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "componentEditorModel", value: "claude-opus-5-5" }).success).toBe(true);
    expect(SettingsChange.safeParse({ key: "subagentModel", value: "gpt-6-luna" }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "componentEditorModel", value: "" }).success).toBe(false);
    expect(SettingsChange.safeParse({ key: "componentEditorModel", value: null }).success).toBe(false);
  });

  it("a custom id survives the round trip through settings.json and the settings view", () => {
    const raw = applySetting(applySetting({}, { key: "subagentModel", value: "claude-fable-5-2" }), { key: "componentEditorModel", value: "claude-haiku-5-5" });
    expect(raw).toMatchObject({ subagentModelDefault: "claude-fable-5-2", componentEditorModel: "claude-haiku-5-5" });
    const view = settingsView(JSON.parse(JSON.stringify(raw)));
    expect(view).toMatchObject({ subagentModel: "claude-fable-5-2", componentEditorModel: "claude-haiku-5-5" });
    expect(SettingsView.parse(view)).toMatchObject({ subagentModel: "claude-fable-5-2", componentEditorModel: "claude-haiku-5-5" });
  });

  it("aliases still work, and a stored value that is not a Claude model falls back to its default (data written before stays readable)", () => {
    expect(settingsView({ subagentModelDefault: "opus", componentEditorModel: "haiku" })).toMatchObject({ subagentModel: "opus", componentEditorModel: "haiku" });
    const bad = settingsView({ subagentModelDefault: "gpt-6-luna", componentEditorModel: 7 });
    expect(bad).toMatchObject({ subagentModel: null, componentEditorModel: DEFAULT_COMPONENT_EDITOR_MODEL });
    expect(DEFAULT_COMPONENT_EDITOR_MODEL).toBe("sonnet");
    expect(settingsView({}).componentEditorModel).toBe("sonnet");
  });
});
