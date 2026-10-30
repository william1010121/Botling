// The app's engine defaults (Settings → Engines and models): which engines a bot has, which of them
// gets a message unless the bot says otherwise, each engine's model and one reasoning effort. They are
// what a new bot starts with, the fallback for a bot with no primary of its own, and what "Apply to all
// bots" writes into every bot. Kept in settings.json (`defaultEngines`, `defaultPrimaryEngine`,
// `defaultEngineModels`, `defaultEffort`); a key that is absent means "as before": Claude only, no
// primary chosen, every engine's own model and effort.
import { ENGINES, isEngine, makeHeads, headsJSON, type Engine } from "./heads";

import { EFFORT_LEVELS, EFFORTS_BY_ENGINE, type EffortLevel } from "../contract/efforts";
export { EFFORT_LEVELS, EFFORTS_BY_ENGINE, type EffortLevel };
export type EngineModels = Record<Engine, string | null>;
export type EngineEfforts = Record<Engine, EffortLevel | null>;
const levelFor = (engine: Engine, value: unknown): EffortLevel | null => (EFFORTS_BY_ENGINE[engine] as readonly unknown[]).includes(value) ? value as EffortLevel : null;

/**
 * The effort a bot runs `engine` with, from its bot.json: the engine's own (`efforts`), else the old single `effort`
 * (the value for every engine that has none of its own), else none (the engine's default). A level the engine does
 * not support is not used.
 */
export function effortFor(settings: Record<string, unknown>, engine: Engine): EffortLevel | null {
  const own = settings.efforts && typeof settings.efforts === "object" && !Array.isArray(settings.efforts) ? levelFor(engine, (settings.efforts as Record<string, unknown>)[engine]) : null;
  return own ?? levelFor(engine, settings.effort);
}
export const effortsFor = (settings: Record<string, unknown>): EngineEfforts => ({ claude: effortFor(settings, "claude"), codex: effortFor(settings, "codex"), agy: effortFor(settings, "agy") });

export interface EngineDefaults {
  /** Never empty, in Claude, Codex, Antigravity order. */
  engines: Engine[];
  /** One of `engines`, or null: each bot's first engine. */
  primary: Engine | null;
  models: EngineModels;
  /** Each engine's own thinking effort (null: the engine's default). */
  efforts: EngineEfforts;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null);

/** A tolerant read of settings.json: an unknown or inconsistent value falls back to its default. */
export function engineDefaultsFor(raw: Record<string, unknown>): EngineDefaults {
  const list = Array.isArray(raw.defaultEngines) ? raw.defaultEngines.filter(isEngine) : [];
  const engines = ENGINES.filter((engine) => list.includes(engine));
  if (!engines.length) engines.push("claude");
  const models = raw.defaultEngineModels && typeof raw.defaultEngineModels === "object" ? raw.defaultEngineModels as Record<string, unknown> : {};
  const efforts = raw.defaultEfforts && typeof raw.defaultEfforts === "object" ? raw.defaultEfforts as Record<string, unknown> : {};
  return {
    engines,
    primary: isEngine(raw.defaultPrimaryEngine) && engines.includes(raw.defaultPrimaryEngine) ? raw.defaultPrimaryEngine : null,
    models: { claude: text(models.claude), codex: text(models.codex), agy: text(models.agy) },
    efforts: { claude: levelFor("claude", efforts.claude), codex: levelFor("codex", efforts.codex), agy: levelFor("agy", efforts.agy) },
  };
}

/** The app's default primary engine for a bot, for `resolvePrimary` (null: none chosen). */
export const defaultPrimaryOf = (raw: Record<string, unknown>): Engine | null => engineDefaultsFor(raw).primary;

/** One change to the defaults, as settings.json keeps it. Returns the new raw settings. */
export function changeEngineDefaults(raw: Record<string, unknown>, change:
  | { key: "defaultEngines"; value: Engine[] }
  | { key: "defaultPrimaryEngine"; value: Engine | null }
  | { key: "defaultEngineModel"; value: { engine: Engine; model: string | null } }
  | { key: "defaultEffort"; value: { engine: Engine; effort: EffortLevel | null } }): Record<string, unknown> {
  const next = { ...raw };
  const before = engineDefaultsFor(raw);
  switch (change.key) {
    case "defaultEngines": {
      const engines = ENGINES.filter((engine) => change.value.includes(engine));
      if (!engines.length) return next;
      next.defaultEngines = engines;
      // The primary goes with its engine.
      if (before.primary && !engines.includes(before.primary)) delete next.defaultPrimaryEngine;
      break;
    }
    case "defaultPrimaryEngine":
      if (change.value === null) delete next.defaultPrimaryEngine;
      else if (before.engines.includes(change.value)) next.defaultPrimaryEngine = change.value;
      break;
    case "defaultEngineModel": {
      const models = { ...before.models, [change.value.engine]: text(change.value.model) };
      const kept = Object.fromEntries(ENGINES.flatMap((engine) => (models[engine] ? [[engine, models[engine]]] : [])));
      if (Object.keys(kept).length) next.defaultEngineModels = kept; else delete next.defaultEngineModels;
      break;
    }
    case "defaultEffort": {
      // A level the engine does not support is refused.
      if (change.value.effort && !levelFor(change.value.engine, change.value.effort)) break;
      const efforts = { ...before.efforts, [change.value.engine]: change.value.effort };
      const kept = Object.fromEntries(ENGINES.flatMap((engine) => (efforts[engine] ? [[engine, efforts[engine]]] : [])));
      if (Object.keys(kept).length) next.defaultEfforts = kept; else delete next.defaultEfforts;
      break;
    }
  }
  return next;
}

/** What one bot is set to by the defaults (new bot, or "Apply to all bots"). A bot's own primary is cleared: it follows `primary`. */
export interface BotChoices {
  engines: Engine[];
  primary: Engine | null;
  model: string | null;
  efforts: EngineEfforts;
  codexModel: string | null;
  agyModel: string | null;
}
export function botChoicesFromDefaults(defaults: EngineDefaults): BotChoices {
  return {
    engines: [...defaults.engines], primary: defaults.primary,
    model: defaults.models.claude, efforts: { ...defaults.efforts }, codexModel: defaults.models.codex, agyModel: defaults.models.agy,
  };
}

/**
 * A new bot's bot.json from the defaults: only what the app names, so an app without defaults makes
 * a bot exactly as before. `engine` is the head the bot runs as (its primary, else its first engine).
 */
export function seedBotChoices(raw: Record<string, unknown>, setSetting: (key: string, value: unknown) => void) {
  const touched = ["defaultEngines", "defaultPrimaryEngine", "defaultEngineModels", "defaultEfforts"].some((key) => raw[key] !== undefined);
  if (!touched) return;
  const choices = botChoicesFromDefaults(engineDefaultsFor(raw));
  if (choices.engines.length > 1 || choices.engines[0] !== "claude" || choices.primary) {
    // The bot follows the app's primary (answerWith left out) until it picks one of its own.
    setSetting("heads", headsJSON(makeHeads(choices.engines, null, { codexModel: choices.codexModel })));
    setSetting("engine", choices.primary ?? choices.engines[0]);
  } else if (choices.codexModel) {
    setSetting("heads", headsJSON(makeHeads(["claude"], null, { codexModel: choices.codexModel })));
  }
  if (choices.model) setSetting("model", choices.model);
  if (ENGINES.some((engine) => choices.efforts[engine])) setSetting("efforts", Object.fromEntries(ENGINES.flatMap((engine) => (choices.efforts[engine] ? [[engine, choices.efforts[engine]]] : []))));
  if (choices.agyModel) setSetting("agyModel", choices.agyModel);
}
