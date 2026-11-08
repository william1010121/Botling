// @vitest-environment jsdom
// Settings' model, effort and permission choices (Settings → Models & workers, Permissions) and a bot's own settings
// panel. Models are dropdowns; in Settings efforts are segmented controls with only the engine's levels, in the bot panel
// dropdowns. Codex models come from `codex.models` (the local Codex's `model/list`); a saved model the list lacks stays.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { BotSettings, SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";
import type { BotSettingsView, BotView, PluginsView, SettingsChange, SettingsView } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";
import summaries from "../../builtin-plugins/botling.catchup/package.json";

/** The Plugins view with botling.catchup on and its settings (Settings → General → Chat summaries draws them). */
function plugins(values: Record<string, unknown> = {}): PluginsView {
  const settings = Object.entries(summaries.ccb.contributes.settings).map(([key, setting]) => ({
    key, type: setting.type, title: setting.title, options: (setting as { options?: string[] }).options ?? [], secret: false, set: true, hidden: true,
    default: setting.default as boolean | number | string, value: (key in values ? values[key] : setting.default) as boolean | number | string | null,
  }));
  return { plugins: [{ name: summaries.name, title: summaries.displayName, version: summaries.version, description: null, enabled: true, failure: null, installedFrom: null, builtIn: true, permissions: [], parts: ["web", "host"], settings, commands: [], panels: [] }], broken: [], host: { running: true, problem: null }, secretsProblem: null };
}

const MODELS = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", isDefault: true, efforts: null },
  { id: "gpt-6-sol", name: "GPT-6 Sol", isDefault: false, efforts: null },
];

function fakeClient(raw: Record<string, unknown>, sent: unknown[], botView?: BotSettingsView, extra: Partial<SettingsView> = {}) {
  let settings = raw;
  let bot = botView;
  return {
    request: async (cmd: any) => {
      sent.push(cmd);
      if (cmd.type === "engine.models") return {status:"ready", models:cmd.engine === "claude" ? ["haiku","sonnet","opus"].map(id=>({id,name:id,isDefault:false,efforts:null})) : MODELS,source:cmd.engine,message:"Runtime catalog"};
      if (cmd.type === "codex.models") return { models: MODELS };
      if (cmd.type === "agy.runtime.check") return { saved: null, override: null, effective: null, valid: false, message: "Runtime not configured." };
      if (cmd.type === "settings.get") return { ...settingsView(settings), ...extra };
      if (cmd.type === "settings.set") { settings = applySetting(settings, cmd.change as SettingsChange); return { ...settingsView(settings), ...extra }; }
      if (cmd.type === "bot.settings") return bot;
      if (cmd.type === "plugins.setting") return plugins({ [cmd.key]: cmd.value });
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
  return { host, rerender: async (next: ReturnType<typeof createElement>) => { await act(async () => root.render(next)); }, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}

const select = (host: HTMLElement, label: string) => {
  const found = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`no select ${label}`);
  return found;
};
const options = (element: HTMLSelectElement) => [...element.options].map((option) => option.value);
const radios = (host: HTMLElement, label: string) => {
  const group = host.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
  if (!group) throw new Error(`no radiogroup ${label}`);
  return [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
};
const pick = async (host: HTMLElement, label: string, text: string) => act(async () => radios(host, label).find((radio) => radio.textContent === text)!.click());
const tab = async (host: HTMLElement, name: string) => act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((one) => one.textContent?.startsWith(name))!.click());
const headings = (host: HTMLElement) => [...host.querySelectorAll(".settings-group-head > h3")].map((heading) => heading.textContent);
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("Settings' model, effort and permission choices", () => {
  it("Permissions: one two-step choice per engine, saved independently, with what each step means", async () => {
    const sent: any[] = [];
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({}, sent), settings: null, bot: null, plugins: null, initialSection: "permissions", onClose() {} }));
    try {
      expect(radios(host, "Claude permission").map((radio) => radio.textContent)).toEqual(["Auto", "Full access"]);
      expect(radios(host, "Codex permission").map((radio) => radio.textContent)).toEqual(["Auto", "Full access"]);
      expect(radios(host, "Antigravity permission").map((radio) => radio.textContent)).toEqual(["Ask", "Full access"]);
      const on = (label: string) => radios(host, label).find((radio) => radio.getAttribute("aria-checked") === "true")!.textContent;
      expect(on("Claude permission")).toBe("Auto");
      await pick(host, "Claude permission", "Full access");
      expect(on("Claude permission")).toBe("Full access");
      expect(on("Codex permission")).toBe("Auto");
      await pick(host, "Codex permission", "Full access");
      await pick(host, "Claude permission", "Auto");
      expect(on("Codex permission")).toBe("Full access");
      expect(sent.filter(c => c.type === "settings.set").map(c => c.change)).toEqual([
        { key: "claudeBypassPermissions", value: true }, { key: "codexBypassPermissions", value: true }, { key: "claudeBypassPermissions", value: false },
      ]);
      expect(host.textContent).toContain("Running sessions keep their mode");
      expect(host.textContent).toContain("file or network sandbox");
      expect(host.querySelector('section[aria-label="Codex permissions"]')!.textContent).toContain("In effect: Full access");
    } finally { await done(); }
  });

  it("Models & workers: Claude's and Codex's workers, the component editor", async () => {
    const sent: any[] = [];
    const raw = { codexWorkersFollow: false, codexWorkerChoice: { model: "gpt-5-old", effort: null, fast: null } };
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient(raw, sent, undefined, { claudeAutoCompactWindow: 300_000 }), settings: null, bot: null, plugins: null, initialSection: "models", onClose() {} }));
    try {
      expect(host.querySelector('input[type="text"]')).toBeNull();
      expect(options(select(host, "Claude workers model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      expect(radios(host, "Claude workers effort").map((radio) => radio.textContent)).toEqual(["Same", "Low", "Medium", "High", "Extra high", "Max"]);
      await pick(host, "Claude workers effort", "High");
      expect(sent.at(-1)).toMatchObject({ type: "settings.set", change: { key: "subagentEffort", value: "high" } });
      // The auto-compact window from ~/.claude/settings.json, read-only.
      expect(host.querySelector('[aria-label="Auto-compact window"]')?.textContent).toBe("300K");
      await tab(host, "Codex");
      // The Codex list, after "Same as head", and the saved model it does not have.
      const workers = select(host, "Codex workers model");
      expect(options(workers)).toEqual(["", "gpt-6-luna", "gpt-6-sol", "gpt-5-old"]);
      expect(workers.value).toBe("gpt-5-old");
      expect(workers.options[1].textContent).toBe("GPT-6 Luna (default)");
      await choose(workers, "gpt-6-sol");
      expect(sent.at(-1)).toMatchObject({ type: "settings.set", change: { key: "codexWorkers", value: { model: "gpt-6-sol" } } });
      expect(select(host, "Codex workers model").value).toBe("gpt-6-sol");
      expect(radios(host, "Codex workers effort").map((radio) => radio.textContent)).toEqual(["Same", "Low", "Medium", "High", "Extra high"]);
      await pick(host, "Codex workers effort", "Extra high");
      expect(sent.at(-1)).toMatchObject({ change: { key: "codexWorkers", value: { model: "gpt-6-sol", effort: "xhigh" } } });
      await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Codex workers fast mode"]')!.click());
      expect(sent.at(-1)).toMatchObject({ change: { key: "codexWorkers", value: { model: "gpt-6-sol", effort: "xhigh", fast: true } } });
      expect(options(select(host, "Component editor's model"))).toEqual(["haiku", "sonnet", "opus"]);
      await choose(select(host, "Component editor's model"), "opus");
      expect(sent.at(-1)).toMatchObject({ change: { key: "componentEditorModel", value: "opus" } });
    } finally { await done(); }
  });

  it("Models & workers: following config.toml shows what it says, read-only, instead of the workers' choices", async () => {
    const sent: any[] = [];
    const file = { model: "gpt-6-sol", effort: "high" as const, fast: true };
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({ codexWorkersFollow: true }, sent, undefined, { codexConfigFile: file }), settings: null, bot: null, plugins: null, initialSection: "models", onClose() {} }));
    try {
      await tab(host, "Codex");
      expect(host.querySelector('select[aria-label="Codex workers model"]')).toBeNull();
      expect(host.querySelector('[aria-label="Codex workers effort"]')).toBeNull();
      expect([...host.querySelectorAll('[aria-label="From config.toml"]')].map((cell) => cell.textContent)).toEqual(["gpt-6-sol", "High", "Fast"]);
      await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Follow ~/.codex/config.toml"]')!.click());
      expect(sent.at(-1)).toMatchObject({ change: { key: "codexWorkersFollow", value: false } });
      expect(host.querySelector('select[aria-label="Codex workers model"]')).not.toBeNull();
    } finally { await done(); }
  });

  it("Models & workers: Antigravity's workers have their own model and effort (Antigravity's levels only)", async () => {
    const sent: any[] = [];
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({}, sent), settings: null, bot: null, plugins: null, initialSection: "models", onClose() {} }));
    try {
      await tab(host, "Antigravity");
      expect(host.textContent).toContain("Workers: Preview");
      expect(radios(host, "Antigravity workers effort").map((radio) => radio.textContent)).toEqual(["Same", "Low", "Medium", "High"]);
      await pick(host, "Antigravity workers effort", "Low");
      expect(sent.at(-1)).toMatchObject({ type: "settings.set", change: { key: "agyWorkerEffort", value: "low" } });
      await pick(host, "Antigravity workers effort", "Same");
      expect(sent.at(-1)).toMatchObject({ type: "settings.set", change: { key: "agyWorkerEffort", value: null } });
      expect(select(host, "Antigravity workers model").options[0].textContent).toBe("Same as head");
    } finally { await done(); }
  });

  it("Models & workers: the summary model is picked from every engine's models, grouped by engine", async () => {
    const sent: any[] = [];
    const client = fakeClient({}, sent);
    const sheet = (values: Record<string, unknown> | null = {}) => createElement(SettingsSheet, { client, settings: null, bot: null, plugins: values ? plugins(values) : null, initialSection: "models", onClose() {} });
    const { host, done, rerender } = await render(sheet());
    try {
      const summary = select(host, "Summary model");
      expect(options(summary)).toEqual(["claude:haiku", "claude:sonnet", "claude:opus", "codex:gpt-6-luna", "codex:gpt-6-sol"]);
      expect(summary.value).toBe("codex:gpt-6-luna");
      expect([...summary.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Claude", "Codex"]);
      await choose(summary, "codex:gpt-6-sol");
      expect(sent.slice(-2)).toMatchObject([
        { type: "plugins.setting", name: "botling.catchup", key: "botling.catchup.model", value: "gpt-6-sol" },
        { type: "plugins.setting", name: "botling.catchup", key: "botling.catchup.engine", value: "codex" },
      ]);
      await choose(select(host, "Summary model"), "claude:sonnet");
      expect(sent.slice(-2)).toMatchObject([{ key: "botling.catchup.model", value: "sonnet" }, { key: "botling.catchup.engine", value: "claude" }]);
      // What the plugin keeps comes back in its view.
      await rerender(sheet({ "botling.catchup.model": "sonnet", "botling.catchup.engine": "claude" }));
      expect(select(host, "Summary model").value).toBe("claude:sonnet");
      // Off, the plugin's settings are not drawn.
      await rerender(sheet(null));
      expect(host.querySelector('select[aria-label="Summary model"]')).toBeNull();
    } finally { await done(); }
  });

  it("Models & workers: with a bot to ask, Antigravity's models are listed for summaries but disabled, with the reason", async () => {
    const sent: any[] = [];
    const bot = { id: "11111111-1111-4111-8111-111111111111", heads: ["claude", "codex", "agy"] } as unknown as BotView;
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({}, sent), settings: null, bot, plugins: plugins(), initialSection: "models", onClose() {} }));
    try {
      const summary = select(host, "Summary model");
      const agy = [...summary.options].filter((option) => option.value.startsWith("agy:"));
      expect(agy.length).toBeGreaterThan(0);
      expect(agy.every((option) => option.disabled)).toBe(true);
      expect([...summary.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Claude", "Codex", "Antigravity (not available for summaries)"]);
      expect(host.textContent).toContain("Antigravity models can't write summaries");
    } finally { await done(); }
  });

  it("Chat & reports: the summaries' options, or how to turn them on", async () => {
    const sent: any[] = [];
    const client = fakeClient({}, sent);
    const sheet = (on: boolean) => createElement(SettingsSheet, { client, settings: null, bot: null, plugins: on ? plugins() : null, initialSection: "chat", onClose() {} });
    const { host, done, rerender } = await render(sheet(true));
    try {
      await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Summarize between your messages"]')!.click());
      expect(sent.at(-1)).toMatchObject({ type: "plugins.setting", key: "botling.catchup.interval", value: true });
      expect(select(host, "Publish as")).toBeDefined();
      await rerender(sheet(false));
      expect(host.querySelector('input[aria-label="Summarize between your messages"]')).toBeNull();
      expect(host.textContent).toContain("Turn on the Chat summaries plugin");
    } finally { await done(); }
  });

  it("a bot's own head and workers' model and effort, per engine", async () => {
    const sent: any[] = [];
    const bot = { id: "main", name: "Main bot", heads: ["claude", "codex"], phase: "asleep" } as unknown as BotView;
    const view: BotSettingsView = { botId: "main", engines: ["claude", "codex"], model: null, effort: "high", subagentModel: null, codexModel: "gpt-5-old" };
    const { host, done } = await render(createElement(BotSettings, { client: fakeClient({}, sent, view), bot }));
    try {
      expect(host.querySelectorAll(".segmented")).toHaveLength(0);
      expect(headings(host)).toEqual(["Engines in this bot", "Primary engine", "Claude", "Codex"]);
      const where = (label: string) => select(host, label).closest("section")?.getAttribute("aria-label");
      expect(where("Claude head model")).toBe("Claude");
      expect(where("Claude workers' model")).toBe("Claude");
      expect(where("Codex head model")).toBe("Codex");
      expect(where("Codex workers' model")).toBe("Codex");
      expect(where("Claude head effort")).toBe("Claude");
      expect(where("Codex head effort")).toBe("Codex");
      expect(options(select(host, "Codex head effort"))).toEqual(["", "low", "medium", "high", "xhigh"]);
      expect(options(select(host, "Claude head model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      // The old single effort shows for each engine that has none of its own.
      expect(select(host, "Claude head effort").value).toBe("high");
      expect(select(host, "Codex head effort").value).toBe("high");
      expect(options(select(host, "Claude workers' model"))).toEqual(["", "haiku", "sonnet", "opus"]);
      expect(options(select(host, "Codex head model"))).toEqual(["", "gpt-5-old", "gpt-6-luna", "gpt-6-sol"]);
      await choose(select(host, "Claude head model"), "opus");
      expect(sent.at(-1)).toMatchObject({ type: "bot.configure", model: "opus" });
      await choose(select(host, "Claude workers' model"), "sonnet");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentModel: "sonnet" });
      await choose(select(host, "Claude workers' model"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentModel: null });
      await choose(select(host, "Codex head model"), "gpt-6-sol");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", codexModel: "gpt-6-sol" });
      await choose(select(host, "Codex head model"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", codexModel: null });
      await choose(select(host, "Codex head effort"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", efforts: { codex: null } });
      await choose(select(host, "Claude head effort"), "max");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", efforts: { claude: "max" } });
      expect(options(select(host, "Claude workers' effort"))).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
      await choose(select(host, "Claude workers' effort"), "xhigh");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentEffort: "xhigh" });
      await choose(select(host, "Claude workers' effort"), "");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentEffort: null });
      // The Codex workers' own choice, as one value.
      await choose(select(host, "Codex workers' model"), "gpt-6-luna");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", codexWorkers: { model: "gpt-6-luna", effort: null, fast: null } });
      await choose(select(host, "Codex workers' fast mode"), "fast");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", codexWorkers: { model: "gpt-6-luna", effort: null, fast: true } });
    } finally { await done(); }
  });

  it("a bot's Antigravity workers' model and effort (Preview)", async () => {
    const sent: any[] = [];
    const bot = { id: "main", name: "Main bot", heads: ["agy"], phase: "asleep" } as unknown as BotView;
    const view: BotSettingsView = { botId: "main", engines: ["agy"], model: null, effort: null, subagentModel: null, codexModel: null, agyModel: null };
    const { host, done } = await render(createElement(BotSettings, { client: fakeClient({ agyWorkerEffortDefault: "high" }, sent, view), bot }));
    try {
      const section = host.querySelector('section[aria-label="Antigravity"]')!;
      expect(section.textContent).toContain("Workers: Preview");
      expect(options(select(host, "Antigravity workers' effort"))).toEqual(["", "low", "medium", "high"]);
      // The app gives workers High; this bot has none, so it is its own choice against that default.
      expect(select(host, "Antigravity workers' effort").closest(".settings-row")!.textContent).toContain("Own · app default: High");
      await choose(select(host, "Antigravity workers' effort"), "low");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", agyWorkerEffort: "low" });
      await choose(select(host, "Antigravity workers' model"), "gpt-6-sol");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", agyWorkerModel: "gpt-6-sol" });
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Antigravity: use app defaults"]')!.click());
      expect(sent.at(-1)).toMatchObject({ type: "bot.configure", botId: "main", agyModel: null, agyWorkerModel: null, agyWorkerEffort: "high", efforts: { agy: null } });
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
      expect(headings(host)).toEqual(["Engines in this bot", name(engine)]);
      const active = host.querySelector<HTMLInputElement>(`input[aria-label="${name(engine)}"]`)!;
      const inactive = host.querySelector<HTMLInputElement>(`input[aria-label="${name(other)}"]`)!;
      expect(active.checked).toBe(true);
      expect(active.disabled).toBe(true);
      expect(inactive.checked).toBe(false);
      expect(inactive.disabled).toBe(false);
      await choose(select(host, `${name(engine)} head effort`), "high");
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
