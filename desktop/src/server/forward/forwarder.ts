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
//
// It never answers a command with an outcome of its own (F3): no refusal, no scope or grant check (only the owner's
// decision counts); the front end hears `held`, then the owner's answer. Who owns what is directory.ts.
import { queueKey, type CmdBody, type Message, type MessageOf, type Slot, type WireMessage } from "../../protocol";
import type { Db } from "../store";
import { cmdHash } from "../slots";
import { commitCancel, commitRow, isRetired, ownerWork, queueStats, takeNoted, takeResult, takeRetry } from "./forward-queue";
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
  log(line: string): void;
  now?: () => number;
}

/** Where a front end session of an origin hears relayed answers. */
export type RelaySink = (message: Message) => boolean;

type Answer = MessageOf<"cmd.result"> | MessageOf<"cmd.retry"> | MessageOf<"cancel.noted">;

const slotKeyOf = (slot: Slot) => `${queueKey(slot)}\u0000${slot.n}`;

export class Forwarder {
  /** Per live session: what it carried, slot key → the copy's fingerprint (rows) or "c" (cancels). */
  private readonly sent = new WeakMap<ForwardSession, { rows: Map<string, string>; cancels: Set<string> }>();
  private readonly sinks = new Map<string, Set<RelaySink>>();
  private readonly now: () => number;

  constructor(private readonly options: ForwarderOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The peer that owns `target`, or null when this server decides it. */
  ownerOf(target: string): string | null {
    return this.options.directory.peerOwner(target);
  }

  /** Commits a front end's command for `owner` (resolves after the commit: only then may `held` go), then sends it. */
  async commit(envelope: CmdBody, owner: string): Promise<void> {
    if (!envelope.scope) throw new TypeError("forward: the accepting server states the scope before it forwards");
    const hash = cmdHash({ cmd: envelope.cmd, scope: envelope.scope, basis: envelope.basis, via: envelope.via });
    await this.options.submit((tx) => commitRow(tx, envelope, hash, owner, this.now()));
    this.pump(owner);
  }

  /** Commits a front end's cancel for `owner`, then sends it (after its row). */
  async cancel(slot: Slot, owner: string): Promise<void> {
    await this.options.submit((tx) => commitCancel(tx, slot, owner, this.now()));
    this.pump(owner);
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
   * reads the committed queue and writes frames in one turn, so nothing interleaves.
   */
  pump(owner: string): void {
    const session = this.options.session(owner);
    if (!session || session.state !== "open") return;
    let sent = this.sent.get(session);
    if (!sent) this.sent.set(session, (sent = { rows: new Map(), cancels: new Set() }));
    let work;
    try { work = ownerWork(this.options.reader(), owner); } catch (error) { this.options.log(`forward: reading the queue for ${owner} failed: ${errorText(error)}`); return; }
    for (const queue of work.queues) {
      let c = 0;
      for (let r = 0; r <= queue.rows.length; r++) {
        const row = queue.rows[r];
        // A slot's cancel goes right after its own row; a cancel whose row is not here goes at its place in slot order.
        while (c < queue.cancels.length && (!row || queue.cancels[c]!.slot.n < row.slot.n)) {
          if (!this.sendCancel(session, sent.cancels, queue.cancels[c]!.slot)) return;
          c++;
        }
        if (!row) break;
        const key = slotKeyOf(row.slot);
        const print = `${row.cmdHash}\u0000${row.envelope.inc}`;
        if (sent.rows.get(key) !== print) {
          if (!session.sendWire({ t: "cmd", ...row.envelope } as WireMessage)) return;
          sent.rows.set(key, print);
        }
        if (c < queue.cancels.length && queue.cancels[c]!.slot.n === row.slot.n) {
          if (!this.sendCancel(session, sent.cancels, queue.cancels[c]!.slot)) return;
          c++;
        }
      }
    }
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
