// @vitest-environment jsdom
// Every model and reasoning-effort choice in Settings (and a bot's own settings) is a dropdown. Codex models
// come from `codex.models` (the local Codex's `model/list`); a saved model the list lacks stays as an option.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { BotSettings, SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";
import type { BotSettingsView, BotView, SettingsChange, SettingsView } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";

const MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", isDefault: true, efforts: null },
  { id: "gpt-6-sol", name: "GPT-6 Sol", isDefault: false, efforts: null },
];

function fakeClient(raw: Record<string, unknown>, sent: unknown[], botView?: BotSettingsView) {
  let settings = raw;
  let bot = botView;
  return {
    request: async (cmd: any) => {
      sent.push(cmd);
      if (cmd.type === "codex.models") return { models: MODELS };
      if (cmd.type === "settings.get") return settingsView(settings);
      if (cmd.type === "settings.set") { settings = applySetting(settings, cmd.change as SettingsChange); return settingsView(settings); }
      if (cmd.type === "bot.settings") return bot;
      if (cmd.type === "bot.configure") { const { type: _type, botId: _id, ...change } = cmd; bot = { ...bot!, ...change }; return bot; }
      throw new Error(`unexpected ${cmd.type}`);
    },
  } as unknown as Client;
}

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(element));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}

const select = (host: HTMLElement, label: string) => {
  const found = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`no select ${label}`);
  return found;
};
const options = (element: HTMLSelectElement) => [...element.options].map((option) => option.value);
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("Settings' model and effort choices are dropdowns", () => {
  it("Engines: subagents, Codex workers, verification and component editor", async () => {
    const sent: any[] = [];
    const raw = { codexWorkersFollow: false, codexWorkerChoice: { model: "gpt-5-old", effort: null, fast: null }, completionVerificationEnabledChoice: false };
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient(raw, sent), settings: null, bot: null, plugins: null, initialSection: "engines", onClose() {} }));
    try {
      expect(host.querySelectorAll(".segmented")).toHaveLength(0);
      expect(host.querySelector('input[type="text"]')).toBeNull();
      expect(options(select(host, "Subagents' model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      // The Codex list, after "Same as bot", and the saved model it does not have.
      const workers = select(host, "Workers' model");
      expect(options(workers)).toEqual(["", "gpt-6-luna", "gpt-6-sol", "gpt-5-old"]);
      expect(workers.value).toBe("gpt-5-old");
      expect(workers.options[1].textContent).toBe("GPT-6 Luna (default)");
      await choose(workers, "gpt-6-sol");
      expect(sent.at(-1)).toMatchObject({ type: "settings.set", change: { key: "codexWorkers", value: { model: "gpt-6-sol" } } });
      expect(select(host, "Workers' model").value).toBe("gpt-6-sol");
      const effort = select(host, "Workers' reasoning effort");
      expect(options(effort)).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
      await choose(effort, "xhigh");
      expect(sent.at(-1)).toMatchObject({ change: { key: "codexWorkers", value: { model: "gpt-6-sol", effort: "xhigh" } } });
      const verification = select(host, "Verification model");
      expect(verification.disabled).toBe(true);
      expect(verification.value).toBe("gpt-6-luna");
      expect(options(select(host, "Component editor's model"))).toEqual(["haiku", "sonnet", "opus"]);
      await choose(select(host, "Component editor's model"), "opus");
      expect(sent.at(-1)).toMatchObject({ change: { key: "componentEditorModel", value: "opus" } });
    } finally { await done(); }
  });

  it("following the Codex config file disables the workers' choices", async () => {
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({ codexWorkersFollow: true }, []), settings: null, bot: null, plugins: null, initialSection: "engines", onClose() {} }));
    try {
      expect(select(host, "Workers' model").disabled).toBe(true);
      expect(select(host, "Workers' reasoning effort").disabled).toBe(true);
    } finally { await done(); }
  });

  it("General: the summary model is a Codex model", async () => {
    const sent: any[] = [];
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({}, sent), settings: null, bot: null, plugins: null, initialSection: "general", onClose() {} }));
    try {
      const summary = select(host, "Summary model");
      expect(options(summary)).toEqual(["gpt-6-luna", "gpt-6-sol"]);
      await choose(summary, "gpt-6-sol");
      expect(sent.at(-1)).toMatchObject({ change: { key: "catchUpModel", value: "gpt-6-sol" } });
    } finally { await done(); }
  });

  it("a bot's own model, effort, subagents' model and Codex model", async () => {
    const sent: any[] = [];
    const bot = { id: "main", name: "Main bot", heads: ["claude", "codex"], phase: "asleep" } as unknown as BotView;
    const view: BotSettingsView = { botId: "main", engines: ["claude", "codex"], model: null, effort: "high", subagentModel: null, codexModel: "gpt-5-old" };
    const { host, done } = await render(createElement(BotSettings, { client: fakeClient({}, sent, view), bot }));
    try {
      expect(host.querySelectorAll(".segmented")).toHaveLength(0);
      expect(options(select(host, "Claude's model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      expect(select(host, "Reasoning effort").value).toBe("high");
      expect(options(select(host, "This bot's subagents' model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      expect(options(select(host, "Codex's model"))).toEqual(["", "gpt-6-luna", "gpt-6-sol", "gpt-5-old"]);
      await choose(select(host, "Claude's model"), "opus");
      expect(sent.at(-1)).toMatchObject({ type: "bot.configure", model: "opus" });
      await choose(select(host, "Reasoning effort"), "");
      expect(sent.at(-1)).toMatchObject({ type: "bot.configure", effort: null });
    } finally { await done(); }
  });
});
