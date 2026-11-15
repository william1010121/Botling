// The forwarding side (M3 step 9, protocol v1 §11.2 steps 3–6, D49, D50, D58, D59; plan change F3, F4, F7): a server
// that accepts a command for a target a peer owns keeps it in `forwardq` and sends it to that owner.
//
//   front end cmd (target owned by B)  → commit the row (scope as stated, `inc` as sent) → `held{slot, at: me}`
//   front end cancel (same)            → commit into `fwdcancels` (whether or not the row is here); no answer of its own
//   B's session up / a commit          → send what B has not had on this session: each (origin, originEpoch, target)
//                                        queue in slot order, a slot's cancel right after its row; after a lost session
//                                        the new one starts again from the lowest row still held
//   B: cmd.result{slot}                → row and cancel go (one transaction), the result is relayed to the origin's
//                                        sessions; a result of a logId this server knows as retired is dropped (D50)
//   B: cmd.retry{slot, inc}            → slot n and every row above it in that queue go, with their cancels, in one
//                                        transaction; one `cmd.retry` per row
//                                        that went is passed on. Never re-sent under a new `inc` by this server (D49)
//   B: cancel.noted{slot}              → the cancel goes (the row stays until the result); relayed
//   a row that can never be sent      → (it does not parse, its frame is too large, the encoder throws) it moves into
//                                        `forwarddead` with its reason, its cancel goes with it, the origin hears
//                                        `cmd.result{refused invalid}`, and the rest of its queue goes on. Rows after the dead
//                                        slot carry a `floor` above it, and wait for the rows below it to be answered
//                                        first, so the owner never holds a copy for a slot nobody sends. A refused send
//                                        (`sendWire` false: the link, not the row) never settles a row; it is tried again
//                                        on the next pump.
//   a dead row nothing needs        → deleted (`pruneDead`, forward-queue.ts): once no row, unanswered slot or ServerOrigin
//                                        submit of its queue can still need the raised floor, so `forwarddead` stays small.
//
// It never answers a command with an outcome of its own (F3): no scope or grant check (only the owner's decision
// counts); the front end hears `held`, then the owner's answer. The two exceptions settle a row no owner can ever
// decide: a revoked owner (`refused revoked`) and a row that can never be sent (`refused invalid`, above). Who owns
// what is directory.ts.
import { encodeWireFrame, LogId, queueKey, type CmdBody, type Message, type MessageOf, type Slot, type WireMessage } from "../../protocol";
import type { Db } from "../store";
import { cmdHash } from "../slots";
import { commitCancel, commitRow, deadToPrune, dropOwner, failRow, isRetired, ownerHasHole, ownerWork, pruneDead, queueStats, serverOriginPending, takeNoted, takeResult, takeRetry, type DroppedRow, type OwnerQueue, type QueuedRow } from "./forward-queue";
import type { Directory } from "./directory";

/** A peer session as the forwarder uses it (server/peer PeerSession). */
export interface ForwardSession {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
}

export interface ForwarderOptions {
  self: string;
  submit<T>(command: (tx: Db) => T): Promise<T>;
  reader(): Db;
  directory: Directory;
  /** The live session with a peer, if any. */
  session(peer: string): ForwardSession | null;
  /** True when a peer server is no longer valid in the roster (§4.6). */
  isRevoked?(owner: string): boolean;
  log(line: string): void;
  now?: () => number;
  /** How a row is checked before it goes out (default: the peer session's own `encodeWireFrame`). A refusal is final for that row. */
  encode?: (message: WireMessage) => { ok: true } | { ok: false; reason: string };
}

/** Where a front end session of an origin hears relayed answers. */
export type RelaySink = (message: Message) => boolean;

type Answer = MessageOf<"cmd.result"> | MessageOf<"cmd.retry"> | MessageOf<"cancel.noted">;

const slotKeyOf = (slot: Slot) => `${queueKey(slot)}\u0000${slot.n}`;
const UNKNOWN_INC = "unknown0" as LogId;
const SETTLE_RETRY_MS = 250;
const SETTLE_RETRY_MAX_MS = 30_000;
const encodeForPeer = (message: WireMessage) => encodeWireFrame(message, "peer", { local: false });

export class Forwarder {
  /** Per live session: what it carried, slot key → the copy's fingerprint (rows) or "c" (cancels). */
  private readonly sent = new WeakMap<ForwardSession, { rows: Map<string, string>; cancels: Set<string> }>();
  private readonly sinks = new Map<string, Set<RelaySink>>();
  private readonly now: () => number;
  private readonly encode: (message: WireMessage) => { ok: true } | { ok: false; reason: string };
  /** Dead rows being moved out right now (slot key + command hash), so a second pump does not submit them again. */
  private readonly settling = new Set<string>();
  /** Owners whose dead rows are being pruned right now (one prune at a time per owner). */
  private readonly pruning = new Set<string>();
  /** Per owner: failed attempts to move a dead row out, and the timer for the next one. */
  private readonly settleRetries = new Map<string, { tries: number; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(private readonly options: ForwarderOptions) {
    this.now = options.now ?? Date.now;
    this.encode = options.encode ?? encodeForPeer;
  }

  /** The peer that owns `target`, or null when this server decides it. */
  ownerOf(target: string): string | null {
    return this.options.directory.peerOwner(target);
  }

  /** Commits a front end's command for `owner` (resolves after the commit: only then may `held` go), then sends it. */
  async commit(envelope: CmdBody, owner: string): Promise<void> {
    if (!envelope.scope) throw new TypeError("forward: the accepting server states the scope before it forwards");
    if (this.options.isRevoked?.(owner)) {
      this.relay(envelope.slot.origin, this.refusedRevoked(envelope.slot, envelope.inc));
      return;
    }
    const hash = cmdHash({ cmd: envelope.cmd, scope: envelope.scope, basis: envelope.basis, via: envelope.via });
    await this.options.submit((tx) => commitRow(tx, envelope, hash, owner, this.now()));
    this.pump(owner);
  }

  /** Commits a front end's cancel for `owner`, then sends it (after its row). */
  async cancel(slot: Slot, owner: string): Promise<void> {
    if (this.options.isRevoked?.(owner)) return;
    await this.options.submit((tx) => commitCancel(tx, slot, owner, this.now()));
    this.pump(owner);
  }

  /** Drops every queued command and cancel for each revoked `owner` and relays `cmd.refused{revoked}` (§4.6). */
  async revoked(owners: readonly string[]): Promise<void> {
    for (const owner of owners) {
      let dropped: DroppedRow[];
      try {
        dropped = await this.options.submit((tx) => dropOwner(tx, owner));
      } catch (error) {
        this.options.log(`forward: dropping work for revoked ${owner} failed: ${errorText(error)}`);
        continue;
      }
      const session = this.options.session(owner);
      if (session) this.sent.delete(session);
      for (const row of dropped) this.relay(row.slot.origin, this.refusedRevoked(row.slot, row.envelope && LogId.safeParse(row.envelope.inc).success ? row.envelope.inc : UNKNOWN_INC));
      if (dropped.length) this.options.log(`forward: dropped ${dropped.length} queued command(s) for revoked peer ${owner}`);
    }
  }

  /** A front end session of `origin` hears the owners' answers for its slots while it is open. */
  attach(origin: string, sink: RelaySink): () => void {
    let set = this.sinks.get(origin);
    if (!set) this.sinks.set(origin, (set = new Set()));
    set.add(sink);
    return () => {
      const current = this.sinks.get(origin);
      current?.delete(sink);
      if (current?.size === 0) this.sinks.delete(origin);
    };
  }

  /** A full session with a peer opened (the pair's one session): it starts from the lowest row held for that peer. */
  opened(session: ForwardSession): void {
    this.sent.set(session, { rows: new Map(), cancels: new Set() });
    if (session.peer) this.pump(session.peer);
  }

  closed(session: ForwardSession): void {
    this.sent.delete(session);
  }

  /** Rows and cancels waiting (status). */
  stats(): { rows: number; cancels: number; oldestHeldAt: number | null } {
    return queueStats(this.options.reader());
  }

  /** The owner's answers on a peer session; false for any other frame. */
  async onMessage(session: ForwardSession, message: WireMessage): Promise<boolean> {
    if (message.t !== "cmd.result" && message.t !== "cmd.retry" && message.t !== "cancel.noted") return false;
    const peer = session.peer;
    if (!peer) return true;
    await this.answer(session, peer, message as Answer);
    return true;
  }

  /**
   * Sends `owner` every row and cancel its live session has not carried yet, each queue in slot order. Synchronous: it
   * reads the committed queue and writes frames in one turn, so nothing interleaves. A row that can never be sent is
   * handed to `settle` (an async commit) and its queue waits at that row; other queues go on. A refused `sendWire` ends
   * the pump: that is the link, and the next pump tries again.
   */
  pump(owner: string): void {
    if (this.options.isRevoked?.(owner)) return;
    this.prune(owner);
    const session = this.options.session(owner);
    if (!session || session.state !== "open") return;
    let sent = this.sent.get(session);
    if (!sent) this.sent.set(session, (sent = { rows: new Map(), cancels: new Set() }));
    let work;
    try { work = ownerWork(this.options.reader(), owner); } catch (error) { this.options.log(`forward: reading the queue for ${owner} failed: ${errorText(error)}`); return; }
    for (const queue of work.queues) {
      if (!this.pumpQueue(owner, session, sent, queue)) return;
    }
  }

  /** One queue of `pump`; false when a send was refused (stop everything), true to go on with the next queue. */
  private pumpQueue(owner: string, session: ForwardSession, sent: { rows: Map<string, string>; cancels: Set<string> }, queue: OwnerQueue): boolean {
    let c = 0;
    for (let r = 0; r <= queue.rows.length; r++) {
      const row = queue.rows[r];
      // A slot's cancel goes right after its own row; a cancel whose row is not here goes at its place in slot order.
      while (c < queue.cancels.length && (!row || queue.cancels[c]!.slot.n < row.slot.n)) {
        if (!queue.holes.includes(queue.cancels[c]!.slot.n) && !this.sendCancel(session, sent.cancels, queue.cancels[c]!.slot)) return false;
        c++;
      }
      if (!row) break;
      const key = slotKeyOf(row.slot);
      const print = `${row.cmdHash}\u0000${row.envelope?.inc}`;
      if (sent.rows.get(key) !== print) {
        // Checked with the largest floor this row can ever carry (its own n; a raise never goes above it), so the answer
        // depends only on the stored row: the same on every pump, session and restart. A row that went once is never
        // refused later, and the frame sent (floor <= n) is never larger than the one checked.
        const readable = !!row.envelope && typeof row.envelope === "object" && !Array.isArray(row.envelope);
        const envelope = readable ? this.stamped(queue, row, row.envelope!) : undefined;
        if (envelope === null) return true;
        const bad = this.unsendable(envelope && { ...envelope, floor: Math.max(envelope.floor, row.slot.n) });
        if (bad) { this.settle(owner, row, bad); return true; }
        if (!session.sendWire({ t: "cmd", ...envelope } as WireMessage)) return false;
        sent.rows.set(key, print);
      }
      if (c < queue.cancels.length && queue.cancels[c]!.slot.n === row.slot.n) {
        if (!this.sendCancel(session, sent.cancels, queue.cancels[c]!.slot)) return false;
        c++;
      }
    }
    return true;
  }

  /** Why this frame (the row as it would go, floor raised) can never be sent: a fixed word, never the row's own text; null when it can. */
  private unsendable(envelope: CmdBody | undefined): string | null {
    if (!envelope) return "unreadable";
    try {
      const encoded = this.encode({ t: "cmd", ...envelope } as WireMessage);
      return encoded.ok ? null : encoded.reason;
    } catch {
      return "encoder error";
    }
  }

  /**
   * The envelope to send for `row`: as stored, unless a dead slot of its queue lies between its `floor` and its own `n`.
   * Then the owner would wait for that slot, so the floor goes above it, to the smallest slot this origin still holds
   * (rows here, and this server's own pending submits). While a slot below the dead one is unanswered the row waits
   * (null): a floor above the dead slot would make the owner skip that slot too.
   */
  private stamped(queue: OwnerQueue, row: QueuedRow, envelope: CmdBody): CmdBody | null {
    const dead = queue.holes.filter((h) => h >= envelope.floor && h < row.slot.n);
    if (dead.length === 0) return envelope;
    const top = Math.max(...dead);
    const held = new Set(queue.rows.map((r) => r.slot.n));
    if (row.slot.origin === this.options.self) {
      try { for (const n of serverOriginPending(this.options.reader(), row.slot)) held.add(n); } catch { return null; }
    }
    for (const h of queue.holes) held.delete(h);
    let floor = row.slot.n;
    for (const n of held) {
      if (n >= envelope.floor && n < top) return null;
      if (n > top && n < floor) floor = n;
    }
    return { ...envelope, floor };
  }

  /** Moves a row that can never be sent out of the queue (one commit), tells its origin, then pumps again. */
  private settle(owner: string, row: QueuedRow, reason: string): void {
    const id = `${slotKeyOf(row.slot)}\u0000${row.cmdHash}`;
    if (this.settling.has(id)) return;
    this.settling.add(id);
    this.options.submit((tx) => failRow(tx, row, reason, this.now())).then((moved) => {
      this.settling.delete(id);
      this.settleRetries.delete(owner);
      try {
        if (moved) {
          this.options.log(`forward: the command for slot ${row.slot.n} of ${JSON.stringify(row.slot.target)} to ${owner} can never be sent (${reason}); moved out of the queue and refused`);
          const inc = LogId.safeParse(row.envelope?.inc).success ? row.envelope!.inc : UNKNOWN_INC;
          const detail = `this command could not be sent to the server that owns its target (${reason})`;
          this.relay(row.slot.origin, { t: "cmd.result", slot: row.slot, outcome: { kind: "refused", reason: "invalid", detail }, logId: inc, seq: null });
        }
        this.pump(owner);
      } catch (error) {
        this.options.log(`forward: after moving an unsendable command out of the queue for ${owner}: ${errorText(error)}`);
      }
    }, (error: unknown) => {
      this.settling.delete(id);
      this.options.log(`forward: moving an unsendable command out of the queue for ${owner} failed: ${errorText(error)}`);
      this.retrySettle(owner);
    });
  }

  /** Pumps `owner` again after a failed settle, with a growing wait (250 ms up to 30 s). */
  private retrySettle(owner: string): void {
    const state = this.settleRetries.get(owner) ?? { tries: 0, timer: null };
    if (state.timer) return;
    const wait = Math.min(SETTLE_RETRY_MAX_MS, SETTLE_RETRY_MS * 2 ** state.tries);
    state.tries += 1;
    state.timer = setTimeout(() => { state.timer = null; this.pump(owner); }, wait);
    state.timer.unref?.();
    this.settleRetries.set(owner, state);
  }

  /**
   * Deletes the dead rows of `owner` that nothing needs any more (async, one commit; decided again inside it). A failed
   * read or commit leaves them: the next pump tries again, and nothing is lost by waiting.
   */
  private prune(owner: string): void {
    if (this.pruning.has(owner)) return;
    try { if (deadToPrune(this.options.reader(), owner).length === 0) return; } catch { return; }
    this.pruning.add(owner);
    this.options.submit((tx) => pruneDead(tx, owner)).then(() => { this.pruning.delete(owner); }, (error: unknown) => {
      this.pruning.delete(owner);
      this.options.log(`forward: pruning dead rows for ${owner} failed: ${errorText(error)}`);
    });
  }

  /** Pumps `owner` when a dead slot has a row above it: an answer may have freed that row (a dead row with nothing above it has nothing to free). */
  private pumpAfterAnswer(owner: string): void {
    try {
      if (!ownerHasHole(this.options.reader(), owner)) return;
    } catch { return; }
    this.pump(owner);
  }

  private sendCancel(session: ForwardSession, sent: Set<string>, slot: Slot): boolean {
    const key = slotKeyOf(slot);
    if (sent.has(key)) return true;
    if (!session.sendWire({ t: "cancel", slot } as WireMessage)) return false;
    sent.add(key);
    return true;
  }

  private async answer(session: ForwardSession, peer: string, message: Answer): Promise<void> {
    const slot = message.slot;
    const sent = this.sent.get(session);
    const forget = (s: Slot) => { const key = slotKeyOf(s); sent?.rows.delete(key); sent?.cancels.delete(key); };
    if (message.t === "cmd.result") {
      // D50: never take an outcome of an incarnation this server knows was retired (a late or cached copy).
      if (isRetired(this.options.reader(), slot.target, message.logId)) { this.options.log(`forward: a cmd.result for slot ${slot.n} of ${slot.target} names a retired logId; dropped`); return; }
      const taken = await this.options.submit((tx) => takeResult(tx, slot, peer));
      forget(slot);
      if (taken.row || taken.cancel || this.ownerOf(slot.target) === peer) this.relay(slot.origin, message);
      this.pumpAfterAnswer(peer);
      return;
    }
    if (message.t === "cancel.noted") {
      await this.options.submit((tx) => takeNoted(tx, slot, peer));
      sent?.cancels.delete(slotKeyOf(slot));
      if (this.ownerOf(slot.target) === peer) this.relay(slot.origin, message);
      return;
    }
    const gone = await this.options.submit((tx) => takeRetry(tx, slot, peer));
    forget(slot);
    for (const s of gone) {
      forget(s);
      this.relay(s.origin, { t: "cmd.retry", slot: s, inc: message.inc });
    }
    this.pumpAfterAnswer(peer);
  }

  private refusedRevoked(slot: Slot, inc: CmdBody["inc"]): MessageOf<"cmd.result"> {
    return { t: "cmd.result", slot, outcome: { kind: "refused", reason: "revoked", detail: "the target server was removed from the roster" }, logId: inc, seq: null };
  }

  private relay(origin: string, message: Message): void {
    for (const sink of this.sinks.get(origin) ?? []) {
      try { sink(message); } catch (error) { this.options.log(`forward: relaying ${message.t} failed: ${errorText(error)}`); }
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
