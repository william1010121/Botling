// Test harness for src/server/slots: a fake SlotLog that writes entries into server.db's `entries` table in the
// command's own transaction (so rollbacks cover it), an in-memory server.db behind the real group-commit writer, and
// envelope builders. Step 3's real log replaces the fake; nothing here is used by the app.
import { ProtocolEntryEvent, type CmdBody, type Cursor, type LogId, type Slot, type StreamId } from "../../src/protocol";
import { migrate, Writer, type Db, type WriterOptions } from "../../src/server/store";
import { openDb } from "../../src/server/store/sqlite";
import type { SlotLog } from "../../src/server/slots";

export const SERVER = "srv:me";
export const EPOCH_A = "a".repeat(32);
export const EPOCH_B = "b".repeat(32);

export interface FakeEntry { stream: string; seq: number; kind: string; body: Record<string, unknown>; slot: Slot | null }

/** Each stream's logId lives in memory (the restore test changes it); entries live in the db. */
export class FakeLog implements SlotLog {
  readonly logIds = new Map<string, LogId>();
  constructor(public inc: LogId = "inc-00000001") {}
  serverInc(): LogId { return this.inc; }
  logId(_tx: Db, stream: StreamId): LogId {
    let id = this.logIds.get(stream);
    if (!id) this.logIds.set(stream, (id = `log-${stream.replace(/[^A-Za-z0-9]/g, "")}-1`.slice(0, 60)));
    return id;
  }
  appendEntry(tx: Db, stream: StreamId, kind: string, body: Record<string, unknown>, slot?: Slot): Cursor {
    if (kind.startsWith("cmd.")) {
      const check = ProtocolEntryEvent.safeParse({ type: kind, ...body });
      if (!check.success) throw new Error(`fake log: invalid ${kind} body: ${check.error.message}`);
    }
    const head = Number(tx.prepare("SELECT COALESCE(MAX(seq), 0) AS head FROM entries WHERE stream = ?").get(stream)!.head);
    tx.prepare("INSERT INTO entries (stream, seq, hlc, kind, body, slot, hash) VALUES (?, ?, '0', ?, ?, ?, 'h')")
      .run(stream, head + 1, kind, JSON.stringify(body), slot ? JSON.stringify(slot) : null);
    return { logId: this.logId(tx, stream), seq: head + 1 };
  }
  /** A restore: every stream and the server get a new incarnation (§7.6). */
  restore(): void {
    const bump = (id: string) => id.replace(/-(\d+)$/, (_m, k) => `-${Number(k) + 1}`);
    this.inc = bump(this.inc);
    for (const [stream, id] of this.logIds) this.logIds.set(stream, bump(id));
  }
}

export function entries(db: Db, stream?: string): FakeEntry[] {
  const rows = stream
    ? db.prepare("SELECT stream, seq, kind, body, slot FROM entries WHERE stream = ? ORDER BY seq").all(stream)
    : db.prepare("SELECT stream, seq, kind, body, slot FROM entries ORDER BY stream, seq").all();
  return rows.map((row) => ({ stream: String(row.stream), seq: Number(row.seq), kind: String(row.kind), body: JSON.parse(String(row.body)), slot: row.slot ? JSON.parse(String(row.slot)) : null }));
}

export function memoryStore(options: WriterOptions = {}): { db: Db; writer: Writer } {
  const db = openDb(":memory:");
  migrate(db);
  return { db, writer: new Writer(db, options) };
}

export function slot(n: number, over: Partial<Slot> = {}): Slot {
  return { origin: "desktop", originEpoch: EPOCH_A, target: "bot:b1", n, ...over };
}

/** A `chat.react` envelope for slot n (any target bot), as the local front end sends it (no scope). */
export function react(n: number, opts: { floor?: number; inc?: LogId; over?: Partial<Slot>; emoji?: string; basis?: Cursor } = {}): CmdBody {
  const s = slot(n, opts.over);
  const botId = s.target.startsWith("bot:") ? s.target.slice(4) : "b1";
  return {
    slot: s, floor: opts.floor ?? n, inc: opts.inc ?? "inc-00000001",
    cmd: { type: "chat.react", botId, messageId: `m${n}`, emoji: opts.emoji ?? "👍", present: true },
    ...(opts.basis ? { basis: opts.basis } : {}),
  } as CmdBody;
}

/** A seeded PRNG (mulberry32), so a failing random run can be replayed from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
