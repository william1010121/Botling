// settings.json as 1.x keeps it (AppSettings.swift): one global file, each key the Swift property's
// name, optional keys left out for "the default". 2.0 reads and writes the same keys, so a folder
// imported from 1.x keeps its choices. Two differences, on purpose: 2.0 keeps keys it does not know
// (1.x drops them on its next save), and one bad value falls back to its own default instead of the
// whole file. It is written compact, as 1.x's `JSONEncoder` writes it.
//
// Per-bot choices (model, effort, the subagents' model) live in each bot's bot.json (BotStore.swift).
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./durable/atomic";
import type { SettingsChange, SettingsView } from "../contract";
import { messageWidth } from "../contract/message-width";
import { normalizeOverrides } from "../contract/shortcuts";
import { savedLanguage } from "./prompts";
import { changeEngineDefaults, engineDefaultsFor, seedBotChoices } from "./engine-defaults";
import { specWriters } from "./spec-guard";

export const LANGUAGES = ["en", "zh-Hant"] as const;
export const BOT_MODELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const RESULT_PUBLISHING = ["artifactUnlessSensitive", "localOnly", "artifactAlways"] as const;
export const STALL_CHOICES = [5, 10, 15, 30, 60, 0];

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
  const size = int(raw.chatAvatarSizeChoice);
  const stall = int(raw.stallReminderMinutes);
  return {
    agyAcpPath: text(raw.agyAcpPath)?.trim() ?? null,
    language: savedLanguage(raw.languageChoice) ?? null,
    effectiveLanguage: savedLanguage(raw.languageChoice) ?? systemLanguage,
    botLook: oneOf(["original", "cute"] as const, raw.botLookChoice) ?? "cute",
    chatAvatarSize: size === null ? null : Math.min(96, Math.max(32, size)),
    messageColumnWidth: messageWidth(raw.messageColumnWidth),
    subagentModel: oneOf(BOT_MODELS, raw.subagentModelDefault),
    subagentHourCache: bool(raw.subagentHourCacheChoice, false),
    claudeWorkerLimit: claudeWorkerLimit(raw),
    claudeBypassPermissions: bool(raw.claudeBypassPermissions, false),
    codexBypassPermissions: bool(raw.codexBypassPermissions, false),
    agyBypassPermissions: bool(raw.agyBypassPermissions, false),
    agyPermissionSessions: [],
    codexWorkersFollow: bool(raw.codexWorkersFollow, true),
    codexWorkers: codexWorkerDefaults(raw.codexWorkerChoice),
    componentEditorModel: oneOf(BOT_MODELS, raw.componentEditorModel) ?? "sonnet",
    engineDefaults: engineDefaultsFor(raw),
    resultPublishing: oneOf(RESULT_PUBLISHING, raw.resultPublishingChoice) ?? "artifactUnlessSensitive",
    stallReminderMinutes: stall !== null && stall >= 0 ? stall : 15,
    rightPanelCollapsed: bool(raw.rightPanelCollapsed, false),
    railCollapsed: bool(raw.railCollapsed, false),
    pinnedBots: [...new Set(readSettingsList(raw.pinnedBots).filter((id) => /^[0-9A-Fa-f-]{36}$/.test(id)).map((id) => id.toUpperCase()))].slice(0, 200),
    idleBots: [...new Set(readSettingsList(raw.idleBots).filter((id) => /^[0-9A-Fa-f-]{36}$/.test(id)).map((id) => id.toUpperCase()))].slice(0, 200),
    developerMode: bool(raw.developerMode, false),
    developerProject: typeof raw.developerProjectID === "string" && /^[0-9A-Fa-f-]{36}$/.test(raw.developerProjectID) ? raw.developerProjectID.toUpperCase() : null,
    updateCheck: bool(raw.updateCheckEnabled, true),
    shortcuts: normalizeOverrides(raw.shortcutBindings),
    mainTabs: mainTabs(raw.mainTabs),
  };
}

/**
 * Settings that became a built-in plugin's, by their settings.json key: what that plugin calls it, and
 * the most it may be (they were whole numbers from 0, and 0 turned a limit off).
 */
const MOVED_TO_PLUGINS: Record<string, { plugin: string; key: string } & ({ type: "number"; max: number } | { type: "boolean" } | { type: "string" })> = {
  pasteCollapseChars: { plugin: "botling.chat-extras", key: "botling.chat-extras.pasteCollapseChars", type: "number", max: 1_000_000 },
  pasteCollapseLines: { plugin: "botling.chat-extras", key: "botling.chat-extras.pasteCollapseLines", type: "number", max: 100_000 },
  worktreesEnabled: { plugin: "botling.git", key: "botling.git.enabled", type: "boolean" },
  worktreeRootChoice: { plugin: "botling.git", key: "botling.git.root", type: "string" },
};

/**
 * On start: each of those still in settings.json goes to its plugin's settings (`set`, plugins.json)
 * and then out of settings.json, so it moves once. A bad value is dropped (the plugin's default).
 */
export function moveSettingsToPlugins(file: string, set: (plugin: string, key: string, value: number | boolean | string) => void): void {
  const raw = readSettings(file);
  const moved = Object.keys(MOVED_TO_PLUGINS).filter((key) => key in raw);
  if (!moved.length) return;
  for (const name of moved) {
    const entry = MOVED_TO_PLUGINS[name];
    if (entry.type === "boolean") {
      if (typeof raw[name] === "boolean") set(entry.plugin, entry.key, raw[name]);
    } else if (entry.type === "string") {
      const value = text(raw[name]);
      if (value !== null) set(entry.plugin, entry.key, value.trim());
    } else {
      const value = int(raw[name]);
      if (value !== null && value >= 0) set(entry.plugin, entry.key, Math.min(value, entry.max));
    }
  }
  // plugins.json first: stopped in between, they move again next time.
  writeSettings(file, Object.fromEntries(Object.entries(raw).filter(([key]) => !moved.includes(key))));
}

/** Shortcuts that became a built-in plugin's command, by their old id in `shortcutBindings`: the command that took them over. */
const MOVED_SHORTCUTS: Record<string, string> = { toggleTerminal: "botling.terminal.toggle" };

/** On start: a key the user chose for such a shortcut becomes the key of the command that replaced it (once; one already chosen for the command wins). */
export function moveShortcutsToPlugins(file: string): void {
  const raw = readSettings(file);
  const saved = raw.shortcutBindings;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  const bindings = { ...(saved as Record<string, unknown>) };
  const moved = Object.keys(MOVED_SHORTCUTS).filter((id) => id in bindings);
  if (!moved.length) return;
  for (const id of moved) {
    const command = MOVED_SHORTCUTS[id]!;
    if (!(command in bindings) && typeof bindings[id] === "string") bindings[command] = bindings[id];
    delete bindings[id];
  }
  writeSettings(file, { ...raw, shortcutBindings: bindings });
}

/** settings.json's `mainTabs`: each bot's plugin tab (bot ids upper case), what cannot be used left out. */
function mainTabs(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => /^[0-9A-Fa-f-]{36}$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0 && entry[1].length <= 320);
  return Object.fromEntries(entries.slice(-500).map(([id, tab]) => [id.toUpperCase(), tab]));
}

/** One change from the Settings page, as 1.x's setters make it (`Workspace+Settings`). */
export function applySetting(raw: RawSettings, change: SettingsChange): RawSettings {
  const next: RawSettings = { ...raw };
  const set = (key: string, value: unknown) => { if (value === null || value === undefined) delete next[key]; else next[key] = value; };
  switch (change.key) {
    case "agyAcpPath": set("agyAcpPath", change.value?.trim() || null); break;
    case "language": set("languageChoice", change.value); break;
    case "botLook": set("botLookChoice", change.value); break;
    case "chatAvatarSize": set("chatAvatarSizeChoice", change.value === null ? null : Math.min(96, Math.max(32, Math.round(change.value)))); break;
    case "messageColumnWidth": set("messageColumnWidth", messageWidth(change.value)); break;
    case "subagentModel": set("subagentModelDefault", change.value); break;
    case "claudeBypassPermissions": set("claudeBypassPermissions", change.value); break;
    case "agyBypassPermissions": set("agyBypassPermissions", change.value); break;
    case "codexBypassPermissions": set("codexBypassPermissions", change.value); break;
    case "subagentHourCache": set("subagentHourCacheChoice", change.value); break;
    case "claudeWorkerLimit": set("claudeWorkerLimit", change.value === null ? null : claudeWorkerLimit({ claudeWorkerLimit: change.value })); break;
    case "codexWorkersFollow": set("codexWorkersFollow", change.value); break;
    case "codexWorkers": {
      const value = { ...(change.value.model ? { model: change.value.model } : {}), ...(change.value.effort ? { effort: change.value.effort } : {}), ...(typeof change.value.fast === "boolean" ? { fast: change.value.fast } : {}) };
      set("codexWorkerChoice", Object.keys(value).length ? value : null);
      break;
    }
    case "defaultEngines": case "defaultPrimaryEngine": case "defaultEngineModel": case "defaultEffort": return changeEngineDefaults(raw, change);
    case "componentEditorModel": set("componentEditorModel", change.value); break;
    case "resultPublishing": set("resultPublishingChoice", change.value); break;
    case "stallReminderMinutes": set("stallReminderMinutes", change.value); break;
    case "rightPanelCollapsed": set("rightPanelCollapsed", change.value); break;
    case "railCollapsed": set("railCollapsed", change.value); break;
    // 1.x keeps the project when developer mode goes off (`setDeveloperMode(_:project:)`).
    case "developerMode": set("developerMode", change.value); break;
    case "updateCheck": set("updateCheckEnabled", change.value); break;
    case "shortcuts": { const kept = normalizeOverrides(change.value); set("shortcutBindings", Object.keys(kept).length ? kept : null); break; }
    case "mainTab": {
      const tabs = { ...mainTabs(raw.mainTabs) };
      if (change.value.tab) tabs[change.value.botId.toUpperCase()] = change.value.tab;
      else delete tabs[change.value.botId.toUpperCase()];
      set("mainTabs", Object.keys(tabs).length ? tabs : null);
      break;
    }
    case "developerProject": if (change.value) set("developerProjectID", change.value.toUpperCase()); break;
    // 1.x keeps the list (an empty one too) once anything was pinned.
    case "pinnedBots": set("pinnedBots", [...new Set(change.value.map((id) => id.toUpperCase()))]); break;
    // The left column's Idle group: only the user sends a bot there (the clock on its row) or brings it back.
    case "idleBots": set("idleBots", [...new Set(change.value.map((id) => id.toUpperCase()))]); break;
  }
  return next;
}

/**
 * What a new head is started with from the app's settings (AgentProcess.swift's environment). Since
 * Phase 4c the subagents' model and the Codex workers' choice are each bot's own (bot.json, seeded from
 * the app's defaults and changed with them, as 1.x); only the hour cache is the app's.
 */
export function launchSettings(raw: RawSettings) {
  // 1.x's `autoApprove` (AppSettings.autoApprovesSafeActions), on unless turned off; settings.json comes over from 1.x as it is.
  return { subagentHourCache: settingsView(raw).subagentHourCache, defaultPrimaryEngine: engineDefaultsFor(raw).primary, autoMode: bool(raw.autoApprove, true),
    claudeBypassPermissions: bool(raw.claudeBypassPermissions, false), codexBypassPermissions: bool(raw.codexBypassPermissions, false), agyBypassPermissions: bool(raw.agyBypassPermissions, false),
    // Hidden (debugging only): "native" gives Claude heads their own Agent tool back instead of app-managed workers.
    claudeWorkers: claudeWorkersMode(raw), claudeWorkerLimit: claudeWorkerLimit(raw),
    // Which models' app-managed workers may write spec/ (spec-guard.ts); bot heads are not restricted.
    specWriters: specWriters(raw) };
}

/** settings.json's `claudeWorkerLimit`: how many Claude workers of one bot may be at work at once (1–16; default 4); more wait for a slot. */
export function claudeWorkerLimit(raw: RawSettings): number {
  const value = (raw as Record<string, unknown>).claudeWorkerLimit;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 16) : 4;
}

/** settings.json's hidden `claudeWorkers`: "app" (default: every Claude subagent is an app-managed worker) or "native". */
export function claudeWorkersMode(raw: RawSettings): "app" | "native" {
  return (raw as Record<string, unknown>).claudeWorkers === "native" ? "native" : "app";
}

/** What Codex workers start on with the app's choice applied (`appliedCodexWorkerDefaults`): following
 * Codex's config, nothing of the app's. */
export function appliedCodexWorkers(raw: RawSettings): { model: string | null; effort: string | null; fast: boolean | null } {
  const view = settingsView(raw);
  return view.codexWorkersFollow ? { model: null, effort: null, fast: null } : view.codexWorkers;
}

/** `CodexWorkerDefaults` as bot.json keeps it (`codexWorkers`): nil values left out, none at all: no key. */
export function codexWorkersJSON(value: { model: string | null; effort: string | null; fast: boolean | null }): Record<string, unknown> | undefined {
  const json = { ...(value.model ? { model: value.model } : {}), ...(value.effort ? { effort: value.effort } : {}), ...(typeof value.fast === "boolean" ? { fast: value.fast } : {}) };
  return Object.keys(json).length ? json : undefined;
}

/**
 * The app's engine defaults written into a new bot's bot.json before it is made (1.x's
 * `seedEngineDefaults`): the subagents' model when the app names one, the Codex workers' choice when it
 * is not "follow Codex's config".
 */
export function seedEngineDefaults(raw: RawSettings, setSetting: (key: string, value: unknown) => void) {
  const model = settingsView(raw).subagentModel;
  if (model) setSetting("subagentModel", model);
  const workers = codexWorkersJSON(appliedCodexWorkers(raw));
  if (workers) setSetting("codexWorkers", workers);
  // Engines, primary, models and effort (Settings → Engines and models).
  seedBotChoices(raw, setSetting);
}

/** A list of strings in settings.json (`ignoredWaiting`). */
export function readSettingsList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
