// server.db schema and its migrations (protocol v1 §7.3). `meta.schemaVersion` holds the version; each migration
// runs in its own BEGIN IMMEDIATE … COMMIT, so a crash during a migration leaves the previous version intact.
// A migration is never edited once released: add the next one.
import { randomUUID } from "node:crypto";
import type { Db } from "./sqlite";

export interface Migration {
  version: number;
  description: string;
  up(db: Db): void;
}

const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE streams (
  stream TEXT PRIMARY KEY, owner TEXT NOT NULL, logId TEXT NOT NULL, head INTEGER NOT NULL DEFAULT 0,
  headHash TEXT, state TEXT NOT NULL, heardAt INTEGER
) WITHOUT ROWID;
CREATE TABLE entries (
  stream TEXT NOT NULL, seq INTEGER NOT NULL, hlc TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  slot TEXT, hash TEXT NOT NULL, PRIMARY KEY (stream, seq)
) WITHOUT ROWID;
CREATE TABLE rows (
  stream TEXT NOT NULL, key TEXT NOT NULL, rev INTEGER NOT NULL, body TEXT, deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stream, key)
) WITHOUT ROWID;
CREATE INDEX rows_by_rev ON rows (stream, rev);
CREATE TABLE receipts (
  origin TEXT NOT NULL, originEpoch TEXT NOT NULL, target TEXT NOT NULL, n INTEGER NOT NULL, cmdHash TEXT NOT NULL,
  outcome TEXT NOT NULL, seq INTEGER, PRIMARY KEY (origin, originEpoch, target, n)
) WITHOUT ROWID;
CREATE TABLE slots (
  origin TEXT NOT NULL, originEpoch TEXT NOT NULL, target TEXT NOT NULL, next INTEGER NOT NULL,
  PRIMARY KEY (origin, originEpoch, target)
) WITHOUT ROWID;
CREATE TABLE cancels (
  origin TEXT NOT NULL, originEpoch TEXT NOT NULL, target TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (origin, originEpoch, target, n)
) WITHOUT ROWID;
CREATE TABLE forwardq (
  origin TEXT NOT NULL, originEpoch TEXT NOT NULL, target TEXT NOT NULL, n INTEGER NOT NULL, owner TEXT NOT NULL,
  cmdHash TEXT NOT NULL, envelope TEXT NOT NULL, heldAt INTEGER NOT NULL, PRIMARY KEY (origin, originEpoch, target, n)
) WITHOUT ROWID;
CREATE TABLE myorigins (target TEXT PRIMARY KEY, originEpoch TEXT NOT NULL, nextN INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE effects (
  effectId TEXT PRIMARY KEY, stream TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT, state TEXT NOT NULL,
  seq INTEGER, startedAt INTEGER, endedAt INTEGER
) WITHOUT ROWID;
CREATE INDEX effects_by_state ON effects (state);
CREATE TABLE messages (
  botId TEXT NOT NULL, msgId TEXT NOT NULL, rev INTEGER NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (botId, msgId)
) WITHOUT ROWID;
CREATE INDEX messages_by_seq ON messages (botId, seq);
CREATE TABLE cards (
  botId TEXT NOT NULL, cardId TEXT NOT NULL, rev INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY (botId, cardId)
) WITHOUT ROWID;
CREATE TABLE bots (
  botId TEXT PRIMARY KEY, settings TEXT, head INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
  model TEXT, liveTurnId TEXT, liveText TEXT, liveAt INTEGER
) WITHOUT ROWID;
CREATE TABLE lists (botId TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (botId, name)) WITHOUT ROWID;
CREATE TABLE roster (id TEXT PRIMARY KEY, kind TEXT NOT NULL, member TEXT, bytes BLOB NOT NULL, receivedAt INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT, hlc TEXT, writer TEXT) WITHOUT ROWID;
CREATE TABLE grants (
  grantId TEXT PRIMARY KEY, requester TEXT NOT NULL, prefix TEXT NOT NULL, mode TEXT NOT NULL, expires INTEGER,
  createdAt INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE content (
  id TEXT PRIMARY KEY, size INTEGER, type TEXT, pin TEXT, path TEXT, statSig TEXT, chunkHashes TEXT, state TEXT NOT NULL,
  createdAt INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE content_refs (id TEXT NOT NULL, stream TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (id, stream, seq)) WITHOUT ROWID;
CREATE INDEX content_refs_by_entry ON content_refs (stream, seq);
CREATE TABLE variants (
  srcId TEXT NOT NULL, variant TEXT NOT NULL, id TEXT, state TEXT NOT NULL, lastUsed INTEGER,
  PRIMARY KEY (srcId, variant)
) WITHOUT ROWID;
CREATE TABLE media_jobs (srcId TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (srcId, kind)) WITHOUT ROWID;
CREATE TABLE chunk_cache (
  id TEXT NOT NULL, idx INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0, lastUsed INTEGER,
  PRIMARY KEY (id, idx)
) WITHOUT ROWID;
`;

// v2 (M1 step 3, src/server/log):
// - entries.logId: the incarnation an entry was appended in. seq numbering continues across a restore (§7.6), so one
//   stream's table holds entries of several logIds; the hash covers the entry's own logId (§8.1).
// - streams.tail / tailHash: the last evicted seq and its hash, so a batch from tail + 1 still carries its prevHash.
// - retired: every earlier logId of a stream with the last seq the restore (or rewind) kept of it; `reset` lists them
//   and readers never go back to one (D50). `n` orders them per stream.
const V2 = `
ALTER TABLE entries ADD COLUMN logId TEXT NOT NULL DEFAULT '';
ALTER TABLE streams ADD COLUMN tail INTEGER NOT NULL DEFAULT 0;
ALTER TABLE streams ADD COLUMN tailHash TEXT;
CREATE TABLE retired (
  stream TEXT NOT NULL, logId TEXT NOT NULL, n INTEGER NOT NULL, keptSeq INTEGER NOT NULL, reason TEXT NOT NULL,
  retiredAt INTEGER NOT NULL, PRIMARY KEY (stream, logId)
) WITHOUT ROWID;
`;

// v3 (M1 step 6, src/server/effects and src/server/intents):
// - effects.botId / turnId: the turn an effect row is (a chat.send's, a routine's, an answer's, or one the core began by
//   itself), found by turn for `turn.stop` and the `turn.finished` event; effects_by_queue orders queued rows.
// - fulltext: the whole text of a line or turn whose entry had to be cut to fit one frame (§5.2: an entry is at most
//   ~252 KiB, a 2.x line up to 400,000 characters). key = the line id, or "turn:<turnId>"; seq = the entry it belongs to.
const V3 = `
ALTER TABLE effects ADD COLUMN botId TEXT;
ALTER TABLE effects ADD COLUMN turnId TEXT;
CREATE INDEX effects_by_turn ON effects (botId, turnId);
CREATE INDEX effects_by_queue ON effects (state, stream, seq);
CREATE TABLE fulltext (stream TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (stream, key)) WITHOUT ROWID;
`;

// v4 (M1 step 13, src/server/content): what each line names. `content_refs (id, stream, seq)` says an entry references
// the bytes `id`; `content_names` says which file of the line (by its absolute path) that is, so Electron main can turn
// the renderer's `botling-chat://chat/attachment/…?line=` URL into the reference (`content.find`). Written in the same
// transaction as the entry; `id` is `pending:<hex>` until the hash is ready, then the `sha256:` id (both tables). `sig`:
// the source's stat signature when the line finished (a later update of the line naming the same version reuses `id`).
const V4 = `
CREATE TABLE content_names (
  stream TEXT NOT NULL, seq INTEGER NOT NULL, line TEXT NOT NULL, path TEXT NOT NULL, id TEXT NOT NULL, sig TEXT,
  PRIMARY KEY (stream, line, path)
) WITHOUT ROWID;
CREATE INDEX content_names_by_id ON content_names (id);
`;

// v5 (M2 step 2, src/server/roster): roster statements are looked up by member (a device's Add and Revoke, a server's
// Endorse). `roster (id, kind, member, bytes, receivedAt)` is v1's table: `kind` is the statement type, `member` its
// member (a Root's `root`), `bytes` the canonical JSON of the signed statement. Audit rows of pairing and revocation go
// to the server's `srv:` table stream (`rows`, key `audit:<statement id>`, §8.2). meta gains `memberId`, `signPub`,
// `dhPub` (public keys only; the private keys are in server-keys.json, 0600) and `clusterId` once the cluster exists.
const V5 = `
CREATE INDEX roster_by_member ON roster (member, kind);
`;

// v6 (src/server/content): a `pending:<hex>` id stays resolvable after its hash is ready. `content.find` may hand a
// front end the pending id a moment before the hash's command moves the line's rows to the `sha256:` id; that command
// records `content_aliases (pending, id)` in the same transaction, and `content.open` of the pending id answers for the
// content id (with the same proof of reference, now held by the content id).
const V6 = `
CREATE TABLE content_aliases (pending TEXT PRIMARY KEY, id TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX content_aliases_by_id ON content_aliases (id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "protocol v1 §7.3 tables",
    up(db) {
      db.exec(V1);
      const put = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
      put.run("serverId", randomUUID());
      put.run("dbId", randomUUID());
      put.run("createdAt", String(Date.now()));
    },
  },
  {
    version: 2,
    description: "log streams (src/server/log): each entry's logId, the evicted tail, retired logIds (D50)",
    up(db) {
      db.exec(V2);
    },
  },
  {
    version: 3,
    description: "effect outbox by turn (src/server/effects), full text of cut entries",
    up(db) {
      db.exec(V3);
    },
  },
  {
    version: 4,
    description: "content path (src/server/content): the files each line names (content_names)",
    up(db) {
      db.exec(V4);
    },
  },
  {
    version: 5,
    description: "roster (src/server/roster): statements by member",
    up(db) {
      db.exec(V5);
    },
  },
  {
    version: 6,
    description: "content path (src/server/content): pending ids resolve to the content id once hashed (content_aliases)",
    up(db) {
      db.exec(V6);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** 0 for an empty file (no meta table yet). */
export function schemaVersion(db: Db): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get();
  return row ? Number(row.value) : 0;
}

export class SchemaTooNewError extends Error {
  constructor(readonly found: number, readonly known: number) {
    super(`server.db has schema version ${found}; this Botling knows versions up to ${known}. Use a newer Botling.`);
    this.name = "SchemaTooNewError";
  }
}

/** Applies every migration above the file's version, each in its own transaction. Returns the versions applied. */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const known = migrations.length ? migrations[migrations.length - 1].version : 0;
  const from = schemaVersion(db);
  if (from > known) throw new SchemaTooNewError(from, known);
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= from) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(String(migration.version));
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
    applied.push(migration.version);
  }
  return applied;
}
