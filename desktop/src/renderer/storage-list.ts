// The Storage tab's list (StorageTab.tsx), as pure functions: the type filter chips, search, sort, and how a row
// writes its size, date and type badge. The rows come from the core (`storage.list`, core/storage.ts).
import type { StorageItemView, StorageKind } from "../contract";

export type StorageSort = "date" | "name" | "size" | "type";
export const STORAGE_SORTS: StorageSort[] = ["date", "name", "size", "type"];
/** The chips over the list: everything, the bot's own files, the ones you dragged in, or one kind. */
export type StorageFilter = "all" | "bot" | "added" | "image" | "pdf" | "doc";
export const STORAGE_FILTERS: StorageFilter[] = ["all", "bot", "added", "image", "pdf", "doc"];

/** When a row came: when it was dragged in, else when the bot last wrote it (ms; 0 when unknown). */
export const itemDate = (item: StorageItemView): number => item.added ?? item.modified ?? 0;

const collator = typeof Intl !== "undefined" ? new Intl.Collator(["zh-Hant", "en"], { numeric: true, sensitivity: "base" }) : null;
const byName = (a: StorageItemView, b: StorageItemView) => (collator ? collator.compare(a.name, b.name) : a.name.localeCompare(b.name));
const KIND_ORDER: StorageKind[] = ["page", "doc", "pdf", "image", "sheet", "video", "audio", "text", "other"];

/**
 * The rows in `sort` order: newest first, name A→Z, largest first (a missing file, with no size, last), or by kind
 * (pages, documents, PDFs, pictures, …) then name. Ties go by name, so the order never jumps between refreshes.
 */
export function sortItems(items: readonly StorageItemView[], sort: StorageSort): StorageItemView[] {
  const rows = [...items];
  switch (sort) {
    case "name": return rows.sort(byName);
    case "size": return rows.sort((a, b) => (b.size ?? -1) - (a.size ?? -1) || byName(a, b));
    case "type": return rows.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || extension(a.name).localeCompare(extension(b.name)) || byName(a, b));
    default: return rows.sort((a, b) => itemDate(b) - itemDate(a) || byName(a, b));
  }
}

/** The rows whose name (or subfolder) has every word of `query`, case and width aside; an empty query keeps all. */
export function searchItems(items: readonly StorageItemView[], query: string): StorageItemView[] {
  const words = query.normalize("NFKC").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((item) => {
    const text = `${item.name} ${item.folder ?? ""}`.normalize("NFKC").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The rows a chip keeps. */
export function filterItems(items: readonly StorageItemView[], filter: StorageFilter): StorageItemView[] {
  switch (filter) {
    case "bot": return items.filter((item) => item.source === "bot");
    case "added": return items.filter((item) => item.source === "added");
    case "image": case "pdf": case "doc": return items.filter((item) => item.kind === filter || (filter === "doc" && item.kind === "page"));
    default: return [...items];
  }
}

/** What the list shows for these settings: filtered, searched, then sorted. */
export function visibleItems(items: readonly StorageItemView[], { filter, query, sort }: { filter: StorageFilter; query: string; sort: StorageSort }): StorageItemView[] {
  return sortItems(searchItems(filterItems(items, filter), query), sort);
}

/** How many rows each chip would keep (its count). */
export function filterCounts(items: readonly StorageItemView[]): Record<StorageFilter, number> {
  return Object.fromEntries(STORAGE_FILTERS.map((filter) => [filter, filterItems(items, filter).length])) as Record<StorageFilter, number>;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The type badge on a row's thumbnail: its extension in capitals (at most 4 letters), or the kind's word. */
export function typeBadge(item: Pick<StorageItemView, "name" | "kind">): string {
  const ext = extension(item.name);
  if (ext === "markdown") return "MD";
  if (ext && ext.length <= 4) return ext.toUpperCase();
  return { image: "IMG", pdf: "PDF", doc: "DOC", page: "HTML", sheet: "XLS", video: "VID", audio: "AUD", text: "TXT", other: "FILE" }[item.kind];
}

/** A size as Finder writes it (1000 bytes to a KB): "820 bytes", "14 KB", "2.4 MB"; null: "—". */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** A row's date: the time today ("14:05"), the month and day this year ("11/10"), else the full date ("2025/3/2"). */
export function formatWhen(ms: number, now = Date.now()): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const today = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}/${date.getDate()}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** The total size of the rows that are there. */
export function totalSize(items: readonly StorageItemView[]): number {
  return items.reduce((sum, item) => sum + (item.size ?? 0), 0);
}

/** The file links a drop from the chat carries (text/uri-list: one per line, # lines are comments). */
export function droppedLinks(list: string): string[] {
  return list.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}
