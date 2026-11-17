// The first run takes over what the core kept for Catch-up before it was a plugin: its settings (settings.json's
// `catchUp…Choice` keys, 1.x's AppSettings names; only the switch and the threshold are still used). The old
// file is read, never changed or removed, so an older Botling opened on the same folder still finds it. The old
// summaries (catchup-summaries.json) are not taken over: nothing is summarized any more.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { clampedThreshold, SETTING } from "./catchup";

/** settings.json's Catch-up keys as this plugin's settings (only those the user set). */
export function legacySettings(raw: Record<string, unknown>): Record<string, boolean | number> {
  const out: Record<string, boolean | number> = {};
  if (typeof raw.catchUpEnabledChoice === "boolean") out[SETTING.unread] = raw.catchUpEnabledChoice;
  if (typeof raw.catchUpThresholdChoice === "number" && Number.isFinite(raw.catchUpThresholdChoice)) out[SETTING.unreadThreshold] = clampedThreshold(raw.catchUpThresholdChoice);
  return out;
}

/** Once: the old settings, if Botling's data folder has them; what settings it took over. */
export async function migrate(api: Pick<BotlingApi, "plugin" | "storage" | "settings">): Promise<Record<string, unknown>> {
  const taken: Record<string, unknown> = {};
  if (api.storage.get("migrated")) return taken;
  const dir = api.plugin.appDataDir;
  if (dir) {
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
