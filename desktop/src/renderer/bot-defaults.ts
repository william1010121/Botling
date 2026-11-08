// A bot's model choices next to the app's defaults (Settings → Models & workers): which of its values are its own
// (differ from the default) and which follow it, for the bot's settings panel ("App default" / "Own · app default: …")
// and the one line "N bots use their own settings". "Use app defaults" is the bot.configure change that gives a bot the
// defaults again. Nothing here changes how defaults reach bots (server.ts and bot.ts keep that).
import type { BotSettingsView, Command, SettingsView } from "../contract";

export type EngineId = "claude" | "codex" | "agy";
export const ENGINE_NAMES: Record<EngineId, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };
export type ChoiceField = "model" | "effort" | "workerModel" | "workerEffort" | "workerFast";
export type ChoiceRow = { engine: EngineId; field: ChoiceField; value: string | boolean | null; appDefault: string | boolean | null; own: boolean };
export type ConfigureChange = Omit<Extract<Command, { type: "bot.configure" }>, "type" | "botId">;

const MODEL_NAMES: Record<string, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
const EFFORT_NAMES: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const FIELD_LABELS: Record<ChoiceField, string> = { model: "Head model", effort: "Head effort", workerModel: "Workers’ model", workerEffort: "Workers’ effort", workerFast: "Workers’ fast mode" };

/** The Codex workers' choice the app gives bots: none while it follows ~/.codex/config.toml. */
export function appCodexWorkers(settings: SettingsView): { model: string | null; effort: string | null; fast: boolean | null } {
  return settings.codexWorkersFollow ? { model: null, effort: null, fast: null } : { model: settings.codexWorkers.model, effort: settings.codexWorkers.effort, fast: settings.codexWorkers.fast };
}

/** How a value reads: a model's name, an effort's, or what null means for that field. */
export function choiceLabel(engine: EngineId, field: ChoiceField, value: string | boolean | null): string {
  if (field === "workerFast") return value === true ? "Fast" : value === false ? "Standard" : "Same as head";
  if (value === null || value === "") return field === "model" ? `${ENGINE_NAMES[engine]} default` : field === "effort" ? "Default" : "Same as head";
  const text = String(value);
  return field === "effort" || field === "workerEffort" ? EFFORT_NAMES[text] ?? text : engine === "claude" ? MODEL_NAMES[text] ?? text : text;
}

/** Stands in for the app's settings before they are known (every default null). */
const UNKNOWN = {
  engineDefaults: { engines: [], primary: null, models: { claude: null, codex: null, agy: null }, efforts: { claude: null, codex: null, agy: null } },
  subagentModel: null, subagentEffort: null, codexWorkers: { model: null, effort: null, fast: null }, codexWorkersFollow: false, agyWorkerModel: null, agyWorkerEffort: null,
} as unknown as SettingsView;
const same = (a: string | boolean | null | undefined, b: string | boolean | null | undefined) => (a ?? null) === (b ?? null);
const row = (engine: EngineId, field: ChoiceField, value: string | boolean | null | undefined, appDefault: string | boolean | null | undefined): ChoiceRow =>
  ({ engine, field, value: value ?? null, appDefault: appDefault ?? null, own: !same(value, appDefault) });

/** One engine's head and workers choices of a bot, each against the app's default (none known yet: none is marked own). */
export function engineChoices(view: BotSettingsView, settings: SettingsView | null, engine: EngineId): ChoiceRow[] {
  if (!settings) return engineChoices(view, UNKNOWN, engine).map((choice) => ({ ...choice, appDefault: null, own: false }));
  const defaults = settings.engineDefaults;
  const effort = view.efforts?.[engine] ?? view.effort ?? null;
  if (engine === "claude") return [
    row(engine, "model", view.model, defaults.models.claude), row(engine, "effort", effort, defaults.efforts.claude),
    row(engine, "workerModel", view.subagentModel, settings.subagentModel), row(engine, "workerEffort", view.subagentEffort, settings.subagentEffort),
  ];
  if (engine === "codex") {
    const app = appCodexWorkers(settings), own = view.codexWorkers ?? { model: null, effort: null, fast: null };
    return [
      row(engine, "model", view.codexModel, defaults.models.codex), row(engine, "effort", effort, defaults.efforts.codex),
      row(engine, "workerModel", own.model, app.model), row(engine, "workerEffort", own.effort, app.effort), row(engine, "workerFast", own.fast, app.fast),
    ];
  }
  return [
    row(engine, "model", view.agyModel, defaults.models.agy), row(engine, "effort", effort, defaults.efforts.agy),
    row(engine, "workerModel", view.agyWorkerModel, settings.agyWorkerModel), row(engine, "workerEffort", view.agyWorkerEffort, settings.agyWorkerEffort),
  ];
}

/** What a bot sets its own way, in short ("Claude workers’ model: Sonnet"), for the engines it has and its primary. */
export function ownChoices(view: BotSettingsView, settings: SettingsView): string[] {
  const words: string[] = [];
  if (view.primary) words.push(`Primary: ${ENGINE_NAMES[view.primary]}`);
  for (const engine of view.engines) {
    for (const choice of engineChoices(view, settings, engine)) {
      if (choice.own) words.push(`${ENGINE_NAMES[engine]} ${FIELD_LABELS[choice.field].toLowerCase()}: ${choiceLabel(engine, choice.field, choice.value)}`);
    }
  }
  return words;
}

/**
 * The bot.configure change that gives a bot the app's defaults again: one engine's head and workers choices, or (no
 * engine) every engine's and its primary (it follows the app's again). A bot still on the old single effort keeps the
 * other engines' effective efforts as their own, so only the engine asked about changes.
 */
export function defaultsChange(view: BotSettingsView, settings: SettingsView, engine?: EngineId): ConfigureChange {
  const defaults = settings.engineDefaults;
  const engines: EngineId[] = engine ? [engine] : ["claude", "codex", "agy"];
  const change: ConfigureChange = {};
  const efforts: Partial<Record<EngineId, BotSettingsView["effort"]>> = {};
  if (view.effort) {
    change.effort = null;
    for (const other of ["claude", "codex", "agy"] as const) if (!engines.includes(other)) efforts[other] = (view.efforts?.[other] ?? view.effort) as BotSettingsView["effort"];
  }
  for (const one of engines) efforts[one] = defaults.efforts[one];
  change.efforts = efforts;
  if (engines.includes("claude")) Object.assign(change, { model: defaults.models.claude, subagentModel: settings.subagentModel, subagentEffort: settings.subagentEffort });
  if (engines.includes("codex")) {
    const app = appCodexWorkers(settings);
    Object.assign(change, { codexModel: defaults.models.codex, codexWorkers: app.model || app.effort || app.fast !== null ? app : null });
  }
  if (engines.includes("agy")) Object.assign(change, { agyModel: defaults.models.agy, agyWorkerModel: settings.agyWorkerModel, agyWorkerEffort: settings.agyWorkerEffort });
  if (!engine) change.primary = null;
  return change;
}

/** "300K", "1M": a token count as the window is usually named. */
export function tokensLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
