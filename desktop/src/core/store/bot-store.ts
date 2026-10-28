// One bot's files, in the same folder layout and formats as the Swift app's `BotStore`:
//   chat.json        its chat lines (the newest HISTORY_LIMIT), an array of ChatMessage
//   bot.json         its settings (model, alwaysAllowed, unread, …); keys 2.0 does not use are kept
//   subagents.json + subagents.json.journal/   compatible checkpoint plus durable worker changes
//   tasks.json, pins.json, specs.json          complete atomic files
//   head.json        2.0 only: the claude session its head resumes
//   done-days.json   2.0 only: when its tasks were finished, the last 14 days (the whiteboard's chart)
// Every write is atomic. A file that exists but cannot be read is never replaced: the bot is
// reported as broken instead, and the file stays for the user (or 1.x) to look at.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { HistoryJournal, readHistory } from "../durable/history-journal";
import { HISTORY_LIMIT, isChatRecord, type ChatRecord } from "./records";

export class StoreError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`${file}: ${reason}`);
  }
}

export const CHAT_FILES = ["chat.json", "subagents.json", "pins.json", "specs.json", "tasks.json"] as const;

export interface HeadState {
  /** The claude session the bot's head runs (`--session-id` the first time, `--resume` after). */
  sessionId: string;
  /** claude has written that session (it answered once), so it can be resumed. */
  started: boolean;
}

/** Reads a JSON file: undefined when missing, StoreError when present but unreadable. */
export function readJSON(file: string): unknown {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StoreError(file, `not valid JSON (${(error as Error).message})`);
  }
}

export class BotStore {
  constructor(readonly directory: string) {}

  private workerJournal?: HistoryJournal;

  /** Flush the compatible array checkpoint before releasing a profile or handing it over. */
  async flushWorkerHistory(): Promise<void> { await this.workerJournal?.flush(); }
  async closeWorkerHistory(): Promise<void> { await this.workerJournal?.close(); }

  private path(name: string) {
    return join(this.directory, name);
  }

  get hasChat(): boolean {
    return existsSync(this.path("chat.json"));
  }

  /**
   * The chat lines. Lines 1.x would not decode are left out of what 2.0 shows; `dropped` counts
   * them, and a store with dropped lines is not written back until the chat changes.
   */
  loadMessages(): { records: ChatRecord[]; dropped: number } {
    const value = readJSON(this.path("chat.json"));
    if (value === undefined) return { records: [], dropped: 0 };
    if (!Array.isArray(value)) throw new StoreError(this.path("chat.json"), "not a list of chat lines");
    const records = value.filter(isChatRecord);
    return { records, dropped: value.length - records.length };
  }

  saveMessages(records: ChatRecord[]) {
    writeFileAtomic(this.path("chat.json"), JSON.stringify(records.slice(-HISTORY_LIMIT)));
  }

  /** bot.json as an object (empty when missing; 1.x reads a broken one as empty too). */
  loadSettings(): Record<string, unknown> {
    try {
      const value = readJSON(this.path("bot.json"));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Sets one key of bot.json, keeping every other key as it was. */
  saveSetting(key: string, value: unknown) {
    const settings = this.loadSettings();
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    writeFileAtomic(this.path("bot.json"), JSON.stringify(settings));
  }

  loadAlwaysAllowed(): string[] {
    const value = this.loadSettings().alwaysAllowed;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  }

  loadUnread(): number {
    const value = this.loadSettings().unread;
    return typeof value === "number" && value >= 0 ? Math.floor(value) : 0;
  }

  /** The model 1.x saved for it ("haiku", "sonnet", "opus"), if any. */
  loadModel(): string | null {
    const value = this.loadSettings().model;
    return typeof value === "string" && /^[a-z0-9.-]+$/i.test(value) ? value : null;
  }

  /** A list file kept as it is (subagents.json, tasks.json, …): its entries, or [] when missing. */
  loadList(name: (typeof CHAT_FILES)[number]): unknown[] {
    if (name === "subagents.json") {
      const rows = readHistory(this.path(name));
      this.workerJournal = HistoryJournal.forFile(this.path(name), rows);
      return rows;
    }
    const value = readJSON(this.path(name));
    // subagents-progress.json belonged to an unreleased incompatible implementation.
    // It is not authoritative and is deliberately never read or removed: even malformed
    // leftovers must not hide a valid checkpoint or trigger Bot's empty-list fallback.
    return Array.isArray(value) ? value : [];
  }

  /** Other lists replace their file; worker updates commit a journal and checkpoint off-thread. */
  saveList(name: (typeof CHAT_FILES)[number], list: unknown[]) {
    if (name === "subagents.json") this.commitWorkerHistory(list);
    else writeFileAtomic(this.path(name), JSON.stringify(list));
  }

  /** Running progress uses the same durable journal as critical changes. The bot coalesces it. */
  saveWorkerProgress(list: unknown[], changedIds?: ReadonlySet<string>): void {
    this.commitWorkerHistory(list, changedIds);
  }

  /** The synchronous return acknowledges a small fsynced transaction, not an unfinished write.
   * Only changed records are diffed; unchanged retained history is never JSON encoded here.
   * readHistory replays the journal until the off-thread compatible checkpoint completes.
   */
  commitWorkerHistory(list: unknown[], changedIds?: ReadonlySet<string>): void {
    this.workerJournal ??= HistoryJournal.forFile(this.path("subagents.json"));
    this.workerJournal.commit(list, changedIds);
  }

  /** The bot's picture on the main bot's whiteboard (whiteboard.json, 2.0 only), as kept; null: none. */
  loadWhiteboard(): unknown {
    return readJSON(this.path("whiteboard.json")) ?? null;
  }

  /** Keeps the whiteboard picture (null: takes the file away). */
  saveWhiteboard(value: unknown) {
    if (value === null) rmSync(this.path("whiteboard.json"), { force: true });
    else writeFileAtomic(this.path("whiteboard.json"), JSON.stringify(value));
  }

  /** When its tasks were finished (done-days.json, 2.0 only; `whiteboard-data.ts`), as kept; null: none or unreadable. */
  loadDoneLog(): unknown {
    try { return readJSON(this.path("done-days.json")) ?? null; } catch { return null; }
  }

  saveDoneLog(value: unknown) {
    writeFileAtomic(this.path("done-days.json"), JSON.stringify(value));
  }

  loadHead(): HeadState | null {
    try {
      const value = readJSON(this.path("head.json")) as Partial<HeadState> | undefined;
      if (value && typeof value.sessionId === "string" && typeof value.started === "boolean") return { sessionId: value.sessionId, started: value.started };
    } catch { /* a new session then */ }
    return null;
  }

  saveHead(state: HeadState) {
    writeFileAtomic(this.path("head.json"), JSON.stringify(state));
  }
}
