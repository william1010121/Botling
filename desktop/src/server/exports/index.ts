// Exports for bots (protocol v1 §7.5): Botling 3 keeps a bot's chat in server.db, but bots and plugin authors read the
// 2.x files in the bot's data folder (the bot guides point at chat.json and pins.json; plugins at specs.json). So the
// server writes chat.json, pins.json, subagents.json, specs.json and tasks.json there, in the 2.x format, from what
// server.db committed. The files are written by 2.x's own writer (`FileBotStore`: the same JSON, the same atomic
// write, subagents.json through `SubagentStore`), so they are what 2.x would have written for the same chat.
//
// When:
//   - after a commit that touched the bot (`committed`, wired to `DbBotStores`' `onCommitted`): debounced. The first
//     commit starts a `debounceMs` (500 ms) timer and later commits join it, so a busy turn exports at most twice a
//     second and the last commit is never more than `debounceMs` behind on disk;
//   - at turn end (`turnEnded`, or `feed` with the core's `turn.finished`): at once, after the bot's writes in flight
//     have committed;
//   - at start (`start`): every export whose file differs from server.db (missing, older, or edited by hand) is
//     rewritten.
// A file is rewritten only when its content changed since this exporter last wrote or checked it.
//
// The files are derived: nothing in Botling reads them back, and server.db stays the source of truth. A part that
// server.db has never stored is not exported (2.x would not have written its file either), except that an emptied chat
// or subagent index rewrites a file that is there, as 2.x would.
//
// subagents/<id>.jsonl (each subagent's steps) is not exported: the bot guides do not point at it, and rewriting a
// growing step log from rows on every debounce costs far more than the index.
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Event as ContractEvent } from "../../contract";
import { FileBotStore, readJSON, type ChatFile } from "../../core/store/bot-store";
import type { ChatRecord } from "../../core/store/records";
import { INDEX_FORMAT } from "../../core/store/subagent-store";
import { readCommittedBot, type CommittedBot } from "../botstore";
import { systemClock, type Clock, type TimerHandle } from "../live/clock";
import type { Db } from "../store/sqlite";

/** The exported files, in the order they are written. */
export const EXPORT_FILES = ["chat.json", "pins.json", "subagents.json", "specs.json", "tasks.json"] as const satisfies readonly ChatFile[];
export type ExportFile = (typeof EXPORT_FILES)[number];

export const EXPORT_DEBOUNCE_MS = 500;

export interface BotExportsOptions {
  /** A read connection to server.db (opened once, closed by `close`). */
  openReader(): Db;
  clock?: Clock;
  debounceMs?: number;
  /** Resolves once bot `botId`'s writes submitted so far have committed (`DbBotStores.settled`). */
  settled?: (botId: string) => Promise<void>;
  /** An export that failed (the next commit or turn end tries again). */
  onError?: (botId: string, error: unknown) => void;
  /** Called after each export (also when nothing needed writing). */
  onExported?: (result: ExportResult) => void;
}

interface BotEntry {
  directory: string;
  timer?: TimerHandle;
  /** file → the content it has on disk, as far as this exporter knows (JSON of what was written or found). */
  readonly written: Map<ExportFile, string>;
}

/** What one export wrote. */
export interface ExportResult {
  botId: string;
  written: ExportFile[];
}

export class BotExports {
  private readonly bots = new Map<string, BotEntry>();
  private readonly clock: Clock;
  private readonly debounceMs: number;
  private reader?: Db;
  private closed = false;

  constructor(private readonly options: BotExportsOptions) {
    this.clock = options.clock ?? systemClock;
    this.debounceMs = options.debounceMs ?? EXPORT_DEBOUNCE_MS;
  }

  private entry(botId: string, directory?: string): BotEntry | undefined {
    let entry = this.bots.get(botId);
    if (!entry && directory !== undefined) this.bots.set(botId, entry = { directory, written: new Map() });
    if (entry && directory !== undefined && entry.directory !== directory) {
      entry.directory = directory;
      entry.written.clear(); // another folder: nothing known about its files
    }
    return entry;
  }

  /** Whether an export of `botId` is waiting for its debounce timer. */
  pending(botId: string): boolean { return !!this.bots.get(botId)?.timer; }

  /** A commit touched bot `botId` (kept in `directory`): export within `debounceMs`. */
  committed(botId: string, directory: string): void {
    if (this.closed) return;
    const entry = this.entry(botId, directory)!;
    if (entry.timer) return; // joins the export already scheduled
    entry.timer = this.clock.setTimeout(() => {
      entry.timer = undefined;
      this.tryExport(botId);
    }, this.debounceMs);
  }

  /** A turn of bot `botId` ended: export at once, once its writes in flight committed. */
  async turnEnded(botId: string, directory?: string): Promise<ExportResult | null> {
    if (this.closed) return null;
    if (directory !== undefined) this.entry(botId, directory);
    // The last writes commit first (their commit may also be what makes the bot known here).
    try { await this.options.settled?.(botId); } catch (error) { this.options.onError?.(botId, error); }
    const entry = this.entry(botId);
    if (!entry || this.closed) return null;
    if (entry.timer) { this.clock.clearTimeout(entry.timer); entry.timer = undefined; }
    return this.tryExport(botId);
  }

  /** The core's contract events: `turn.finished` is a turn end. Returns the export it started, if any. */
  feed(event: ContractEvent): Promise<ExportResult | null> | null {
    return event.type === "turn.finished" ? this.turnEnded(event.botId) : null;
  }

  /** At start: compares every bot's exports with server.db and rewrites those that differ. */
  start(bots: Iterable<{ botId: string; directory: string }>): ExportResult[] {
    const results: ExportResult[] = [];
    for (const { botId, directory } of bots) {
      const entry = this.entry(botId, directory)!;
      entry.written.clear(); // know nothing: compare with the files themselves
      const result = this.tryExport(botId);
      if (result) results.push(result);
    }
    return results;
  }

  /** Exports bot `botId` now, from what server.db committed. Throws what failed. */
  exportNow(botId: string, directory?: string): ExportResult {
    const entry = this.entry(botId, directory);
    if (!entry) throw new Error(`no data folder known for bot ${botId}`);
    if (entry.timer) { this.clock.clearTimeout(entry.timer); entry.timer = undefined; }
    if (this.closed) throw new Error("exports are closed");
    const committed = readCommittedBot(this.reader ??= this.options.openReader(), botId);
    const written: ExportFile[] = [];
    let failure: unknown;
    for (const file of EXPORT_FILES) {
      try { if (writeExport(entry, file, committed)) written.push(file); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
    const result = { botId, written };
    try { this.options.onExported?.(result); } catch { /* an observer never fails an export */ }
    return result;
  }

  private tryExport(botId: string): ExportResult | null {
    try { return this.exportNow(botId); } catch (error) { this.options.onError?.(botId, error); return null; }
  }

  /** Writes the exports still waiting for their timer, then closes the read connection. */
  close(): void {
    if (this.closed) return;
    for (const [botId, entry] of this.bots) if (entry.timer) this.tryExport(botId);
    this.closed = true;
    this.reader?.close();
    this.reader = undefined;
  }
}

/** What `file` should hold for `committed`, as JSON of its payload; null: leave the file as it is. */
function wanted(file: ExportFile, committed: CommittedBot, exists: () => boolean): unknown[] | null {
  const value = file === "chat.json" ? committed.chat : file === "subagents.json" ? committed.subagents : committed.lists[file];
  if (value !== null) return value;
  // No rows: never stored, or emptied (DbBotStore keeps no row for an empty chat or subagent index). 2.x writes an
  // emptied chat as [] and an emptied index as an empty index, so a file that is there is emptied too.
  return (file === "chat.json" || file === "subagents.json") && exists() ? [] : null;
}

/** The payload a file on disk holds, as JSON (subagents.json: its entries); undefined when missing or unreadable. */
function onDisk(path: string, file: ExportFile): string | undefined {
  try {
    const value = readJSON(path) as { format?: unknown; subagents?: unknown } | undefined;
    if (value === undefined) return undefined;
    if (file !== "subagents.json") return JSON.stringify(value);
    return value?.format === INDEX_FORMAT && Array.isArray(value.subagents) ? JSON.stringify(value.subagents) : undefined;
  } catch {
    return undefined;
  }
}

function writeExport(entry: BotEntry, file: ExportFile, committed: CommittedBot): boolean {
  const path = join(entry.directory, file);
  const known = entry.written.get(file);
  const value = wanted(file, committed, () => known !== undefined || onDisk(path, file) !== undefined);
  if (value === null) return false;
  const text = JSON.stringify(value);
  if (text === (known ?? onDisk(path, file))) { entry.written.set(file, text); return false; }
  // 2.x's writer, on a store of its own each time (SubagentStore reads the index on disk first: nothing is cached).
  const store = new FileBotStore(entry.directory);
  if (file === "chat.json") store.saveMessages(value as ChatRecord[]);
  else if (file === "subagents.json") {
    try { store.saveList(file, value); } catch {
      // A broken index (derived, never read back) would stop every later export: replace it.
      rmSync(path, { force: true });
      new FileBotStore(entry.directory).saveList(file, value);
    }
  } else store.saveList(file, value);
  entry.written.set(file, text);
  return true;
}
