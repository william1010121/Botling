// Apply at the owner: exactly-once intent, FIFO per origin incarnation (protocol v1 §11.3, D12, D49, D50).
//
// Every decision is taken inside one writer transaction (server/store/writer.ts), reading `slots.next`, receipts and
// cancels there, so nothing about a slot is ever "pending or uncertain" after a crash: the store is the whole state.
// The only memory is the held-ahead buffer: copies of slots above `next`, at most 64 per queue, kept so that a slot
// that arrives before its predecessor applies as soon as the gap closes. Losing it (a restart) costs nothing but a
// re-send: a held copy is re-run through the same checks, never trusted.
//
//   on cmd with slot n, floor f, inc i, hash h:
//     i ≠ my srv: logId                 → cmd.retry{slot, inc}; no receipt, no outcome (D49)
//     f > next                          → cmd.skipped{from: next, to: f-1}; next = f; audit
//     n < next, receipt(n).hash = h     → the stored outcome again (a skipped slot matches any hash)
//     n < next, otherwise               → refused{slot conflict}, seq null, nothing stored; audit
//     n > next                          → hold (≤ 64 per queue) and wait
//     n ∈ cancels                       → cmd.cancelled
//     carries `via` (a plugin's)        → cmd.refused{grant} unless device scope ∩ the grant at via.codeHash allows (M5-15)
//     origin invalid / scope forbids    → cmd.refused{scope | origin}
//     target or basis check fails       → cmd.refused{invalid | changed} (§11.5)
//     apply throws SlotRefusal          → cmd.refused{reason} (the apply's writes rolled back)
//     else                              → the apply's intent entries + cmd.applied{slot, result}
//   then receipt(n, h, outcome), next = n + 1, commit, cmd.result{slot, outcome, logId, seq}, held slots in turn.
//   on cancel(n): n < next → "too late" with the stored outcome; n's legacy handler began → wait for its outcome, then
//   "too late" with it; else n joins cancels (committed). Either way the canceller gets one answer (D59,
//   `cancelAnswer`): the stored `cmd.result`, or `cancel.noted` once committed.
//
// Begun (legacy apply): a legacy command's handler runs before the transaction that stores its outcome, so the slot is
// marked begun (in memory) in the same transaction that admits it. While it is marked, a cancel never joins `cancels`:
// the handler's effect may already have happened, so the cancel is too late and waits for the real outcome. The mark
// stays until the slot's outcome is committed, also when the handler ran and the store then failed (the session ends,
// the front end re-sends, the re-send decides it). A restart forgets marks: that is the crash case legacy.ts states (the
// re-send runs the handler again).
//
// Order (D58): a slot is decided only when it is exactly `next`, so within a queue outcomes commit in slot order; a
// held copy is re-run only by `pump`, in slot order, after its predecessor moved `next`. The only way past a slot that
// never arrived is a floor above `next` (cmd.skipped): the origin computes floor as its smallest unresolved slot, so a
// floor above `next` names slots the origin already holds an outcome for (seen before a rewind or restore), never one
// it still wants. A session delivers one queue's copies in send order (the session core chains them), so a gap or a
// copy dropped from the held buffer means the session broke FIFO: that session is ended and the origin re-sends.
import type { Command } from "../../contract";
import { queueKey, type CmdBody, type Cursor, type LogId, type MessageOf, type Outcome, type Scope, type Slot, type Via } from "../../protocol";
import { PluginRow } from "../../protocol/table-rows";
import { ownTableStream, readRowBody } from "../replica/tables";
import type { Command as StoreCommand, Db } from "../store";
import { checkBasis, checkTarget, dbBasisReader, localOnly } from "./basis";
import { grantAllows } from "./grant-check";
import { cmdHash } from "./hash";
import { addCancel, findReceipt, isCancelled, readNext, removeCancel, writeNext, writeReceipt, writeSkip, type QueueRef } from "./tables";
import { SlotRefusal, type ApplyFn, type Audit, type Authorize, type BasisReader, type SlotLog } from "./types";

export type CmdResultMessage = MessageOf<"cmd.result">;
export type CmdRetryMessage = MessageOf<"cmd.retry">;
export type SlotReply = CmdResultMessage | CmdRetryMessage;
/** Where the messages about one copy of a command go (the session that sent it). */
export type ReplySink = (message: SlotReply) => void;

/** Held-ahead slots kept per (origin, originEpoch, target) (§11.3, §20). */
export const HELD_LIMIT = 64;
const DETAIL_LIMIT = 2_000;

/** One command copy as the owner checks it. `scope` is the one the accepting server stated (§11.1). */
export interface SlotInput {
  slot: Slot;
  floor: number;
  inc: LogId;
  cmd: Command;
  scope: Scope;
  basis?: Cursor;
  /** The plugin the command came from (N1): checked against this owner's grant for `codeHash` (M5-15). */
  via?: Via;
  /** cmdHash over cmd, scope, basis and via when present (never floor or inc). */
  hash: string;
}

/** What the checks say about a copy, before anything is written (also what a legacy-apply path asks first). */
export type Admission =
  | { kind: "retry"; inc: LogId }
  | { kind: "duplicate"; outcome: Outcome; seq: number | null; skip: Skip | null }
  | { kind: "conflict"; skip: Skip | null }
  | { kind: "hold"; skip: Skip | null }
  | { kind: "ready"; cancelled: boolean; skip: Skip | null };
export interface Skip { from: number; to: number }

export type ReceiveStatus =
  /** `fresh`: this copy decided the slot now; otherwise the stored outcome (or a conflict) was sent again. */
  | { status: "result"; message: CmdResultMessage; fresh: boolean }
  | { status: "retry"; message: CmdRetryMessage }
  | { status: "held" }
  /** Above `next` with the held buffer full of nearer slots: not kept; the sender's re-send brings it again. */
  | { status: "dropped" };

export type CancelStatus = { status: "too late"; message: CmdResultMessage } | { status: "cancelled ahead" };
/** How a begun slot's handler run ended (`SlotEngine.begin`). */
export type BegunEnd = "stored" | "ran" | "not run";

interface Begun { copies: number; ran: boolean; settled: Promise<void>; settle: () => void }
export type CancelNotedMessage = MessageOf<"cancel.noted">;
/** What a `cancel` is answered with (D59): exactly one per cancel the owner committed or found too late. */
export type CancelAnswer = CmdResultMessage | CancelNotedMessage;

/** The answer the canceller gets for a `cancel` (D59): the stored outcome when too late, otherwise `cancel.noted`. */
export function cancelAnswer(slot: Slot, status: CancelStatus): CancelAnswer {
  return status.status === "too late" ? status.message : { t: "cancel.noted", slot };
}

/**
 * The slot a message answers a `cancel` for, or null (D59). M3's forwarding server keeps a forwarded `cancel` in its
 * `forwardq` until this returns the cancel's slot for a message from the owner; only then may it delete the row (a
 * `cmd.retry` or `held` is not an answer). The slot must match origin, originEpoch, target and n.
 */
export function cancelAnswered(message: { t: string; slot?: Slot }): Slot | null {
  return (message.t === "cancel.noted" || message.t === "cmd.result") && message.slot ? message.slot : null;
}

export interface SlotEngineOptions {
  /** The writer's submit (ServerStore.submit): runs a synchronous command in the group-commit transaction. */
  submit<T>(command: StoreCommand<T>): Promise<T>;
  log: SlotLog;
  /** The apply step (step 6 plugs the intent handlers in here). */
  apply: ApplyFn;
  basis?: BasisReader;
  authorize?: Authorize;
  audit?: Audit;
  heldLimit?: number;
}

interface HeldCopy { body: CmdBody; scope: Scope; reply?: ReplySink }

/** This server's `plugin:<name>` row, or null when there is none or it cannot be read (fail closed: no row, no grant). */
function readPluginRow(tx: Db, plugin: string): PluginRow | null {
  try {
    const parsed = PluginRow.safeParse(readRowBody(tx, ownTableStream(tx), `plugin:${plugin}`));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The name this machine gives itself in its `machine` row, else its server id (never empty). */
function ownServerName(tx: Db): string {
  try {
    const stream = ownTableStream(tx);
    const machine = readRowBody(tx, stream, "machine") as { name?: unknown } | null;
    return typeof machine?.name === "string" && machine.name ? machine.name : stream.slice("srv:".length);
  } catch {
    return "this server";
  }
}

const queueOf = (slot: Slot): QueueRef => ({ origin: slot.origin, originEpoch: slot.originEpoch, target: slot.target });
const truncate = (text: string) => (text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 1)}…` : text);

/** The checks of §11.3 in order, read-only. `next` is read in `tx`, so the answer holds for that transaction. */
export function admit(tx: Db, log: SlotLog, input: SlotInput): Admission {
  const inc = log.serverInc(tx);
  if (input.inc !== inc) return { kind: "retry", inc };
  const next = readNext(tx, queueOf(input.slot));
  const skip = input.floor > next ? { from: next, to: input.floor - 1 } : null;
  const effective = skip ? input.floor : next;
  const n = input.slot.n;
  if (n < effective) {
    const receipt = findReceipt(tx, input.slot);
    if (receipt && (receipt.skipped || receipt.cmdHash === input.hash)) return { kind: "duplicate", outcome: receipt.outcome, seq: receipt.seq, skip };
    return { kind: "conflict", skip };
  }
  if (n > effective) return { kind: "hold", skip };
  return { kind: "ready", cancelled: isCancelled(tx, input.slot), skip };
}

type Step =
  | { kind: "result"; message: CmdResultMessage; fresh: boolean; next: number }
  | { kind: "retry"; message: CmdRetryMessage }
  | { kind: "hold"; next: number };

export class SlotEngine {
  private readonly held = new Map<string, Map<number, HeldCopy>>();
  /** Slots whose legacy handler began and whose outcome is not committed yet, by queue key, then n. */
  private readonly begun = new Map<string, Map<number, Begun>>();
  private readonly heldLimit: number;
  private readonly basis: BasisReader;
  private readonly authorize: Authorize;

  constructor(private readonly options: SlotEngineOptions) {
    this.heldLimit = Math.max(1, options.heldLimit ?? HELD_LIMIT);
    this.basis = options.basis ?? dbBasisReader;
    this.authorize = options.authorize ?? localOnly;
  }

  /** Slots held ahead of `next` (for a queue, or in all). */
  heldCount(queue?: QueueRef): number {
    if (queue) return this.held.get(queueKey(queue))?.size ?? 0;
    let total = 0;
    for (const copies of this.held.values()) total += copies.size;
    return total;
  }

  /**
   * The scope and origin check alone (§11.3 "origin invalid or scope forbids"), read-only. Legacy apply runs it before a
   * command's handler, so a command the owner would refuse never runs its handler (the slot is then decided as usual).
   */
  denies(tx: Db, input: { slot: Slot; cmd: Command; scope: Scope; via?: Via }): { reason: "scope" | "origin" | "grant"; detail?: string } | null {
    // §11.3 / D53 / M5-15: the device's scope first (N7), then the plugin's grant at `via.codeHash`, read from this
    // owner's own `srv:` row inside the decision transaction. Only the owner refuses for a grant (D58).
    const denied = this.authorize(tx, input);
    if (denied) return denied;
    if (input.via) {
      // D54 / M5-14a F3: a plugin never sends `plugin.grant`. Kept ahead of the grant lookup on purpose.
      if (input.cmd.type === "plugin.grant") return { reason: "grant", detail: "plugin.grant cannot be sent by a plugin" };
      const decision = grantAllows(readPluginRow(tx, input.via.plugin), input.via, input.cmd, ownServerName(tx));
      if (!decision.ok) return { reason: "grant", detail: decision.detail };
    }
    return null;
  }

  /** The owner's `next` for a queue (`welcome.next`, §11.4). */
  next(tx: Db, queue: QueueRef): number {
    return readNext(tx, queue);
  }

  /**
   * One copy of a command from an origin. `scope` is the scope the accepting server states (a front end's `cmd` never
   * carries one); falls back to the envelope's for a forwarded command. Every message about this copy, including
   * the result of a held copy applied later, goes to `reply`; the returned status repeats the immediate one.
   */
  async receive(body: CmdBody, options: { scope?: Scope; reply?: ReplySink } = {}): Promise<ReceiveStatus> {
    const scope = options.scope ?? body.scope;
    if (!scope) throw new TypeError("slots: a command needs the scope its accepting server stated");
    const input: SlotInput = {
      slot: body.slot, floor: body.floor, inc: body.inc, cmd: body.cmd, scope, basis: body.basis, ...(body.via ? { via: body.via } : {}),
      hash: cmdHash({ cmd: body.cmd, scope, basis: body.basis, via: body.via }),
    };
    let holdResult: ReceiveStatus = { status: "held" };
    const step = await this.options.submit((tx) => {
      const decided = this.step(tx, input);
      // Kept in memory inside the transaction's turn, so a predecessor later in the same batch finds it when it pumps.
      if (decided.kind === "hold") holdResult = this.hold(input.slot, { body, scope, reply: options.reply });
      return decided;
    });
    if (step.kind === "retry") {
      options.reply?.(step.message);
      return { status: "retry", message: step.message };
    }
    if (step.kind === "result") options.reply?.(step.message);
    this.settleBelow(queueOf(input.slot), step.next);
    await this.pump(queueOf(input.slot), step.next);
    return step.kind === "result" ? { status: "result", message: step.message, fresh: step.fresh } : holdResult;
  }

  /**
   * Marks slot `n` begun: its legacy handler is about to run. Call it inside the writer transaction that admitted the
   * copy (ready, not cancelled), so no cancel can commit between that check and the mark. The returned function ends
   * this copy's part: `stored` once the slot's outcome is committed, `ran` when the handler ran but nothing was stored,
   * `not run` when the admission did not commit (the handler never ran).
   */
  begin(slot: Slot): (end: BegunEnd) => void {
    const key = queueKey(slot);
    let queue = this.begun.get(key);
    if (!queue) this.begun.set(key, (queue = new Map()));
    let entry = queue.get(slot.n);
    if (!entry) {
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      entry = { copies: 0, ran: false, settled, settle };
      queue.set(slot.n, entry);
    }
    entry.copies += 1;
    const mine = entry;
    let done = false;
    return (end) => {
      if (done) return;
      done = true;
      mine.copies -= 1;
      if (end === "ran") mine.ran = true;
      if (end === "stored" || (mine.copies === 0 && !mine.ran)) this.unbegin(slot, mine);
    };
  }

  /** Slots marked begun (for a queue, or in all): a legacy handler ran or runs and the outcome is not committed. */
  begunCount(queue?: QueueRef): number {
    if (queue) return this.begun.get(queueKey(queue))?.size ?? 0;
    let total = 0;
    for (const slots of this.begun.values()) total += slots.size;
    return total;
  }

  private unbegin(slot: Slot, entry: Begun): void {
    const key = queueKey(slot);
    const queue = this.begun.get(key);
    if (queue?.get(slot.n) === entry) {
      queue.delete(slot.n);
      if (queue.size === 0) this.begun.delete(key);
    }
    entry.settle();
  }

  /** Drops the marks of slots below `next` (decided, or skipped past): their outcome is committed. */
  private settleBelow(queue: QueueRef, next: number): void {
    const slots = this.begun.get(queueKey(queue));
    if (!slots) return;
    for (const [n, entry] of [...slots]) if (n < next) this.unbegin({ ...queue, n } as Slot, entry);
  }

  /**
   * The origin no longer wants slot `n` (§11.3). Once n's legacy handler began, the cancel is too late: it waits until
   * n's outcome is committed and answers with it (D59: the answer is the real outcome, never a cancel after the effect).
   */
  async cancel(slot: Slot): Promise<CancelStatus> {
    for (;;) {
      const decided = await this.options.submit((tx): CancelStatus | { status: "begun"; settled: Promise<void> } => {
        if (slot.n < readNext(tx, queueOf(slot))) {
          const receipt = findReceipt(tx, slot);
          if (receipt) return { status: "too late", message: this.result(tx, slot, receipt.outcome, receipt.seq) };
          // Below next with no receipt cannot happen (every slot below next has one, or a skip row covers it).
          throw new Error("slots: a slot below next has no receipt");
        }
        const begun = this.begun.get(queueKey(slot))?.get(slot.n);
        if (begun) return { status: "begun", settled: begun.settled };
        addCancel(tx, slot);
        return { status: "cancelled ahead" };
      });
      if (decided.status !== "begun") return decided;
      await decided.settled;
    }
  }

  /** The §11.3 checks and writes for one copy, inside the writer transaction. */
  private step(tx: Db, input: SlotInput): Step {
    const { log } = this.options;
    const admission = admit(tx, log, input);
    if (admission.kind === "retry") return { kind: "retry", message: { t: "cmd.retry", slot: input.slot, inc: admission.inc } };
    const queue = queueOf(input.slot);
    let next = readNext(tx, queue);
    if (admission.skip) {
      const { from, to } = admission.skip;
      const at = log.appendEntry(tx, input.slot.target, "cmd.skipped", { origin: queue.origin, originEpoch: queue.originEpoch, target: queue.target, from, to });
      writeSkip(tx, queue, from, to, at.seq);
      next = to + 1;
      writeNext(tx, queue, next);
      this.options.audit?.(tx, { kind: "skipped", slot: queue, from, to });
    }
    switch (admission.kind) {
      case "duplicate":
        return { kind: "result", message: this.result(tx, input.slot, admission.outcome, admission.seq), fresh: false, next };
      case "conflict":
        this.options.audit?.(tx, { kind: "slot conflict", slot: input.slot });
        return { kind: "result", message: this.result(tx, input.slot, { kind: "refused", reason: "slot conflict" }, null), fresh: false, next };
      case "hold":
        return { kind: "hold", next };
      case "ready": {
        const { outcome, seq } = admission.cancelled ? this.appendCancelled(tx, input) : this.decide(tx, input);
        writeReceipt(tx, input.slot, input.hash, outcome, seq);
        next = input.slot.n + 1;
        writeNext(tx, queue, next);
        return { kind: "result", message: this.result(tx, input.slot, outcome, seq), fresh: true, next };
      }
    }
  }

  private appendCancelled(tx: Db, input: SlotInput): { outcome: Outcome; seq: number } {
    removeCancel(tx, input.slot);
    const at = this.options.log.appendEntry(tx, input.slot.target, "cmd.cancelled", { slot: input.slot }, input.slot);
    return { outcome: { kind: "cancelled" }, seq: at.seq };
  }

  /** Scope, target, basis, then the apply step in its own savepoint; a refusal rolls the apply's writes back. */
  private decide(tx: Db, input: SlotInput): { outcome: Outcome; seq: number } {
    const { log } = this.options;
    let outcome: Outcome;
    const denied = this.denies(tx, { slot: input.slot, cmd: input.cmd, scope: input.scope, via: input.via });
    if (denied) {
      outcome = { kind: "refused", reason: denied.reason, ...(denied.detail ? { detail: truncate(denied.detail) } : {}) };
    } else {
      tx.exec("SAVEPOINT slot_apply");
      try {
        checkTarget(input.slot.target, input.cmd);
        checkBasis(tx, this.basis, log, input.slot.target, input.cmd, input.basis);
        const applied = this.options.apply({ tx, slot: input.slot, cmd: input.cmd, scope: input.scope, basis: input.basis, log });
        if (applied && typeof (applied as unknown as PromiseLike<unknown>).then === "function") {
          (applied as unknown as Promise<unknown>).then(undefined, () => {});
          throw new TypeError("slots: an apply step must be synchronous (it returned a promise)");
        }
        tx.exec("RELEASE slot_apply");
        const result = applied ? applied.result : undefined;
        outcome = result === undefined ? { kind: "applied" } : { kind: "applied", result };
      } catch (error) {
        if (!tx.inTransaction) throw error;
        tx.exec("ROLLBACK TO slot_apply");
        tx.exec("RELEASE slot_apply");
        if (!(error instanceof SlotRefusal)) throw error;
        outcome = { kind: "refused", reason: error.reason, ...(error.detail ? { detail: truncate(error.detail) } : {}) };
      }
    }
    const body: Record<string, unknown> = outcome.kind === "applied"
      ? { slot: input.slot, ...(outcome.result !== undefined ? { result: outcome.result } : {}) }
      : { slot: input.slot, reason: (outcome as { reason: string }).reason, ...((outcome as { detail?: string }).detail ? { detail: (outcome as { detail?: string }).detail } : {}) };
    const at = log.appendEntry(tx, input.slot.target, outcome.kind === "applied" ? "cmd.applied" : "cmd.refused", body, input.slot);
    return { outcome, seq: at.seq };
  }

  private result(tx: Db, slot: Slot, outcome: Outcome, seq: number | null): CmdResultMessage {
    return { t: "cmd.result", slot, outcome, logId: this.options.log.logId(tx, slot.target), seq };
  }

  /** Keeps a copy above `next`: the nearest slots win when the buffer is full. */
  private hold(slot: Slot, copy: HeldCopy): ReceiveStatus {
    const key = queueKey(slot);
    let copies = this.held.get(key);
    if (!copies) this.held.set(key, (copies = new Map()));
    if (!copies.has(slot.n) && copies.size >= this.heldLimit) {
      const farthest = Math.max(...copies.keys());
      if (slot.n > farthest) {
        this.options.audit?.(null, { kind: "held dropped", slot });
        return { status: "dropped" };
      }
      copies.delete(farthest);
      this.options.audit?.(null, { kind: "held dropped", slot: { ...slot, n: farthest } });
    }
    copies.set(slot.n, copy);
    return { status: "held" };
  }

  /** Re-runs held copies at or below `next` in order; each goes through every check again. */
  private async pump(queue: QueueRef, next: number): Promise<void> {
    const key = queueKey(queue);
    const copies = this.held.get(key);
    if (!copies) return;
    const due = [...copies.keys()].filter((n) => n <= next).sort((a, b) => a - b);
    for (const n of due) {
      const copy = copies.get(n);
      if (!copy) continue;
      copies.delete(n);
      if (copies.size === 0) this.held.delete(key);
      // A copy that fails (the store refused the transaction) is dropped; the sender re-sends it.
      await this.receive(copy.body, { scope: copy.scope, reply: copy.reply }).catch(() => undefined);
    }
  }
}
