// server.db for `botlingd` (protocol v1 §7): open with the §7.2 settings, back up and migrate the schema, then one
// writer with group commit. Reads use separate connections (`openReader`).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeBackup, type BackupKind } from "./backup";
import { runCompaction, type CompactionOptions } from "./compaction";
import { externalDiskNote, openReaderDb, openWriterDb } from "./connection";
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, schemaVersion, SchemaTooNewError, type Migration } from "./schema";
import type { Db } from "./sqlite";
import { Writer, type Command, type WriterOptions } from "./writer";

export { BACKUP_AT_KEY, backupFile, listBackups, newestBackup, stampTime, takeBackup, type BackupKind } from "./backup";
export { PRUNED_KEY, PRUNE_MAX_SCHEMA, runCompaction, VACUUMED_KEY, type CompactionOptions, type CompactionReport } from "./compaction";
export { externalDiskNote, openReaderDb, openWriterDb, WRITER_PRAGMAS } from "./connection";
export { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, schemaVersion, SchemaTooNewError, type Migration } from "./schema";
export type { Db, SqlRow, SqlValue, Statement } from "./sqlite";
export { MAX_BATCH, StoreCommitError, Writer, WriterClosedError, type BatchInfo, type Command, type CommandContext, type WriterOptions } from "./writer";

export interface OpenStoreOptions extends WriterOptions {
  /** Defaults to the released migrations; tests pass their own list. */
  migrations?: readonly Migration[];
  /** The one-time prune + VACUUM of an oversized old file (compaction.ts); `false` turns it off. */
  compaction?: CompactionOptions | false;
}

export interface ServerStore {
  readonly dataDir: string;
  readonly file: string;
  readonly backupsDir: string;
  readonly writer: Writer;
  /** Migrations applied by this open (empty when the file was current). */
  readonly migrated: number[];
  /** D43 Doctor note, or null when the data folder is on the internal disk. */
  readonly diskNote: string | null;
  submit<T>(command: Command<T>): Promise<T>;
  meta(key: string): string | undefined;
  openReader(): Db;
  backup(kind?: BackupKind): Promise<string>;
  close(): Promise<void>;
}

export async function openServerStore(dataDir: string, options: OpenStoreOptions = {}): Promise<ServerStore> {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "server.db");
  const backupsDir = join(dataDir, "backups");
  const migrations = options.migrations ?? MIGRATIONS;
  const known = migrations.length ? migrations[migrations.length - 1].version : 0;
  const existed = existsSync(file);
  let db = openWriterDb(file);
  let migrated: number[];
  try {
    const from = schemaVersion(db);
    if (from > known) throw new SchemaTooNewError(from, known);
    // Before the pre-migration backup, so a bloated file is trimmed first and the backup copies the small one.
    if (existed && from > 0 && options.compaction !== false) runCompaction(db, options.compaction ?? {});
    if (existed && from > 0 && from < known) {
      // v1 §7.6: a backup before every schema migration (the writer is not running yet, nothing else writes).
      await takeBackup(file, backupsDir, "pre-migration");
    }
    migrated = migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  const writer = new Writer(db, options);
  let closed = false;
  return {
    dataDir,
    file,
    backupsDir,
    writer,
    migrated,
    diskNote: externalDiskNote(dataDir),
    submit: (command) => writer.submit(command),
    meta: (key) => {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
      return row ? String(row.value) : undefined;
    },
    openReader: () => openReaderDb(file),
    backup: (kind = "manual") => takeBackup(file, backupsDir, kind),
    async close() {
      if (closed) return;
      closed = true;
      await writer.close();
      db.close();
      db = undefined as unknown as Db;
    },
  };
}
