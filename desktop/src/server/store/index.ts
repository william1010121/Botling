// server.db for `botlingd` (protocol v1 §7): open with the §7.2 settings, back up and migrate the schema, then one
// writer with group commit. Reads use separate connections (`openReader`).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { takeBackup, takePreMigrationBackup, type BackupKind } from "./backup";
import { runStartupVacuum, type CompactionOptions } from "./compaction";
import { BOOT_KEY, commitFlushed, durabilityGate, externalDiskNote, lostTail, machineBootId, OPEN_KEY, openReaderDb, openWriterDb } from "./connection";
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, schemaVersion, SchemaTooNewError, type Migration } from "./schema";
import type { Db } from "./sqlite";
import { Writer, type Command, type WriterOptions } from "./writer";
import type { DurabilityGate } from "./connection";

export { BACKUP_AT_KEY, backupFile, CONVERSATIONS_ONLY_KEY, isConversationsBackup, KEEP, listBackups, newestBackup, PRE_MIGRATION_FULL_COPY_MAX_BYTES, serverDbBytes, stampTime, takeBackup, takePreMigrationBackup, type BackupKind } from "./backup";
export { PRUNED_KEY, PRUNE_DELAY_MS, pruneInBackground, runStartupVacuum, startBackgroundPrune, VACUUMED_KEY, type BackgroundPrune, type CompactionOptions, type PruneDeps, type PruneReport, type VacuumReport } from "./compaction";
export { BOOT_KEY, DURABLE_TABLES, durabilityGate, externalDiskNote, lostTail, machineBootId, OPEN_KEY, openReaderDb, openWriterDb, SYNCED_KEY, WRITER_PRAGMAS, type DurabilityGate } from "./connection";
export { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS, schemaVersion, SchemaTooNewError, type Migration } from "./schema";
export type { Db, SqlRow, SqlValue, Statement } from "./sqlite";
export { MAX_BATCH, StoreCommitError, Writer, WriterClosedError, type BatchInfo, type Command, type CommandContext, type WriterOptions } from "./writer";

export interface OpenStoreOptions extends WriterOptions {
  /** Defaults to the released migrations; tests pass their own list. */
  migrations?: readonly Migration[];
  /** Tests: the size above which the backup before a migration is conversations-only (default PRE_MIGRATION_FULL_COPY_MAX_BYTES). */
  preMigrationFullCopyMaxBytes?: number;
  /** The one-time VACUUM (after the background prune, compaction.ts) of an oversized old file; `false` turns it off. */
  compaction?: CompactionOptions | false;
  /**
   * D75: the previous run did not close and the machine booted since, so its last unflushed commits may be gone while
   * readers (front ends, peers) saw them. Runs inside the flushed transaction that opens the store, before anything is
   * served; botlingd retires every own stream there (a rewind, §7.6: readers get `reset` + `snap`).
   */
  onLostTail?: (db: Db) => void;
  /** Tests: this machine's boot id (default `machineBootId()`; null = unknown). */
  bootId?: string | null;
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
  /** D75: this open found that the previous run may have lost its last commits (and ran `onLostTail`). */
  readonly lostTail: boolean;
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
  let durability: DurabilityGate;
  let lost = false;
  try {
    const from = schemaVersion(db);
    if (from > known) throw new SchemaTooNewError(from, known);
    // Only once the background prune is done (its marker), and before the pre-migration backup, so the backup copies the small file.
    if (existed && from > 0 && options.compaction !== false) runStartupVacuum(db, options.compaction ?? {});
    if (existed && from > 0 && from < known) {
      // v1 §7.6: a backup before every schema migration (the writer is not running yet, nothing else writes). A big file gets
      // a conversations-only copy instead of a whole one, and only one copy is kept (see PRE_MIGRATION_FULL_COPY_MAX_BYTES).
      await takePreMigrationBackup(file, backupsDir, { maxFullBytes: options.preMigrationFullCopyMaxBytes });
    }
    migrated = migrate(db, migrations);
    durability = durabilityGate(db);
    // D75's boot check, then this run's own marks, in one flushed transaction (it also flushes the migration).
    const current = options.bootId === undefined ? machineBootId() : options.bootId;
    const read = (key: string) => {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
      return row ? String(row.value) : undefined;
    };
    const hasMeta = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get());
    lost = hasMeta && lostTail({ open: read(OPEN_KEY), boot: read(BOOT_KEY) }, current);
    if (hasMeta) {
      const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      commitFlushed(db, () => {
        if (lost) options.onLostTail?.(db);
        put.run(OPEN_KEY, "1");
        put.run(BOOT_KEY, current ?? "");
      });
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const writer = new Writer(db, { ...options, durability });
  let closed = false;
  return {
    dataDir,
    file,
    backupsDir,
    writer,
    migrated,
    diskNote: externalDiskNote(dataDir),
    lostTail: lost,
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
      // D75: a clean close, flushed, so the next start knows nothing was lost (the flush covers every commit before it).
      try { commitFlushed(db, () => { db.prepare("UPDATE meta SET value = '0' WHERE key = ?").run(OPEN_KEY); }); }
      catch { /* not marked closed: the next start after a reboot resets readers, which is safe */ }
      db.close();
      db = undefined as unknown as Db;
    },
  };
}
