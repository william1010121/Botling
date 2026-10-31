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
      if (cmd.type === "engine.models") return {status:"ready", models:cmd.engine === "claude" ? ["haiku","sonnet","opus"].map(id=>({id,name:id,isDefault:false,efforts:null})) : MODELS,source:cmd.engine,message:"Runtime catalog"};
      if (cmd.type === "codex.models") return { models: MODELS };
      if (cmd.type === "agy.runtime.check") return { saved: null, override: null, effective: null, valid: false, message: "Runtime not configured." };
      if (cmd.type === "settings.get") return settingsView(settings);
      if (cmd.type === "settings.set") { settings = applySetting(settings, cmd.change as SettingsChange); return settingsView(settings); }
      if (cmd.type === "bot.settings") return bot;
      if (cmd.type === "heads.set") { bot = { ...bot!, engines: cmd.engines }; return {}; }
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
  it("saves independent permission switches and explains running-session behavior", async () => {
    const sent: any[] = [];
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({}, sent), settings: null, bot: null, plugins: null, initialSection: "engines", onClose() {} }));
    try {
      const claude = host.querySelector<HTMLInputElement>('input[aria-label="Claude: bypass permission checks"]')!;
      const codex = host.querySelector<HTMLInputElement>('input[aria-label="Codex: bypass approvals and sandbox"]')!;
      expect(claude.checked).toBe(false);
      expect(codex.checked).toBe(false);
      await act(async () => claude.click());
      expect(claude.checked).toBe(true);
      expect(codex.checked).toBe(false);
      await act(async () => codex.click());
      expect(codex.checked).toBe(true);
      await act(async () => claude.click());
      expect(codex.checked).toBe(true);
      expect(sent.filter(c => c.type === "settings.set").map(c => c.change)).toEqual([
        { key: "claudeBypassPermissions", value: true }, { key: "codexBypassPermissions", value: true }, { key: "claudeBypassPermissions", value: false },
      ]);
      expect(host.textContent).toContain("Running sessions keep their current mode");
      expect(host.textContent).toContain("filesystem/network sandbox");
    } finally { await done(); }
  });

  it("Engines: subagents, Codex workers, verification and component editor", async () => {
    const sent: any[] = [];
    const raw = { codexWorkersFollow: false, codexWorkerChoice: { model: "gpt-5-old", effort: null, fast: null } };
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient(raw, sent), settings: null, bot: null, plugins: null, initialSection: "engines", onClose() {} }));
    try {
      expect(host.querySelectorAll(".segmented")).toHaveLength(0);
      expect(host.querySelector('input[type="text"]:not([aria-label="Official ACP runtime path"])')).toBeNull();
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
      expect([...host.querySelectorAll(".settings-group > h3")].map((heading) => heading.textContent))
        .toEqual(["Engines in this bot", "Primary engine", "Claude", "Codex"]);
      expect(select(host, "Claude's model").closest("section")?.getAttribute("aria-label")).toBe("Claude");
      expect(select(host, "Claude subagents' model").closest("section")?.getAttribute("aria-label")).toBe("Claude");
      expect(select(host, "Codex's model").closest("section")?.getAttribute("aria-label")).toBe("Codex");
      expect(select(host, "Claude thinking effort").closest("section")?.getAttribute("aria-label")).toBe("Claude");
      expect(select(host, "Codex thinking effort").closest("section")?.getAttribute("aria-label")).toBe("Codex");
      expect(options(select(host, "Codex thinking effort"))).toEqual(["", "low", "medium", "high", "xhigh"]);
      expect(options(select(host, "Claude's model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      // The old single effort shows for each engine that has none of its own.
      expect(select(host, "Claude thinking effort").value).toBe("high");
      expect(select(host, "Codex thinking effort").value).toBe("high");
      expect(options(select(host, "Claude subagents' model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      expect(options(select(host, "Codex's model"))).toEqual(["", "gpt-5-old", "gpt-6-luna", "gpt-6-sol"]);
      await choose(select(host, "Claude's model"), "opus");
      expect(sent.at(-1)).toMatchObject({ type: "bot.configure", model: "opus" });
      await choose(select(host, "Claude subagents' model"), "sonnet");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentModel: "sonnet" });
      await choose(select(host, "Claude subagents' model"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentModel: null });
      await choose(select(host, "Codex's model"), "gpt-6-sol");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", codexModel: "gpt-6-sol" });
      await choose(select(host, "Codex's model"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", codexModel: null });
      await choose(select(host, "Codex thinking effort"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", efforts: { codex: null } });
      await choose(select(host, "Claude thinking effort"), "max");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", efforts: { claude: "max" } });
    } finally { await done(); }
  });

  it.each(["claude", "codex"] as const)("a %s-only bot shows its own settings and can enable the other engine", async (engine) => {
    const other = engine === "claude" ? "codex" : "claude";
    const name = (value: string) => value === "claude" ? "Claude" : "Codex";
    const sent: any[] = [];
    const bot = { id: "main", name: "Main bot", heads: [engine], phase: "asleep" } as unknown as BotView;
    const view: BotSettingsView = { botId: "main", engines: [engine], model: "opus", effort: "medium", subagentModel: null, codexModel: null };
    const { host, done } = await render(createElement(BotSettings, { client: fakeClient({}, sent, view), bot }));
    try {
      expect([...host.querySelectorAll(".settings-group > h3")].map((heading) => heading.textContent))
        .toEqual(["Engines in this bot", name(engine)]);
      const active = host.querySelector<HTMLInputElement>(`input[aria-label="${name(engine)}"]`)!;
      const inactive = host.querySelector<HTMLInputElement>(`input[aria-label="${name(other)}"]`)!;
      expect(active.checked).toBe(true);
      expect(active.disabled).toBe(true);
      expect(inactive.checked).toBe(false);
      expect(inactive.disabled).toBe(false);
      await choose(select(host, `${name(engine)} thinking effort`), "high");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", efforts: { [engine]: "high" } });
      await act(async () => inactive.click());
      expect(sent).toContainEqual({ type: "heads.set", botId: "main", engines: [engine, other] });
      expect(host.querySelector('section[aria-label="Claude"]')).not.toBeNull();
      expect(host.querySelector('section[aria-label="Codex"]')).not.toBeNull();
    } finally { await done(); }
  });

  it.each(["asleep", "switching"] as const)("dual-engine toggles retain their guards while %s", async (phase) => {
    const sent: any[] = [];
    const bot = { id: "main", name: "Main bot", heads: ["claude", "codex"], phase } as unknown as BotView;
    const view: BotSettingsView = { botId: "main", engines: ["claude", "codex"], model: null, effort: null, subagentModel: null, codexModel: null };
    const { host, done } = await render(createElement(BotSettings, { client: fakeClient({}, sent, view), bot }));
    try {
      const claude = host.querySelector<HTMLInputElement>('input[aria-label="Claude"]')!;
      const codex = host.querySelector<HTMLInputElement>('input[aria-label="Codex"]')!;
      expect(claude.disabled).toBe(phase === "switching");
      expect(codex.disabled).toBe(phase === "switching");
      await act(async () => claude.click());
      if (phase === "switching") {
        expect(sent.filter((cmd) => cmd.type === "heads.set")).toEqual([]);
      } else {
        expect(sent).toContainEqual({ type: "heads.set", botId: "main", engines: ["codex"] });
        expect(host.querySelector('section[aria-label="Claude"]')).toBeNull();
        expect(host.querySelector('section[aria-label="Codex"]')).not.toBeNull();
      }
    } finally { await done(); }
  });
});
