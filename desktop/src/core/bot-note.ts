// A bot's note: the one Markdown file the Note tab edits (a plugin's main tab, through `notes.read` / `notes.write`).
// It lives with the bot's other .bot files (profilePaths' `note`: <project>/.bot/note.md, a sub bot's under
// .bot/sub-bots/<id>/, the main bot's in its own folder), is made empty on first read, saved whole through a temp file
// and a rename, and a save based on an older version than the one on disk is refused with what is there, so a bot's
// edit is never overwritten. NoteWatcher tells when a watched note changes on disk by someone else (a bot, the user's
// editor), once per settled change and never for the app's own saves.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, watch, writeFileSync, type FSWatcher, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { profilePaths } from "./prompts";
import type { BotProfile } from "./store/workspace";

/** The longest note `notes.write` takes (characters). */
export const NOTE_MAX = 2_000_000;

export interface NoteState { path: string; text: string; mtime: number }
export type NoteWrite = { saved: true; mtime: number } | { saved: false; text: string; mtime: number };

/** Where a bot's note is (absolute). */
export function notePath(profile: Pick<BotProfile, "role" | "folder" | "memoryPath"> & { id?: string; parent?: string | null }): string {
  return join(profile.folder, profilePaths(profile).note);
}

const mtimeOf = (file: string): number | null => {
  try { return statSync(file).mtimeMs; } catch { return null; }
};

/**
 * note.md's mtime after the app wrote it, always later than `before` (its mtime before the write): the mtime is the
 * version a save is based on, and Linux file systems stamp with the kernel's coarse clock (a few ms), so two saves in
 * one tick would otherwise share it and a save based on the older one would not be refused. APFS stamps in ns.
 * The words are already saved here, so a stat or a stamp that fails (a disk that refuses utimes, the note removed
 * just now) never turns the save into an error: the mtime as it is (0 when there is no file) is the answer.
 */
function laterMtime(file: string, before: number | null): number {
  let stat: Stats;
  try { stat = statSync(file); } catch { return 0; }
  if (before === null || stat.mtimeMs > before) return stat.mtimeMs;
  try {
    utimesSync(file, stat.atime, new Date(Math.floor(before) + 1));
    return statSync(file).mtimeMs;
  } catch {
    return stat.mtimeMs;
  }
}

/** The note's words and when it last changed; an empty one is made (folders too) when there is none. */
export function readNote(file: string): NoteState {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const text = readFileSync(file, "utf8");
  return { path: file, text, mtime: mtimeOf(file) ?? 0 };
}

/**
 * Saves the whole note. With `base` (the mtime the editor last read or saved), a note on disk changed since is left
 * as it is and its words come back (`saved: false`) for the editor to take in; a note removed meanwhile is made again.
 */
export function writeNote(file: string, text: string, base?: number): NoteWrite {
  if (text.length > NOTE_MAX) throw new Error(`A note holds at most ${NOTE_MAX} characters.`);
  mkdirSync(dirname(file), { recursive: true });
  const before = mtimeOf(file);
  if (base !== undefined && before !== null && before !== base) return { saved: false, text: readFileSync(file, "utf8"), mtime: before };
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`);
  try {
    writeFileSync(temp, text);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { saved: true, mtime: laterMtime(file, before) };
}

interface Watched { file: string; known: number | null; watcher: FSWatcher | null; timer: ReturnType<typeof setTimeout> | null }

/**
 * Watches the notes a plugin has read or saved (by bot), telling `changed(botId, mtime)` when one changes on disk
 * by someone else (null: it was removed). The folder is watched, not the file, since a save replaces the file; a slow
 * look at each watched note's mtime backs that up (FSEvents can drop a change made just as the watch starts).
 */
export class NoteWatcher {
  private readonly notes = new Map<string, Watched>();
  private readonly settleMs: number;
  private readonly max: number;
  private readonly pollMs: number;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly changed: (botId: string, mtime: number | null) => void, options: { settleMs?: number; max?: number; pollMs?: number } = {}) {
    this.settleMs = options.settleMs ?? 150;
    this.max = options.max ?? 50;
    this.pollMs = options.pollMs ?? 2_000;
  }

  /** Watches `botId`'s note, knowing it as of `mtime` (what was just read or saved, so that is not told). */
  watch(botId: string, file: string, mtime: number | null) {
    const current = this.notes.get(botId);
    if (current && current.file === file) {
      current.known = mtime;
      // Most recently used last, for the oldest to go first.
      this.notes.delete(botId);
      this.notes.set(botId, current);
      return;
    }
    if (current) this.unwatch(botId);
    while (this.notes.size >= this.max) this.unwatch(this.notes.keys().next().value!);
    const entry: Watched = { file, known: mtime, watcher: null, timer: null };
    try {
      entry.watcher = watch(dirname(file), (_event, name) => {
        if (name && String(name) !== basename(file)) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.settle(botId, entry), this.settleMs);
      });
      entry.watcher.on("error", () => {});
    } catch {
      // The folder is gone: nothing to watch until the note is read again.
    }
    this.notes.set(botId, entry);
    if (!this.poll) {
      this.poll = setInterval(() => { for (const [id, note] of this.notes) if (!note.timer) this.settle(id, note); }, this.pollMs);
      this.poll.unref?.();
    }
  }

  private settle(botId: string, entry: Watched) {
    entry.timer = null;
    if (this.notes.get(botId) !== entry) return;
    const now = mtimeOf(entry.file);
    if (now === entry.known) return;
    entry.known = now;
    this.changed(botId, now);
  }

  unwatch(botId: string) {
    const entry = this.notes.get(botId);
    if (!entry) return;
    this.notes.delete(botId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    if (!this.notes.size && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  /** The bots whose notes are watched, oldest first. */
  watched(): string[] {
    return [...this.notes.keys()];
  }

  close() {
    for (const botId of [...this.notes.keys()]) this.unwatch(botId);
  }
}
