// Opening server.db with the "durable before acknowledged" settings of protocol v1 §7.2 (D2 as narrowed by D75), and the
// Doctor note of D43.
//
// D75 (2026-11-18): an ordinary commit no longer flushes. The writer runs WAL with synchronous = NORMAL: COMMIT
// writes the WAL frames with write() and returns, so a commit survives a crash of this process (the frames are in the
// OS) but a power loss or an OS crash may lose the last commits. What it never does is lose an earlier commit while
// keeping a later one, or damage the file: WAL recovery keeps the frames up to the first one whose running checksum
// fails, i.e. a prefix of the commits, and checkpoints sync the WAL before they copy it (checkpoint_fullfsync).
// So after any crash server.db is the state after some commit k, with k at least the last flushed commit.
//
// What must not be lost is what someone outside this process was told (an acknowledgement: `held`, `cmd.result`, a
// roster statement, a pairing, a forwarded or originated command, an effect that ran). Those are exactly the writes to
// the tables in DURABLE_TABLES (and srv: rows). `durabilityGate` marks a transaction that wrote any of them (TEMP
// triggers calling a function of this connection) and the writer then flushes before it settles its promises: one
// synchronous = FULL commit of a meta row, whose F_FULLFSYNC of the WAL also covers every earlier commit, since the
// WAL is one file. A flushed commit k makes the whole prefix 1..k durable.
// The rest (log entries, read models, live checkpoints, caches) may be lost on a power loss; readers that saw them
// are reset at the next start (`bootCheck`, index.ts: the previous run did not close and the machine booted since).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { openDb, type Db } from "./sqlite";

/** v1 §7.2 as narrowed by D75, in order. `fullfsync` makes SQLite use F_FULLFSYNC on macOS for the syncs that happen. */
export const WRITER_PRAGMAS: readonly string[] = [
  "journal_mode = WAL",
  "synchronous = NORMAL",
  "fullfsync = ON",
  "checkpoint_fullfsync = ON",
  "foreign_keys = ON",
  "busy_timeout = 5000",
  "journal_size_limit = 67108864",
];

/**
 * The tables whose rows are, or stand behind, something this server told another process (D75). A transaction that
 * writes one of them is flushed before its commands settle. Receipts, slot state and kept results (`held`,
 * `cmd.result`, exactly-once per slot); the forward queue and its cancels and dead letters (a front end dropped its
 * copy on `held`); this server's own origin counters (a number sent to a peer is never reused); effects (an effect
 * that started or ended outside must not run again or be forgotten); the roster and prefs (statements and pairings
 * sent to peers and devices); fetch grants; meta (identity, epochs, audit); retired logIds (D50, a reset was sent);
 * import ids (an import is not redone).
 */
export const DURABLE_TABLES: readonly string[] = [
  "receipts", "slots", "cancels", "slot_results", "forwardq", "forwarddead", "fwdcancels", "myorigins", "effects",
  "roster", "prefs", "grants", "meta", "retired", "import_ids",
];

/** `rows` of the server's own srv: table streams (plugin rows and their grants, D52; audits) are durable too. */
const DURABLE_ROWS_WHEN = "stream LIKE 'srv:%'";

/** The meta key the flush writes (when, and the number of flushes this connection made). */
export const SYNCED_KEY = "store.synced";

export class StoreSettingsError extends Error {
  constructor(message: string) { super(message); this.name = "StoreSettingsError"; }
}

/** The single writer connection. Throws if SQLite did not take a setting the durability rule depends on. */
export function openWriterDb(file: string): Db {
  const db = openDb(file);
  try {
    for (const pragma of WRITER_PRAGMAS) db.exec(`PRAGMA ${pragma}`);
    const mode = String(db.pragma("journal_mode")).toLowerCase();
    if (mode !== "wal") throw new StoreSettingsError(`server.db: journal_mode is ${mode}, expected wal`);
    // synchronous: 1 = NORMAL. NORMAL is only safe from damage in WAL (checked above); a flush is FULL (durabilityGate).
    const sync = Number(db.pragma("synchronous"));
    if (sync !== 1) throw new StoreSettingsError(`server.db: synchronous is ${sync}, expected NORMAL (1)`);
    if (Number(db.pragma("fullfsync")) !== 1) throw new StoreSettingsError("server.db: fullfsync did not stay ON");
    if (Number(db.pragma("checkpoint_fullfsync")) !== 1) throw new StoreSettingsError("server.db: checkpoint_fullfsync did not stay ON");
    if (Number(db.pragma("foreign_keys")) !== 1) throw new StoreSettingsError("server.db: foreign_keys did not stay ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** What the writer asks of the connection about durability (writer.ts). */
export interface DurabilityGate {
  /** Forgets the mark (the writer calls it right before BEGIN of each batch). */
  clear(): void;
  /**
   * The batch must be flushed before it settles: the transaction since `clear` wrote a durable table or called `mark`,
   * or an earlier flush failed (its commits are in the file but not known to be on disk, and a later batch may answer
   * from them: a re-sent command found by its receipt, a forward row already queued).
   */
  marked(): boolean;
  /** Marks the running transaction as one to flush (CommandContext.durable: an effect outside the store follows it). */
  mark(): void;
  /**
   * Makes every commit so far durable: one synchronous = FULL transaction (a meta row), whose WAL flush covers the
   * earlier frames too. Throws when it could not; the connection is back on NORMAL either way.
   */
  flush(): void;
  /** Flushes made (tests, the latency log). */
  readonly flushes: number;
}

/**
 * Installs the durability marks on the writer connection (after migration: the tables must exist) and returns the
 * gate. TEMP triggers belong to this connection only: nothing is written into the file's schema.
 */
export function durabilityGate(db: Db): DurabilityGate {
  let mark = false;
  /** A flush failed (or is running): every later batch flushes until one succeeds. */
  let owing = false;
  let flushes = 0;
  db.defineFunction("botling_durable", () => { mark = true; return null; });
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)),
  );
  // A table the file does not have cannot be written (migrations all ran before this), so it needs no mark.
  for (const table of DURABLE_TABLES.filter((name) => tables.has(name))) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS durable_${table}_${op.toLowerCase()} AFTER ${op} ON main.${table} `
        + "BEGIN SELECT botling_durable(); END");
    }
  }
  if (tables.has("rows")) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS durable_rows_insert AFTER INSERT ON main.rows WHEN NEW.${DURABLE_ROWS_WHEN} BEGIN SELECT botling_durable(); END`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS durable_rows_update AFTER UPDATE ON main.rows WHEN NEW.${DURABLE_ROWS_WHEN} OR OLD.${DURABLE_ROWS_WHEN} BEGIN SELECT botling_durable(); END`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS durable_rows_delete AFTER DELETE ON main.rows WHEN OLD.${DURABLE_ROWS_WHEN} BEGIN SELECT botling_durable(); END`);
  }
  const hasMeta = tables.has("meta");
  return {
    clear() { mark = false; },
    marked: () => mark || owing,
    mark() { mark = true; },
    get flushes() { return flushes; },
    flush() {
      owing = true;
      try {
        db.exec("PRAGMA synchronous = FULL");
        db.exec("BEGIN IMMEDIATE");
        try {
          // A changed row gives the flush a frame to write (an empty transaction would not sync). No meta: refuse.
          if (!hasMeta) throw new StoreSettingsError("server.db: no meta table to flush with");
          db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .run(SYNCED_KEY, `${Date.now()}:${flushes + 1}`);
          db.exec("COMMIT");
        } catch (error) {
          try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* the connection reports its own state */ }
          throw error;
        }
        flushes += 1;
        owing = false;
      } finally {
        mark = false;
        db.exec("PRAGMA synchronous = NORMAL");
      }
    },
  };
}

/**
 * Commits `run` with synchronous = FULL (the store's own bookkeeping at open and close: it must be on disk before
 * anything is served, and a clean close must survive the power loss right after it).
 */
export function commitFlushed(db: Db, run: () => void): void {
  db.exec("PRAGMA synchronous = FULL");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      db.exec("COMMIT");
    } catch (error) {
      try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* the connection reports its own state */ }
      throw error;
    }
  } finally {
    db.exec("PRAGMA synchronous = NORMAL");
  }
}

/** meta keys of the boot check (D75). */
export const OPEN_KEY = "store.open";
export const BOOT_KEY = "store.boot";

/**
 * This boot of the machine (null when it cannot be told): macOS `kern.bootsessionuuid`, Linux's boot_id. A new value
 * means the machine started again since it was read.
 */
export function machineBootId(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === "darwin") {
      const out = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return /^[0-9A-Fa-f-]{8,64}$/.test(out) ? out : null;
    }
    if (platform === "linux") {
      const out = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return /^[0-9A-Fa-f-]{8,64}$/.test(out) ? out : null;
    }
  } catch { /* unknown: the check treats it as a new boot */ }
  return null;
}

/**
 * D75's boot check, from what the previous run left in meta: may its last commits have been lost? Only when it did
 * not close (`store.open` is "1") and the machine booted since (another boot id), since a crash of the process alone
 * loses nothing. An unknown boot id on either side counts as another boot (fail closed); a file that never had the
 * keys (written before D75, every commit flushed) lost nothing.
 */
export function lostTail(previous: { open: string | undefined; boot: string | undefined }, current: string | null): boolean {
  if (previous.open !== "1") return false;
  if (!previous.boot || current === null) return true;
  return previous.boot !== current;
}

/** A read connection: WAL snapshot isolation, so a read transaction sees one committed state (v1 §7.2). */
export function openReaderDb(file: string): Db {
  const db = openDb(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * D43: `server.db` belongs on the internal disk. On an external disk an enclosure may acknowledge F_FULLFSYNC before
 * the data is on flash (M0 measured 0.7 ms there), so "durable" then depends on the enclosure. Returns the Doctor note
 * for a data folder on an external volume, or null. macOS mounts every non-boot volume under /Volumes.
 */
export function externalDiskNote(dataDir: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "darwin") return null;
  let real = dataDir;
  try { real = realpathSync(dataDir); } catch { /* not created yet: judge the path as given */ }
  if (!real.startsWith("/Volumes/")) return null;
  return "The Botling 3 data folder is on an external disk. Commands are acknowledged once the disk reports them "
    + "flushed, and some external enclosures report that before the data is safe; keep the data folder on the "
    + "internal disk for durable history.";
}
