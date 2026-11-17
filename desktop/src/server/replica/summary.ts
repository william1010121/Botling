// The server's own summary rows (protocol v1 §8.2, §14.1; M3 step 6): `bot:<botId>`, `machine`, `settings` in the
// server's `srv:` table (tables.ts), written from what the event tap stores and what the read models hold.
//
// - A bot's row is built from the core's last `bot.updated` view of it (name, role, parent, face, heads, working,
//   approvals, problem, unread), the `cards` read model (open cards → `waiting`, ≤ 5), the `messages` read model (the
//   newest three lines, ≤ 140 characters each) and the running turn (`bots.liveTurnId`, the live channel's text).
// - The 2 s rule: a bot's row is rewritten at most once per `SUMMARY_WRITE_INTERVAL_MS`, and at once when its `status`
//   or `waiting` changes. A change inside the interval marks the bot and a timer writes it when the interval is up.
//   Writes that ride an event go into that event's transaction (the tap's `eventStored` hook), so a row never says
//   more than the log; timer writes are writer commands of their own.
// - `bot.removed` → a tombstone at once; at start (`reconcile`) rows of bots the engine no longer has are tombstoned,
//   tombstones older than 30 days are purged (also every hour after), and the machine row is written.
// - The `settings` row is the settings view without any key that names a secret, at any depth (`SECRET_KEY`).
// Only names reach a row (a folder's last part, never a path), and no line beyond 140 characters.
import { basename } from "node:path";
import { PhaseMarks, PhaseTally } from "../../core/phase-marks";
import type { BotView, Event as ContractEvent, MessageView } from "../../contract";
import { Id as ContractId } from "../../protocol/ids";
import { canonicalJson } from "../../protocol";
import {
  SECRET_KEY, SUMMARY_LINE_CHARS, SUMMARY_LINES_LIMIT, SUMMARY_ROW_CHARS, SUMMARY_WAITING_LIMIT, SUMMARY_WRITE_INTERVAL_MS, TABLE_ROW_CHARS,
  TOMBSTONE_KEEP_MS, SummaryRow, type MachineRow, type SummaryStatus,
} from "../../protocol/table-rows";
import type { TxScope } from "../effects";
import type { Db } from "../store";
import { latestFromEntries } from "./summary-entries";
import { deleteRow, ownTableStream, purgeTombstones, putRow, readRowBody } from "./tables";

/** How often tombstones are purged after the start. */
export const PURGE_EVERY_MS = 60 * 60 * 1000;

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set(run, ms) {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) { clearTimeout(handle as NodeJS.Timeout); },
};

/** What the summary writer reads of the running turn (LiveChannel `running`). */
export interface LiveText {
  running(botId: string): { turnId: string; turnText: string } | null;
}

export interface SummaryRowsOptions {
  scope: TxScope;
  /** The bots the engine has now, and the core's view of one (null: not known; the srv: entries are read instead). */
  engine: { bots(): string[]; botView?(botId: string): BotView | null };
  live?: LiveText | null;
  /** The machine row (written at `reconcile` when it changed). */
  machine?: () => MachineRow;
  now?: () => number;
  timers?: Timers;
  intervalMs?: number;
  tombstoneKeepMs?: number;
  log?: (line: string) => void;
  /** A row was committed (key, rev): step 7 pushes it to peers; tests count writes. */
  onWritten?: (key: string, rev: number) => void;
  /**
   * botlingd's start: the events the core said while it was made are stored before `reconcile` writes a row for every bot
   * from the same read models, so until `reconcile` runs an event only keeps the bot's view and builds no row (every row
   * would be built twice). Off: an event writes its bot's row at once (tests, and any other use).
   */
  holdUntilReconcile?: boolean;
}

interface Written {
  /** When it was written (this server's clock). */
  at: number;
  text: string;
  urgent: string;
}

/** Events that may change a bot's summary. */
const SUMMARY_EVENTS = new Set<string>(["bot.updated", "message.added", "message.updated", "message.removed", "turn.started", "turn.finished", "heads.updated"]);

/** One short line: whitespace folded, at most `max` characters (an ellipsis marks a cut). */
export function shortLine(text: string, max = SUMMARY_LINE_CHARS, from: "start" | "end" = "start"): string {
  const folded = text.replace(/\s+/g, " ").trim();
  if (folded.length <= max) return folded;
  return from === "start" ? `${folded.slice(0, max - 1)}…` : `…${folded.slice(folded.length - (max - 1))}`;
}

/** Drops every key that names a secret, at any depth. */
export function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) || inner === undefined) continue;
      out[key] = withoutSecrets(inner);
    }
    return out;
  }
  return value;
}

function cardKind(message: MessageView): string {
  if (message.approval) return "approval";
  if (message.questions?.length) return "questions";
  return "question";
}

function cardTitle(message: MessageView, max: number): string {
  const text = shortLine(message.text ?? "", max);
  if (text) return text;
  if (message.approval) return shortLine(message.approval.tool, max);
  return shortLine(message.questions?.[0]?.question ?? "", max);
}

/** A bot's summary row from its view and the read models (`tx` or a reader). */
export function buildSummary(db: Db, botId: string, view: BotView, options: { live?: LiveText | null; colors?: Record<string, { avatar: string; color: string }> } = {}): SummaryRow {
  // What the database holds is read once; only the cuts to the row's limits are tried again (they change nothing read).
  const openCards = db.prepare("SELECT cardId, rev, body FROM cards WHERE botId = ? AND state = 'open' ORDER BY rev LIMIT ?").all(botId, SUMMARY_WAITING_LIMIT * 2)
    .filter((row) => ContractId.safeParse(String(row.cardId)).success)
    .slice(0, SUMMARY_WAITING_LIMIT)
    .map((row) => ({ cardId: String(row.cardId), cardRev: Number(row.rev), message: JSON.parse(String(row.body)) as MessageView }));
  const bot = db.prepare("SELECT model, liveTurnId, liveAt FROM bots WHERE botId = ?").get(botId);
  const recent = recentLines(db, botId);
  const liveTurnId = bot?.liveTurnId == null ? null : String(bot.liveTurnId);
  const running = liveTurnId ? options.live?.running(botId) ?? null : null;
  const newest = recent[0] ? Date.parse(recent[0].time) : NaN;
  let turn: SummaryRow["turn"];
  if (liveTurnId && ContractId.safeParse(liveTurnId).success) {
    const effect = db.prepare("SELECT startedAt FROM effects WHERE botId = ? AND turnId = ? AND kind = 'turn'").get(botId, liveTurnId);
    const startedAt = Number(effect?.startedAt ?? bot?.liveAt ?? 0);
    turn = { turnId: liveTurnId, startedAt: Number.isFinite(startedAt) && startedAt >= 0 ? startedAt : 0 };
  }
  const build = (titleChars: number, lineChars: number): SummaryRow => {
    const waiting = openCards.map(({ cardId, cardRev, message }) => ({ cardId, cardRev, kind: cardKind(message), title: cardTitle(message, titleChars) }));
    const lines = recent.slice(0, SUMMARY_LINES_LIMIT).reverse().map((message) => shortLine(message.text, lineChars));
    if (running && running.turnId === liveTurnId && running.turnText.trim()) {
      lines.push(shortLine(running.turnText, lineChars, "end"));
      while (lines.length > SUMMARY_LINES_LIMIT) lines.shift();
    }
    const status: SummaryStatus = view.problem || view.connection === "disconnected" ? "error"
      : waiting.length || view.approvals > 0 ? "waiting"
        : view.working || turn ? "running"
          : "idle";
    const color = options.colors?.[botId];
    const folder = view.folder ? basename(view.folder.replace(/[\\/]+$/, "").replace(/\\/g, "/")) : "";
    return {
      name: view.name.trim() ? view.name.slice(0, 200) : botId,
      face: color && /^#[0-9A-Fa-f]{6}$/.test(color.color) ? { avatar: color.avatar.slice(0, 40), color: color.color } : null,
      role: view.role,
      parent: view.parent ?? null,
      folderName: folder && !/[\\/]/.test(folder) ? folder.slice(0, 255) : null,
      engine: view.heads[0] ?? "claude",
      model: bot?.model == null ? null : String(bot.model).slice(0, 200),
      status,
      ...(turn ? { turn } : {}),
      waiting,
      unread: view.unread,
      lastAt: Number.isFinite(newest) && newest >= 0 ? newest : null,
      lines,
    };
  };
  // Every field at its own limit can pass the row cap: shorter titles, then shorter lines.
  for (const [titleChars, lineChars] of [[200, SUMMARY_LINE_CHARS], [80, SUMMARY_LINE_CHARS], [40, 80], [20, 40]] as const) {
    const row = build(titleChars, lineChars);
    if (canonicalJson(row).length <= SUMMARY_ROW_CHARS) return row;
  }
  return build(10, 20);
}

/** How many of a bot's newest lines the summary looks at (the row shows the last three of them that say something). */
const SUMMARY_LOOK_BACK = 20;
/** Lines read and parsed first; more only when these hold fewer than the row needs. */
const SUMMARY_FIRST_READ = 6;

/**
 * The newest lines (newest first) that a user or the bot said, with text, from the last `SUMMARY_LOOK_BACK` lines of the
 * read model: only as many as the row shows (`SUMMARY_LINES_LIMIT`), read from the newest end and parsed one by one, so
 * the answer is the same as parsing all twenty and keeping the first three that count.
 */
function recentLines(db: Db, botId: string): MessageView[] {
  const wanted: MessageView[] = [];
  const select = db.prepare("SELECT body FROM messages WHERE botId = ? ORDER BY seq DESC LIMIT ? OFFSET ?");
  for (let offset = 0; offset < SUMMARY_LOOK_BACK && wanted.length < SUMMARY_LINES_LIMIT;) {
    const size = offset === 0 ? SUMMARY_FIRST_READ : SUMMARY_LOOK_BACK - offset;
    const rows = select.all(botId, size, offset);
    for (const row of rows) {
      const message = JSON.parse(String(row.body)) as MessageView;
      if ((message.role === "user" || message.role === "bot") && message.text.trim()) wanted.push(message);
      if (wanted.length >= SUMMARY_LINES_LIMIT) break;
    }
    if (rows.length < size) break;
    offset += size;
  }
  return wanted;
}

/** The settings row: the view without secrets, the largest keys dropped if it would not fit. */
export function settingsRow(settings: unknown): Record<string, unknown> {
  const clean = { ...((withoutSecrets(settings) ?? {}) as Record<string, unknown>) };
  while (canonicalJson(clean).length > TABLE_ROW_CHARS) {
    const largest = Object.keys(clean).sort((a, b) => canonicalJson(clean[b] ?? null).length - canonicalJson(clean[a] ?? null).length)[0];
    if (largest === undefined) break;
    delete clean[largest];
  }
  return clean;
}

const urgentOf = (row: SummaryRow) => canonicalJson({ status: row.status, waiting: row.waiting });

export class SummaryRows {
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly interval: number;
  private readonly views = new Map<string, BotView>();
  private readonly written = new Map<string, Written>();
  private readonly due = new Map<string, unknown>();
  private settings: Record<string, unknown> | null = null;
  private purgeTimer: unknown = null;
  private closed = false;
  /** `holdUntilReconcile`: no row is built by an event until `reconcile` has run. */
  private holding: boolean;

  constructor(private readonly options: SummaryRowsOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? realTimers;
    this.interval = options.intervalMs ?? SUMMARY_WRITE_INTERVAL_MS;
    this.holding = options.holdUntilReconcile === true;
  }

  // ---------------------------------------------------------------------------------------------
  // Event tap hooks

  /** Every event the engine emits, before it is stored (turn text included): a running turn's text marks its bot. */
  seen(event: ContractEvent): void {
    if (this.closed || this.holding) return;
    if (event.type === "turn.delta" || event.type === "turn.steps") this.later(event.botId);
  }

  /** An event was stored in `tx`: the rows it changes are written in the same transaction (or marked for later). */
  stored(tx: Db, event: ContractEvent): void {
    if (this.closed) return;
    if (event.type === "settings.updated") {
      this.settings = event.settings as unknown as Record<string, unknown>;
      this.put(tx, "settings", settingsRow(this.settings));
      return;
    }
    if (event.type === "bot.removed") {
      this.forget(event.botId);
      const rev = deleteRow(tx, ownTableStream(tx), `bot:${event.botId}`, this.now());
      if (rev != null) this.committed(`bot:${event.botId}`, rev);
      return;
    }
    if (!SUMMARY_EVENTS.has(event.type)) return;
    const botId = event.type === "bot.updated" ? event.bot.id : (event as { botId: string }).botId;
    if (event.type === "bot.updated") this.views.set(botId, event.bot);
    if (this.holding) return;
    this.mark(tx, botId);
  }

  // ---------------------------------------------------------------------------------------------
  // Start, purge, stop

  /**
   * At start, inside a writer command: views from the engine (or the last `bot.updated` in the srv: entries), a row for
   * every bot with a view, tombstones for rows of bots gone, the purge, the machine and settings rows.
   */
  reconcile(tx: Db): { written: number; tombstoned: number; purged: number; unknown: string[] } {
    // Startup timing (steps of 100 ms or more; the slowest bots of the two repeated steps).
    const marks = new PhaseMarks(this.options.log, "summary reconcile", undefined, 100);
    const tally = new PhaseTally();
    // From here every event builds its own row again; the loop below writes the rows of all bots, from the same tables.
    this.holding = false;
    const stream = ownTableStream(tx);
    const bots = new Set(this.options.engine.bots());
    // Only a bot with no view from the engine needs its last `bot.updated` from the log, and settings only when none are
    // known; with every bot viewed the log is not read at all (summary-entries.ts says why that matters).
    const lacking = new Set([...bots].filter((botId) => {
      if (this.views.has(botId)) return false;
      const began = performance.now();
      const view = this.options.engine.botView?.(botId);
      tally.add("core bot view (engine.botView)", botId, performance.now() - began);
      return !view;
    }));
    marks.lap(`views of ${bots.size} bots`);
    const found = latestFromEntries(tx, stream, lacking, !this.settings);
    marks.lap(`latest entries of ${lacking.size} bots without a view`);
    const fromEntries = found.bots;
    if (!this.settings && found.settings) this.settings = found.settings;
    const unknown: string[] = [];
    let written = 0;
    for (const botId of bots) {
      const began = performance.now();
      const view = this.views.get(botId) ?? this.options.engine.botView?.(botId) ?? fromEntries.get(botId) ?? null;
      tally.add("core bot view again (engine.botView)", botId, performance.now() - began);
      if (!view) { unknown.push(botId); continue; }
      this.views.set(botId, view);
      const writeBegan = performance.now();
      if (this.write(tx, botId)) written += 1;
      tally.add("build and write a bot's row (buildSummary)", botId, performance.now() - writeBegan);
    }
    marks.lap(`rows of ${bots.size} bots`);
    tally.report(this.options.log, "summary reconcile");
    let tombstoned = 0;
    for (const row of tx.prepare("SELECT key FROM rows WHERE stream = ? AND key LIKE 'bot:%' AND deleted = 0").all(stream)) {
      const key = String(row.key);
      if (bots.has(key.slice(4))) continue;
      const rev = deleteRow(tx, stream, key, this.now());
      if (rev != null) { tombstoned += 1; this.committed(key, rev); }
    }
    marks.lap("tombstones");
    const purged = purgeTombstones(tx, stream, this.now(), this.options.tombstoneKeepMs ?? TOMBSTONE_KEEP_MS);
    marks.lap("purge tombstones");
    if (this.options.machine) this.put(tx, "machine", this.options.machine());
    marks.lap("machine row (reads every plugin folder's hash)");
    if (this.settings && readRowBody(tx, stream, "settings") == null) this.put(tx, "settings", settingsRow(this.settings));
    if (unknown.length) this.options.log?.(`summary: no view yet of ${unknown.length} bot(s); their rows come with their next update`);
    return { written, tombstoned, purged, unknown };
  }

  /** Purges old tombstones now and then every hour (until `close`). */
  startPurging(): void {
    if (this.closed || this.purgeTimer) return;
    const tick = () => {
      this.purgeTimer = this.timers.set(tick, PURGE_EVERY_MS);
      void this.purge().catch((error) => this.options.log?.(`summary: purge failed (${String((error as Error)?.message ?? error)})`));
    };
    this.purgeTimer = this.timers.set(tick, PURGE_EVERY_MS);
  }

  /** Purges tombstones older than the keep time (a writer command). Returns how many went. */
  purge(): Promise<number> {
    return this.options.scope.submit((tx) => purgeTombstones(tx, ownTableStream(tx), this.now(), this.options.tombstoneKeepMs ?? TOMBSTONE_KEEP_MS));
  }

  /** Writes every bot marked for later now (stop, tests). */
  async flush(): Promise<void> {
    const marked = [...this.due.keys()];
    for (const botId of marked) this.cancel(botId);
    if (!marked.length) return;
    await this.options.scope.submit((tx) => { for (const botId of marked) this.write(tx, botId); });
  }

  /** Bots marked for a later write. */
  get pending(): string[] {
    return [...this.due.keys()];
  }

  close(): void {
    this.closed = true;
    for (const botId of [...this.due.keys()]) this.cancel(botId);
    if (this.purgeTimer) this.timers.clear(this.purgeTimer);
    this.purgeTimer = null;
  }

  // ---------------------------------------------------------------------------------------------

  /** Inside a command: write now if urgent or due, else mark for when the interval is up. */
  private mark(tx: Db, botId: string): void {
    const view = this.views.get(botId);
    if (!view) return;
    const row = buildSummary(tx, botId, view, this.buildOptions());
    const text = canonicalJson(row);
    const last = this.written.get(botId);
    if (last && last.text === text) { this.cancel(botId); return; }
    if (!last || last.urgent !== urgentOf(row) || this.now() - last.at >= this.interval) {
      this.cancel(botId);
      this.commitRow(tx, botId, row, text);
      return;
    }
    this.schedule(botId, last.at + this.interval - this.now());
  }

  /** Outside a command (turn text): a write when the interval allows, by timer. */
  private later(botId: string): void {
    if (!this.views.has(botId) || this.due.has(botId)) return;
    const last = this.written.get(botId);
    this.schedule(botId, last ? Math.max(0, last.at + this.interval - this.now()) : 0);
  }

  private schedule(botId: string, ms: number): void {
    if (this.closed || this.due.has(botId)) return;
    const handle = this.timers.set(() => {
      if (this.due.get(botId) !== handle) return;
      this.due.delete(botId);
      this.options.scope.submit((tx) => {
        const last = this.written.get(botId);
        // Written meanwhile (an urgent change): wait for the rest of the interval.
        if (last && this.now() - last.at < this.interval) {
          const view = this.views.get(botId);
          if (view && canonicalJson(buildSummary(tx, botId, view, this.buildOptions())) !== last.text) this.schedule(botId, last.at + this.interval - this.now());
          return;
        }
        this.write(tx, botId);
      }).catch((error) => this.options.log?.(`summary: writing ${botId}'s row failed (${String((error as Error)?.message ?? error)})`));
    }, Math.max(0, ms));
    this.due.set(botId, handle);
  }

  private cancel(botId: string): void {
    const handle = this.due.get(botId);
    if (handle === undefined) return;
    this.timers.clear(handle);
    this.due.delete(botId);
  }

  private forget(botId: string): void {
    this.cancel(botId);
    this.views.delete(botId);
    this.written.delete(botId);
  }

  /** Writes a bot's row now if it changed. True when written. */
  private write(tx: Db, botId: string): boolean {
    const view = this.views.get(botId);
    if (!view) return false;
    const row = buildSummary(tx, botId, view, this.buildOptions());
    return this.commitRow(tx, botId, row, canonicalJson(row));
  }

  private commitRow(tx: Db, botId: string, row: SummaryRow, text: string): boolean {
    const key = `bot:${botId}`;
    const rev = putRow(tx, ownTableStream(tx), key, SummaryRow.parse(row));
    const previous = this.written.get(botId);
    this.written.set(botId, { at: this.now(), text, urgent: urgentOf(row) });
    this.options.scope.onRollback(() => {
      if (previous) this.written.set(botId, previous); else this.written.delete(botId);
      this.later(botId);
    });
    if (rev == null) return false;
    this.committed(key, rev);
    return true;
  }

  private put(tx: Db, key: string, body: unknown): void {
    const rev = putRow(tx, ownTableStream(tx), key, body);
    if (rev != null) this.committed(key, rev);
  }

  private committed(key: string, rev: number): void {
    const listener = this.options.onWritten;
    if (listener) this.options.scope.afterCommit(() => listener(key, rev));
  }

  private buildOptions(): { live?: LiveText | null; colors?: Record<string, { avatar: string; color: string }> } {
    const colors = (this.settings?.botColors ?? undefined) as Record<string, { avatar: string; color: string }> | undefined;
    return { live: this.options.live ?? null, ...(colors ? { colors } : {}) };
  }
}
