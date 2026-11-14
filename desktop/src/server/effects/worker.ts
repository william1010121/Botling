// The effect worker (protocol v1 §12): runs the outbox's queued rows after their intent committed.
//
//   kick → one command: take up to `batch` queued rows (each bot's in queue order) and mark them `started`
//        → after that commit, hand each to the engine:
//          turn   a turn kept aside in this process is released (the same core Turn); otherwise the engine starts it
//                 from the row (chat.send: the user's text and ids; an answer's or routine's turn: its words and ids)
//          remove the engine removes the bot (idempotent), then the row is `finished`
//
// A row is `started` (committed) before the engine is asked, so a turn is begun at most once: a crash after that makes
// it `interrupted` at the next start (recovery.ts), never started again. The turn's row ends with its `turn.finished`
// event (tap.ts). Turns that do not end that way are closed here with a `turn.finished` of their own:
// - the engine refused it (an error; status failed), or a plugin stopped the message (no turn; status stopped);
// - another turn under way read it in (Codex steering, a pause): it ends when that turn ends (`turnEnded`);
// - its `done` settled while its row is still `started` (a safety net; checked a moment later, after the event).
import type { Db } from "../store";
import type { DeferredTurnRequest, TurnEngine, TurnRunning, TurnStatus } from "./engine";
import { appendFitted, clearLive } from "./log-ops";
import type { TxScope } from "./scope";
import { moveEffect, queuedEffects, readEffect, type EffectRow, type TurnPayload } from "./table";

export interface EffectWorkerOptions {
  scope: TxScope;
  engine: TurnEngine;
  now?: () => number;
  log?: (line: string) => void;
  /** Rows taken per command. */
  batch?: number;
}

interface Absorbed { effectId: string; botId: string; turnId: string; replyId: string }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2_000);

export class EffectWorker {
  /** Turns being handed to the engine now: the engine's `deferTurn` lets these through. */
  readonly starting = new Set<string>();
  /** Turns kept aside in this process, by turnId: released instead of started again. */
  private readonly kept = new Map<string, DeferredTurnRequest>();
  /** `turn.stop` arrived while the turn was being handed over: stopped once it is. */
  private readonly stops = new Set<string>();
  /** Turns another turn read in, by the turn that read them. */
  private readonly absorbed = new Map<string, Absorbed[]>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly batch: number;
  private scheduled = false;
  private draining: Promise<void> | null = null;
  private again = false;
  private closed = false;

  constructor(private readonly options: EffectWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.batch = Math.max(1, options.batch ?? 32);
  }

  /** A turn the engine kept aside (its row and `turn.queued` are in the command that kept it). */
  keep(turn: DeferredTurnRequest): void {
    this.kept.set(turn.turnId, turn);
  }

  /** A kept turn that will not run (cancelled, or its command rolled back). */
  forget(turnId: string): boolean {
    return this.kept.delete(turnId);
  }

  /** Runs the queued rows soon (after the current turn of the event loop). */
  kick(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  /** Takes and runs queued rows until none is left. */
  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          for (;;) {
            const rows = await this.options.scope.submit((tx) => this.take(tx));
            if (!rows.length) break;
            for (const row of rows) this.track(this.run(row));
          }
        } while (this.again && !this.closed);
      } catch (error) {
        this.options.log?.(`effects: taking queued rows failed (${errorText(error)})`);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /** Settles once nothing is being taken or handed over (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.scheduled) await new Promise<void>((resolve) => setImmediate(resolve));
      else if (this.draining) await this.draining;
      else if (this.inFlight.size) await Promise.all([...this.inFlight]);
      else return;
    }
  }

  /** `turn.stop` of a started turn, after its intent committed. */
  stop(botId: string, turnId: string): void {
    if (this.starting.has(turnId)) this.stops.add(turnId);
    else this.options.engine.stopTurn(botId, turnId);
  }

  /** A queued turn was cancelled (its intent committed): the engine forgets it. */
  discard(botId: string, turnId: string): void {
    this.forget(turnId);
    this.options.engine.discardTurn(botId, turnId);
  }

  /** The tap stored `turn.finished` of `turnId` in `tx`: turns it read in end with it, in the same transaction. */
  turnEnded(tx: Db, botId: string, turnId: string, status: TurnStatus): void {
    const absorbed = this.absorbed.get(turnId);
    if (!absorbed) return;
    this.absorbed.delete(turnId);
    for (const turn of absorbed) this.finish(tx, turn.effectId, turn.botId, turn.turnId, turn.replyId, status);
    this.options.scope.onRollback(() => this.absorbed.set(turnId, absorbed));
    void botId;
  }

  close(): void {
    this.closed = true;
  }

  private take(tx: Db): EffectRow[] {
    const rows = queuedEffects(tx, this.batch);
    const now = this.now();
    return rows.filter((row) => moveEffect(tx, row.effectId, ["queued"], "started", now)).map((row) => ({ ...row, state: "started" as const, startedAt: now }));
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private async run(row: EffectRow): Promise<void> {
    if (row.kind === "remove") return this.runRemove(row);
    const payload = row.payload as TurnPayload;
    const turnId = row.turnId!;
    let running: TurnRunning;
    this.starting.add(turnId);
    try {
      const kept = this.kept.get(turnId);
      if (kept) {
        this.kept.delete(turnId);
        running = kept.release();
      } else {
        running = await this.options.engine.startTurn({
          botId: row.botId, turnId, replyId: payload.replyId, userId: payload.userId,
          ...(payload.send ? { send: payload.send } : {}),
          ...(payload.words !== undefined ? { words: payload.words } : {}),
          ...(payload.engine ? { engine: payload.engine } : {}),
          ...(payload.coreOrigin ? { origin: payload.coreOrigin } : {}),
          ...(payload.origin === "routine" ? { routine: true } : {}),
        });
      }
    } catch (error) {
      this.starting.delete(turnId);
      this.stops.delete(turnId);
      this.options.log?.(`effects: turn ${turnId} of ${row.botId} did not start (${errorText(error)})`);
      await this.closeRow(row, "failed", errorText(error));
      return;
    }
    this.starting.delete(turnId);
    const stopNow = this.stops.delete(turnId);
    if (running.turnId === null) {
      // No turn (a plugin stopped the message).
      await this.closeRow(row, "stopped");
      return;
    }
    if (running.turnId !== turnId) {
      const list = this.absorbed.get(running.turnId) ?? [];
      list.push({ effectId: row.effectId, botId: row.botId, turnId, replyId: payload.replyId });
      this.absorbed.set(running.turnId, list);
    } else if (stopNow) {
      this.options.engine.stopTurn(row.botId, turnId);
    }
    // The safety net: the turn's own `turn.finished` normally closed the row before this runs.
    void running.done?.then((status) => {
      setImmediate(() => { void this.closeRow(row, status); });
    }, () => {});
  }

  private async runRemove(row: EffectRow): Promise<void> {
    try {
      await this.options.engine.removeBot(row.botId);
    } catch (error) {
      this.options.log?.(`effects: removing ${row.botId} failed (${errorText(error)})`);
    }
    try {
      await this.options.scope.submit((tx) => { moveEffect(tx, row.effectId, ["started"], "finished", this.now()); });
    } catch (error) {
      this.options.log?.(`effects: closing the removal of ${row.botId} failed (${errorText(error)})`);
    }
  }

  /** Ends a turn row that is still `started` with a `turn.finished` of its own. */
  private async closeRow(row: EffectRow, status: TurnStatus, error?: string): Promise<void> {
    if (this.closed) return;
    const payload = row.payload as TurnPayload;
    try {
      await this.options.scope.submit((tx) => { this.finish(tx, row.effectId, row.botId, row.turnId!, payload.replyId, status, error); });
    } catch (failure) {
      this.options.log?.(`effects: closing turn ${row.turnId} failed (${errorText(failure)})`);
    }
  }

  private finish(tx: Db, effectId: string, botId: string, turnId: string, replyId: string, status: TurnStatus, error?: string): void {
    const current = readEffect(tx, effectId);
    if (!current || current.state !== "started") return;
    appendFitted(this.options.scope, tx, current.stream as `bot:${string}`, "turn.finished", {
      botId, turnId, messageId: replyId, status, text: "", ...(error ? { error } : {}),
    }, { log: this.options.log });
    moveEffect(tx, effectId, ["started"], "finished", this.now());
    clearLive(tx, botId, turnId);
  }
}
