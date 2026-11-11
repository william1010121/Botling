// The Notes in the core: one NoteService opens each bot's note.db (note-db.ts) as it is asked for, watches the note.md
// of each one it opened (an edit made in the file comes in by id), and answers the Note tab (`notes.*`, plugins/index.ts)
// and the bots' app_note_* tools (app-tools/registry.ts), so the core process is the one writer of every note.db.
//
// Who may do what (decided by the user, 2026-11-11): a bot reads its own Note and the Notes of the other bots of its
// project (bots sharing its folder: the project bot and its sub bots), and changes only its own; an app-managed worker
// reads (outline, read, search) its owner's and its project's Notes and changes none.
import { statSync } from "node:fs";
import { NoteWatcher, type NoteState, type NoteWrite } from "./bot-note";
import { branch, edit, insert, merge, move, NoteDb, outline, read, remove, search, split, type BranchArgs, type NoteMode } from "./note-db";

export const NOTE_READ_TOOLS = ["app_note_outline", "app_note_read", "app_note_search"] as const;
export const NOTE_WRITE_TOOLS = ["app_note_edit", "app_note_insert", "app_note_delete", "app_note_move", "app_note_split", "app_note_merge", "app_note_branch"] as const;
export const NOTE_TOOLS = [...NOTE_READ_TOOLS, ...NOTE_WRITE_TOOLS] as const;
export type NoteToolName = (typeof NOTE_TOOLS)[number];
export const isNoteTool = (name: string): name is NoteToolName => (NOTE_TOOLS as readonly string[]).includes(name);
const isWriteTool = (name: NoteToolName) => (NOTE_WRITE_TOOLS as readonly string[]).includes(name);

/** Who calls a bot tool: the bot itself (its coordinator session) or one of its app-managed workers. */
export type ToolCaller = "coordinator" | "worker";

export interface NoteServiceOptions {
  log?: (message: string) => void;
  /** An edit made in `note` (note.md) could not be taken; it was kept as `kept`. */
  conflict?: (note: string, kept: string, reason: string) => void;
  /** Watch each opened note.md for edits made there (the app; off in tests that do not ask). */
  watch?: boolean;
  /** At most this many note.db open at once (the oldest closes first). */
  max?: number;
}

export class NoteService {
  private readonly notes = new Map<string, NoteDb>();
  private readonly watcher: NoteWatcher | null;

  constructor(private readonly options: NoteServiceOptions = {}) {
    this.watcher = options.watch ? new NoteWatcher((file) => {
      try { this.notes.get(file)?.sync(); } catch (error) { options.log?.(`note sync failed for ${file}: ${(error as Error).message}`); }
    }) : null;
  }

  /** A note's database, opened (and moved in) the first time, with any edit made in note.md since taken in. */
  note(file: string, bot = ""): NoteDb {
    let note = this.notes.get(file);
    if (note) {
      this.notes.delete(file);
      this.notes.set(file, note);
    } else {
      note = new NoteDb(file, bot, {
        log: this.options.log, conflict: (kept, reason) => this.options.conflict?.(file, kept, reason),
        exported: (mtime) => this.watcher?.watch(file, file, mtime),
      });
      this.notes.set(file, note);
      while (this.notes.size > (this.options.max ?? 50)) {
        const [oldest, open] = this.notes.entries().next().value!;
        open.close();
        this.notes.delete(oldest);
        this.watcher?.unwatch(oldest);
      }
    }
    try {
      note.open();
    } catch (error) {
      this.notes.delete(file);
      throw error;
    }
    if (this.watcher && note.mode === "db") {
      note.sync();
      let mtime: number | null = null;
      try { mtime = statSync(file).mtimeMs; } catch { /* gone */ }
      this.watcher.watch(file, file, mtime);
    }
    return note;
  }

  /** notes.read: the note without ids (file mode: the file as it is). */
  read(file: string, bot?: string): NoteState { return this.note(file, bot).readPlain(); }
  /** notes.write: a whole save, refused when based on an older note. */
  write(file: string, text: string, base?: number, bot?: string): NoteWrite { return this.note(file, bot).writePlain(text, base); }
  mode(file: string, mode?: NoteMode, bot?: string): { mode: NoteMode; reason: string | null } {
    const note = this.note(file, bot);
    return mode ? note.setMode(mode) : { mode: note.mode, reason: note.modeReason };
  }

  close() {
    this.watcher?.close();
    for (const note of this.notes.values()) note.close();
    this.notes.clear();
  }
}

let service = new NoteService();
/** The core's NoteService. */
export function noteService(): NoteService { return service; }
/** Sets the core's NoteService up (server.ts, once). */
export function configureNotes(options: NoteServiceOptions): NoteService {
  service.close();
  service = new NoteService(options);
  return service;
}

/** A bot as the note tools see it. */
export interface NoteBot { id: string; name: string; folder: string; note: string }
let directory: () => NoteBot[] = () => [];
/** Where the bots are (server.ts). */
export function setNoteBots(list: () => NoteBot[]): void { directory = list; }

export interface NoteToolContext { botId: string; caller: ToolCaller; bots?: () => NoteBot[]; service?: NoteService }

const str = (args: Record<string, unknown>, key: string, required = false): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${key} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
};
const int = (args: Record<string, unknown>, key: string, required = false): number | undefined => {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${key} is required.`);
    return undefined;
  }
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`${key} must be a whole number.`);
  return n;
};
const list = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${key} must be a list of strings.`);
  return value as string[];
};
const at = (args: Record<string, unknown>): "start" | "end" | undefined => {
  const value = str(args, "at");
  if (value !== undefined && value !== "start" && value !== "end") throw new Error('at must be "start" or "end".');
  return value as "start" | "end" | undefined;
};
const place = (args: Record<string, unknown>) => ({
  ...(str(args, "after") ? { after: str(args, "after")! } : {}), ...(str(args, "before") ? { before: str(args, "before")! } : {}),
  ...(str(args, "route") ? { route: str(args, "route")! } : {}), ...(at(args) ? { at: at(args)! } : {}),
});

/** One app_note_* call: its result for the model, or a thrown error it reads (nothing was changed). */
export function runNoteTool(name: NoteToolName, args: Record<string, unknown>, context: NoteToolContext): unknown {
  const bots = (context.bots ?? directory)();
  const self = bots.find((bot) => bot.id === context.botId);
  if (!self) throw new Error("Notes are not available for this session.");
  if (isWriteTool(name) && context.caller === "worker") {
    throw new Error("A worker reads Notes only (app_note_outline, app_note_read, app_note_search): say in your report what should change in the Note; your owner changes it.");
  }
  const project = bots.filter((bot) => bot.folder === self.folder);
  const pick = (wanted: string | undefined): NoteBot => {
    if (!wanted || wanted === self.id) return self;
    const lower = wanted.toLowerCase();
    const found = bots.find((bot) => bot.id === wanted) ?? bots.find((bot) => bot.name.toLowerCase() === lower);
    const names = project.map((bot) => `${bot.name} (${bot.id})`).join(", ");
    if (!found) throw new Error(`No bot ${wanted}. Notes you can read: ${names}.`);
    if (found.folder !== self.folder) throw new Error(`${found.name}'s Note is in another project: you can read only the Notes of this project's bots (${names}).`);
    return found;
  };
  const service = context.service ?? noteService();
  const actor = `${context.caller === "worker" ? "worker" : "bot"}:${self.id}`;
  const target = name === "app_note_search" && args.bot === "all" ? self : pick(str(args, "bot"));
  if (isWriteTool(name) && target.id !== self.id) throw new Error(`You can change only your own Note; ${target.name}'s is read-only for you.`);
  const open = (bot: NoteBot) => service.note(bot.note, bot.id);
  const about = (bot: NoteBot) => ({ bot: { id: bot.id, name: bot.name } });
  const note = open(target);
  const all = name === "app_note_search" && args.bot === "all";
  if (note.mode === "file" && !all) {
    throw new Error(`${target.id === self.id ? "Your" : `${target.name}'s`} Note is kept as a plain file (${note.modeReason ?? "not moved into its database"}), so it has no cell ids: read${target.id === self.id ? " and edit" : ""} ${target.note} directly.`);
  }
  const conflict = note.mode === "db" ? note.sync() : null;
  const kept = conflict ? { conflict_file: conflict, note: "An edit made in note.md was not taken (it changed an older copy of a cell); it is kept in conflict_file. Tell the user." } : {};
  switch (name) {
    case "app_note_outline":
      return { ...about(target), ...outline(note), ...kept };
    case "app_note_read": {
      const ids = list(args, "ids");
      const route = str(args, "route");
      return { ...about(target), ...read(note, { ...(ids ? { ids } : {}), ...(route ? { route } : {}) }), ...kept };
    }
    case "app_note_search": {
      const query = str(args, "query", true)!;
      const limit = Math.max(1, Math.min(int(args, "limit") ?? 20, 200));
      const where = args.bot === "all" ? project : [target];
      const matches = where.flatMap((bot) => {
        try {
          const each = bot === target ? note : open(bot);
          if (each.mode === "file") return [];
          return search(each, query, limit).map((match) => ({ ...(where.length > 1 ? { bot: bot.id } : {}), ...match }));
        } catch { return []; }
      }).slice(0, limit);
      return { ...(where.length > 1 ? { bots: where.map((bot) => ({ id: bot.id, name: bot.name })) } : about(target)), matches, ...kept };
    }
    case "app_note_edit":
      return { ...edit(note, actor, { id: str(args, "id", true)!, rev: int(args, "rev"), text: args.text === undefined ? undefined : String(args.text ?? ""), old_text: str(args, "old_text"), new_text: args.new_text === undefined ? undefined : String(args.new_text ?? "") }), ...kept };
    case "app_note_insert":
      if (typeof args.text !== "string") throw new Error("text is required.");
      return { ...insert(note, actor, { ...place(args), text: args.text }), ...kept };
    case "app_note_delete":
      return { ...remove(note, actor, { id: str(args, "id", true)!, rev: int(args, "rev") }), ...kept };
    case "app_note_move":
      return { ...move(note, actor, { ...place(args), id: str(args, "id", true)! }), ...kept };
    case "app_note_split":
      return { ...split(note, actor, { id: str(args, "id", true)!, rev: int(args, "rev"), line: int(args, "line", true)! }), ...kept };
    case "app_note_merge":
      return { ...merge(note, actor, { id: str(args, "id", true)!, rev: int(args, "rev"), next_rev: int(args, "next_rev") }), ...kept };
    case "app_note_branch": {
      const op = str(args, "op", true) as BranchArgs["op"];
      const fields: BranchArgs = { op, ...place(args) };
      for (const key of ["name", "branch", "route", "keep"] as const) { const value = str(args, key); if (value !== undefined) fields[key] = value; }
      const ids = list(args, "ids");
      const names = list(args, "names");
      const rev = int(args, "rev");
      return { ...branch(note, actor, { ...fields, ...(ids ? { ids } : {}), ...(names ? { names } : {}), ...(rev !== undefined ? { rev } : {}) }), ...kept };
    }
  }
}
