// `DbBotStore`: the core's `BotStore` on server.db rows (protocol v1 §7.3), for Botling 3's server. 2.x never
// reaches this file; it keeps `FileBotStore`.
//
// Where each part lives:
//   chat lines         rows (stream "chat:<botId>", key = line id, rev, body = {"seq":n,"record":<2.x line>}): one row
//                      per line, ordered by seq. A save diffs the list against the rows by id and body: only new,
//                      changed or moved lines are written (rev + 1), lines that left the newest HISTORY_LIMIT are
//                      deleted. Appending a line writes one row. Not the `messages` table: that is the log's read
//                      model (src/server/log/read-model.ts: protocol MessageView bodies, seq = log entry, whole
//                      history), written in the entry's transaction; this is the core's own 2.x-shaped copy.
//   bot.json           bots.settings (the whole object as JSON; `unread` and `model` mirrored into their columns)
//   pins/specs/tasks   lists (botId, name, body), written only when the text changed
//   head.json          lists (botId, "head.json", body)
//   subagent index     rows (stream "subagents:<botId>", key = subagent id, rev, body): one row per entry, written
//                      only when its entry changed; their order in lists (botId, "subagents.order")
//   subagent steps     rows (stream "substeps:[botId,id]", key = zero-padded seq, rev = seq, body = one encoded line),
//                      append-only like the 2.x .jsonl files; removed with their subagent
//
// Sync vs async. The 2.x interface is synchronous: the core reads its own writes at once and a save returns once the
// file is on disk. server.db has one writer with group commit whose acknowledgement is a promise (writer.ts), and a
// command must be synchronous. So:
//   - every bot's state is cached in memory per host (`DbBotStores`), loaded lazily from a read connection, the first
//     time a part is read or merged; after that the cache is always at least as new as server.db;
//   - a save updates the cache synchronously, computes the row diff, and submits one synchronous writer command with
//     it. Group commit batches the saves of the same event-loop turn into one transaction. Commands run in submit
//     order, so the rows always converge to the cache;
//   - reads come from the cache (subagent steps: from the read connection, plus the lines submitted and not yet
//     committed), so read-your-writes holds synchronously for every `DbBotStore` of the same host;
//   - durability is asynchronous: `durable()` resolves once everything submitted so far committed. A failed commit
//     makes the bot's store failed: `durable()` rejects with it and every later save throws it (2.x throws from the
//     save itself; here it is the next save, and `durable()`, that report it).
// One host per server.db (the server process): two hosts on one file would each trust their own cache.
import { encodeLine, foldLines, indexEntry, READ_TAIL_BYTES, type SubagentHistory, type SubagentLine } from "../../core/store/subagent-store";
import { StoreError, type BotStore, type ChatFile, type HeadState } from "../../core/store/bot-store";
import { HISTORY_LIMIT, isChatRecord, type ChatRecord } from "../../core/store/records";
import type { Command } from "../store/writer";
import type { Db } from "../store/sqlite";

/** What a host needs of the server store (`openServerStore` gives it). */
export interface BotStoreBackend {
  submit<T>(command: Command<T>): Promise<T>;
  openReader(): Db;
}

interface Versioned { rev: number; body: string }
/** A chat line's row: `body` is the 2.x line's JSON (the stored body wraps it with its seq). */
interface MessageRow extends Versioned { seq: number }
const chatBody = (row: MessageRow) => `{"seq":${row.seq},"record":${row.body}}`;

const SUBAGENTS_ORDER = "subagents.order";
const HEAD = "head.json";
const STEP_PAGE = 512;
const chatStream = (botId: string) => `chat:${botId}`;
const subagentsStream = (botId: string) => `subagents:${botId}`;
const stepsStream = (botId: string, id: string) => `substeps:${JSON.stringify([botId, id])}`;
const stepKey = (seq: number) => String(seq).padStart(12, "0");

const SQL = {
  settings: "SELECT settings FROM bots WHERE botId = ?",
  putSettings: "INSERT INTO bots (botId, settings, unread, model) VALUES (?, ?, ?, ?) "
    + "ON CONFLICT (botId) DO UPDATE SET settings = excluded.settings, unread = excluded.unread, model = excluded.model",
  list: "SELECT body FROM lists WHERE botId = ? AND name = ?",
  putList: "INSERT INTO lists (botId, name, body) VALUES (?, ?, ?) ON CONFLICT (botId, name) DO UPDATE SET body = excluded.body",
  rows: "SELECT key, rev, body FROM rows WHERE stream = ? AND deleted = 0",
  putRow: "INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0) "
    + "ON CONFLICT (stream, key) DO UPDATE SET rev = excluded.rev, body = excluded.body, deleted = 0",
  dropRow: "DELETE FROM rows WHERE stream = ? AND key = ?",
  dropStream: "DELETE FROM rows WHERE stream = ?",
  maxRev: "SELECT MAX(rev) AS rev FROM rows WHERE stream = ?",
  stepsBefore: "SELECT rev, body FROM rows WHERE stream = ? AND rev > ? AND rev < ? AND deleted = 0 ORDER BY rev DESC LIMIT ?",
} as const;

class BotState {
  messages?: Map<string, MessageRow>;
  maxSeq = 0;
  settings?: string;
  /** name → body text, or null when the list has no row. */
  readonly lists = new Map<string, string | null>();
  subagents?: Map<string, Versioned>;
  order?: string[];
  /** Last step seq used per subagent. */
  readonly stepSeq = new Map<string, number>();
  /** Steps at or below this seq belong to a removed subagent (their DELETE may still be in flight). */
  readonly stepFloor = new Map<string, number>();
  /** Step lines submitted and not known to be committed: seq → text. */
  readonly pendingSteps = new Map<string, Map<number, string>>();
  failure: unknown = null;
  readonly inflight = new Set<Promise<unknown>>();
}

/** One server.db's bot stores: shared caches, one read connection, writes through the writer. */
export class DbBotStores {
  private reader?: Db;
  private readonly states = new Map<string, BotState>();
  private closed = false;

  constructor(private readonly backend: BotStoreBackend) {}

  /** The store of bot `botId`; `directory` is its data folder (exports and other bot files live there). */
  open(botId: string, directory: string): DbBotStore {
    if (this.closed) throw new Error("bot stores are closed");
    let state = this.states.get(botId);
    if (!state) this.states.set(botId, state = new BotState());
    return new DbBotStore(this, state, botId, directory);
  }

  /** @internal */
  read(): Db {
    if (this.closed) throw new Error("bot stores are closed");
    return this.reader ??= this.backend.openReader();
  }

  /** @internal Submits one synchronous command for `state`'s bot. Throws the bot's earlier failure, if any. */
  write(state: BotState, command: Command<void>, settled?: (ok: boolean) => void): void {
    if (state.failure) throw state.failure;
    if (this.closed) throw new Error("bot stores are closed");
    const promise = this.backend.submit(command).then(
      () => { state.inflight.delete(promise); settled?.(true); },
      (error) => { state.failure ??= error; state.inflight.delete(promise); settled?.(false); },
    );
    state.inflight.add(promise);
  }

  /** Resolves once every write submitted so far (all bots) committed; rejects with the first failure. */
  async durable(): Promise<void> {
    for (const state of this.states.values()) await settle(state);
  }

  /** Waits for the writes in flight, then closes the read connection. The server store is closed by its owner. */
  async close(): Promise<void> {
    if (this.closed) return;
    for (const state of this.states.values()) await Promise.allSettled([...state.inflight]);
    this.closed = true;
    this.reader?.close();
    this.reader = undefined;
  }
}

async function settle(state: BotState): Promise<void> {
  while (state.inflight.size) await Promise.allSettled([...state.inflight]);
  if (state.failure) throw state.failure;
}

function parse(where: string, text: string): unknown {
  try { return JSON.parse(text); } catch (error) { throw new StoreError(where, `not valid JSON (${(error as Error).message})`); }
}

export class DbBotStore implements BotStore {
  /** Subagent lines staged by this store, appended at the next commit or flush (2.x: in the store's memory too). */
  private readonly staged = new Map<string, string[]>();

  /** @internal Use `DbBotStores.open`. */
  constructor(
    private readonly host: DbBotStores,
    private readonly state: BotState,
    readonly botId: string,
    readonly directory: string,
  ) {}

  /** Resolves once this bot's writes submitted so far are committed; rejects with the failure that stopped them. */
  durable(): Promise<void> { return settle(this.state); }

  // ── chat lines ────────────────────────────────────────────────────────────────────────────────────────────────────

  private messageRows(): Map<string, MessageRow> {
    const state = this.state;
    if (!state.messages) {
      const rows = new Map<string, MessageRow>();
      let maxSeq = 0;
      for (const row of this.host.read().prepare(SQL.rows).all(chatStream(this.botId))) {
        const stored = parse(`server.db chat line ${String(row.key)} of ${this.botId}`, String(row.body)) as { seq: number; record: unknown };
        rows.set(String(row.key), { rev: Number(row.rev), seq: stored.seq, body: JSON.stringify(stored.record) });
        maxSeq = Math.max(maxSeq, stored.seq);
      }
      state.maxSeq = maxSeq;
      state.messages = rows;
    }
    return state.messages;
  }

  loadMessages(): { records: ChatRecord[]; dropped: number } {
    const rows = [...this.messageRows().values()].sort((a, b) => a.seq - b.seq);
    const values = rows.map((row) => JSON.parse(row.body) as unknown);
    const records = values.filter(isChatRecord);
    return { records, dropped: values.length - records.length };
  }

  /** Keeps the newest HISTORY_LIMIT lines, like chat.json; writes only the lines that are new, changed or moved. */
  saveMessages(records: ChatRecord[]): void {
    if (this.state.failure) throw this.state.failure;
    const current = this.messageRows();
    const next = new Map<string, MessageRow>();
    const puts: [string, MessageRow][] = [];
    const seen = new Map<string, number>();
    let maxSeq = this.state.maxSeq, last = 0;
    for (const record of records.slice(-HISTORY_LIMIT)) {
      // Ids are unique in practice; a repeated one still keeps its own row, as chat.json keeps both lines.
      const id = String((record as { id?: unknown } | null)?.id);
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      const key = count === 1 ? id : `${id}\u0000${count}`;
      const body = JSON.stringify(record);
      const old = current.get(key);
      const seq = old && old.seq > last ? old.seq : ++maxSeq;
      last = seq;
      if (old && old.seq === seq && old.body === body) { next.set(key, old); continue; }
      const row = { rev: (old?.rev ?? 0) + 1, seq, body };
      next.set(key, row);
      puts.push([key, row]);
    }
    const drops = [...current.keys()].filter((key) => !next.has(key));
    if (!puts.length && !drops.length) return;
    const stream = chatStream(this.botId);
    const bodies = puts.map(([key, row]) => [key, row.rev, chatBody(row)] as const);
    this.host.write(this.state, (db) => {
      const put = db.prepare(SQL.putRow), drop = db.prepare(SQL.dropRow);
      for (const key of drops) drop.run(stream, key);
      for (const [key, rev, body] of bodies) put.run(stream, key, rev, body);
    });
    this.state.messages = next;
    this.state.maxSeq = maxSeq;
  }

  // ── bot.json ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private settingsText(): string {
    if (this.state.settings === undefined) {
      const row = this.host.read().prepare(SQL.settings).get(this.botId);
      this.state.settings = typeof row?.settings === "string" ? row.settings : "{}";
    }
    return this.state.settings;
  }

  loadSettings(): Record<string, unknown> {
    try {
      const value = JSON.parse(this.settingsText());
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  saveSetting(key: string, value: unknown): void {
    if (this.state.failure) throw this.state.failure;
    const settings = this.loadSettings();
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    const text = JSON.stringify(settings);
    const botId = this.botId;
    this.state.settings = text;
    const unread = this.loadUnread(), model = this.loadModel();
    this.host.write(this.state, (db) => { db.prepare(SQL.putSettings).run(botId, text, unread, model); });
  }

  loadAlwaysAllowed(): string[] {
    const value = this.loadSettings().alwaysAllowed;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  }

  loadUnread(): number {
    const value = this.loadSettings().unread;
    return typeof value === "number" && value >= 0 ? Math.floor(value) : 0;
  }

  loadModel(): string | null {
    const value = this.loadSettings().model;
    return typeof value === "string" && /^[a-z0-9.-]+$/i.test(value) ? value : null;
  }

  // ── lists and head ────────────────────────────────────────────────────────────────────────────────────────────────

  private listText(name: string): string | null {
    const lists = this.state.lists;
    if (!lists.has(name)) {
      const row = this.host.read().prepare(SQL.list).get(this.botId, name);
      lists.set(name, typeof row?.body === "string" ? row.body : null);
    }
    return lists.get(name)!;
  }

  private putList(name: string, text: string): void {
    if (this.state.failure) throw this.state.failure;
    if (this.state.lists.get(name) === text) return;
    const botId = this.botId;
    this.host.write(this.state, (db) => { db.prepare(SQL.putList).run(botId, name, text); });
    this.state.lists.set(name, text);
  }

  loadList(name: ChatFile): unknown[] {
    if (name === "subagents.json") {
      const index = this.subagentIndex();
      return this.subagentOrder().filter((id) => index.has(id)).map((id) => parse(`server.db subagent ${id} of ${this.botId}`, index.get(id)!.body));
    }
    const text = this.listText(name);
    if (text === null) return [];
    const value = parse(`server.db list ${name} of ${this.botId}`, text);
    return Array.isArray(value) ? value : [];
  }

  saveList(name: ChatFile, list: unknown[]): void {
    if (name === "subagents.json") this.commitSubagents(list);
    else this.putList(name, JSON.stringify(list));
  }

  loadHead(): HeadState | null {
    try {
      const text = this.listText(HEAD);
      const value = text === null ? undefined : JSON.parse(text) as Partial<HeadState> | undefined;
      if (value && typeof value.sessionId === "string" && typeof value.started === "boolean") return { sessionId: value.sessionId, started: value.started, ...(typeof value.promptHash === "string" ? { promptHash: value.promptHash } : {}) };
    } catch { /* a new session then */ }
    return null;
  }

  saveHead(state: HeadState): void {
    this.putList(HEAD, JSON.stringify(state));
  }

  // ── subagents ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private subagentIndex(): Map<string, Versioned> {
    if (!this.state.subagents) {
      const index = new Map<string, Versioned>();
      for (const row of this.host.read().prepare(SQL.rows).all(subagentsStream(this.botId))) index.set(String(row.key), { rev: Number(row.rev), body: String(row.body) });
      this.state.subagents = index;
    }
    return this.state.subagents;
  }

  private subagentOrder(): string[] {
    if (!this.state.order) {
      const text = this.listText(SUBAGENTS_ORDER);
      const value = text === null ? [] : parse(`server.db subagent order of ${this.botId}`, text);
      this.state.order = Array.isArray(value) ? value.map(String) : [];
    }
    return this.state.order;
  }

  stageSubagentLine(id: string, line: SubagentLine): void {
    const text = encodeLine(line);
    const list = this.staged.get(id);
    if (list) list.push(text); else this.staged.set(id, [text]);
  }

  private lastStepSeq(id: string): number {
    let seq = this.state.stepSeq.get(id);
    if (seq === undefined) {
      seq = Number(this.host.read().prepare(SQL.maxRev).get(stepsStream(this.botId, id))?.rev ?? 0);
      this.state.stepSeq.set(id, seq);
    }
    return seq;
  }

  /** Submits what is staged as appended step rows. */
  flushSubagents(): void {
    if (!this.staged.size) return;
    if (this.state.failure) throw this.state.failure;
    const appends: { stream: string; lines: [number, string][] }[] = [];
    for (const [id, lines] of this.staged) {
      let seq = this.lastStepSeq(id);
      const numbered = lines.map((text): [number, string] => [++seq, text]);
      this.state.stepSeq.set(id, seq);
      let pending = this.state.pendingSteps.get(id);
      if (!pending) this.state.pendingSteps.set(id, pending = new Map());
      for (const [n, text] of numbered) pending.set(n, text);
      appends.push({ stream: stepsStream(this.botId, id), lines: numbered });
    }
    const ids = [...this.staged.keys()];
    this.staged.clear();
    this.host.write(this.state, (db) => {
      const put = db.prepare(SQL.putRow);
      for (const { stream, lines } of appends) for (const [seq, text] of lines) put.run(stream, stepKey(seq), seq, text);
    }, (ok) => {
      if (!ok) return; // the store is failed now; the lines stay readable from the pending set
      appends.forEach(({ lines }, i) => {
        const pending = this.state.pendingSteps.get(ids[i]);
        if (!pending) return;
        for (const [seq] of lines) pending.delete(seq);
        if (!pending.size) this.state.pendingSteps.delete(ids[i]);
      });
    });
  }

  /** Appends the staged lines, writes the index entries that changed, and removes subagents that left the list. */
  commitSubagents(list: unknown[], changedIds?: ReadonlySet<string>): void {
    if (this.state.failure) throw this.state.failure;
    const index = this.subagentIndex();
    const before = this.subagentOrder();
    this.flushSubagents();
    const records = list as Record<string, unknown>[];
    const ids = new Set<string>();
    const puts: [string, Versioned][] = [];
    for (const record of records) {
      const id = String(record.id);
      ids.add(id);
      if (changedIds && !changedIds.has(id) && index.has(id)) continue;
      const body = JSON.stringify(indexEntry(record));
      const old = index.get(id);
      if (old?.body === body) continue;
      const row = { rev: (old?.rev ?? 0) + 1, body };
      index.set(id, row);
      puts.push([id, row]);
    }
    const removed = [...index.keys()].filter((id) => !ids.has(id));
    for (const id of removed) {
      index.delete(id);
      this.state.stepFloor.set(id, this.lastStepSeq(id));
      this.state.pendingSteps.delete(id);
    }
    const order = records.map((record) => String(record.id));
    const orderChanged = order.length !== before.length || order.some((id, i) => id !== before[i]);
    if (!puts.length && !removed.length && !orderChanged) return;
    const botId = this.botId, stream = subagentsStream(botId), orderText = JSON.stringify(order);
    this.host.write(this.state, (db) => {
      const put = db.prepare(SQL.putRow), drop = db.prepare(SQL.dropRow), dropSteps = db.prepare(SQL.dropStream);
      for (const id of removed) { drop.run(stream, id); dropSteps.run(stepsStream(botId, id)); }
      for (const [id, row] of puts) put.run(stream, id, row.rev, row.body);
      if (orderChanged) db.prepare(SQL.putList).run(botId, SUBAGENTS_ORDER, orderText);
    });
    this.state.order = order;
    if (orderChanged) this.state.lists.set(SUBAGENTS_ORDER, orderText);
  }

  /** One subagent's steps: the committed rows plus the lines still in flight, at most `maxBytes` from the end (like the .jsonl tail). */
  readSubagentSteps(id: string, maxBytes = READ_TAIL_BYTES): SubagentHistory {
    try { this.flushSubagents(); } catch { /* read what is there */ }
    const floor = this.state.stepFloor.get(id) ?? 0;
    const pending = [...(this.state.pendingSteps.get(id) ?? new Map<number, string>())].filter(([seq]) => seq > floor).sort((a, b) => b[0] - a[0]);
    const statement = this.host.read().prepare(SQL.stepsBefore);
    const stream = stepsStream(this.botId, id);
    // Newest first: lines in flight, then committed rows a page at a time (a committed line may also still be in the
    // pending set for a moment; its seq is taken once).
    const taken: string[] = [];
    let bytes = 0, upper = Number.MAX_SAFE_INTEGER, page: [number, string][] = [], full = false;
    const seen = new Set<number>();
    const next = (): [number, string] | undefined => {
      for (;;) {
        if (pending.length && (!page.length || pending[0][0] >= page[0][0])) {
          const line = pending.shift()!;
          if (page.length && page[0][0] === line[0]) page.shift();
          return line;
        }
        if (page.length) return page.shift();
        if (full) return undefined;
        page = statement.all(stream, floor, upper, STEP_PAGE).map((row) => [Number(row.rev), String(row.body)]);
        if (page.length < STEP_PAGE) full = true;
        if (page.length) upper = page[page.length - 1][0];
        else if (!pending.length) return undefined;
      }
    };
    // The .jsonl reader keeps the lines that start after the cut at `size - maxBytes`: a line is kept while the bytes
    // from its start to the end stay under maxBytes, or when it is the very first line and they equal it.
    let line = next();
    while (line) {
      const [seq, text] = line;
      line = next();
      if (seen.has(seq)) continue;
      seen.add(seq);
      bytes += Buffer.byteLength(text, "utf8") + 1;
      if (bytes > maxBytes || (bytes === maxBytes && line)) break;
      taken.push(text);
    }
    return foldLines(taken.reverse());
  }
}
