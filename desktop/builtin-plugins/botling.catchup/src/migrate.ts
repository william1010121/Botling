// The first run takes over what the core kept for Catch-up before it was a plugin: its summaries
// (catchup-summaries.json in Botling's data folder, 1.x's name) and its settings (settings.json's
// `catchUp…Choice` keys, 1.x's AppSettings names). The old files are read, never changed or removed,
// so an older Botling opened on the same folder still finds them.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { clampedThreshold, DEFAULT_THRESHOLD, SETTING } from "./catchup";

/** The plugin's summaries file. */
export const summariesFile = (api: Pick<BotlingApi, "plugin">) => join(api.plugin.storageDir, "summaries.json");

/** settings.json's Catch-up keys as this plugin's settings (only those the user set). */
export function legacySettings(raw: Record<string, unknown>): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {};
  if (typeof raw.catchUpEnabledChoice === "boolean") out[SETTING.unread] = raw.catchUpEnabledChoice;
  if (typeof raw.intervalSummaryEnabledChoice === "boolean") out[SETTING.interval] = raw.intervalSummaryEnabledChoice;
  const threshold = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? clampedThreshold(value) : null);
  const unread = threshold(raw.catchUpThresholdChoice), interval = threshold(raw.intervalSummaryThresholdChoice);
  if (unread !== null) out[SETTING.unreadThreshold] = unread;
  if (interval !== null) out[SETTING.intervalThreshold] = interval;
  const customized = typeof raw.summaryThresholdsCustomizedChoice === "boolean" ? raw.summaryThresholdsCustomizedChoice
    : (unread ?? DEFAULT_THRESHOLD) !== DEFAULT_THRESHOLD || (interval ?? DEFAULT_THRESHOLD) !== DEFAULT_THRESHOLD;
  if (customized) out[SETTING.customThresholds] = true;
  const model = typeof raw.catchUpModelChoice === "string" ? raw.catchUpModelChoice.trim() : "";
  if (model) {
    out[SETTING.model] = model;
    // 1.x (and 2.1.0) saved a Codex model id alone.
    out[SETTING.engine] = raw.catchUpModelEngine === "claude" || raw.catchUpModelEngine === "agy" ? raw.catchUpModelEngine : "codex";
  }
  if (typeof raw.summaryPromptChoice === "string" && raw.summaryPromptChoice.trim()) out[SETTING.prompt] = raw.summaryPromptChoice;
  return out;
}

/** Once: the old summaries and settings, if Botling's data folder has them; what settings it took over. */
export async function migrate(api: Pick<BotlingApi, "plugin" | "storage" | "settings">): Promise<Record<string, unknown>> {
  const taken: Record<string, unknown> = {};
  if (api.storage.get("migrated")) return taken;
  const dir = api.plugin.appDataDir;
  if (dir) {
    const old = join(dir, "catchup-summaries.json");
    if (existsSync(old) && !existsSync(summariesFile(api))) {
      try { copyFileSync(old, summariesFile(api)); } catch { /* summaries are written again */ }
    }
    let raw: Record<string, unknown> = {};
    try {
      const value = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) raw = value;
    } catch { /* none */ }
    for (const [key, value] of Object.entries(legacySettings(raw))) {
      try { await api.settings.update(key, value); taken[key] = value; } catch { /* left at its default */ }
    }
  }
  api.storage.set("migrated", true);
  return taken;
}

/**
 * The plugin's settings, with what the first run took over until Botling sends them back (it does once
 * the plugin has started): read through this from the start.
 */
export function settingsReader(api: Pick<BotlingApi, "settings">, taken: Record<string, unknown>): (key: string) => unknown {
  const pending = new Map(Object.entries(taken));
  return (key) => {
    if (pending.has(key)) {
      if (api.settings.get(key) !== pending.get(key)) return pending.get(key);
      pending.delete(key);
    }
    return api.settings.get(key);
  };
}
