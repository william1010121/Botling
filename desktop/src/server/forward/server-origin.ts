// A server acting as its own command origin (M5-04a, protocol v1 §11.1–§11.4, D30, D49, D58): call-ins, main bot,
// and any cross-server act this server originates itself.
//
// - `submit(target, cmd)` allocates `n` from `myorigins (target, originEpoch, nextN)` and commits the `forwardq` row in
//   one writer transaction, with `floor` = the smallest `n` still unresolved for `(originEpoch, target)` and `inc` = this
//   server's copy of `srv:<owner>` (`tableLogId`). Targets this server owns (`ownerOf === null`) throw TypeError. If the
//   owner is already revoked in the roster (`isRevoked`), it ends immediately with `refused{revoked}` without queueing.
// - Outcomes arrive from `Forwarder.attach(self, ...)`: kept in memory for `outcome(slot)` and delivered to listeners.
// - `slot conflict` (§11.4, D30): allocates a new `originEpoch` (once per conflict wave), moves the refused item to
//   `(newEpoch, nextN)`, commits + pumps it, and forwards the final outcome under the original `submit()` slot too.
// - `cmd.retry{slot, inc}` (D49): `Forwarder` already dropped the row from `forwardq` and relayed the retry; this class
//   keeps unresolved submits in `meta` (`serverOrigin:...`) and re-commits the slot with `inc` once this server's copy
//   of `srv:<owner>` reaches `inc` (including across restarts). A retry naming a retired `logId` (or an orphaned `meta`
//   entry whose `forwardq` row was lost in a crash window) reconciles under the current `tableLogId`.
import { randomBytes } from "node:crypto";
import type { Command } from "../../contract";
import { slotKey, type CmdBody, type LogId, type Message, type Outcome, type Scope, type Slot, type Target, type WireMessage } from "../../protocol";
import { tableLogId } from "../replica/tables";
import { statedScope } from "../session/remote-reads";
import { cmdHash } from "../slots";
import type { Db } from "../store";
import { commitRow, isRetired } from "./forward-queue";
import type { Forwarder } from "./forwarder";

const META_PREFIX = "serverOrigin:";
const UNKNOWN_INC = "unknown0" as LogId;
const OUTCOME_LIMIT = 10_000;
const REVOKED_OUTCOME: Outcome = { kind: "refused", reason: "revoked", detail: "the target server was removed from the roster" };

interface PendingSubmit {
  slot: Slot;
  owner: string;
  cmd: Command;
  scope: Scope;
  retryInc?: LogId;
  /** Original slot returned by `submit()` before any `slot conflict` epoch move (§11.4). */
  originSlot?: Slot;
}

export interface ServerOriginOptions {
  /** This server's roster `memberId` (never a legacy `serverId`), used as `slot.origin` and to attach to `forwarder`. */
  self: string;
  submit<T>(command: (tx: Db) => T): Promise<T>;
  reader(): Db;
  forwarder: Pick<Forwarder, "ownerOf" | "pump" | "attach">;
  /** True when a peer server is no longer valid in the roster (§4.6). */
  isRevoked?(owner: string): boolean;
  /** Subscribes to a peer `srv:<owner>` stream so pending `cmd.retry` items wake as soon as `reset` lands. */
  subscribeTable?: (stream: string, sink: (frame: WireMessage) => boolean) => { close(): void };
  log?: (line: string) => void;
  now?: () => number;
}

function pendingKey(slot: Pick<Slot, "originEpoch" | "target" | "n">): string {
  return `${META_PREFIX}${slot.originEpoch}:${slot.target}:${slot.n}`;
}

function compareEntries(a: PendingSubmit, b: PendingSubmit): number {
  if (a.slot.originEpoch !== b.slot.originEpoch) return a.slot.originEpoch < b.slot.originEpoch ? -1 : 1;
  if (a.slot.target !== b.slot.target) return a.slot.target < b.slot.target ? -1 : 1;
  return a.slot.n - b.slot.n;
}

export class ServerOrigin {
  private readonly pending = new Map<string, PendingSubmit>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly resolving = new Set<string>();
  private readonly listeners = new Set<(slot: Slot, outcome: Outcome) => void>();
  private readonly watches = new Map<string, { close(): void }>();
  private readonly detach: () => void;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private work: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: ServerOriginOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.detach = options.forwarder.attach(options.self, (message) => {
      this.onRelay(message);
      return !this.closed;
    });
    this.loadPending();
  }

  /** Submits `cmd` for `target` (must be owned by a peer server) with this server as origin. */
  async submit(target: Target, cmd: Command): Promise<Slot> {
    const ownerCheck = this.options.forwarder.ownerOf(target);
    if (ownerCheck === null) {
      throw new TypeError(`server-origin: cannot submit to ${target} (owned by this server or no peer owns it)`);
    }
    const committed = await this.options.submit((tx) => {
      const owner = this.options.forwarder.ownerOf(target);
      if (owner === null) {
        throw new TypeError(`server-origin: cannot submit to ${target} (owned by this server or no peer owns it)`);
      }
      const existing = tx.prepare("SELECT originEpoch, nextN FROM myorigins WHERE target = ?").get(target);
      let originEpoch: string;
      let n: number;
      if (existing) {
        originEpoch = String(existing.originEpoch);
        n = Number(existing.nextN);
        tx.prepare("UPDATE myorigins SET nextN = ? WHERE target = ?").run(n + 1, target);
      } else {
        originEpoch = randomBytes(16).toString("hex");
        n = 1;
        tx.prepare("INSERT INTO myorigins (target, originEpoch, nextN) VALUES (?, ?, ?)").run(target, originEpoch, 2);
      }
      const slot: Slot = { origin: this.options.self, originEpoch, target, n };
      if (this.options.isRevoked?.(owner)) {
        return { slot, owner, record: null as PendingSubmit | null };
      }
      const floor = this.computeFloor(tx, originEpoch, target, n);
      const inc = tableLogId(tx, `srv:${owner}`) ?? UNKNOWN_INC;
      const scope = statedScope(cmd);
      const envelope = { slot, floor, inc, cmd, scope } as CmdBody;
      const hash = cmdHash({ cmd, scope });
      const record: PendingSubmit = { slot, owner, cmd, scope };
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(pendingKey(slot), JSON.stringify(record));
      commitRow(tx, envelope, hash, owner, this.now());
      return { slot, owner, record };
    });
    if (!committed.record) {
      this.recordAndNotify(committed.slot, REVOKED_OUTCOME);
      return committed.slot;
    }
    this.pending.set(slotKey(committed.slot), committed.record);
    this.options.forwarder.pump(committed.owner);
    return committed.slot;
  }

  /** The outcome heard for `slot` in this process lifetime, or null while unresolved/unknown. */
  outcome(slot: Slot): Outcome | null {
    return this.outcomes.get(slotKey(slot)) ?? null;
  }

  /** Subscribes to outcomes for slots originated by this server; returns an unsubscribe function. */
  on(listener: (slot: Slot, outcome: Outcome) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-checks any pending `cmd.retry` items for `owner` against this server's copy of `srv:<owner>`. */
  syncTable(owner: string): Promise<void> {
    return this.enqueue(() => this.recommitReady(owner));
  }

  /** Ends every pending command targeting any of `owners` with `refused{revoked}` and notifies listeners (§4.6). */
  revoked(owners: readonly string[]): Promise<void> {
    const list = [...new Set(owners)].filter(Boolean);
    if (list.length === 0) return Promise.resolve();
    return this.enqueue(() => this.failRevokedOwners(list));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detach();
    for (const watch of this.watches.values()) watch.close();
    this.watches.clear();
  }

  private loadPending(): void {
    const db = this.options.reader();
    const retryOwners = new Set<string>();
    for (const row of db.prepare("SELECT value FROM meta WHERE key LIKE ?").all(`${META_PREFIX}%`)) {
      try {
        const record = JSON.parse(String(row.value)) as PendingSubmit;
        if (!record?.slot || !record.owner) continue;
        this.pending.set(slotKey(record.slot), record);
        if (record.retryInc && !this.options.isRevoked?.(record.owner)) retryOwners.add(record.owner);
      } catch {
        // Ignore malformed entries rather than blocking startup.
      }
    }
    for (const owner of retryOwners) this.ensureTableWatch(owner);
    if (this.pending.size > 0) void this.enqueue(() => this.reconcileOnStart());
  }

  private async reconcileOnStart(): Promise<void> {
    if (this.closed || this.pending.size === 0) return;
    const revokedOwners = new Set<string>();
    for (const entry of this.pending.values()) {
      if (this.options.isRevoked?.(entry.owner)) revokedOwners.add(entry.owner);
    }
    if (revokedOwners.size > 0) await this.failRevokedOwners([...revokedOwners]);

    const db = this.options.reader();
    const unheldByOwner = new Map<string, PendingSubmit[]>();
    const retryOwners = new Set<string>();
    for (const entry of this.pending.values()) {
      const stream = `srv:${entry.owner}`;
      if (entry.retryInc && !isRetired(db, stream, entry.retryInc)) {
        retryOwners.add(entry.owner);
        continue;
      }
      if (!entry.retryInc) {
        const held = db
          .prepare("SELECT 1 FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ?")
          .get(entry.slot.origin, entry.slot.originEpoch, entry.slot.target, entry.slot.n);
        if (held) continue;
      }
      let list = unheldByOwner.get(entry.owner);
      if (!list) unheldByOwner.set(entry.owner, (list = []));
      list.push(entry);
    }
    for (const [owner, entries] of unheldByOwner) await this.recommitUnheld(owner, entries);
    for (const owner of retryOwners) await this.recommitReady(owner);
  }

  private computeFloor(tx: Db, originEpoch: string, target: Target, currentN: number): number {
    let floor = currentN;
    const fq = tx
      .prepare("SELECT MIN(n) AS minN FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ?")
      .get(this.options.self, originEpoch, target);
    if (fq?.minN != null) floor = Math.min(floor, Number(fq.minN));
    for (const row of tx.prepare("SELECT value FROM meta WHERE key LIKE ?").all(`${META_PREFIX}${originEpoch}:%`)) {
      try {
        const entry = JSON.parse(String(row.value)) as PendingSubmit;
        if (entry?.slot?.originEpoch === originEpoch && entry.slot.target === target) {
          floor = Math.min(floor, Number(entry.slot.n));
        }
      } catch {
        // Ignore malformed entries.
      }
    }
    return floor;
  }

  private onRelay(message: Message): void {
    if (this.closed) return;
    if (message.t === "cmd.result") {
      const key = slotKey(message.slot);
      if (this.outcomes.has(key) || this.resolving.has(key)) return;
      this.resolving.add(key);
      void this.enqueue(() => this.handleResult(message.slot, message.outcome));
      return;
    }
    if (message.t === "cmd.retry") {
      void this.enqueue(() => this.handleRetry(message.slot, message.inc));
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.work.then(async () => {
      if (this.closed) return;
      await task();
    }, async () => {
      if (this.closed) return;
      await task();
    });
    this.work = next.catch((error) => {
      this.log(`server-origin: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.work;
  }

  private async handleResult(slot: Slot, outcome: Outcome): Promise<void> {
    const key = slotKey(slot);
    if (this.outcomes.has(key)) {
      this.resolving.delete(key);
      return;
    }
    const existing = this.pending.get(key);
    // Every unresolved slot has a durable meta entry loaded into `pending`; a result for a slot not there is a
    // duplicate (e.g. a second copy of a slot conflict after the slot moved to a new epoch): drop it (N1).
    if (!existing) {
      this.resolving.delete(key);
      return;
    }
    const isConflict = outcome.kind === "refused" && outcome.reason === "slot conflict";
    if (isConflict && existing) {
      if (this.options.isRevoked?.(existing.owner)) {
        this.resolving.delete(key);
        await this.failRevokedOwners([existing.owner]);
        return;
      }
      try {
        const moved = await this.options.submit((tx) => {
          if (!tx.prepare("SELECT 1 FROM meta WHERE key = ?").get(pendingKey(slot))) return null;
          const cur = tx.prepare("SELECT originEpoch, nextN FROM myorigins WHERE target = ?").get(slot.target);
          let newEpoch: string;
          let newN: number;
          if (!cur || String(cur.originEpoch) === slot.originEpoch) {
            newEpoch = randomBytes(16).toString("hex");
            newN = 1;
            tx.prepare("INSERT INTO myorigins (target, originEpoch, nextN) VALUES (?, ?, ?) ON CONFLICT (target) DO UPDATE SET originEpoch = excluded.originEpoch, nextN = excluded.nextN")
              .run(slot.target, newEpoch, 2);
          } else {
            newEpoch = String(cur.originEpoch);
            newN = Number(cur.nextN);
            tx.prepare("UPDATE myorigins SET nextN = ? WHERE target = ?").run(newN + 1, slot.target);
          }
          const movedSlot: Slot = { origin: this.options.self, originEpoch: newEpoch, target: slot.target, n: newN };
          const originSlot = existing.originSlot ?? existing.slot;
          const floor = this.computeFloor(tx, newEpoch, slot.target, newN);
          const inc = tableLogId(tx, `srv:${existing.owner}`) ?? UNKNOWN_INC;
          const movedRecord: PendingSubmit = {
            slot: movedSlot,
            owner: existing.owner,
            cmd: existing.cmd,
            scope: existing.scope,
            originSlot,
          };
          tx.prepare("DELETE FROM meta WHERE key = ?").run(pendingKey(slot));
          tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .run(pendingKey(movedSlot), JSON.stringify(movedRecord));
          const envelope = { slot: movedSlot, floor, inc, cmd: existing.cmd, scope: existing.scope } as CmdBody;
          const hash = cmdHash({ cmd: existing.cmd, scope: existing.scope });
          commitRow(tx, envelope, hash, existing.owner, this.now());
          return { movedSlot, movedRecord };
        });
        this.pending.delete(key);
        if (moved) {
          this.pending.set(slotKey(moved.movedSlot), moved.movedRecord);
          this.log(`server-origin: slot conflict on ${slot.target} (epoch ${slot.originEpoch}, n ${slot.n}); re-sending under epoch ${moved.movedSlot.originEpoch} n ${moved.movedSlot.n}`);
          this.maybeCloseWatch(existing.owner);
          this.options.forwarder.pump(existing.owner);
        }
      } finally {
        this.resolving.delete(key);
      }
      return;
    }
    try {
      await this.options.submit((tx) => {
        tx.prepare("DELETE FROM meta WHERE key = ?").run(pendingKey(slot));
        if (isConflict) {
          tx.prepare("DELETE FROM myorigins WHERE target = ? AND originEpoch = ?").run(slot.target, slot.originEpoch);
        }
      });
    } finally {
      this.resolving.delete(key);
    }
    if (isConflict) {
      this.log(`server-origin: slot conflict on ${slot.target} (epoch ${slot.originEpoch}, n ${slot.n}); next submit starts a new epoch`);
    }
    this.pending.delete(key);
    if (existing) this.maybeCloseWatch(existing.owner);
    this.recordAndNotify(slot, outcome, existing?.originSlot);
  }

  private async handleRetry(slot: Slot, inc: LogId): Promise<void> {
    const key = slotKey(slot);
    if (this.outcomes.has(key)) return;
    const entry = this.pending.get(key);
    if (!entry) return;
    if (this.options.isRevoked?.(entry.owner)) {
      await this.failRevokedOwners([entry.owner]);
      return;
    }
    const db = this.options.reader();
    const stream = `srv:${entry.owner}`;
    if (isRetired(db, stream, inc)) {
      await this.recommitUnheld(entry.owner, [entry]);
      return;
    }
    if (tableLogId(db, stream) === inc) {
      await this.recommitEntries(entry.owner, inc, [entry]);
      return;
    }
    const updated: PendingSubmit = { ...entry, retryInc: inc };
    await this.options.submit((tx) => {
      if (!tx.prepare("SELECT 1 FROM meta WHERE key = ?").get(pendingKey(slot))) return;
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(pendingKey(slot), JSON.stringify(updated));
    });
    if (this.pending.has(key)) this.pending.set(key, updated);
    this.ensureTableWatch(entry.owner);
    await this.recommitReady(entry.owner);
  }

  private async recommitReady(owner: string): Promise<void> {
    if (this.options.isRevoked?.(owner)) {
      await this.failRevokedOwners([owner]);
      return;
    }
    const currentInc = tableLogId(this.options.reader(), `srv:${owner}`);
    if (!currentInc) return;
    const matching = [...this.pending.values()]
      .filter((entry) => entry.owner === owner && entry.retryInc === currentInc)
      .sort(compareEntries);
    if (matching.length === 0) {
      this.maybeCloseWatch(owner);
      return;
    }
    await this.recommitEntries(owner, currentInc, matching);
  }

  private async recommitEntries(owner: string, inc: LogId, entries: readonly PendingSubmit[]): Promise<void> {
    if (this.options.isRevoked?.(owner)) {
      await this.failRevokedOwners([owner]);
      return;
    }
    const committed: PendingSubmit[] = [];
    const didCommit = await this.options.submit((tx) => {
      const txInc = tableLogId(tx, `srv:${owner}`);
      if (txInc !== inc) return false;
      for (const entry of entries) {
        const key = slotKey(entry.slot);
        if (!this.pending.has(key)) continue;
        const floor = this.computeFloor(tx, entry.slot.originEpoch, entry.slot.target, entry.slot.n);
        const envelope = { slot: entry.slot, floor, inc, cmd: entry.cmd, scope: entry.scope } as CmdBody;
        const hash = cmdHash({ cmd: entry.cmd, scope: entry.scope });
        commitRow(tx, envelope, hash, owner, this.now());
        const cleared: PendingSubmit = {
          slot: entry.slot,
          owner: entry.owner,
          cmd: entry.cmd,
          scope: entry.scope,
          ...(entry.originSlot ? { originSlot: entry.originSlot } : {}),
        };
        tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
          .run(pendingKey(entry.slot), JSON.stringify(cleared));
        committed.push(cleared);
      }
      return committed.length > 0;
    });
    for (const entry of committed) {
      const key = slotKey(entry.slot);
      if (this.pending.has(key)) this.pending.set(key, entry);
    }
    this.maybeCloseWatch(owner);
    if (didCommit) this.options.forwarder.pump(owner);
  }

  private async recommitUnheld(owner: string, entries: readonly PendingSubmit[]): Promise<void> {
    if (this.options.isRevoked?.(owner)) {
      await this.failRevokedOwners([owner]);
      return;
    }
    const sorted = [...entries].sort(compareEntries);
    const updated: PendingSubmit[] = [];
    const didCommit = await this.options.submit((tx) => {
      const inc = tableLogId(tx, `srv:${owner}`) ?? UNKNOWN_INC;
      let any = false;
      for (const entry of sorted) {
        const key = slotKey(entry.slot);
        if (!this.pending.has(key)) continue;
        const floor = this.computeFloor(tx, entry.slot.originEpoch, entry.slot.target, entry.slot.n);
        const envelope = { slot: entry.slot, floor, inc, cmd: entry.cmd, scope: entry.scope } as CmdBody;
        const hash = cmdHash({ cmd: entry.cmd, scope: entry.scope });
        commitRow(tx, envelope, hash, owner, this.now());
        any = true;
        if (entry.retryInc !== undefined) {
          const cleared: PendingSubmit = {
            slot: entry.slot,
            owner: entry.owner,
            cmd: entry.cmd,
            scope: entry.scope,
            ...(entry.originSlot ? { originSlot: entry.originSlot } : {}),
          };
          tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .run(pendingKey(entry.slot), JSON.stringify(cleared));
          updated.push(cleared);
        }
      }
      return any;
    });
    for (const entry of updated) {
      const key = slotKey(entry.slot);
      if (this.pending.has(key)) this.pending.set(key, entry);
    }
    this.maybeCloseWatch(owner);
    if (didCommit) this.options.forwarder.pump(owner);
  }

  private async failRevokedOwners(owners: readonly string[]): Promise<void> {
    const ownerSet = new Set(owners);
    const targets = [...this.pending.values()].filter((entry) => ownerSet.has(entry.owner)).sort(compareEntries);
    for (const owner of ownerSet) {
      const watch = this.watches.get(owner);
      if (watch) {
        this.watches.delete(owner);
        watch.close();
      }
    }
    if (targets.length === 0) return;
    await this.options.submit((tx) => {
      const delMeta = tx.prepare("DELETE FROM meta WHERE key = ?");
      const delFq = tx.prepare("DELETE FROM forwardq WHERE origin = ? AND originEpoch = ? AND target = ? AND n = ? AND owner = ?");
      for (const entry of targets) {
        delMeta.run(pendingKey(entry.slot));
        delFq.run(entry.slot.origin, entry.slot.originEpoch, entry.slot.target, entry.slot.n, entry.owner);
      }
    });
    for (const entry of targets) {
      const key = slotKey(entry.slot);
      this.pending.delete(key);
      if (this.outcomes.has(key)) continue;
      this.recordAndNotify(entry.slot, REVOKED_OUTCOME, entry.originSlot);
    }
  }

  private ensureTableWatch(owner: string): void {
    if (this.closed || this.watches.has(owner) || !this.options.subscribeTable || this.options.isRevoked?.(owner)) return;
    const stream = `srv:${owner}`;
    const sub = this.options.subscribeTable(stream, () => {
      if (this.closed) return false;
      if (this.hasMatchingRetry(owner)) void this.syncTable(owner);
      return !this.closed;
    });
    this.watches.set(owner, sub);
  }

  private hasMatchingRetry(owner: string): boolean {
    const inc = tableLogId(this.options.reader(), `srv:${owner}`);
    if (!inc) return false;
    for (const entry of this.pending.values()) {
      if (entry.owner === owner && entry.retryInc === inc) return true;
    }
    return false;
  }

  private maybeCloseWatch(owner: string): void {
    for (const entry of this.pending.values()) {
      if (entry.owner === owner && entry.retryInc !== undefined) return;
    }
    const watch = this.watches.get(owner);
    if (watch) {
      this.watches.delete(owner);
      watch.close();
    }
  }

  private recordAndNotify(slot: Slot, outcome: Outcome, originSlot?: Slot): void {
    this.rememberOutcome(slotKey(slot), outcome);
    if (originSlot) this.rememberOutcome(slotKey(originSlot), outcome);
    const notifySlot = originSlot ?? slot;
    for (const listener of [...this.listeners]) {
      try {
        listener(notifySlot, outcome);
      } catch (error) {
        this.log(`server-origin: listener error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private rememberOutcome(key: string, outcome: Outcome): void {
    if (this.outcomes.size >= OUTCOME_LIMIT) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest !== undefined) this.outcomes.delete(oldest);
    }
    this.outcomes.set(key, outcome);
  }
}
