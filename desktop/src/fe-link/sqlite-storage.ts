// The desktop front end's durable storage (protocol v1 §13.2): a small SQLite file in the window's profile folder.
// `node:sqlite` is reached only through the server's wrapper module (src/server/store/sqlite.ts, M1 brief risk 7), so an
// Electron upgrade touches one file. Not exported from fe-link/index.ts: the phone build (M2) must not pull node:sqlite.
//
// Durable before resolved: WAL with `synchronous = FULL` and `fullfsync` (F_FULLFSYNC on macOS), one transaction per
// `write`. DatabaseSync commits synchronously, so once COMMIT returns the operations are on disk and the promise resolves.
import { openDb, type Db } from "../server/store/sqlite";
import { emptyState, type FeStorage, type OutboxItem, type StorageOp, type StoredState } from "./storage";

const PRAGMAS = ["journal_mode = WAL", "synchronous = FULL", "fullfsync = ON", "checkpoint_fullfsync = ON", "busy_timeout = 5000"];
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS counters (target TEXT PRIMARY KEY, next INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS outbox (epoch TEXT NOT NULL, target TEXT NOT NULL, n INTEGER NOT NULL, item TEXT NOT NULL, PRIMARY KEY (epoch, target, n)) STRICT;
CREATE TABLE IF NOT EXISTS cursors (stream TEXT PRIMARY KEY, logId TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT) STRICT;
CREATE TABLE IF NOT EXISTS retired (stream TEXT NOT NULL, logId TEXT NOT NULL, keptSeq INTEGER NOT NULL, PRIMARY KEY (stream, logId)) STRICT;
`;

export class SqliteFeStorage implements FeStorage {
  private readonly db: Db;

  constructor(file: string) {
    this.db = openDb(file);
    try {
      for (const pragma of PRAGMAS) this.db.exec(`PRAGMA ${pragma}`);
      if (String(this.db.pragma("journal_mode")).toLowerCase() !== "wal") throw new Error("fe storage: journal_mode did not become wal");
      if (Number(this.db.pragma("synchronous")) < 2) throw new Error("fe storage: synchronous is not FULL");
      this.db.exec(SCHEMA);
      const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
      if (!version) this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
      else if (Number(version.value) !== SCHEMA_VERSION) throw new Error(`fe storage: schema ${String(version.value)} is not ${SCHEMA_VERSION}`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async load(): Promise<StoredState> {
    const state = emptyState();
    const epoch = this.db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get();
    state.epoch = epoch ? String(epoch.value) : null;
    for (const row of this.db.prepare("SELECT target, next FROM counters").all()) state.counters[String(row.target)] = Number(row.next);
    state.items = this.db.prepare("SELECT item FROM outbox ORDER BY epoch, target, n").all().map((row) => JSON.parse(String(row.item)) as OutboxItem);
    for (const row of this.db.prepare("SELECT stream, logId, seq, hash FROM cursors").all()) {
      state.cursors[String(row.stream)] = { logId: String(row.logId), seq: Number(row.seq), hash: row.hash === null ? null : String(row.hash) };
    }
    for (const row of this.db.prepare("SELECT stream, logId, keptSeq FROM retired ORDER BY rowid").all()) {
      (state.retired[String(row.stream)] ??= []).push({ logId: String(row.logId), keptSeq: Number(row.keptSeq) });
    }
    return state;
  }

  async write(ops: readonly StorageOp[]): Promise<void> {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const op of ops) {
        switch (op.op) {
          case "epoch":
            db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(op.epoch);
            db.prepare("DELETE FROM counters").run();
            break;
          case "counter":
            db.prepare("INSERT INTO counters (target, next) VALUES (?, ?) ON CONFLICT (target) DO UPDATE SET next = excluded.next").run(op.target, op.next);
            break;
          case "put":
            db.prepare("INSERT INTO outbox (epoch, target, n, item) VALUES (?, ?, ?, ?) ON CONFLICT (epoch, target, n) DO UPDATE SET item = excluded.item")
              .run(op.item.slot.originEpoch, op.item.slot.target, op.item.slot.n, JSON.stringify(op.item));
            break;
          case "delete":
            db.prepare("DELETE FROM outbox WHERE epoch = ? AND target = ? AND n = ?").run(op.slot.originEpoch, op.slot.target, op.slot.n);
            break;
          case "cursor":
            if (op.cursor) {
              db.prepare("INSERT INTO cursors (stream, logId, seq, hash) VALUES (?, ?, ?, ?) ON CONFLICT (stream) DO UPDATE SET logId = excluded.logId, seq = excluded.seq, hash = excluded.hash")
                .run(op.stream, op.cursor.logId, op.cursor.seq, op.cursor.hash);
            } else {
              db.prepare("DELETE FROM cursors WHERE stream = ?").run(op.stream);
            }
            break;
          case "retired":
            for (const old of op.retired) db.prepare("INSERT OR IGNORE INTO retired (stream, logId, keptSeq) VALUES (?, ?, ?)").run(op.stream, old.logId, old.keptSeq);
            break;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
