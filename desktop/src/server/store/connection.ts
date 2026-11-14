// Opening server.db with the "durable before acknowledged" settings of protocol v1 §7.2, and the Doctor note of D43.
import { realpathSync } from "node:fs";
import { openDb, type Db } from "./sqlite";

/** v1 §7.2, in order. `fullfsync` makes SQLite use F_FULLFSYNC on macOS (a real flush past the drive cache). */
export const WRITER_PRAGMAS: readonly string[] = [
  "journal_mode = WAL",
  "synchronous = FULL",
  "fullfsync = ON",
  "checkpoint_fullfsync = ON",
  "foreign_keys = ON",
  "busy_timeout = 5000",
  "journal_size_limit = 67108864",
];

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
    // synchronous: 2 = FULL (3 = EXTRA would also be durable).
    const sync = Number(db.pragma("synchronous"));
    if (sync < 2) throw new StoreSettingsError(`server.db: synchronous is ${sync}, expected FULL (2)`);
    if (Number(db.pragma("fullfsync")) !== 1) throw new StoreSettingsError("server.db: fullfsync did not stay ON");
    if (Number(db.pragma("foreign_keys")) !== 1) throw new StoreSettingsError("server.db: foreign_keys did not stay ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
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
