// The event tap (M1 step 6): every contract event the engine emits becomes a log entry, except `turn.delta`, which
// goes to the live channel (D10). It also keeps the effect rows in step with the engine's turns:
// - `turn.started`: the bot's running turn from now (`bots.liveTurnId`); a turn the core began by itself (a call-in, a
//   worker's report, a steer that began its own turn) gets a `started` row here, so a crash interrupts it too;
// - `turn.finished`: its row is `finished` and its checkpoint goes, in the same transaction as the entry; a second
//   finish of a turn whose row already ended (the worker closed it, recovery interrupted it) is not stored again;
// - `message.updated`, `bot.updated` and `subagent.updated` that repeat the state the log already holds are not stored
//   again (D0: about 65% of `message.updated` were identical redraws);
// - `message.added` of a line the log already has (the user's line `chat.send` stored with its intent) is stored only
//   when it differs, as `message.updated`;
// - `bot.updated` mirrors `unread` into the bot row; `bot.removed` drops the bot row (the snap shows no bot).
// Server events (no bot): `settings.updated` goes into the server's `srv:` stream; the rest go to `onServerEvent`, or
// also into `srv:` with `serverEvents: "all"` (botlingd), which can mirror `bot.updated` there too.
//
// Order: an event emitted while a writer command runs (the core's synchronous handlers in `applyNow`) is written into
// that command's transaction; one emitted outside waits in `pending` and is written at the start of the next command
// (TxScope.onEnter), which the tap submits itself when nothing else runs. So entries keep the order the engine
// emitted them in, whichever path they take. Each event is written in its own savepoint: one the log refuses (it does
// not validate) is logged and skipped, never failing the command it rode in.
import { randomUUID } from "node:crypto";
import { Slowest } from "../../core/phase-marks";
import type { Event as ContractEvent } from "../../contract";
import { canonicalJson, type Entry } from "../../protocol";
import type { ContractLiveFeed } from "../live";
import type { Db } from "../store";
import { appendFitted, clearLive, ensureBot, markLive, serverStreamOf } from "./log-ops";
import type { TxScope } from "./scope";
import { findTurnEffect, insertEffect, moveEffect } from "./table";

export interface TapHooks {
  /** A turn ended (its `turn.finished` is in `tx`): turns another turn read in end with it (worker.ts). */
  turnEnded?(tx: Db, botId: string, turnId: string, status: "done" | "stopped" | "failed"): void;
  /**
   * A chat line's entry (`message.added`, or `message.updated`) is in `tx`: the content index notes the files the line
   * names in the same transaction (src/server/content `contentLineHook`). `event` is the whole event, even when the
   * entry's text was cut to fit a frame.
   */
  lineStored?(tx: Db, event: ContractEvent, entry: Pick<Entry, "stream" | "seq">): void;
  /** Every event the engine emits, before anything else (turn text included); a throw is logged and ignored (M3 summary rows). */
  eventSeen?(event: ContractEvent): void;
  /**
   * An event was stored in `tx` (after its entries): M3's summary rows are written in the same transaction. Runs in a
   * savepoint of its own: a throw is logged and undoes only what the hook wrote.
   */
  eventStored?(tx: Db, event: ContractEvent): void;
}

export interface EventTapOptions {
  scope: TxScope;
  live?: ContractLiveFeed | null;
  hooks?: TapHooks;
  now?: () => number;
  log?: (line: string) => void;
  /** Server events that are no entry of any stream (plugins, Doctor, waiting list, core swap). */
  onServerEvent?: (event: ContractEvent) => void;
  /**
   * Which server events (no bot) become entries of the `srv:` stream: only `settings.updated` (default), or every one
   * (botlingd: the window's renderer needs plugins, Doctor, the waiting list… as they change, from the srv: stream).
   */
  serverEvents?: "settings" | "all";
  /** `bot.updated` also goes into the `srv:` stream (botlingd: the window's bot list follows every bot, not only open ones). */
  mirrorBotUpdates?: boolean;
}

/** The bot a contract event belongs to, or null for a server event. */
export function botOfEvent(event: ContractEvent): string | null {
  if (event.type === "bot.updated") return event.bot.id;
  const botId = (event as { botId?: unknown }).botId;
  return typeof botId === "string" ? botId : null;
}

function bodyOf(event: ContractEvent): Record<string, unknown> {
  const { type: _type, ...body } = event as Record<string, unknown> & { type: string };
  return body;
}

export class EventTap {
  private pending: ContractEvent[] = [];
  private scheduled = false;
  private holds = 0;
  private readonly now: () => number;

  constructor(private readonly options: EventTapOptions) {
    this.now = options.now ?? Date.now;
    options.scope.onEnter((tx) => this.flush(tx));
  }

  /** Events not stored yet (they wait for the next command). */
  get waiting(): number {
    return this.pending.length;
  }

  event(event: ContractEvent): void {
    const seen = this.options.hooks?.eventSeen;
    if (seen) {
      try { seen(event); } catch (error) { this.options.log?.(`event tap: eventSeen failed (${error instanceof Error ? error.message : String(error)})`); }
    }
    // The live channel sees every turn event at once (start, steps, end); `turn.delta` is its alone.
    const liveOnly = this.options.live ? this.options.live.feed(event) : event.type === "turn.delta";
    if (liveOnly || event.type === "turn.delta") return;
    const botId = botOfEvent(event);
    if (!botId && event.type !== "settings.updated" && this.options.serverEvents !== "all") {
      this.options.onServerEvent?.(event);
      return;
    }
    const tx = this.options.scope.tx;
    if (tx) {
      this.flush(tx);
      this.store(tx, event);
      return;
    }
    this.pending.push(event);
    this.schedule();
  }

  /**
   * Keeps events that arrive from now in `pending` until the returned release is called (or a command writes them):
   * legacy apply holds them while the core's handler runs, so what the handler emitted is stored in the same
   * transaction as the command's receipt. Release is idempotent.
   */
  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds -= 1;
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.scheduled || this.holds > 0 || !this.pending.length) return;
    this.scheduled = true;
    // An empty command: TxScope.onEnter writes what waits.
    this.options.scope.submit(() => undefined).catch((error) => {
      this.scheduled = false;
      this.options.log?.(`event tap: storing events failed (${error instanceof Error ? error.message : String(error)}); they wait for the next command`);
    });
  }

  /** Writes the waiting events into `tx` (the start of every command). */
  flush(tx: Db): void {
    this.scheduled = false;
    if (!this.pending.length) return;
    const taken = this.pending.splice(0);
    // Rolled back with the command they rode in: they wait again, ahead of anything newer.
    this.options.scope.onRollback(() => {
      this.pending.unshift(...taken);
      if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => { this.options.scope.submit(() => undefined).catch(() => { this.scheduled = false; }); });
      }
    });
    // Startup timing: what storing the waiting events cost, written only when it took 100 ms or more.
    const began = performance.now();
    const byType = new Map<string, { n: number; ms: number }>();
    const slowest = new Slowest(5);
    let writeMs = 0, hookMs = 0;
    for (const event of taken) {
      const at = performance.now();
      this.store(tx, event);
      const ms = performance.now() - at;
      writeMs += this.stored.write;
      hookMs += this.stored.hook;
      const entry = byType.get(event.type) ?? { n: 0, ms: 0 };
      entry.n += 1; entry.ms += ms;
      byType.set(event.type, entry);
      slowest.add(`${event.type} ${botOfEvent(event) ?? "server"}`, ms);
    }
    const total = performance.now() - began;
    if (total >= 100 && this.options.log) {
      const types = [...byType].sort((a, b) => b[1].ms - a[1].ms).slice(0, 5).map(([type, entry]) => `${type} ${entry.n}x ${Math.round(entry.ms)}`).join(", ");
      this.options.log(`timing: event tap flush: ${taken.length} events, entries ${Math.round(writeMs)} ms, summary and push hooks ${Math.round(hookMs)} ms, all ${Math.round(total)} ms`);
      this.options.log(`timing: event tap flush by type (events x ms): ${types} ms`);
      this.options.log(`timing: event tap flush: bots ${slowest.line(taken.length)}`);
    }
  }

  /** Startup timing: the last `store` call's time in the entry write and in the `eventStored` hook. */
  private readonly stored = { write: 0, hook: 0 };

  private store(tx: Db, event: ContractEvent): void {
    this.stored.write = 0;
    this.stored.hook = 0;
    const began = performance.now();
    tx.exec("SAVEPOINT tap_event");
    try {
      this.write(tx, event);
      tx.exec("RELEASE tap_event");
    } catch (error) {
      if (!tx.inTransaction) throw error;
      tx.exec("ROLLBACK TO tap_event");
      tx.exec("RELEASE tap_event");
      this.options.log?.(`event tap: a ${event.type} event was not stored (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    const stored = this.options.hooks?.eventStored;
    this.stored.write = performance.now() - began;
    if (!stored) return;
    const hookBegan = performance.now();
    tx.exec("SAVEPOINT tap_stored");
    try {
      stored(tx, event);
      tx.exec("RELEASE tap_stored");
      this.stored.hook = performance.now() - hookBegan;
    } catch (error) {
      if (!tx.inTransaction) throw error;
      tx.exec("ROLLBACK TO tap_stored");
      tx.exec("RELEASE tap_stored");
      this.options.log?.(`event tap: eventStored of a ${event.type} event failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private write(tx: Db, event: ContractEvent): void {
    const { scope } = this.options;
    const log = this.options.log;
    const now = this.now();
    const botId = botOfEvent(event);
    if (!botId) {
      appendFitted(scope, tx, serverStreamOf(tx), event.type, bodyOf(event), { log });
      return;
    }
    const stream = ensureBot(tx, botId);
    switch (event.type) {
      case "turn.started": {
        const row = findTurnEffect(tx, botId, event.turnId);
        const entry = appendFitted(scope, tx, stream, event.type, bodyOf(event), { log });
        if (!row) {
          insertEffect(tx, {
            effectId: randomUUID(), stream, botId, turnId: event.turnId, kind: "turn",
            payload: { kind: "turn", origin: "core", replyId: event.messageId, userId: null },
            state: "started", seq: entry?.seq ?? 0, startedAt: now, endedAt: null,
          });
        }
        markLive(tx, botId, event.turnId, now);
        return;
      }
      case "turn.finished": {
        const row = findTurnEffect(tx, botId, event.turnId);
        if (row && (row.state === "finished" || row.state === "interrupted" || row.state === "cancelled")) return;
        appendFitted(scope, tx, stream, event.type, bodyOf(event), { log });
        if (row) moveEffect(tx, row.effectId, ["started", "queued"], "finished", now);
        clearLive(tx, botId, event.turnId);
        this.options.hooks?.turnEnded?.(tx, botId, event.turnId, event.status);
        return;
      }
      case "message.added": {
        const known = tx.prepare("SELECT body FROM messages WHERE botId = ? AND msgId = ?").get(botId, event.message.id);
        const entry = known
          ? (String(known.body) === canonicalJson(event.message) ? null : appendFitted(scope, tx, stream, "message.updated", bodyOf(event), { log }))
          : appendFitted(scope, tx, stream, event.type, bodyOf(event), { log });
        if (entry) this.options.hooks?.lineStored?.(tx, event, entry);
        return;
      }
      case "message.updated": {
        // A redraw of a line exactly as the log has it (about two in three updates) stores nothing; the content index
        // still looks at the line again against the entry that holds it (a file it names may have changed on disk).
        const known = tx.prepare("SELECT rev, body FROM messages WHERE botId = ? AND msgId = ?").get(botId, event.message.id);
        if (known && String(known.body) === canonicalJson(event.message)) {
          this.options.hooks?.lineStored?.(tx, event, { stream, seq: Number(known.rev) });
          return;
        }
        const entry = appendFitted(scope, tx, stream, event.type, bodyOf(event), { log });
        if (entry) this.options.hooks?.lineStored?.(tx, event, entry);
        return;
      }
      case "bot.updated":
        // The same bot view as the last one (in the bot's stream, and in `srv:` where it is mirrored) is not stored again;
        // the unread count always follows the event.
        appendFitted(scope, tx, stream, event.type, bodyOf(event), { log, skipSame: true });
        if (this.options.mirrorBotUpdates) appendFitted(scope, tx, serverStreamOf(tx), event.type, bodyOf(event), { log, skipSame: true });
        tx.prepare("UPDATE bots SET unread = ? WHERE botId = ?").run(event.bot.unread, botId);
        return;
      case "subagent.updated":
        appendFitted(scope, tx, stream, event.type, bodyOf(event), { log, skipSame: true });
        return;
      case "bot.removed":
        appendFitted(scope, tx, stream, event.type, bodyOf(event), { log });
        tx.prepare("DELETE FROM bots WHERE botId = ?").run(botId);
        return;
      default:
        appendFitted(scope, tx, stream, event.type, bodyOf(event), { log });
    }
  }
}
