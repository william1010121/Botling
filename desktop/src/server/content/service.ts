// The content path's local part on the owner (protocol v1 §9A.2–§9A.4, §9A.7, D44).
//
// When a chat line finishes, the files it names are indexed:
//   1. `prepareLine` (before the entry's command): each named file of an indexed kind gets a pinned version (pin.ts),
//      known as `pending:<hex>` until hashed.
//   2. `recordLine(db, prepared, entry)` (inside the entry's writer command, right after the entry is appended): a
//      `content` row per pin (state `preparing`), `content_refs (id, stream, seq)` for the entry and `content_names`
//      (which file of the line it is). Same transaction as the entry: neither exists without the other.
//   3. `afterCommit(prepared)`: the pin is hashed in the worker thread (hasher.ts); then one command moves the line's
//      rows from the pending id to the `sha256:` id and appends `content.ready{botId, lineId, url, ref}` to the stream
//      (with its own `content_refs` row). The window may open the pending pin meanwhile (its bytes are fixed).
// `content.find` / `content.open` (local socket) are answered by `handle`. `recover` runs once at start.
//
// A reference serves the bytes of its hash or nothing (§9A.3): a `pin: path` file whose stat signature no longer matches
// is marked `changed` (with `content.changed{id}` on each stream that references it) and answers `content.gone{changed}`.
import { rmSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTENT_CHUNK_BYTES, type ContentRef, type Entry, type MessageOf, type StreamId } from "../../protocol";
import { appendEntries, readStream } from "../log";
import type { Command, Db, SqlRow } from "../store";
import { contentTypeOf, namedFiles, pathOfFileRef, type LineLike, type NamedFile } from "./files";
import { CHUNK_BYTES, Hasher, type HashResult } from "./hasher";
import { pinFile, pinsDir, sameSig, statSig, sweepPins, type Pin, type PinOptions, type StatSig } from "./pin";

/** What the service needs of the store (`ServerStore` has it). */
export interface ContentStore {
  submit<T>(command: Command<T>): Promise<T>;
  openReader(): Db;
}

export interface ContentServiceOptions {
  store: ContentStore;
  dataDir: string;
  /** This server's id (`meta.serverId`): the `owner` of every reference it makes. */
  serverId: string;
  hasher?: Hasher;
  pin?: PinOptions;
  /** Called after a content command committed entries (step 9: `LogHub.committed`). */
  onCommitted?: (streams: StreamId[]) => void;
  audit?: (text: string) => void;
  now?: () => number;
}

export interface PreparedFile {
  named: NamedFile;
  pin: Pin;
}

export interface PreparedLine {
  botId: string;
  lineId: string;
  files: PreparedFile[];
  /** Named files that could not be pinned (missing, unreadable): the line shows them through the 2.x path. */
  skipped: Array<{ path: string; reason: string }>;
}

/** The largest chunk-hash list sent in a `content.file` (the schema's limit). */
const CHUNK_HASHES_TEXT_LIMIT = 240_000;

export type ContentRequest = MessageOf<"content.find"> | MessageOf<"content.open">;
export type ContentAnswer = MessageOf<"content.found"> | MessageOf<"content.file"> | MessageOf<"content.gone">;

/** A chat line that is finished, from a contract event: `message.added/updated` of a line that is not streaming. */
export function finishedLine(event: { type: string; botId?: string; message?: unknown }): { botId: string; line: LineLike } | null {
  if ((event.type !== "message.added" && event.type !== "message.updated") || typeof event.botId !== "string") return null;
  const message = event.message as { id?: unknown; state?: unknown; text?: unknown; attachments?: unknown } | undefined;
  if (!message || typeof message.id !== "string" || message.state === "streaming") return null;
  return {
    botId: event.botId,
    line: {
      id: message.id,
      text: typeof message.text === "string" ? message.text : "",
      attachments: Array.isArray(message.attachments) ? (message.attachments as Array<{ url: string; name?: string }>) : [],
    },
  };
}

interface ContentRow {
  id: string;
  size: number;
  type: string;
  pin: Pin["pin"];
  path: string;
  sig: StatSig | null;
  chunkHashes: string | null;
  state: ContentRef["state"];
}

function toRow(row: SqlRow): ContentRow {
  return {
    id: String(row.id),
    size: Number(row.size),
    type: String(row.type),
    pin: String(row.pin) as Pin["pin"],
    path: String(row.path),
    sig: row.statSig == null ? null : (JSON.parse(String(row.statSig)) as StatSig),
    chunkHashes: row.chunkHashes == null ? null : String(row.chunkHashes),
    state: String(row.state) as ContentRef["state"],
  };
}

function readRow(db: Db, id: string): ContentRow | null {
  const row = db.prepare("SELECT id, size, type, pin, path, statSig, chunkHashes, state FROM content WHERE id = ?").get(id);
  return row ? toRow(row) : null;
}

export class ContentService {
  readonly hasher: Hasher;
  private readonly ownHasher: boolean;
  private reader: Db | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: ContentServiceOptions) {
    this.ownHasher = !options.hasher;
    this.hasher = options.hasher ?? new Hasher();
  }

  get serverId(): string { return this.options.serverId; }
  get pinsDir(): string { return pinsDir(this.options.dataDir); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private audit(text: string): void { this.options.audit?.(text); }
  private db(): Db {
    if (!this.reader) this.reader = this.options.store.openReader();
    return this.reader;
  }

  // -------------------------------------------------------------------------------------------
  // Indexing

  /** Pins the files a finished line names. Null when it names none (nothing to record). Never throws for one file. */
  async prepareLine(botId: string, line: LineLike): Promise<PreparedLine | null> {
    const named = namedFiles(line, { dataDir: this.options.dataDir });
    if (!named.length) return null;
    const files: PreparedFile[] = [];
    const skipped: PreparedLine["skipped"] = [];
    for (const file of named) {
      try {
        files.push({ named: file, pin: await pinFile(file.path, this.pinsDir, this.options.pin) });
      } catch (error) {
        skipped.push({ path: file.path, reason: String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error) });
      }
    }
    return files.length || skipped.length ? { botId, lineId: line.id, files, skipped } : null;
  }

  /**
   * Inside the writer command that appended `entry` (the line's `message.added` or finishing `message.updated`): the
   * content rows, `content_refs` and `content_names` of the prepared line. Synchronous; throws roll the command back.
   */
  recordLine(db: Db, prepared: PreparedLine, entry: Pick<Entry, "stream" | "seq">): void {
    if (!db.inTransaction) throw new Error("recordLine must run inside the entry's writer command");
    const createdAt = this.now();
    const insertContent = db.prepare("INSERT INTO content (id, size, type, pin, path, statSig, chunkHashes, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, NULL, 'preparing', ?)");
    const insertRef = db.prepare("INSERT OR IGNORE INTO content_refs (id, stream, seq) VALUES (?, ?, ?)");
    const insertName = db.prepare("INSERT OR REPLACE INTO content_names (stream, seq, line, path, id) VALUES (?, ?, ?, ?, ?)");
    for (const { named, pin } of prepared.files) {
      insertContent.run(pin.pendingId, pin.size, named.type, pin.pin, pin.file, JSON.stringify(pin.sig), createdAt);
      insertRef.run(pin.pendingId, entry.stream, entry.seq);
      insertName.run(entry.stream, entry.seq, prepared.lineId, named.path, pin.pendingId);
    }
  }

  /** After the entry's command committed: hashes each pin and records `content.ready`. Resolves with the entries. */
  afterCommit(prepared: PreparedLine): Promise<Entry[]> {
    return this.track(Promise.all(prepared.files.map(({ pin }) => this.hashAndComplete(pin.pendingId, pin.file))).then((lists) => lists.flat()));
  }

  /**
   * The whole sequence for a caller that appends the line's entry itself in one command: pins, then one command that
   * appends `items` (the first one is the line's entry) and records the references, then hashing. Resolves once the
   * entry committed, with the entries and the promise of the `content.ready` entries.
   */
  async appendLine(stream: StreamId, botId: string, line: LineLike, items: Parameters<typeof appendEntries>[2]): Promise<{ entries: Entry[]; ready: Promise<Entry[]> }> {
    const prepared = await this.prepareLine(botId, line);
    const entries = await this.options.store.submit((db) => {
      const appended = appendEntries(db, stream, items, { now: this.now() });
      if (prepared && appended[0]) this.recordLine(db, prepared, appended[0]);
      return appended;
    });
    this.options.onCommitted?.([stream]);
    return { entries, ready: prepared ? this.afterCommit(prepared) : Promise.resolve([]) };
  }

  private async hashAndComplete(pendingId: string, file: string): Promise<Entry[]> {
    let result: HashResult;
    try {
      result = await this.hasher.hash(file);
    } catch (error) {
      if (this.closed) return [];
      this.audit(`content: hashing ${pendingId} failed: ${String((error as Error)?.message ?? error)}`);
      // A source that went away (a path pin) can never serve its version again.
      await this.options.store.submit((db) => { db.prepare("UPDATE content SET state = 'changed' WHERE id = ? AND pin = 'path'").run(pendingId); });
      return [];
    }
    if (this.closed) return [];
    const done = await this.options.store.submit((db) => this.complete(db, pendingId, result));
    if (done.drop) {
      try { rmSync(done.drop, { force: true }); } catch { /* the next start sweeps it */ }
    }
    if (done.entries.length) this.options.onCommitted?.([...new Set(done.entries.map((entry) => entry.stream))]);
    return done.entries;
  }

  /** The hash of a pending pin is known: one transaction moves its rows to the content id and appends `content.ready`. */
  complete(db: Db, pendingId: string, result: HashResult): { entries: Entry[]; drop: string | null } {
    const pending = readRow(db, pendingId);
    if (!pending || pending.state !== "preparing") return { entries: [], drop: null };
    // The bytes hashed must be the pinned bytes: a path pin rewritten (or replaced) since it was pinned is `changed`.
    if (!sameSig(result.before, pending.sig) || !sameSig(result.after, pending.sig) || result.size !== pending.size) {
      db.prepare("UPDATE content SET state = 'changed' WHERE id = ?").run(pendingId);
      return { entries: [], drop: null };
    }
    const id = result.id;
    let drop: string | null = null;
    const existing = readRow(db, id);
    if (existing && existing.state === "ready" && existing.pin !== "path") {
      // The same bytes are already kept: this pin is not needed.
      if (pending.pin !== "path") drop = pending.path;
    } else {
      if (existing && existing.pin !== "path" && existing.path !== pending.path) drop = existing.path;
      db.prepare(
        "INSERT INTO content (id, size, type, pin, path, statSig, chunkHashes, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?) " +
        "ON CONFLICT (id) DO UPDATE SET size = excluded.size, type = excluded.type, pin = excluded.pin, path = excluded.path, " +
        "statSig = excluded.statSig, chunkHashes = excluded.chunkHashes, state = 'ready'",
      ).run(id, pending.size, pending.type, pending.pin, pending.path, JSON.stringify(pending.sig), result.chunkHashes, this.now());
    }
    db.prepare("DELETE FROM content WHERE id = ?").run(pendingId);
    db.prepare("INSERT OR IGNORE INTO content_refs (id, stream, seq) SELECT ?, stream, seq FROM content_refs WHERE id = ?").run(id, pendingId);
    db.prepare("DELETE FROM content_refs WHERE id = ?").run(pendingId);
    const names = db.prepare("SELECT stream, seq, line, path FROM content_names WHERE id = ? ORDER BY stream, seq").all(pendingId);
    db.prepare("UPDATE content_names SET id = ? WHERE id = ?").run(id, pendingId);
    const kept = readRow(db, id)!;
    const entries: Entry[] = [];
    const insertRef = db.prepare("INSERT OR IGNORE INTO content_refs (id, stream, seq) VALUES (?, ?, ?)");
    for (const name of names) {
      const stream = String(name.stream) as StreamId;
      if (!stream.startsWith("bot:") || readStream(db, stream)?.state !== "active") continue;
      const path = String(name.path);
      const ref: ContentRef = {
        owner: this.serverId, id, size: kept.size, type: kept.type, name: basename(path).slice(0, 1_000) || "file",
        kind: contentTypeOf(path)?.kind ?? "file", pin: kept.pin, state: "ready",
      };
      const [entry] = appendEntries(db, stream, [{ kind: "content.ready", body: { botId: stream.slice(4), lineId: String(name.line), url: pathToFileURL(path).href, ref } }], { now: this.now() });
      insertRef.run(id, stream, entry!.seq);
      entries.push(entry!);
    }
    return { entries, drop };
  }

  /** A path pin no longer matches: `changed`, with `content.changed{id}` on each stream that references it. */
  async markChanged(id: string): Promise<void> {
    const streams = await this.options.store.submit((db) => {
      const { changes } = db.prepare("UPDATE content SET state = 'changed' WHERE id = ? AND state IN ('ready', 'preparing')").run(id);
      if (!changes || !id.startsWith("sha256:")) return [];
      const touched: StreamId[] = [];
      for (const row of db.prepare("SELECT DISTINCT stream FROM content_refs WHERE id = ? ORDER BY stream").all(id)) {
        const stream = String(row.stream) as StreamId;
        if (readStream(db, stream)?.state !== "active") continue;
        appendEntries(db, stream, [{ kind: "content.changed", body: { id } }], { now: this.now() });
        touched.push(stream);
      }
      return touched;
    });
    if (streams.length) this.options.onCommitted?.(streams);
  }

  // -------------------------------------------------------------------------------------------
  // Local socket requests (§9A.4): step 9's session passes `content.find` and `content.open` here

  async handle(message: ContentRequest): Promise<ContentAnswer> {
    return message.t === "content.find" ? this.find(message) : this.open(message);
  }

  /** Which reference line `line` of `botId` holds for the file `url` names. */
  find(message: MessageOf<"content.find">): MessageOf<"content.found"> {
    const path = pathOfFileRef(message.url);
    const stream = `bot:${message.botId}`;
    const name = path ? this.db().prepare("SELECT seq, id FROM content_names WHERE stream = ? AND line = ? AND path = ?").get(stream, message.line, path) : undefined;
    const row = name ? readRow(this.db(), String(name.id)) : null;
    if (!name || !row) return { t: "content.found", req: message.req, ref: null };
    return {
      t: "content.found", req: message.req,
      ref: { owner: this.serverId, id: row.id, type: row.type, state: row.state, entry: { stream: stream as StreamId, seq: Number(name.seq) } },
    };
  }

  /** The pinned file of a reference, for an entry that references it (§9A.7); otherwise `content.gone`. */
  async open(message: MessageOf<"content.open">): Promise<MessageOf<"content.file"> | MessageOf<"content.gone">> {
    const gone = (reason: MessageOf<"content.gone">["reason"]): MessageOf<"content.gone"> => ({ t: "content.gone", req: message.req, id: message.id, reason });
    if (message.owner !== this.serverId) return gone("offline"); // M1: one server; another owner's content is M3
    const db = this.db();
    const referenced = db.prepare("SELECT 1 FROM content_refs WHERE id = ? AND stream = ? AND seq = ?").get(message.id, message.entry.stream, message.entry.seq);
    if (!referenced) return gone("denied");
    if (message.variant !== "original") return gone("deleted"); // variants (posters, previews) come in M2
    const row = readRow(db, message.id);
    if (!row) return gone("deleted");
    if (row.state === "changed") return gone("changed");
    if (row.state === "gone") return gone("deleted");
    let now: StatSig | null = null;
    try { now = statSig(row.path); } catch { now = null; }
    if (!sameSig(now, row.sig)) {
      if (row.pin === "path") {
        await this.markChanged(row.id);
        return gone("changed");
      }
      return gone("deleted");
    }
    const chunks = row.pin === "path" && row.chunkHashes && row.chunkHashes.length <= CHUNK_HASHES_TEXT_LIMIT && CHUNK_BYTES === CONTENT_CHUNK_BYTES ? row.chunkHashes : undefined;
    return { t: "content.file", req: message.req, id: row.id, path: row.path, type: row.type, pin: row.pin, sig: row.sig!, ...(chunks ? { chunkHashes: chunks } : {}) };
  }

  // -------------------------------------------------------------------------------------------
  // Start and stop

  /**
   * Once at start, before any line is indexed: removes pin files no content row names, and hashes again every pin that
   * was still `preparing` when the server stopped. Resolves when those are done.
   */
  async recover(): Promise<{ swept: number; rehashed: number }> {
    const db = this.db();
    const keep = new Set(db.prepare("SELECT path FROM content WHERE pin IN ('clone', 'copy')").all().map((row) => String(row.path)));
    const swept = sweepPins(this.pinsDir, keep);
    const pending = db.prepare("SELECT id, path FROM content WHERE id LIKE 'pending:%' AND state = 'preparing' ORDER BY createdAt").all();
    await this.track(Promise.all(pending.map((row) => this.hashAndComplete(String(row.id), String(row.path)))));
    return { swept, rehashed: pending.length };
  }

  /** Resolves when every hashing job started so far has been recorded. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.ownHasher) await this.hasher.close();
    await Promise.allSettled([...this.inflight]);
    this.reader?.close();
    this.reader = null;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inflight.add(promise);
    const done = () => { this.inflight.delete(promise); };
    promise.then(done, done);
    return promise;
  }
}
