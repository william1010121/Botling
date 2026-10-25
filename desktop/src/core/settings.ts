// settings.json as 1.x keeps it (AppSettings.swift): one global file, each key the Swift property's
// name, optional keys left out for "the default". 2.0 reads and writes the same keys, so a folder
// imported from 1.x keeps its choices. Two differences, on purpose: 2.0 keeps keys it does not know
// (1.x drops them on its next save), and one bad value falls back to its own default instead of the
// whole file. It is written compact, as 1.x's `JSONEncoder` writes it.
//
// Per-bot choices (model, effort, the subagents' model) live in each bot's bot.json (BotStore.swift).
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./durable/atomic";
import { DEFAULT_WRITING_PROMPT, JUDGE_MODEL } from "./catchup";
import type { SettingsChange, SettingsView } from "../contract";

export const LANGUAGES = ["en", "zh-Hant", "zh-Hans", "ja", "ko"] as const;
export const BOT_MODELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const RESULT_PUBLISHING = ["artifactUnlessSensitive", "localOnly", "artifactAlways"] as const;
export const STALL_CHOICES = [5, 10, 15, 30, 60, 0];
const THRESHOLD = 3;
const clampThreshold = (value: number) => Math.min(50, Math.max(1, Math.round(value)));

export type RawSettings = Record<string, unknown>;

export function readSettings(file: string): RawSettings {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as RawSettings : {};
  } catch {
    return {};
  }
}

export function writeSettings(file: string, settings: RawSettings) {
  writeFileAtomic(file, JSON.stringify(settings));
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => (typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : null);
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const int = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/** Codex workers' own choices (`CodexWorkerDefaults`): a tolerant read, an unknown effort is none. */
export function codexWorkerDefaults(value: unknown): { model: string | null; effort: (typeof EFFORTS)[number] | null; fast: boolean | null } {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { model: text(raw.model), effort: oneOf(EFFORTS, raw.effort), fast: typeof raw.fast === "boolean" ? raw.fast : null };
}

/** What the Settings page shows (every value with its default filled in). */
export function settingsView(raw: RawSettings, systemLanguage: (typeof LANGUAGES)[number] = "en"): SettingsView {
  const catchUpThreshold = clampThreshold(int(raw.catchUpThresholdChoice) ?? THRESHOLD);
  const intervalThreshold = clampThreshold(int(raw.intervalSummaryThresholdChoice) ?? THRESHOLD);
  const size = int(raw.chatAvatarSizeChoice);
  const stall = int(raw.stallReminderMinutes);
  return {
    language: oneOf(LANGUAGES, raw.languageChoice),
    effectiveLanguage: oneOf(LANGUAGES, raw.languageChoice) ?? systemLanguage,
    botLook: oneOf(["original", "cute"] as const, raw.botLookChoice) ?? "cute",
    chatAvatarSize: size === null ? null : Math.min(96, Math.max(32, size)),
    catchUpEnabled: bool(raw.catchUpEnabledChoice, true),
    intervalSummaryEnabled: bool(raw.intervalSummaryEnabledChoice, false),
    thresholdsCustomized: typeof raw.summaryThresholdsCustomizedChoice === "boolean" ? raw.summaryThresholdsCustomizedChoice : catchUpThreshold !== THRESHOLD || intervalThreshold !== THRESHOLD,
    catchUpThreshold,
    intervalSummaryThreshold: intervalThreshold,
    catchUpModel: text(raw.catchUpModelChoice) ?? JUDGE_MODEL,
    summaryPrompt: text(raw.summaryPromptChoice),
    defaultSummaryPrompt: DEFAULT_WRITING_PROMPT,
    completionVerification: bool(raw.completionVerificationOn, false),
    completionVerificationModel: text(raw.completionVerificationModelChoice) ?? JUDGE_MODEL,
    subagentModel: oneOf(BOT_MODELS, raw.subagentModelDefault),
    subagentHourCache: bool(raw.subagentHourCacheChoice, false),
    codexWorkersFollow: bool(raw.codexWorkersFollow, true),
    codexWorkers: codexWorkerDefaults(raw.codexWorkerChoice),
    componentEditorModel: oneOf(BOT_MODELS, raw.componentEditorModel) ?? "sonnet",
    resultPublishing: oneOf(RESULT_PUBLISHING, raw.resultPublishingChoice) ?? "artifactUnlessSensitive",
    stallReminderMinutes: stall !== null && stall >= 0 ? stall : 15,
    rightPanelCollapsed: bool(raw.rightPanelCollapsed, false),
  };
}

/** One change from the Settings page, as 1.x's setters make it (`Workspace+Settings`, `+CatchUp`). */
export function applySetting(raw: RawSettings, change: SettingsChange): RawSettings {
  const next: RawSettings = { ...raw };
  const set = (key: string, value: unknown) => { if (value === null || value === undefined) delete next[key]; else next[key] = value; };
  switch (change.key) {
    case "language": set("languageChoice", change.value); break;
    case "botLook": set("botLookChoice", change.value); break;
    case "chatAvatarSize": set("chatAvatarSizeChoice", change.value === null ? null : Math.min(96, Math.max(32, Math.round(change.value)))); break;
    case "catchUpEnabled": set("catchUpEnabledChoice", change.value); break;
    case "intervalSummaryEnabled": set("intervalSummaryEnabledChoice", change.value); break;
    case "thresholdsCustomized":
      // Off: both thresholds go back to the default (1.x clears them).
      set("summaryThresholdsCustomizedChoice", change.value);
      if (!change.value) { delete next.catchUpThresholdChoice; delete next.intervalSummaryThresholdChoice; }
      break;
    case "catchUpThreshold": set("catchUpThresholdChoice", clampThreshold(change.value)); set("summaryThresholdsCustomizedChoice", true); break;
    case "intervalSummaryThreshold": set("intervalSummaryThresholdChoice", clampThreshold(change.value)); set("summaryThresholdsCustomizedChoice", true); break;
    case "catchUpModel": set("catchUpModelChoice", change.value && change.value.trim() ? change.value.trim() : null); break;
    case "summaryPrompt": set("summaryPromptChoice", change.value && change.value.trim() ? change.value : null); break;
    case "completionVerification": set("completionVerificationOn", change.value); break;
    case "completionVerificationModel": set("completionVerificationModelChoice", change.value && change.value.trim() ? change.value.trim() : null); break;
    case "subagentModel": set("subagentModelDefault", change.value); break;
    case "subagentHourCache": set("subagentHourCacheChoice", change.value); break;
    case "codexWorkersFollow": set("codexWorkersFollow", change.value); break;
    case "codexWorkers": {
      const value = { ...(change.value.model ? { model: change.value.model } : {}), ...(change.value.effort ? { effort: change.value.effort } : {}), ...(typeof change.value.fast === "boolean" ? { fast: change.value.fast } : {}) };
      set("codexWorkerChoice", Object.keys(value).length ? value : null);
      break;
    }
    case "componentEditorModel": set("componentEditorModel", change.value); break;
    case "resultPublishing": set("resultPublishingChoice", change.value); break;
    case "stallReminderMinutes": set("stallReminderMinutes", change.value); break;
    case "rightPanelCollapsed": set("rightPanelCollapsed", change.value); break;
  }
  return next;
}

/** What a new claude head is started with from the app's settings (AgentProcess.swift's environment). */
export function launchSettings(raw: RawSettings): { subagentModel: string | null; subagentHourCache: boolean; codexWorkers: { model: string | null; effort: string | null; fast: boolean | null } | null } {
  const view = settingsView(raw);
  return {
    subagentModel: view.subagentModel,
    subagentHourCache: view.subagentHourCache,
    // Following ~/.codex/config.toml: the app sets nothing for workers.
    codexWorkers: view.codexWorkersFollow ? null : view.codexWorkers,
  };
}

/** A list of strings in settings.json (`ignoredWaiting`). */
export function readSettingsList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
