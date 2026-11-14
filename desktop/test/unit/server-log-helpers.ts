// Shared by the server/log tests: a quick store (the real writer and schema, without the per-commit flush, so property
// runs stay fast; the durable settings are tested in server-store*.test.ts) and a front-end reader that applies frames
// by the rules of protocol v1 §8.3 / §13.1 and records every rule the server broke.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGES, type Cursor, type Entry, type Message, type StreamId } from "../../src/protocol";
import { hashEntry, type LogStore } from "../../src/server/log";
import { migrate, Writer, type Db } from "../../src/server/store";
import { openDb } from "../../src/server/store/sqlite";

export interface QuickStore extends LogStore {
  writer: Writer;
  db: Db;
  close(): Promise<void>;
}

export function quickStore(): QuickStore {
  const dir = mkdtempSync(join(tmpdir(), "botling-log-"));
  const file = join(dir, "server.db");
  const db = openDb(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA foreign_keys = ON;");
  migrate(db);
  const writer = new Writer(db);
  const readers: Db[] = [];
  return {
    writer,
    db,
    submit: (command) => writer.submit(command),
    openReader: () => {
      const reader = openDb(file, { readOnly: true });
      readers.push(reader);
      return reader;
    },
    async close() {
      await writer.close();
      for (const reader of readers) reader.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const message = (id: string, text = `line ${id}`, role: "user" | "bot" = "user") => ({ id, role, text, time: "2026-11-14T00:00:00.000Z" });

interface StreamView {
  logId: string;
  seq: number;
  hash: string;
  /** After a `reset`: the next frame of the stream must be a snap of this logId. */
  awaitingSnap: boolean;
  /** Entries applied since the last snap (seq order). */
  applied: Entry[];
}

/** A front end that keeps cursors (as its durable storage would) and checks every frame it gets. */
export class FakeFe {
  readonly streams = new Map<StreamId, StreamView>();
  readonly retired = new Map<StreamId, Set<string>>();
  readonly frames: Message[] = [];
  readonly violations: string[] = [];
  dropped = 0;

  constructor(readonly name: string) {}

  cursor(stream: StreamId): Cursor | null {
    const view = this.streams.get(stream);
    return view && !view.awaitingSnap ? { logId: view.logId, seq: view.seq } : null;
  }

  hash(stream: StreamId): string | null {
    const view = this.streams.get(stream);
    return view && !view.awaitingSnap ? view.hash : null;
  }

  private fail(text: string): void {
    this.violations.push(`${this.name}: ${text}`);
  }

  receive = (message: Message): void => {
    const schema = MESSAGES[message.t];
    const parsed = schema.safeParse(message);
    if (!parsed.success) this.fail(`malformed ${message.t}: ${parsed.error.issues[0]?.message}`);
    if (Buffer.byteLength(JSON.stringify(message)) > 256 * 1024) this.fail(`${message.t} frame above 256 KiB`);
    this.frames.push(message);
    switch (message.t) {
      case "batch": return this.batch(message);
      case "snap": return this.snap(message);
      case "reset": return this.reset(message);
      default: this.fail(`unexpected ${message.t}`);
    }
  };

  private batch(batch: Extract<Message, { t: "batch" }>): void {
    const view = this.streams.get(batch.stream);
    if (this.retired.get(batch.stream)?.has(batch.logId)) { this.dropped++; this.fail(`batch of retired ${batch.logId}`); return; }
    if (!view) { this.fail(`batch of ${batch.stream} before any snap or cursor`); return; }
    if (view.awaitingSnap) { this.fail("batch while awaiting the snap after a reset"); return; }
    if (batch.logId !== view.logId) { this.fail(`batch of another logId without a reset (${batch.logId} vs ${view.logId})`); return; }
    if (batch.from !== view.seq + 1) { this.fail(`gap or duplicate: batch from ${batch.from} with cursor ${view.seq}`); return; }
    if (batch.prevHash !== view.hash) { this.fail(`prevHash mismatch at ${batch.from}`); return; }
    for (const entry of batch.entries) {
      if (hashEntry(view.hash, entry) !== entry.hash) { this.fail(`hash chain broken at ${entry.seq}`); return; }
      view.hash = entry.hash;
      view.seq = entry.seq;
      view.applied.push(entry);
    }
  }

  private snap(snap: Extract<Message, { t: "snap" }>): void {
    if (this.retired.get(snap.stream)?.has(snap.logId)) { this.dropped++; this.fail(`snap of retired ${snap.logId}`); return; }
    const view = this.streams.get(snap.stream);
    if (view?.awaitingSnap && view.logId !== snap.logId) this.fail(`snap of ${snap.logId} after a reset to ${view.logId}`);
    if (view && !view.awaitingSnap) {
      if (view.logId !== snap.logId) this.fail(`snap of another logId without a reset`);
      else if (snap.seq < view.seq) this.fail(`older snap (${snap.seq} below cursor ${view.seq})`);
    }
    this.streams.set(snap.stream, { logId: snap.logId, seq: snap.seq, hash: snap.hash, awaitingSnap: false, applied: [] });
  }

  private reset(reset: Extract<Message, { t: "reset" }>): void {
    const view = this.streams.get(reset.stream);
    const mine = view?.logId;
    if (mine && !reset.retired.some((old) => old.logId === mine)) this.fail(`reset that does not list my logId ${mine}`);
    const set = this.retired.get(reset.stream) ?? new Set<string>();
    for (const old of reset.retired) set.add(old.logId);
    this.retired.set(reset.stream, set);
    if (set.has(reset.logId)) this.fail(`reset to a retired logId ${reset.logId}`);
    this.streams.set(reset.stream, { logId: reset.logId, seq: -1, hash: "", awaitingSnap: true, applied: [] });
  }

  /** Simulates a cursor the FE got elsewhere (another machine, a later incarnation): only for sub tests. */
  forceCursor(stream: StreamId, cursor: Cursor, hash = ""): void {
    this.streams.set(stream, { logId: cursor.logId, seq: cursor.seq, hash, awaitingSnap: false, applied: [] });
  }
}
