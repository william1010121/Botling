// The content path's local part on the owner (protocol v1 §9A.2–§9A.4, §9A.7, D44).
//
// When a chat line finishes, the files it names are indexed:
//   1. `noteLine(tx, botId, line, entry)` (synchronous, inside the writer command that appended the line's entry: the
//      event tap's `lineStored` hook, see `contentLineHook`): a `content` row per named file of an indexed kind, known as
//      `pending:<hex>` (state `preparing`, `pin: path` on the source with its stat signature as it is now),
//      `content_refs (id, stream, seq)` for the entry and `content_names` (which file of the line it is). Same
//      transaction as the entry: neither exists without the other.
//   2. `afterCommit(noted)`: each source is pinned (pin.ts: APFS clone, a copy ≤ 64 MiB, else it stays `pin: path`)
//      and the pin is kept only if the source still has the signature noted in step 1 (else the row is `changed`: the
//      line never shows bytes other than those it finished with). Then the pin is hashed in the worker thread
//      (hasher.ts) and one command moves the line's rows from the pending id to the `sha256:` id and appends
//      `content.ready{botId, lineId, url, ref}` (with its own `content_refs` row). The window may open the pending row
//      meanwhile: served with the signature check of a `pin: path` file. The same command records
//      `content_aliases (pending, id)`, so a pending id a front end got from `content.find` just before still opens
//      (as the content id, whose `content_refs` now hold the line's entry).
// `content.find` / `content.open` (local socket) are answered by `handle`. `recover` runs once at start.
//
// A reference serves the bytes of its hash or nothing (§9A.3): a `pin: path` file whose stat signature no longer matches
// is marked `changed` (with `content.changed{id}` on each stream that references it) and answers `content.gone{changed}`.
import { realpathSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTENT_CHUNK_BYTES, type ContentRef, type Entry, type MessageOf, type StreamId } from "../../protocol";
import { appendEntries, inRead, readStream } from "../log";
import type { Command, Db, SqlRow } from "../store";
import { contentTypeOf, namedFiles, pathOfFileRef, type LineLike, type NamedFile } from "./files";
import { CHUNK_BYTES, Hasher, type HashResult } from "./hasher";
import { newPendingHex, pinFile, pinsDir, sameSig, statSig, sweepPins, type Pin, type PinOptions, type StatSig } from "./pin";

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

/** What the content service needs of the media jobs (src/server/media `MediaJobs`, M2 step 10). */
export interface ContentMedia {
  /** Inside the command that made `id` ready: queue its job. */
  enqueue(db: Db, id: string, type: string): void;
  /** After that command committed: run the queue. */
  kick(): void;
  /** A ready variant's file, or null (not made, evicted: the FE falls back to the original). */
  openVariant(srcId: string, name: string): Promise<{ path: string; type: string; sig: StatSig } | null>;
}

export interface NotedFile {
  /** `pending:<hex>` until hashed. */
  id: string;
  named: NamedFile;
}

/** What `noteLine` recorded: `afterCommit` pins and hashes it. */
export interface NotedLine {
  botId: string;
  lineId: string;
  files: NotedFile[];
  /** Named files that are not readable regular files (missing, a folder): the line shows them through the 2.x path. */
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
  private media: ContentMedia | null = null;

  constructor(private readonly options: ContentServiceOptions) {
    this.ownHasher = !options.hasher;
    this.hasher = options.hasher ?? new Hasher();
  }

  get serverId(): string { return this.options.serverId; }
  /** M2 step 10: the media jobs (variants). Before `recover`, so every content made ready has its job. */
  attachMedia(media: ContentMedia | null): void { this.media = media; }
  get pinsDir(): string { return pinsDir(this.options.dataDir); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private audit(text: string): void { this.options.audit?.(text); }
  private db(): Db {
    if (!this.reader) this.reader = this.options.store.openReader();
    return this.reader;
  }

  // -------------------------------------------------------------------------------------------
  // Indexing

  /**
   * Inside the writer command that appended `entry` (the line's `message.added`, or the `message.updated` that finished
   * it): the content rows, `content_refs` and `content_names` of the files the line names. Synchronous (a stat per
   * file); never throws for one file. Null when the line names no file of an indexed kind.
   */
  noteLine(db: Db, botId: string, line: LineLike, entry: Pick<Entry, "stream" | "seq">): NotedLine | null {
    if (!db.inTransaction) throw new Error("noteLine must run inside the entry's writer command");
    const named = namedFiles(line, { dataDir: this.options.dataDir });
    if (!named.length) return null;
    const createdAt = this.now();
    const insertContent = db.prepare("INSERT INTO content (id, size, type, pin, path, statSig, chunkHashes, state, createdAt) VALUES (?, ?, ?, 'path', ?, ?, NULL, 'preparing', ?)");
    const insertRef = db.prepare("INSERT OR IGNORE INTO content_refs (id, stream, seq) VALUES (?, ?, ?)");
    const insertName = db.prepare("INSERT OR REPLACE INTO content_names (stream, seq, line, path, id, sig) VALUES (?, ?, ?, ?, ?, ?)");
    const knownName = db.prepare("SELECT n.id AS id, n.sig AS sig FROM content_names n JOIN content c ON c.id = n.id WHERE n.stream = ? AND n.line = ? AND n.path = ? AND c.state IN ('preparing', 'ready')");
    const files: NotedFile[] = [];
    const skipped: NotedLine["skipped"] = [];
    for (const file of named) {
      let source: string;
      let sig: StatSig;
      try {
        source = realpathSync(file.path);
        if (!statSync(source).isFile()) throw new Error("not a regular file");
        sig = statSig(source);
      } catch (error) {
        skipped.push({ path: file.path, reason: String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error) });
        continue;
      }
      const sigText = JSON.stringify(sig);
      // The line was updated again (an edit, a reaction) and names the same version: this entry references it too.
      const known = knownName.get(entry.stream, line.id, file.path);
      if (known && known.sig === sigText) {
        insertRef.run(String(known.id), entry.stream, entry.seq);
        continue;
      }
      const id = `pending:${newPendingHex()}`;
      insertContent.run(id, sig.size, file.type, source, sigText, createdAt);
      insertRef.run(id, entry.stream, entry.seq);
      insertName.run(entry.stream, entry.seq, line.id, file.path, id, sigText);
      files.push({ id, named: file });
    }
    return files.length || skipped.length ? { botId, lineId: line.id, files, skipped } : null;
  }

  /** After the entry's command committed: pins and hashes each noted file, then records `content.ready`. */
  afterCommit(noted: NotedLine): Promise<Entry[]> {
    return this.track(Promise.all(noted.files.map(({ id }) => this.pinAndHash(id))).then((lists) => lists.flat()));
  }

  /**
   * The whole sequence for a caller that appends the line's entry itself in one command: one command that appends
   * `items` (the first one is the line's entry) and notes the line, then pinning and hashing. Resolves once the entry
   * committed, with the entries and the promise of the `content.ready` entries.
   */
  async appendLine(stream: StreamId, botId: string, line: LineLike, items: Parameters<typeof appendEntries>[2]): Promise<{ entries: Entry[]; ready: Promise<Entry[]> }> {
    let noted: NotedLine | null = null;
    const entries = await this.options.store.submit((db) => {
      const appended = appendEntries(db, stream, items, { now: this.now() });
      noted = appended[0] ? this.noteLine(db, botId, line, appended[0]) : null;
      return appended;
    });
    this.options.onCommitted?.([stream]);
    const done: NotedLine | null = noted;
    return { entries, ready: done ? this.afterCommit(done) : Promise.resolve([]) };
  }

  /**
   * A noted row's pin: a clone or copy of its source in the content store when the source still has the signature it
   * had when the line finished; the source itself (`pin: path`) when it cannot be cloned and is too large to copy;
   * `changed` when the source is gone or was rewritten since. Then its hash.
   */
  private async pinAndHash(id: string): Promise<Entry[]> {
    const row = readRow(this.db(), id);
    if (!row || row.state !== "preparing") return [];
    let file = row.path;
    if (row.pin === "path" && !this.inPins(row.path)) {
      let pin: Pin | null = null;
      let same = false;
      try {
        same = sameSig(statSig(row.path), row.sig);
        if (same) pin = await pinFile(row.path, this.pinsDir, this.options.pin);
        same = same && sameSig(statSig(row.path), row.sig) && (!pin || pin.size === row.size);
      } catch (error) {
        this.audit(`content: pinning ${id} failed: ${String((error as Error)?.message ?? error)}`);
        same = false;
      }
      const made = pin && pin.pin !== "path" ? pin : null;
      if (this.closed) { if (made) rmSync(made.file, { force: true }); return []; }
      // True when the row now names the pin (or stays `pin: path`); false when it is `changed` or no longer preparing.
      const kept = await this.options.store.submit((db) => {
        if (!same) {
          db.prepare("UPDATE content SET state = 'changed' WHERE id = ? AND state = 'preparing'").run(id);
          return false;
        }
        if (!made) return true;
        return db.prepare("UPDATE content SET pin = ?, path = ?, statSig = ? WHERE id = ? AND state = 'preparing'")
          .run(made.pin, made.file, JSON.stringify(made.sig), id).changes > 0;
      });
      if (made && !kept) rmSync(made.file, { force: true });
      if (!kept) return [];
      if (made) file = made.file;
    }
    return this.hashAndComplete(id, file);
  }

  private inPins(path: string): boolean {
    return path.startsWith(`${this.pinsDir}/`);
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
    this.media?.kick();
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
    // A front end may still hold the pending id (`content.find` answered it a moment ago): it keeps resolving.
    db.prepare("INSERT OR REPLACE INTO content_aliases (pending, id) VALUES (?, ?)").run(pendingId, id);
    const kept = readRow(db, id)!;
    this.media?.enqueue(db, id, kept.type);
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
    const db = this.db();
    const { name, row } = inRead(db, () => {
      const name = path ? db.prepare("SELECT seq, id FROM content_names WHERE stream = ? AND line = ? AND path = ?").get(stream, message.line, path) : undefined;
      return { name, row: name ? readRow(db, String(name.id)) : null };
    });
    if (!name || !row) return { t: "content.found", req: message.req, ref: null };
    return {
      t: "content.found", req: message.req,
      ref: { owner: this.serverId, id: row.id, type: row.type, state: row.state, entry: { stream: stream as StreamId, seq: Number(name.seq) } },
    };
  }

  /**
   * Whether a remote front end may read `stream` now (§9A.7 "a stream the requester may read"): a bot's chat stream
   * that is active or archived. Table streams, retired, stale or gone streams hold no reference a device may open.
   */
  readableStream(stream: string, db: Db = this.db()): boolean {
    if (!stream.startsWith("bot:")) return false;
    const state = readStream(db, stream)?.state;
    return state === "active" || state === "archived";
  }

  /**
   * A remote front end's lookup (`content.locate`, M2 step 9): `find`, but only in a stream the device may read; a
   * pending id is answered as `preparing` with its content id only once hashed (a remote page never opens a pending id).
   */
  locate(message: { botId: string; line: string; url: string }): MessageOf<"content.found">["ref"] {
    const stream = `bot:${message.botId}`;
    const db = this.db();
    return inRead(db, () => {
      if (!this.readableStream(stream, db)) return null;
      return this.find({ t: "content.find", req: "locate", botId: message.botId, line: message.line, url: message.url }).ref;
    });
  }

  /**
   * The pinned file of a reference, for an entry that references it (§9A.7); otherwise `content.gone`.
   * `remote`: a device's request (the tailnet path): only a content id (never a pending one), only in a readable stream.
   */
  async open(message: MessageOf<"content.open">, options: { remote?: boolean } = {}): Promise<MessageOf<"content.file"> | MessageOf<"content.gone">> {
    const gone = (reason: MessageOf<"content.gone">["reason"]): MessageOf<"content.gone"> => ({ t: "content.gone", req: message.req, id: message.id, reason });
    if (message.owner !== this.serverId) return gone("offline"); // M1: one server; another owner's content is M3
    if (options.remote && !message.id.startsWith("sha256:")) return gone("denied");
    const db = this.db();
    // One read: the hash's command may move a pending id's rows to its content id between two statements.
    const read = inRead(db, () => {
      const id = this.resolve(db, message.id);
      const referenced = !!db.prepare("SELECT 1 FROM content_refs WHERE id = ? AND stream = ? AND seq = ?").get(id, message.entry.stream, message.entry.seq)
        && (!options.remote || this.readableStream(message.entry.stream, db));
      return { referenced, row: referenced ? readRow(db, id) : null };
    });
    if (!read.referenced) return gone("denied");
    const row = read.row;
    if (!row) return gone("deleted");
    if (row.state === "changed") return gone("changed");
    if (row.state === "gone") return gone("deleted");
    if (message.variant !== "original") {
      // A variant (poster, preview, thumbnail; M2 step 10) under the source's proof of reference: a file the owner made
      // from the hashed bytes, kept in its variants folder (served as a copy, after its own signature check).
      if (row.state !== "ready" || !row.id.startsWith("sha256:")) return gone("deleted");
      const variant = await this.media?.openVariant(row.id, message.variant);
      if (!variant) return gone("deleted");
      return { t: "content.file", req: message.req, id: message.id, path: variant.path, type: variant.type, pin: "copy", sig: variant.sig };
    }
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
    // `id` is the one asked for (as in `content.gone`), also when a pending id resolved to its content id.
    return { t: "content.file", req: message.req, id: message.id, path: row.path, type: row.type, pin: row.pin, sig: row.sig!, ...(chunks ? { chunkHashes: chunks } : {}) };
  }

  /**
   * The chunk hashes (base64, one SHA-256 per MiB) of a ready content id, whatever its pin (M3 step 10: a peer server
   * verifies every chunk it passes on against them); null when not known.
   */
  chunkHashesOf(id: string): string | null {
    const row = readRow(this.db(), this.resolve(this.db(), id));
    return row && row.state === "ready" && row.chunkHashes != null ? row.chunkHashes : null;
  }

  /**
   * The id a request names, as stored now: a `pending:` id whose hash is ready (its row moved to the content id, in the
   * same transaction as `content_aliases`) is its content id; any other id is itself. Opening the pending id then serves
   * the content id's file, with the proof of reference the content id holds for the same entry.
   */
  private resolve(db: Db, id: string): string {
    if (!id.startsWith("pending:")) return id;
    const alias = db.prepare("SELECT id FROM content_aliases WHERE pending = ?").get(id);
    return alias ? String(alias.id) : id;
  }

  // -------------------------------------------------------------------------------------------
  // Start and stop

  /**
   * Once at start, before any line is indexed: removes pin files no content row names (a crash between a pin and the
   * command that records it), then pins (if not yet) and hashes every row still `preparing`. Resolves when done.
   */
  async recover(): Promise<{ swept: number; rehashed: number }> {
    const db = this.db();
    const keep = new Set(db.prepare("SELECT path FROM content WHERE pin IN ('clone', 'copy')").all().map((row) => String(row.path)));
    const swept = sweepPins(this.pinsDir, keep);
    const pending = db.prepare("SELECT id FROM content WHERE id LIKE 'pending:%' AND state = 'preparing' ORDER BY createdAt").all();
    await this.track(Promise.all(pending.map((row) => this.pinAndHash(String(row.id)))));
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
