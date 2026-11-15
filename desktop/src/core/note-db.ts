// A bot's Note kept in SQLite (note-sqlite design, phase 1): `note.db` beside `note.md`, the app's core process its only
// writer. Every cell (block) has an id that never changes and a rev that goes up with each change of its text; a fork is
// a block too (kind "branch") and its routes are rows of their own, so cells nest in routes to any depth. A deleted
// cell stays as a tombstone (its last text, the note rev it went at). Each change is one transaction that bumps the
// note's rev and logs what it did (`ops`).
//
// note.md stays: after each change it is written again with `<!-- cell: <id> -->` before every cell (note-cells.ts
// `exportNote`), so people, git and bots reading the file see the ids, and an edit made in the file comes back by id
// (`sync`). An edit made against an older copy (a cell's text in the file is one it had before) is not taken: the file
// is kept as note.conflict-<time>.md and note.md is written again from the database.
//
// Moving in (`migrate`): note.md is copied to note.md.pre-sqlite-<date>, cut into cells by the Note tab's own rules,
// written to the database, exported and read back; anything that does not read back the same keeps the note in file
// mode (note.md as before, nothing rewritten) with the reason. A note in file mode is read and saved as a plain file;
// switching it back to file mode writes a note.md without ids.
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readNote, writeNote, type NoteState, type NoteWrite } from "./bot-note";
import { exportNote, noteTree, treeShape, type TreeItem } from "./note-cells";
import {
  Model, NOTE_SCHEMA, applyTree, flattenTree, matchTree,
  type BlockRow, type NoteDbHooks, type NoteMode, type NotePathStep, type NoteRow, type RouteRow,
} from "./note-tree";
export {
  NOTE_SCHEMA, NoteConflict, ROOT, align, evenKeys, keyBetween, withoutBlankEdges,
  type NoteDbHooks, type NoteMode, type NotePathStep, type OutlineBlock, type OutlineFork, type OutlineItem,
} from "./note-tree";

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/** Where a note's database is: note.db beside note.md. */
export function noteDbPath(noteFile: string): string {
  return join(dirname(noteFile), `${basename(noteFile).replace(/\.md$/i, "")}.db`);
}

// ---- one note ----

export interface NoteTx<T> { (model: Model): T }
export interface WriteResult { note_rev: number; changed: { id: string; rev: number; deleted?: true }[]; conflict_file?: string }

export class NoteDb {
  private db: DatabaseSync | null = null;

  constructor(readonly file: string, readonly bot: string, private readonly hooks: NoteDbHooks = {}) {}

  private now() { return this.hooks.now?.() ?? Date.now(); }
  private log(message: string) { this.hooks.log?.(`note ${this.bot}: ${message}`); }

  /** Opens note.db, moving the note in first when there is none. */
  open(): DatabaseSync {
    if (this.db) return this.db;
    const path = noteDbPath(this.file);
    const fresh = !existsSync(path);
    if (fresh) readNote(this.file);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;");
      db.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, bot TEXT NOT NULL, rev INTEGER NOT NULL, schema_version INTEGER NOT NULL, mode TEXT NOT NULL, mode_reason TEXT, exported_text TEXT, exported_mtime REAL, migrated_at INTEGER);
        CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, parent TEXT NOT NULL, sort_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, name TEXT, rev INTEGER NOT NULL, deleted_at INTEGER, deleted_rev INTEGER);
        CREATE INDEX IF NOT EXISTS blocks_parent ON blocks(parent, sort_key);
        CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, name TEXT NOT NULL, sort_key TEXT NOT NULL, rev INTEGER NOT NULL, implicit INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);
        CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, note_rev INTEGER NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, target TEXT, before TEXT, after TEXT, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ops_target ON ops(target);`);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    if (fresh || !this.row()) this.migrate();
    return db;
  }

  close() { this.db?.close(); this.db = null; }

  private row(): NoteRow | null {
    return (this.db!.prepare("SELECT * FROM notes WHERE id = 'note'").get() as NoteRow | undefined) ?? null;
  }
  private setRow(fields: Partial<NoteRow>) {
    const keys = Object.keys(fields);
    this.db!.prepare(`UPDATE notes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 'note'`).run(...keys.map((k) => (fields as Record<string, never>)[k]));
  }
  private load(rev: number): Model {
    const blocks = this.db!.prepare("SELECT * FROM blocks").all() as unknown as BlockRow[];
    const routes = this.db!.prepare("SELECT * FROM routes").all() as unknown as RouteRow[];
    return new Model(blocks.map((row) => ({ ...row })), routes.map((row) => ({ ...row })), rev, this.now());
  }

  get mode(): NoteMode { this.open(); return this.row()!.mode; }
  get modeReason(): string | null { this.open(); return this.row()!.mode_reason; }
  get rev(): number { this.open(); return this.row()!.rev; }

  /** The model at this rev, for reading. */
  model(): Model { this.open(); this.sync(); return this.load(this.row()!.rev); }

  /** Moves note.md in (see the file's head). */
  private migrate() {
    const db = this.db!;
    const now = this.now();
    const text = readFileSync(this.file, "utf8");
    db.prepare("INSERT OR REPLACE INTO notes (id, bot, rev, schema_version, mode, mode_reason, exported_text, exported_mtime, migrated_at) VALUES ('note', ?, 0, ?, 'file', NULL, NULL, NULL, NULL)").run(this.bot, NOTE_SCHEMA);
    if (text.trim()) {
      let backup = `${this.file}.pre-sqlite-${stamp(now).slice(0, 8)}`;
      for (let n = 2; existsSync(backup); n++) backup = `${this.file}.pre-sqlite-${stamp(now).slice(0, 8)}-${n}`;
      copyFileSync(this.file, backup);
    }
    const reason = this.takeIn(text, "migrate");
    if (reason) {
      this.setRow({ mode: "file", mode_reason: reason });
      this.log(`stays in file mode: ${reason}`);
    } else {
      this.setRow({ migrated_at: now });
    }
  }

  /**
   * Takes `text` into the database as the whole note (moving in, switching back to database mode, an edit made in the
   * file, a whole save) and exports it. Null when done; else why it could not (nothing changed then).
   */
  private takeIn(text: string, actor: string): string | null {
    const tree = noteTree(text);
    let done: string | null = null;
    try {
      this.transaction(actor, (model) => {
        applyTree(model, tree.items);
        // What was read must read back the same once exported, with or without ids.
        const plain = exportNote(model.exportItems(), { ids: false });
        if (JSON.stringify(treeShape(noteTree(plain).items)) !== JSON.stringify(treeShape(tree.items))) throw new Error("the note does not read back the same once written again");
      }, { mode: "db" });
    } catch (error) {
      done = (error as Error).message;
    }
    return done;
  }

  /**
   * One change: a transaction on the model that must read back the same once exported with ids; the note's rev goes up,
   * the ops are logged and note.md is written again. A note in file mode refuses (unless `mode` makes it db).
   */
  transaction<T>(actor: string, change: NoteTx<T>, options: { mode?: NoteMode } = {}): T & WriteResult {
    const db = this.open();
    const conflict = options.mode ? null : this.sync();
    const current = this.row()!;
    if (current.mode !== "db" && options.mode !== "db") throw new Error(`This note is in file mode${current.mode_reason ? ` (${current.mode_reason})` : ""}: read and edit ${this.file} directly.`);
    const rev = current.rev + 1;
    db.exec("BEGIN IMMEDIATE");
    let open = true;
    let result: T;
    let model: Model;
    try {
      model = this.load(rev);
      result = change(model);
      model.tidy();
      const text = exportNote(model.exportItems(), { ids: true });
      // The empty note is the empty file, which has no id line to read back.
      const withIds = text !== "";
      if (JSON.stringify(treeShape(noteTree(text).items, withIds)) !== JSON.stringify(model.shape(model.tree(), withIds))) {
        throw new Error("That change would not read back the same from note.md (a ``` fence, $$ block or <show> card left open swallows what follows it, or a card shares a cell with text). Nothing was changed.");
      }
      if (!model.changed && current.mode === "db") {
        db.exec("ROLLBACK");
        open = false;
        return { ...(result as object), note_rev: current.rev, changed: [], ...(conflict ? { conflict_file: conflict } : {}) } as T & WriteResult;
      }
      model.save(db);
      const op = db.prepare("INSERT INTO ops (note_rev, actor, op, target, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const entry of model.ops) op.run(rev, actor, entry.op, entry.target, entry.before === null ? null : JSON.stringify(entry.before), entry.after === null ? null : JSON.stringify(entry.after), model.now);
      this.setRow({ rev, mode: "db", mode_reason: null, exported_text: text });
      // note.md before the commit: should the commit fail, the file holds the change and comes back in as an edit made there.
      writeNote(this.file, text);
      db.exec("COMMIT");
      open = false;
    } catch (error) {
      if (open) db.exec("ROLLBACK");
      throw error;
    }
    this.fileWritten();
    const changed = model.changedBlocks().map((id) => {
      const row = model.blocks.get(id)!;
      return row.deleted_at !== null ? { id, rev: row.rev, deleted: true as const } : { id, rev: row.rev };
    });
    return { ...(result as object), note_rev: rev, changed, ...(conflict ? { conflict_file: conflict } : {}) } as T & WriteResult;
  }

  private writeFile(text: string) {
    writeNote(this.file, text);
    this.fileWritten();
  }
  private fileWritten() {
    const mtime = statSync(this.file).mtimeMs;
    this.setRow({ exported_mtime: mtime });
    this.hooks.exported?.(mtime);
  }

  /**
   * Takes in an edit someone made in note.md since the app last wrote it. Cells come back by id; an edit made against an
   * older copy of a cell (its text one it had before, or a deleted cell back) is not taken: the file is kept as
   * note.conflict-<time>.md and note.md is written again. Returns the conflict file, if any.
   */
  sync(): string | null {
    this.open();
    const row = this.row()!;
    if (row.mode !== "db") return null;
    let mtime: number | null = null;
    try { mtime = statSync(this.file).mtimeMs; } catch { /* removed */ }
    if (mtime === null) { this.writeFile(row.exported_text ?? ""); return null; }
    if (mtime === row.exported_mtime) return null;
    const text = readFileSync(this.file, "utf8");
    if (text === row.exported_text) { this.setRow({ exported_mtime: mtime }); return null; }
    const stale = this.staleIn(text);
    if (stale) return this.conflict(text, stale);
    const reason = this.takeIn(text, "file");
    if (reason) return this.conflict(text, reason);
    return null;
  }

  /** Why `text` (note.md as someone left it) is an older copy, or null. */
  private staleIn(text: string): string | null {
    const model = this.load(this.row()!.rev);
    const history = this.db!.prepare("SELECT before FROM ops WHERE target = ? AND before IS NOT NULL");
    for (const block of flattenTree(noteTree(text).items).blocks) {
      if (!block.id || !block.text.trim()) continue;
      const row = model.blocks.get(block.id);
      if (!row || row.kind === "branch") continue;
      if (row.deleted_at !== null) return `cell ${block.id} was deleted at note rev ${row.deleted_rev}`;
      if (row.text === block.text) continue;
      const older = (history.all(block.id) as { before: string }[]).some((entry) => { try { return (JSON.parse(entry.before) as { text?: string }).text === block.text; } catch { return false; } });
      if (older) return `cell ${block.id} has an older text than its rev ${row.rev}`;
    }
    return null;
  }

  private conflict(text: string, reason: string): string {
    let file = join(dirname(this.file), `note.conflict-${stamp(this.now())}.md`);
    for (let n = 2; existsSync(file); n++) file = join(dirname(this.file), `note.conflict-${stamp(this.now())}-${n}.md`);
    writeFileSync(file, text);
    this.writeFile(this.row()!.exported_text ?? "");
    this.log(`an edit made in note.md was not taken (${reason}); kept as ${file}`);
    this.hooks.conflict?.(file, reason);
    return file;
  }

  // ---- the Note tab (notes.read / notes.write), unchanged for it ----

  /** The note as the Note tab reads it: without ids; mtime is note.md's, the base of its next save. */
  readPlain(): NoteState {
    this.open();
    this.sync();
    const row = this.row()!;
    if (row.mode !== "db") return readNote(this.file);
    const model = this.load(row.rev);
    return { path: this.file, text: exportNote(model.exportItems(), { ids: false }), mtime: row.exported_mtime ?? 0 };
  }

  /** A whole save from the Note tab: refused (with the note now) when it was based on an older note. */
  writePlain(text: string, base?: number): NoteWrite {
    this.open();
    this.sync();
    const row = this.row()!;
    if (row.mode !== "db") return writeNote(this.file, text, base);
    const now = this.readPlain();
    if (base !== undefined && base !== now.mtime) return { saved: false, text: now.text, mtime: now.mtime };
    if (text === now.text) return { saved: true, mtime: now.mtime };
    try {
      this.transaction("editor", (model) => applyTree(model, noteTree(text).items));
    } catch (error) {
      // Never lose the user's words: the note goes back to file mode with them.
      const reason = (error as Error).message;
      this.log(`a save could not be kept in note.db (${reason}); the note is in file mode now`);
      this.setRow({ mode: "file", mode_reason: reason });
      return writeNote(this.file, text);
    }
    return { saved: true, mtime: this.row()!.exported_mtime ?? 0 };
  }

  /** Switches the note: "file" writes note.md without ids and leaves note.db as it is; "db" takes note.md in again. */
  setMode(mode: NoteMode): { mode: NoteMode; reason: string | null } {
    this.open();
    const row = this.row()!;
    if (mode === row.mode) return { mode, reason: row.mode_reason };
    if (mode === "file") {
      this.sync();
      const plain = this.readPlain().text;
      this.setRow({ mode: "file", mode_reason: "switched to file mode" });
      writeNote(this.file, plain);
      this.log("switched to file mode");
      return { mode: "file", reason: "switched to file mode" };
    }
    const reason = this.takeIn(readNote(this.file).text, "mode");
    if (reason) { this.setRow({ mode_reason: reason }); return { mode: "file", reason }; }
    this.log("switched to database mode");
    return { mode: "db", reason: null };
  }

  /**
   * Ids for the Note tab's cells and forks, with their lines (0-based) in the text it has: `text` (the editor's words,
   * saved or not: cells matched the way a save would, null for a new one) or, without, the note as notes.read gives it.
   */
  outlineLines(text?: string) {
    const model = this.model();
    const row = this.row()!;
    if (row.mode !== "db") {
      const note = readNote(this.file);
      return { mode: row.mode, reason: row.mode_reason, rev: row.rev, mtime: note.mtime, ...(text === undefined ? { text: note.text } : {}), cells: [], forks: [] };
    }
    const plain = text ?? exportNote(model.exportItems(), { ids: false });
    const tree = noteTree(plain);
    const taken = matchTree(model, tree.items);
    const cells: unknown[] = [];
    const forks: unknown[] = [];
    const walk = (items: readonly TreeItem[], path: NotePathStep[]) => {
      for (const item of items) {
        if (item.type === "block") {
          const id = taken.blocks.get(item) ?? null;
          const known = id ? model.blocks.get(id) : undefined;
          cells.push({ id, rev: known && known.deleted_at === null && known.text === item.text ? known.rev : null, kind: item.kind, type: item.cell, start: item.start, end: item.end, path, label: label(id, path) });
        } else {
          const id = taken.forks.get(item) ?? null;
          forks.push({
            id, name: item.name, start: item.start, end: item.endLine, path, label: forkLabel(id, path, item.name),
            routes: item.routes.map((route) => ({ id: taken.routes.get(route) ?? null, name: route.name, implicit: route.implicit, start: route.marker >= 0 ? route.marker : route.start, end: route.end })),
          });
          for (const route of item.routes) walk(route.items, [...path, { fork: item.name, forkId: id ?? "", route: route.name, routeId: taken.routes.get(route) ?? "" }]);
        }
      }
    };
    walk(tree.items, []);
    return { mode: row.mode, reason: row.mode_reason, rev: row.rev, mtime: row.exported_mtime ?? 0, ...(text === undefined ? { text: plain } : {}), cells, forks };
  }
}

/** "Note #b7k3f9 · Loading › Lazy load": how a quote names a cell. */
export function label(id: string | null, path: readonly NotePathStep[]): string {
  const where = path.map((step) => `${step.fork} › ${step.route}`).join(" › ");
  return `Note${id ? ` #${id}` : ""}${where ? ` · ${where}` : ""}`;
}

/** "Note #f4k2c1 · Loading": how a quote names a fork (the routes above it, then its own name; the quote adds the route it shows). */
export function forkLabel(id: string | null, path: readonly NotePathStep[], name: string): string {
  const where = [...path.map((step) => `${step.fork} › ${step.route}`), ...(name ? [name] : [])].join(" › ");
  return `Note${id ? ` #${id}` : ""}${where ? ` · ${where}` : ""}`;
}

// ---- reading and changing a note by id (the app_note_* tools): now in note-read.ts ----
export {
  branch, edit, insert, merge, move, outline, read, remove, search, split,
} from "./note-read";
export type { BranchArgs, EditArgs, PlaceArgs } from "./note-read";
