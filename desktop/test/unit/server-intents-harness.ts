// Test harness for src/server/intents and src/server/effects: an in-memory server.db behind the real writer, the
// intent runtime over a fake engine, and envelope builders. Nothing here is used by the app.
import type { Command } from "../../src/contract";
import type { CmdBody, Cursor, LogId } from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { IntentRuntime, type UploadedFiles } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import type { ReceiveStatus } from "../../src/server/slots";
import type { Db, Writer } from "../../src/server/store";
import { FakeTurnEngine, type FakeTurnEngineOptions } from "../fixtures/fake-turn-engine";
import { EPOCH_A, memoryStore } from "./server-slots-harness";

export interface StoredEntry { stream: string; seq: number; kind: string; body: Record<string, unknown>; slot: unknown }

export function entriesOf(db: Db, stream: string): StoredEntry[] {
  return db.prepare("SELECT stream, seq, kind, body, slot FROM entries WHERE stream = ? ORDER BY seq").all(stream)
    .map((row) => ({ stream: String(row.stream), seq: Number(row.seq), kind: String(row.kind), body: JSON.parse(String(row.body)), slot: row.slot ? JSON.parse(String(row.slot)) : null }));
}

export const kinds = (db: Db, stream: string) => entriesOf(db, stream).map((entry) => entry.kind);

export function effectRows(db: Db): Array<{ botId: string; turnId: string | null; kind: string; state: string; payload: Record<string, unknown> }> {
  return db.prepare("SELECT botId, turnId, kind, state, payload FROM effects ORDER BY seq").all()
    .map((row) => ({ botId: String(row.botId), turnId: row.turnId == null ? null : String(row.turnId), kind: String(row.kind), state: String(row.state), payload: JSON.parse(String(row.payload)) }));
}

export interface Harness {
  db: Db;
  writer: Writer;
  engine: FakeTurnEngine;
  runtime: IntentRuntime;
  live: LiveChannel;
  logs: string[];
  /** The server's incarnation (its srv stream's logId). */
  inc: LogId;
  serverStream: string;
  /** The next slot per target (each target is its own queue); shared with a restarted harness. */
  slots: Map<string, number>;
  send(cmd: Command, options?: { basis?: Cursor; n?: number; target?: string; origin?: string }): Promise<ReceiveStatus>;
  /** Waits until the worker, the engine's turns and the tap's waiting events are all done. */
  settle(): Promise<void>;
  /** A new runtime and engine on the same server.db (what a restart after a crash finds). */
  restart(options?: FakeTurnEngineOptions): Promise<Harness>;
  close(): void;
}

export async function harness(options: FakeTurnEngineOptions = {}, shared?: { db: Db; writer: Writer; slots: Map<string, number> }, extra: { uploads?: UploadedFiles } = {}): Promise<Harness> {
  const { db, writer } = shared ?? memoryStore();
  const engine = new FakeTurnEngine(options);
  const logs: string[] = [];
  const live = new LiveChannel({ sink: effectCheckpointSink(writer), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store: writer, engine, live, log: (line) => logs.push(line), ...(extra.uploads ? { uploads: extra.uploads } : {}) });
  await runtime.start();
  const serverId = String(db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()!.value);
  const serverStream = `srv:${serverId}`;
  const inc = String(db.prepare("SELECT logId FROM streams WHERE stream = ?").get(serverStream)!.logId) as LogId;
  const h: Harness = {
    db, writer, engine, runtime, live, logs, inc, serverStream, slots: shared?.slots ?? new Map(),
    send(cmd, opts = {}) {
      const botId = (cmd as { botId?: string }).botId;
      const target = opts.target ?? (botId ? `bot:${botId}` : serverStream);
      // Each origin has its own slot counter per target.
      const key = `${opts.origin ?? "desktop"}|${target}`;
      const n = opts.n ?? (h.slots.get(key) ?? 0) + 1;
      if (n > (h.slots.get(key) ?? 0)) h.slots.set(key, n);
      const body = { slot: { origin: opts.origin ?? "desktop", originEpoch: EPOCH_A, target, n }, floor: 1, inc: h.inc, cmd, ...(opts.basis ? { basis: opts.basis } : {}) } as CmdBody;
      return runtime.receive(body, { scope: "local" });
    },
    async settle() {
      for (let round = 0; round < 6; round += 1) {
        await runtime.idle();
        await engine.allEnded();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await runtime.scope.submit(() => undefined);
      }
    },
    async restart(next = options) {
      h.close();
      return harness(next, { db, writer, slots: h.slots }, extra);
    },
    close() {
      runtime.close();
      engine.close();
      live.close();
    },
  };
  return h;
}

export const cursorAt = (db: Db, stream: string): Cursor => {
  const row = db.prepare("SELECT logId, head FROM streams WHERE stream = ?").get(stream)!;
  return { logId: String(row.logId) as LogId, seq: Number(row.head) };
};

export function outcomeOf(status: ReceiveStatus): Record<string, unknown> {
  if (status.status !== "result") throw new Error(`expected a result, got ${status.status}`);
  return status.message.outcome as Record<string, unknown>;
}
