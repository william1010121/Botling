// The one module of Botling 3's server that imports `node:sqlite` (M1 brief, risk 7). `node:sqlite` is still marked
// experimental and its API may change with an Electron upgrade; everything else in `src/server/` talks to the small
// interface below, so an upgrade touches this file and its tests only (test/unit/server-store-sqlite.test.ts).
//
// Synchronous on purpose: a transaction runs inside one turn of the event loop, so no other code of this process can
// interleave with it. Only `backupDb` is asynchronous (SQLite's online backup runs off the main thread).
import { backup as sqliteBackup, DatabaseSync, type StatementSync } from "node:sqlite";

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface Db {
  readonly path: string;
  readonly isOpen: boolean;
  readonly inTransaction: boolean;
  exec(sql: string): void;
  /** Prepared statements are cached per SQL text for the life of the connection. */
  prepare(sql: string): Statement;
  /** The first column of the first row of `PRAGMA <body>`, or undefined. */
  pragma(body: string): SqlValue | undefined;
  close(): void;
}

export interface OpenOptions {
  readOnly?: boolean;
  /** Milliseconds SQLite waits for a lock held by another connection (busy_timeout). */
  timeoutMs?: number;
}

const handles = new WeakMap<Db, DatabaseSync>();

class Connection implements Db {
  private readonly cache = new Map<string, Statement>();
  constructor(readonly path: string, private readonly raw: DatabaseSync) {}

  get isOpen(): boolean { return this.raw.isOpen; }
  get inTransaction(): boolean { return this.raw.isTransaction; }

  exec(sql: string): void { this.raw.exec(sql); }

  prepare(sql: string): Statement {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = wrapStatement(this.raw.prepare(sql));
      this.cache.set(sql, statement);
    }
    return statement;
  }

  pragma(body: string): SqlValue | undefined {
    const row = this.raw.prepare(`PRAGMA ${body}`).get() as SqlRow | undefined;
    return row ? Object.values(row)[0] : undefined;
  }

  close(): void {
    this.cache.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

function wrapStatement(statement: StatementSync): Statement {
  return {
    run: (...params) => {
      const result = statement.run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (...params) => statement.get(...params) as SqlRow | undefined,
    all: (...params) => statement.all(...params) as SqlRow[],
  };
}

export function openDb(path: string, options: OpenOptions = {}): Db {
  const raw = new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    timeout: options.timeoutMs ?? 5000,
    // Foreign keys are set by the caller's PRAGMA list; leave SQLite's default here so read connections match it.
    enableForeignKeyConstraints: true,
  });
  const db = new Connection(path, raw);
  handles.set(db, raw);
  return db;
}

/**
 * SQLite's online backup of `source` into the file `dest` (overwritten). `pagesPerStep` < 0 copies every page in one
 * step, which holds one read snapshot for the whole copy: with the source being a read connection on a WAL database,
 * the result is exactly the state of one committed moment, and writes on other connections cannot restart it.
 */
export async function backupDb(source: Db, dest: string, pagesPerStep = -1): Promise<number> {
  const raw = handles.get(source);
  if (!raw) throw new Error("backupDb: not a connection opened by openDb");
  return sqliteBackup(raw, dest, { rate: pagesPerStep });
}

/** The SQLite library version inside the running Node (for evidence and the Electron-upgrade test). */
export function sqliteVersion(): string {
  const db = new DatabaseSync(":memory:");
  try {
    return String((db.prepare("SELECT sqlite_version() AS v").get() as SqlRow).v);
  } finally {
    db.close();
  }
}
