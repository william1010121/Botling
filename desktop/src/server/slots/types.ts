// The seams of the slot rules (protocol v1 §11.3): the log they append outcome entries to, the apply step a command
// runs, the basis reader and the scope check. Each is a plain interface so step 3's log, step 6's intent handlers and
// a later "legacy apply" path plug in without changing the rules, and tests use fakes.
import type { Command } from "../../contract";
import type { Cursor, LogId, RefuseReason, Scope, Slot, StreamId, Via } from "../../protocol";
import type { Db } from "../store";

/**
 * The bot log as the slot rules need it. Every call runs inside the writer's transaction (`tx`), so an outcome entry,
 * the receipt and `slots.next` commit together or not at all (§7.3). Step 3's `server/log/` implements it.
 */
export interface SlotLog {
  /** The `logId` of this owner's `srv:` stream: the incarnation a command's `inc` must name (D49). */
  serverInc(tx: Db): LogId;
  /** The current `logId` of a stream this server owns; `cmd.result` carries it (D50). */
  logId(tx: Db, stream: StreamId): LogId;
  /** Appends one entry (`kind` and its body without `type`) to `stream`; returns the entry's cursor. */
  appendEntry(tx: Db, stream: StreamId, kind: string, body: Record<string, unknown>, slot?: Slot): Cursor;
  /** Whether `appendEntry` can store this entry (it fits one frame, cut if its kind allows). */
  fits(kind: string, body: Record<string, unknown>): boolean;
}

/** What the apply step gets: the slot, the command and the transaction it runs in. */
export interface ApplyContext {
  tx: Db;
  slot: Slot;
  cmd: Command;
  scope: Scope;
  basis?: Cursor;
  /** M5-16: the plugin attribution the copy carried; part of the command's hash, so legacy apply finds its handler's result. */
  via?: Via;
  /** For the intent entries (and effect rows, §12) the command adds before its `cmd.applied`. */
  log: SlotLog;
}

/**
 * The apply step: runs inside the writer transaction, synchronously, after every §11.3 check passed. It appends the
 * command's intent entries and returns the result `cmd.applied` carries. Throw `SlotRefusal` to refuse the slot (its
 * writes are rolled back, the refusal is the outcome); any other error fails the whole command: nothing is stored,
 * `next` does not move, and the sender's re-send tries again.
 */
export type ApplyFn = (context: ApplyContext) => { result?: unknown } | void;

/** Thrown by an apply step (or a check) to refuse a slot with a stored outcome. */
export class SlotRefusal extends Error {
  constructor(readonly reason: Exclude<RefuseReason, "slot conflict">, readonly detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "SlotRefusal";
  }
}

/** Who may do what (§11.7). Null allows; otherwise the refusal. M1 has only the local desktop front end. */
export type Authorize = (tx: Db, input: { slot: Slot; cmd: Command; scope: Scope; peer?: string | null }) => { reason: "scope" | "origin"; detail?: string } | null;

/** The read models the §11.5 basis checks read. */
export interface BasisReader {
  /** True while `turnId` is the bot's running turn. */
  turnRunning(tx: Db, botId: string, turnId: string): boolean;
  /** A card (a question or approval line, `cardId` = its message id), or null when there is none. */
  card(tx: Db, botId: string, cardId: string): { open: boolean; rev: number } | null;
}

/** Things the owner records for the Doctor and audits (§11.3 "audit"); never part of an outcome. */
export type AuditEvent =
  | { kind: "skipped"; slot: Omit<Slot, "n">; from: number; to: number }
  | { kind: "slot conflict"; slot: Slot }
  | { kind: "held dropped"; slot: Slot };
export type Audit = (tx: Db | null, event: AuditEvent) => void;
