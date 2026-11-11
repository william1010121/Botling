// The Storage tab (檔案庫, 2026-11-11): per bot, the files the bot made itself (everything in its artifacts folder:
// reports, PDFs, Markdown, pictures; listed where they are, never copied) and the files the user dragged in (from Finder
// or the chat), kept as references only: the original path is remembered, nothing is copied, and a reference whose file
// moved or was deleted shows as missing. The references are app state (`<data>/storage.json`), never a file in .bot/,
// which the bots own. Removing a reference never touches the original.
import { randomUUID } from "node:crypto";
import { lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { writeFileAtomic } from "./durable/atomic";
import { readJSON } from "./store/bot-store";
import type { StorageItemView, StorageKind } from "../contract";

/** One file the user dragged into a bot's Storage: where it was, and when it was added (ms). */
export interface StorageRef { id: string; path: string; added: number }

/** The most references a bot keeps (the oldest go first), and the most of its own files listed. */
export const REF_LIMIT = 500;
export const ARTIFACT_LIMIT = 500;
/** How deep the artifacts folder is walked (its own files are depth 0). */
const ARTIFACT_DEPTH = 3;

const KINDS: Record<string, StorageKind> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".heic": "image", ".bmp": "image", ".tiff": "image",
  ".pdf": "pdf",
  ".md": "doc", ".markdown": "doc", ".doc": "doc", ".docx": "doc", ".rtf": "doc", ".pages": "doc", ".key": "doc", ".ppt": "doc", ".pptx": "doc",
  ".html": "page", ".htm": "page",
  ".csv": "sheet", ".tsv": "sheet", ".xls": "sheet", ".xlsx": "sheet", ".numbers": "sheet",
  ".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video",
  ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".aac": "audio", ".flac": "audio",
  ".txt": "text", ".json": "text", ".log": "text", ".yaml": "text", ".yml": "text", ".xml": "text",
};

/** What kind of file a name is, by its extension. */
export function storageKind(name: string): StorageKind {
  return KINDS[extname(name).toLowerCase()] ?? "other";
}

function statOf(path: string): Stats | null {
  try { return statSync(path); } catch { return null; }
}

/**
 * The bot's own files: every file in its artifacts folder (subfolders a few levels down), hidden files and folders
 * left out, symlinks not followed. Missing folder: none. Newest first, at most `limit`.
 */
export function artifactItems(folder: string, limit = ARTIFACT_LIMIT): StorageItemView[] {
  const found: StorageItemView[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || found.length >= limit * 4) continue;
      const path = join(dir, name);
      let link: Stats;
      try { link = lstatSync(path); } catch { continue; }
      if (link.isSymbolicLink()) continue;
      if (link.isDirectory()) { if (depth < ARTIFACT_DEPTH && name !== "node_modules") walk(path, depth + 1); continue; }
      if (!link.isFile()) continue;
      const rel = relative(folder, path).split(sep).join("/");
      found.push({ id: `a:${rel}`, source: "bot", name, folder: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null, path,
        size: link.size, modified: Math.round(link.mtimeMs), added: null, kind: storageKind(name), missing: false });
    }
  };
  walk(folder, 0);
  return found.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0)).slice(0, limit);
}

/** A dragged-in file as the list shows it: its size and date now, or missing when its original is gone (or is no longer a file). */
export function refItem(ref: StorageRef): StorageItemView {
  const stats = statOf(ref.path);
  const ok = !!stats && stats.isFile();
  return { id: `r:${ref.id}`, source: "added", name: basename(ref.path), folder: null, path: ref.path,
    size: ok ? stats.size : null, modified: ok ? Math.round(stats.mtimeMs) : null, added: ref.added, kind: storageKind(ref.path), missing: !ok };
}

/** Everything a bot's Storage lists: its own files, then the files dragged in (newest added first). A dragged-in file inside the artifacts folder shows once, as the bot's. */
export function storageItems(artifacts: string | null, refs: StorageRef[]): StorageItemView[] {
  const own = artifacts ? artifactItems(artifacts) : [];
  const ownPaths = new Set(own.map((item) => item.path));
  const added = [...refs].sort((a, b) => b.added - a.added).filter((ref) => !ownPaths.has(ref.path)).map(refItem);
  return [...own, ...added];
}

function isRef(value: unknown): value is StorageRef {
  const ref = value as StorageRef;
  return !!ref && typeof ref === "object" && typeof ref.id === "string" && typeof ref.path === "string" && ref.path.startsWith("/") && typeof ref.added === "number";
}

/**
 * The references every bot's Storage keeps, in one app file (`{ v: 1, bots: { <BOT ID>: [ref…] } }`). An unreadable or
 * odd file reads as none (and is replaced on the next change); entries that are not references are dropped.
 */
export class StorageBook {
  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  private read(): Record<string, StorageRef[]> {
    let value: unknown;
    try { value = readJSON(this.file); } catch { return {}; }
    const bots = (value as { bots?: unknown } | undefined)?.bots;
    if (!bots || typeof bots !== "object" || Array.isArray(bots)) return {};
    const out: Record<string, StorageRef[]> = {};
    for (const [botId, refs] of Object.entries(bots as Record<string, unknown>)) if (Array.isArray(refs)) out[botId] = refs.filter(isRef);
    return out;
  }

  private write(bots: Record<string, StorageRef[]>): void {
    const kept = Object.fromEntries(Object.entries(bots).filter(([, refs]) => refs.length));
    writeFileAtomic(this.file, JSON.stringify({ v: 1, bots: kept }, null, 1));
  }

  refs(botId: string): StorageRef[] {
    return this.read()[botId.toUpperCase()] ?? [];
  }

  /** Remembers absolute paths for a bot (a path it has already moves to the top, as added now). How many were new. */
  add(botId: string, paths: string[]): number {
    const bots = this.read();
    const key = botId.toUpperCase();
    let refs = bots[key] ?? [];
    let added = 0;
    const at = this.now();
    for (const path of paths) {
      if (!path.startsWith("/")) continue;
      const before = refs.find((ref) => ref.path === path);
      if (!before) added += 1;
      refs = [{ id: before?.id ?? randomUUID(), path, added: at }, ...refs.filter((ref) => ref.path !== path)];
    }
    bots[key] = refs.slice(0, REF_LIMIT);
    this.write(bots);
    return added;
  }

  /** Forgets a reference (`r:<id>` or its bare id); the file itself is never touched. Whether it was there. */
  remove(botId: string, id: string): boolean {
    const bare = id.startsWith("r:") ? id.slice(2) : id;
    const bots = this.read();
    const key = botId.toUpperCase();
    const refs = bots[key] ?? [];
    const kept = refs.filter((ref) => ref.id !== bare);
    if (kept.length === refs.length) return false;
    bots[key] = kept;
    this.write(bots);
    return true;
  }
}
