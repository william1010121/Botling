// One bot's files, in the same folder layout and formats as the Swift app's `BotStore`:
//   chat.json        its chat lines (the newest HISTORY_LIMIT), an array of ChatMessage
//   bot.json         its settings (model, alwaysAllowed, unread, …); keys 2.0 does not use are kept
//   subagents.json, tasks.json, pins.json, specs.json   kept as they are (2.0 does not use them yet)
//   head.json        2.0 only: the claude session its head resumes
// Every write is atomic. A file that exists but cannot be read is never replaced: the bot is
// reported as broken instead, and the file stays for the user (or 1.x) to look at.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
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

// One process-wide LRU budget shared by all bots and partner stores. Neither the owner
// nor cached record keys are held strongly. Dead-owner cleanup is opportunistic as well
// as finalized, so GC scheduling is not needed to enforce the bounds.
const WORKER_CACHE_CHARACTERS = 64 * 1024 * 1024;
const WORKER_CACHE_STORES = 128;
const WORKER_CACHE_ITEMS = 4096;
interface WorkerHistoryCache {
  owner: WeakRef<BotStore>;
  rows: WeakMap<object, string>;
  characters: number;
  items: number;
}
const workerHistoryCaches = new Map<object, WorkerHistoryCache>();
let workerHistoryCharacters = 0;
let workerHistoryItems = 0;
const workerHistoryFinalizer = new FinalizationRegistry<object>(token => clearWorkerHistory(token));
function clearWorkerHistory(token: object): void {
  const entry = workerHistoryCaches.get(token);
  if (!entry) return;
  workerHistoryCharacters -= entry.characters;
  workerHistoryItems -= entry.items;
  workerHistoryCaches.delete(token);
  workerHistoryFinalizer.unregister(token);
}
function sweepWorkerHistory(): void {
  for (const [token, entry] of workerHistoryCaches) if (!entry.owner.deref()) clearWorkerHistory(token);
}
function retainWorkerHistory(token: object, entry: WorkerHistoryCache): void {
  clearWorkerHistory(token);
  sweepWorkerHistory();
  if (!entry.items) return;
  while (workerHistoryCharacters + entry.characters > WORKER_CACHE_CHARACTERS || workerHistoryCaches.size >= WORKER_CACHE_STORES
    || workerHistoryItems + entry.items > WORKER_CACHE_ITEMS) {
    clearWorkerHistory(workerHistoryCaches.keys().next().value!);
  }
  workerHistoryCaches.set(token, entry);
  workerHistoryCharacters += entry.characters;
  workerHistoryItems += entry.items;
  const owner = entry.owner.deref();
  if (owner) workerHistoryFinalizer.register(owner, token, token);
}

export class BotStore {
  constructor(readonly directory: string) {}

  private readonly workerHistoryToken = {};

  /** Read-only cache diagnostics; counts reserved encoded content, not total process RSS. */
  static workerHistoryCacheUsage() {
    sweepWorkerHistory();
    return { characters: workerHistoryCharacters, stores: workerHistoryCaches.size,
      items: workerHistoryItems,
      limitCharacters: WORKER_CACHE_CHARACTERS, limitStores: WORKER_CACHE_STORES, limitItems: WORKER_CACHE_ITEMS };
  }

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
    if (name === "subagents.json") clearWorkerHistory(this.workerHistoryToken);
    const value = readJSON(this.path(name));
    // subagents-progress.json belonged to an unreleased incompatible implementation.
    // It is not authoritative and is deliberately never read or removed: even malformed
    // leftovers must not hide a valid checkpoint or trigger Bot's empty-list fallback.
    return Array.isArray(value) ? value : [];
  }

  /** Writes a list file (tasks.json, subagents.json) whole, in 1.x's format. */
  saveList(name: (typeof CHAT_FILES)[number], list: unknown[]) {
    if (name === "subagents.json") this.saveWorkers(list, false);
    else writeFileAtomic(this.path(name), JSON.stringify(list));
  }

  /** Running text/token/runtime changes only. Ended rows must be unchanged since the
   * last saveList; callers editing history/status/identity must use saveList instead.
   * Every successful call still durably writes the COMPLETE legacy-compatible JSON array.
   */
  saveWorkerProgress(list: unknown[]): void {
    this.saveWorkers(list, true);
  }

  private saveWorkers(list: unknown[], progress: boolean): void {
    const running = list.some(row => row && typeof row === "object" && (row as { status?: string }).status === "running");
    if (!progress || !running) clearWorkerHistory(this.workerHistoryToken);
    const previous = workerHistoryCaches.get(this.workerHistoryToken);
    const next = new WeakMap<object, string>();
    let cachedCharacters = 0;
    let cachedItems = 0;
    const parts = Array.from(list, row => {
      const ended = row && typeof row === "object" && !Array.isArray(row)
        && ["completed", "failed", "stopped"].includes((row as { status: string }).status);
      const text = (progress && ended ? previous?.rows.get(row) : undefined) ?? JSON.stringify(row) ?? "null";
      // No cache for idle/terminal-only stores. Duplicate row references count once.
      if (running && ended && !next.has(row) && cachedItems < WORKER_CACHE_ITEMS && cachedCharacters + text.length <= WORKER_CACHE_CHARACTERS) {
        next.set(row, text); cachedCharacters += text.length; cachedItems++;
      }
      return text;
    });
    writeFileAtomic(this.path("subagents.json"), `[${parts.join(",")}]`);
    // Failed writes must never establish a cache for a checkpoint that did not commit.
    retainWorkerHistory(this.workerHistoryToken, { owner: new WeakRef(this), rows: next,
      characters: cachedCharacters, items: cachedItems });
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
