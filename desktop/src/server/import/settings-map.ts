// Pure mapping from a 2.x settings.json (core/settings.ts) to Botling 3 cluster preferences (protocol-v1.md §17,
// protocol/prefs.ts) and machine-local settings. Layout keys stay on the device only (never imported to prefs or
// kept in machine). Reply language has no 2.x key (`replyLanguage` stays unset); `designatedServer` is never imported.
import { engineDefaultsFor } from "../../core/engine-defaults";
import { savedLanguage } from "../../core/prompts";
import { readSettingsList, type RawSettings } from "../../core/settings";
import { canonicalJson, PREF_VALUE_CHARS } from "../../protocol";

export interface MappedPref {
  key: string;
  value: unknown;
}

export interface MappedSettings {
  prefs: MappedPref[];
  machine: RawSettings;
  layoutKeys: string[];
  oversizedKeys: string[];
}

const THEMES = new Set(["dark", "light", "system"]);
const UUID_RE = /^[0-9A-Fa-f-]{36}$/;
const FOLLOWED_LIMIT = 200;

const ENGINE_DEFAULT_KEYS = [
  "defaultEngines",
  "defaultPrimaryEngine",
  "defaultEngineModels",
  "defaultEfforts",
] as const;

const PREF_SOURCE_KEYS = new Set<string>([
  "languageChoice",
  "appTheme",
  "reportTheme",
  ...ENGINE_DEFAULT_KEYS,
  "pinnedBots",
]);

/** Per-device layout keys in 2.x settings.json (§17: "kept on the device only"). */
export const LAYOUT_SETTINGS_KEYS = new Set<string>([
  "idleBots",
  "pinnedSubBots",
  "railCollapsed",
  "rightPanelCollapsed",
  "mainTabs",
  "pinnedTabs",
  "botColors",
  "chatAvatarSizeChoice",
  "botLookChoice",
]);

function lookupId(idMap: Map<string, string>, id: string): string {
  return idMap.get(id) ?? idMap.get(id.toUpperCase()) ?? idMap.get(id.toLowerCase()) ?? id;
}

function fitsPrefLimit(value: unknown): boolean {
  if (value === undefined) return false;
  try {
    return canonicalJson(value).length <= PREF_VALUE_CHARS;
  } catch {
    return false;
  }
}

/** Splits a 2.x `settings.json` object into cluster preferences, machine-local settings, and layout-only keys. */
export function mapSettings(raw: RawSettings, idMap: Map<string, string>): MappedSettings {
  const candidates: MappedPref[] = [];

  const language = savedLanguage(raw.languageChoice);
  if (language !== undefined) candidates.push({ key: "language", value: language });

  if (typeof raw.appTheme === "string" && THEMES.has(raw.appTheme)) {
    candidates.push({ key: "theme", value: raw.appTheme });
  }

  if (typeof raw.reportTheme === "string" && THEMES.has(raw.reportTheme)) {
    candidates.push({ key: "reportTheme", value: raw.reportTheme });
  }

  if (ENGINE_DEFAULT_KEYS.some((key) => raw[key] !== undefined)) {
    candidates.push({ key: "defaultModels", value: engineDefaultsFor(raw) });
  }

  if (Array.isArray(raw.pinnedBots)) {
    const followed = [
      ...new Set(
        readSettingsList(raw.pinnedBots)
          .filter((id) => UUID_RE.test(id))
          .map((id) => lookupId(idMap, id).toUpperCase()),
      ),
    ].slice(0, FOLLOWED_LIMIT);
    candidates.push({ key: "followedBots", value: followed });
  }

  const prefs: MappedPref[] = [];
  const oversizedKeys: string[] = [];
  for (const item of candidates) {
    if (fitsPrefLimit(item.value)) prefs.push(item);
    else oversizedKeys.push(item.key);
  }

  const machine: RawSettings = {};
  const layoutKeys: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (LAYOUT_SETTINGS_KEYS.has(key)) {
      layoutKeys.push(key);
    } else if (!PREF_SOURCE_KEYS.has(key)) {
      machine[key] = value;
    }
  }

  return { prefs, machine, layoutKeys, oversizedKeys };
}
