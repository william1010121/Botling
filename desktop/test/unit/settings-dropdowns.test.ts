// @vitest-environment jsdom
// Settings' model, effort and permission choices (Settings → Models & workers, Permissions) and a bot's own settings
// panel. Models are dropdowns; in Settings efforts are segmented controls with only the engine's levels, in the bot panel
// dropdowns. Codex models come from `codex.models` (the local Codex's `model/list`); a saved model the list lacks stays.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { BotSettings, SettingsSheet } from "../../src/renderer/Settings";
import { claudeHint } from "../../src/renderer/ModelsWorkers";
import type { Client } from "../../src/renderer/client";
import type { BotSettingsView, BotView, PluginsView, SettingsChange, SettingsView } from "../../src/contract";
import { applySetting, settingsView } from "../../src/core/settings";
import summaries from "../../builtin-plugins/botling.catchup/package.json";
import { loadSettingsShell, type SettingsShell } from "../settings-shell";
// Settings draws only from the settings plugin's slots (M7-02d): a test that renders it loads the plugin as the shell does.
let settingsShell: SettingsShell;
beforeEach(async () => { settingsShell = await loadSettingsShell(); });
afterEach(async () => { await settingsShell.stop(); });

/** The Plugins view with botling.catchup on and its settings (Settings → Chat & reports draws them). */
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
/** Text into a controlled input, as typing does (the native setter, then an input event). */
const typeInto = async (input: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const press = async (input: HTMLElement, key: string, init: KeyboardEventInit = {}) => act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init })); });
const leave = async (input: HTMLElement) => act(async () => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
const box = (host: HTMLElement, label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}: custom model id"]`);
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
      expect(options(select(host, "Claude workers model"))).toEqual(["", "haiku", "sonnet", "opus", "__custom__"]);
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
      expect(options(select(host, "Component editor's model"))).toEqual(["haiku", "sonnet", "opus", "__custom__"]);
      await choose(select(host, "Component editor's model"), "opus");
      expect(sent.at(-1)).toMatchObject({ change: { key: "componentEditorModel", value: "opus" } });
    } finally { await done(); }
  });

  it("Models & workers: any Claude model id can be typed in (workers, head, component editor); a bad one is refused and not sent", async () => {
    const sent: any[] = [];
    const type = async (input: HTMLInputElement, text: string, key: string) => { await typeInto(input, text); await press(input, key); };
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({ subagentModelDefault: "claude-fable-5-2" }, sent), settings: null, bot: null, plugins: null, initialSection: "models", onClose() {} }));
    try {
      // A saved custom id shows as itself, beside the three quick picks.
      const workers = select(host, "Claude workers model");
      expect(workers.value).toBe("claude-fable-5-2");
      expect(options(workers)).toEqual(["", "haiku", "sonnet", "opus", "claude-fable-5-2", "__custom__"]);
      expect(host.querySelector('input[type="text"]')).toBeNull();
      // "Custom model…" opens a box; a value that is not a Claude model is refused with the reason and nothing is sent.
      const before = sent.length;
      await choose(workers, "__custom__");
      const box = () => host.querySelector<HTMLInputElement>('input[aria-label="Claude workers model: custom model id"]')!;
      expect(box().value).toBe("claude-fable-5-2");
      await type(box(), "gpt-6-luna", "Enter");
      expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Not a Claude model/);
      expect(sent.slice(before).filter((cmd) => cmd.type === "settings.set")).toEqual([]);
      // A full id is saved and the box closes, and the saved value is the list's selection.
      await type(box(), "claude-haiku-5-5", "Enter");
      expect(sent.at(-1)).toMatchObject({ type: "settings.set", change: { key: "subagentModel", value: "claude-haiku-5-5" } });
      expect(host.querySelector('input[type="text"]')).toBeNull();
      expect(select(host, "Claude workers model").value).toBe("claude-haiku-5-5");
      // Escape closes the box without saving.
      const count = sent.length;
      await choose(select(host, "Claude workers model"), "__custom__");
      await type(box(), "claude-opus-5-5", "Escape");
      expect(host.querySelector('input[type="text"]')).toBeNull();
      expect(sent.length).toBe(count);
      // The component editor's model takes one too.
      await choose(select(host, "Component editor's model"), "__custom__");
      await type(host.querySelector<HTMLInputElement>('input[aria-label="Component editor\'s model: custom model id"]')!, "claude-opus-5-5", "Enter");
      expect(sent.at(-1)).toMatchObject({ change: { key: "componentEditorModel", value: "claude-opus-5-5" } });
      // The guide and hints name no model version.
      expect(host.textContent).not.toMatch(/Opus 5\.5|opus\[1m\]/);
    } finally { await done(); }
  });

  it("Models & workers: the custom box saves on leaving only a valid id, Esc closes only the box, Enter during composition saves nothing, the head takes one too", async () => {
    const sent: any[] = [];
    let closed = 0;
    const { host, done } = await render(createElement(SettingsSheet, { client: fakeClient({}, sent), settings: null, bot: null, plugins: null, initialSection: "models", onClose() { closed++; } }));
    try {
      const saved = () => sent.filter((cmd) => cmd.type === "settings.set");
      const label = "Claude workers model";
      // Leaving the box with a valid id saves it; with one that is not Claude's saves nothing and says why.
      await choose(select(host, label), "__custom__");
      await typeInto(box(host, label)!, "claude-opus-5-5[1m]");
      await leave(box(host, label)!);
      expect(saved().at(-1)).toMatchObject({ change: { key: "subagentModel", value: "claude-opus-5-5[1m]" } });
      expect(box(host, label)).toBeNull();
      const count = saved().length;
      await choose(select(host, label), "__custom__");
      await typeInto(box(host, label)!, "gpt-6-luna");
      await leave(box(host, label)!);
      expect(saved().length).toBe(count);
      expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Not a Claude model/);
      // Enter while an input method is composing is not a save; the same Enter afterwards is.
      await typeInto(box(host, label)!, "claude-haiku-5-5");
      await press(box(host, label)!, "Enter", { isComposing: true });
      expect(saved().length).toBe(count);
      expect(box(host, label)).not.toBeNull();
      await press(box(host, label)!, "Enter");
      expect(saved().at(-1)).toMatchObject({ change: { key: "subagentModel", value: "claude-haiku-5-5" } });
      // Esc in the box closes the box and does not reach Settings' own Esc (which closes the sheet).
      await choose(select(host, label), "__custom__");
      await press(box(host, label)!, "Escape");
      expect(box(host, label)).toBeNull();
      expect(closed).toBe(0);
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(closed).toBe(1);
      // The head's model takes a custom id, saved as the app default for Claude.
      await choose(select(host, "Claude head model"), "__custom__");
      await typeInto(box(host, "Claude head model")!, "claude-fable-5-2");
      await press(box(host, "Claude head model")!, "Enter");
      expect(saved().at(-1)).toMatchObject({ change: { key: "defaultEngineModel", value: { engine: "claude", model: "claude-fable-5-2" } } });
    } finally { await done(); }
  });

  it("claudeHint: a family has its own line, any other id (even a name on Object's prototype) is named as it is", () => {
    expect(claudeHint("opus")).toBe("Claude Opus · strongest, highest cost");
    expect(claudeHint("claude-fable-5-2")).toContain("claude-fable-5-2");
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(claudeHint(name)).toBe(`${name} · a specific Claude model, as named`);
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

  it("Chat & reports: the catch-up switch and threshold, or how to turn them on", async () => {
    const sent: any[] = [];
    const client = fakeClient({}, sent);
    const sheet = (on: boolean) => createElement(SettingsSheet, { client, settings: null, bot: null, plugins: on ? plugins() : null, initialSection: "chat", onClose() {} });
    const { host, done, rerender } = await render(sheet(true));
    try {
      await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Fold unread replies when I come back"]')!.click());
      expect(sent.at(-1)).toMatchObject({ type: "plugins.setting", key: "botling.catchup.unread", value: false });
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Unread threshold"]')!.value).toBe("3");
      expect(select(host, "Publish as")).toBeDefined();
      await rerender(sheet(false));
      expect(host.querySelector('input[aria-label="Fold unread replies when I come back"]')).toBeNull();
      expect(host.textContent).toContain("Turn on the Catch-up plugin");
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
      expect(options(select(host, "Claude head model"))).toEqual(["", "haiku", "sonnet", "opus", "__custom__"]);
      // The old single effort shows for each engine that has none of its own.
      expect(select(host, "Claude head effort").value).toBe("high");
      expect(select(host, "Codex head effort").value).toBe("high");
      expect(options(select(host, "Claude workers' model"))).toEqual(["", "haiku", "sonnet", "opus", "__custom__"]);
      // A bot's own models take any Claude id too, a [1m] suffix included; one that is not Claude's is refused.
      await choose(select(host, "Claude head model"), "__custom__");
      await typeInto(box(host, "Claude head model")!, "claude-fable-5-2");
      await press(box(host, "Claude head model")!, "Enter");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", model: "claude-fable-5-2" });
      await choose(select(host, "Claude workers' model"), "__custom__");
      await typeInto(box(host, "Claude workers' model")!, "opus[1m]");
      await press(box(host, "Claude workers' model")!, "Enter");
      expect(sent.at(-1)).toEqual({ type: "bot.configure", botId: "main", subagentModel: "opus[1m]" });
      await choose(select(host, "Claude head model"), "__custom__");
      const asked = sent.length;
      await typeInto(box(host, "Claude head model")!, "gpt-6-luna");
      await press(box(host, "Claude head model")!, "Enter");
      expect(sent.length).toBe(asked);
      expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Not a Claude model/);
      await press(box(host, "Claude head model")!, "Escape");
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
