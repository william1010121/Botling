// The sidebar's update entry: what it shows for the update state main reports (UpdateView) plus what this window
// is doing (a download under way, a failed step). Pure, so the transitions are tested without a window.
import type { UpdateView } from "../contract";

export type UpdateEntry =
  | { kind: "none" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; version: string; message: string; retry: "download" | "restart" };

export interface UpdateLocal { downloading: boolean; error: string | null; failedStep: "download" | "restart" | null }

export function updateEntry(view: UpdateView | null, local: UpdateLocal): UpdateEntry {
  // Nothing where the check is off, there is nothing newer, or this install cannot update itself (a development run).
  if (!view || !view.enabled || !view.newer || view.installError) return { kind: "none" };
  const version = view.newer.version;
  const ready = view.readyVersion === version;
  if (local.error && local.failedStep) return { kind: "error", version, message: local.error, retry: local.failedStep };
  if (ready) return { kind: "ready", version };
  if (local.downloading) return { kind: "downloading", version, percent: view.downloadPercent ?? null };
  return { kind: "available", version };
}

const TEXT = {
  en: { available: (v: string) => `Update to ${v}`, downloading: "Downloading…", ready: "Restart to update", error: "Update failed, click to retry" },
  "zh-Hant": { available: (v: string) => `更新至 ${v}`, downloading: "下載中…", ready: "重新啟動以更新", error: "更新失敗，點擊重試" },
};

export function updateLabel(locale: string, entry: UpdateEntry): string {
  const text = /^zh(-|_)?(tw|hant|hk|mo)?/i.test(locale) && !/hans|cn|sg/i.test(locale) ? TEXT["zh-Hant"] : TEXT.en;
  switch (entry.kind) {
    case "available": return text.available(entry.version);
    case "downloading": return entry.percent === null ? text.downloading : `${text.downloading} ${entry.percent}%`;
    case "ready": return text.ready;
    case "error": return text.error;
    default: return "";
  }
}
