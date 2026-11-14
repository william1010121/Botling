// Test harness for src/fe-link: a fake socket network and a fake Botling 3 server built on the real slot rules
// (src/server/slots SlotEngine over an in-memory server.db), a log kept in memory with a hash chain, and a fake clock.
// Every frame crosses the fake network as text and is checked with the protocol's frame codec in both directions.
import { createHash } from "node:crypto";
import {
  decodeFrame, encodeFrame, GENESIS_HASH,
  type CmdBody, type Cursor, type Entry, type Message, type MessageOf, type Slot, type StreamId,
} from "../../src/protocol";
import { cancelAnswer, SlotEngine, type ApplyContext, type SlotLog } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import type { Clock, Dial, FeSocket, SocketHandlers } from "../../src/fe-link";
import { FakeLog, memoryStore } from "./server-slots-harness";

export const SERVER_ID = "srv1";
export const SRV_STREAM = `srv:${SERVER_ID}` as StreamId;
export const BOT = "bot:b1" as StreamId;

/** A fake clock: timers run only when the test advances time. */
export class FakeClock implements Clock {
  private t = 1_000_000;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void { this.tasks.delete(handle as number); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.t = Math.max(this.t, due[1].at);
      due[1].fn();
    }
    this.t = end;
  }
}

/** Lets queued promises, microtasks and the writer's commits run. */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

class MemLog extends FakeLog {
  readonly entries = new Map<string, Entry[]>();
  readonly retired = new Map<string, Array<{ logId: string; keptSeq: number }>>();

  override appendEntry(tx: Db, stream: StreamId, kind: string, body: Record<string, unknown>, slot?: Slot): Cursor {
    const at = super.appendEntry(tx, stream, kind, body, slot);
    const list = this.entries.get(stream) ?? [];
    const prev = list.length ? list[list.length - 1].hash : GENESIS_HASH;
    const content = { stream, logId: at.logId, seq: at.seq, hlc: { ms: at.seq, c: 0 }, kind, body, ...(slot ? { slot } : {}) };
    list.push({ ...content, hash: createHash("sha256").update(`${prev}\n${JSON.stringify(content)}`).digest("hex") } as Entry);
    this.entries.set(stream, list);
    return at;
  }

  head(stream: string): { seq: number; hash: string } {
    const list = this.entries.get(stream) ?? [];
    return list.length ? { seq: list[list.length - 1].seq, hash: list[list.length - 1].hash } : { seq: 0, hash: GENESIS_HASH };
  }

  current(stream: string): string {
    return stream === SRV_STREAM ? this.inc : this.logId(null as unknown as Db, stream as StreamId);
  }

  override restore(): void {
    const bump = (id: string) => id.replace(/-(\d+)$/, (_m, k: string) => `-${String(Number(k) + 1).padStart(k.length, "0")}`);
    this.inc = bump(this.inc);
    for (const [stream, id] of this.logIds) this.logIds.set(stream, bump(id));
  }

  /** A restore: every stream gets a new logId; `keptSeq` is what the restore kept of each (default: the head). */
  restoreAll(keptSeq?: number): void {
    const streams = new Set<string>([SRV_STREAM, ...this.entries.keys(), ...this.logIds.keys()]);
    const old = new Map([...streams].map((s) => [s, this.current(s)]));
    this.restore();
    for (const stream of streams) {
      const list = this.retired.get(stream) ?? [];
      list.push({ logId: old.get(stream)!, keptSeq: keptSeq ?? this.head(stream).seq });
      this.retired.set(stream, list);
    }
  }
}

interface ServerConn {
  handlers: SocketHandlers;
  open: boolean;
  welcomed: boolean;
  subs: Map<string, { sent: number }>;
  feSocket: FeSocket;
}

/** A fake botlingd: hello/welcome, sub (snap, batches, reset), cmd through the real SlotEngine, live frames. */
export class FakeServer {
  readonly log = new MemLog();
  readonly db: Db;
  readonly engine: SlotEngine;
  readonly applied: Array<{ slot: Slot; cmd: unknown }> = [];
  /** Every `cmd` copy that reached the server, in order. */
  readonly copies: CmdBody[] = [];
  /** Every frame the server got (decoded). */
  readonly received: Message[] = [];
  minFeVersion = "3.0.0";
  /** Drop the next n replies to `cmd` (cmd.result / cmd.retry) on the wire. */
  dropReplies = 0;
  /** Do not send resets yet (a restore the front end has not heard of). */
  holdResets = false;
  refuse = false;
  /** The `view` of a snap (default `{}`). */
  snapView: (stream: string) => Record<string, unknown> = () => ({});
  /** The apply step (default: records the command and answers `{ n }`). */
  applyHook: ((context: ApplyContext) => { result?: unknown } | void) | null = null;
  /** Messages the fake does not handle itself (req, history, shell.done…). */
  onMessage: ((message: Message) => void) | null = null;
  private conn: ServerConn | null = null;
  private readonly heldResets: Array<() => void> = [];

  constructor() {
    const { db, writer } = memoryStore();
    this.db = db;
    this.engine = new SlotEngine({
      submit: (command) => writer.submit(command),
      log: this.log as SlotLog,
      apply: (context) => {
        this.applied.push({ slot: context.slot, cmd: context.cmd });
        return this.applyHook ? this.applyHook(context) : { result: { n: context.slot.n } };
      },
    });
  }

  get connected(): boolean { return !!this.conn?.open; }

  /** The fake network's dial. */
  readonly dial: Dial = (handlers) => {
    const conn: ServerConn = {
      handlers, open: false, welcomed: false, subs: new Map(),
      feSocket: {
        send: (frame) => { setImmediate(() => { if (this.conn === conn && conn.open) void this.onFrame(conn, frame); }); },
        close: () => { if (this.conn === conn) { conn.open = false; this.conn = null; } },
      },
    };
    if (this.refuse) {
      setImmediate(() => handlers.close("refused"));
      return conn.feSocket;
    }
    if (this.conn) this.kill();
    this.conn = conn;
    setImmediate(() => { if (this.conn === conn) { conn.open = true; handlers.open(); } });
    return conn.feSocket;
  };

  /** The connection drops (both sides see it). */
  kill(): void {
    const conn = this.conn;
    if (!conn) return;
    this.conn = null;
    conn.open = false;
    setImmediate(() => conn.handlers.close("killed"));
  }

  send(message: Message): void {
    const conn = this.conn;
    if (!conn?.open) return;
    const encoded = encodeFrame(message, "server", { local: true });
    if (!encoded.ok) throw new Error(`fake server: cannot send ${message.t}: ${encoded.detail}`);
    setImmediate(() => { if (this.conn === conn && conn.open) conn.handlers.frame(encoded.text); });
  }

  /** A restore (§7.6): new logIds everywhere; the front end hears `reset` + `snap` on each followed stream. */
  restore(keptSeq?: number): void {
    this.log.restoreAll(keptSeq);
    const conn = this.conn;
    if (!conn) return;
    for (const stream of conn.subs.keys()) {
      const deliver = () => { if (this.conn === conn) this.resetAndSnap(conn, stream); };
      if (this.holdResets) this.heldResets.push(deliver); else deliver();
    }
  }

  releaseResets(): void {
    for (const deliver of this.heldResets.splice(0)) deliver();
  }

  /** Appends an entry outside any command (a bot's reply, a turn) and sends it to followers. */
  append(stream: string, kind: string, body: Record<string, unknown>, slot?: Slot): void {
    this.log.appendEntry(this.db, stream as StreamId, kind, body, slot);
    this.push();
  }

  /** Entries of a stream as the server holds them. */
  entries(stream: string): Entry[] { return this.log.entries.get(stream) ?? []; }

  private async onFrame(conn: ServerConn, frame: string): Promise<void> {
    const decoded = decodeFrame(frame, "fe", { local: true });
    if (!decoded.ok) throw new Error(`fake server: bad frame from the front end: ${decoded.detail}`);
    const message = decoded.message;
    this.received.push(message);
    switch (message.t) {
      case "hello":
        conn.welcomed = true;
        this.send({ t: "welcome", serverId: SERVER_ID, protocol: { min: 1, max: 1 }, minFeVersion: this.minFeVersion, rosterDigest: null, servers: [], next: {}, views: {} });
        return;
      case "sub": this.onSub(conn, message.stream, message.cursor); return;
      case "unsub": conn.subs.delete(message.stream); return;
      case "cmd": {
        const { t: _t, ...body } = message;
        this.copies.push(body as CmdBody);
        await this.engine.receive(body as CmdBody, {
          scope: "local",
          reply: (reply) => { if (this.dropReplies > 0) { this.dropReplies -= 1; return; } this.send(reply); },
        });
        this.push();
        return;
      }
      // D59: every cancel is answered (the stored cmd.result when too late, else cancel.noted), as botlingd does.
      case "cancel": this.send(cancelAnswer(message.slot, await this.engine.cancel(message.slot))); this.push(); return;
      default: this.onMessage?.(message); return;
    }
  }

  private onSub(conn: ServerConn, stream: string, cursor: Cursor | null): void {
    const current = this.log.current(stream);
    const head = this.log.head(stream);
    if (cursor === null) return this.snap(conn, stream);
    if (cursor.logId !== current) return this.resetAndSnap(conn, stream);
    conn.subs.set(stream, { sent: Math.min(cursor.seq, head.seq) });
    this.push();
  }

  private snap(conn: ServerConn, stream: string): void {
    const head = this.log.head(stream);
    conn.subs.set(stream, { sent: head.seq });
    this.send({ t: "snap", stream: stream as StreamId, logId: this.log.current(stream), seq: head.seq, hash: head.hash, view: this.snapView(stream) });
  }

  private resetAndSnap(conn: ServerConn, stream: string): void {
    const retired = this.log.retired.get(stream) ?? [];
    if (retired.length) this.send({ t: "reset", stream: stream as StreamId, logId: this.log.current(stream), retired, reason: "restored" });
    this.snap(conn, stream);
  }

  /** Sends every followed stream's new entries of the current logId. */
  push(): void {
    const conn = this.conn;
    if (!conn?.open) return;
    for (const [stream, sub] of conn.subs) {
      const current = this.log.current(stream);
      const fresh = this.entries(stream).filter((entry) => entry.seq > sub.sent && entry.logId === current);
      if (!fresh.length) continue;
      const prev = this.entries(stream).find((entry) => entry.seq === fresh[0].seq - 1)?.hash ?? GENESIS_HASH;
      sub.sent = fresh[fresh.length - 1].seq;
      this.send({ t: "batch", stream: stream as StreamId, logId: current, from: fresh[0].seq, to: sub.sent, prevHash: prev, entries: fresh, more: false });
    }
  }

  /** A raw batch (for drop tests). */
  batchOf(stream: string, entries: Entry[], prevHash: string): MessageOf<"batch"> {
    return { t: "batch", stream: stream as StreamId, logId: entries[0].logId, from: entries[0].seq, to: entries[entries.length - 1].seq, prevHash, entries, more: false };
  }
}

/** A `chat.react` command for bot b1 (a mutating command whose apply step needs nothing else). */
export function react(messageId: string, emoji = "👍") {
  return { type: "chat.react", botId: "b1", messageId, emoji, present: true } as const;
}
