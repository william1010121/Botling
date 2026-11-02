// `sessions.folder` (plugin-extraction.md §3.2 #2): a built-in plugin decides which folder a bot's session starts in
// (an app-made git worktree, today). The core never waits for the plugin host when a turn starts: it keeps what each
// plugin last assigned, here and on disk, and answers from that at once. The plugin pushes changes (`set`) and, when
// it loads, its whole picture (`replace`); a folder it assigned stays in force across restarts of Botling and of the
// host until the plugin says otherwise or is turned off.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { writeFileAtomic } from "../durable/atomic";

/** Where a bot's session starts, what else it may use there, and the words the bot hears at each wake (the wake note). */
export interface SessionFolder { cwd: string; addDirs: string[]; note: string }

export const FOLDER_BOTS_MOST = 500;
export const FOLDER_NOTE_MAX = 8_000;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A folder as a plugin sent it, cleaned (null: not a folder: an absolute `cwd` is required). */
export function cleanFolder(raw: unknown): SessionFolder | null {
  if (!isObject(raw) || typeof raw.cwd !== "string" || !isAbsolute(raw.cwd) || raw.cwd.length > 4_000) return null;
  const addDirs = Array.isArray(raw.addDirs) ? raw.addDirs.filter((dir): dir is string => typeof dir === "string" && isAbsolute(dir) && dir.length <= 4_000).slice(0, 20) : [];
  const note = typeof raw.note === "string" ? raw.note.slice(0, FOLDER_NOTE_MAX) : "";
  return { cwd: raw.cwd, addDirs, note };
}

const same = (a: SessionFolder | undefined, b: SessionFolder | undefined) => (!a && !b) || (!!a && !!b && a.cwd === b.cwd && a.note === b.note && a.addDirs.join("\0") === b.addDirs.join("\0"));

export class SessionFolders {
  private by: Record<string, Record<string, SessionFolder>> = {};

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!isObject(raw)) return;
      for (const [plugin, bots] of Object.entries(raw)) {
        if (!isObject(bots)) continue;
        const kept: Record<string, SessionFolder> = {};
        for (const [botId, value] of Object.entries(bots).slice(0, FOLDER_BOTS_MOST)) { const folder = cleanFolder(value); if (folder) kept[botId] = folder; }
        if (Object.keys(kept).length) this.by[plugin] = kept;
      }
    } catch { /* unreadable: nothing assigned; the plugin pushes its picture when it loads */ }
  }

  get(plugin: string, botId: string): SessionFolder | null {
    return this.by[plugin]?.[botId] ?? null;
  }

  /** Every plugin that assigned anything, by name. */
  plugins(): string[] {
    return Object.keys(this.by).sort();
  }

  /** Every bot a plugin assigned a folder to. */
  bots(plugin: string): string[] {
    return Object.keys(this.by[plugin] ?? {});
  }

  /** One bot's folder (null: back to its own); true when that changed anything. */
  set(plugin: string, botId: string, folder: SessionFolder | null): boolean {
    const bots = this.by[plugin] ?? {};
    if (same(bots[botId], folder ?? undefined)) return false;
    if (!folder && !(botId in bots)) return false;
    if (folder && !(botId in bots) && Object.keys(bots).length >= FOLDER_BOTS_MOST) return false;
    if (folder) bots[botId] = folder; else delete bots[botId];
    if (Object.keys(bots).length) this.by[plugin] = bots; else delete this.by[plugin];
    this.save();
    return true;
  }

  /** A plugin's whole picture: bots not in it go back to their own folder. The ids of the bots that changed. */
  replace(plugin: string, folders: Record<string, SessionFolder>): string[] {
    const before = this.by[plugin] ?? {};
    const next = Object.fromEntries(Object.entries(folders).slice(0, FOLDER_BOTS_MOST));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])].filter((id) => !same(before[id], next[id]));
    if (!changed.length) return [];
    if (Object.keys(next).length) this.by[plugin] = next; else delete this.by[plugin];
    this.save();
    return changed;
  }

  private save() {
    try { writeFileAtomic(this.file, JSON.stringify(this.by)); } catch { /* the next change writes it again */ }
  }
}
