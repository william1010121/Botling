// Uploads from a front end (M2 step 12, protocol v1 §9A.9, D40): `content.put {req, id, size, type, name}` names the
// SHA-256 of the bytes it will send; the bytes follow as binary `content.chunk {req, offset}` frames on the bulk lane,
// within the `content.credit` window this server grants (4 MiB, renewed as it writes). The server keeps them in
// `<data>/uploads/`: `<hex>-<size>.part` while they come in, `<hex>` once the whole file is in and its hash checked.
//
// - Resume: a `content.put` for bytes already partly here answers `content.stored{have}` with what is on disk, and the
//   front end goes on from there (a dropped connection, another session, a restart of either side). `have = size` means
//   the file is here and checked.
// - Order: one session is a FIFO stream (D58), so a chunk must start exactly at `have`; one that does not (a chunk of an
//   older put of the same id, a sender that lost count) is not written, and the sender is told `have` again.
// - Hash: checked once the last byte is in, over the whole file. A mismatch deletes the part and answers
//   `content.gone{reason: "changed"}`: those bytes are never kept as that id.
// - One writer per id: a newer put of the same id takes it over (the older req's chunks are then refused).
// - Size: at most CONTENT_PUT_LIMIT (500 MB, the schema refuses more before a byte is written) and never more than
//   `size`.
// - The command that names the upload (a `chat.send` with `files`) waits for `whenComplete` (session-core: the slot is
//   `held` meanwhile) and its handler checks `complete` inside its transaction (intents/handlers.ts).
// Uploads are kept as content: nothing here deletes a finished upload (an LRU is left for later, see the evidence).
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, statSync } from "node:fs";
import { open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { CONTENT_PUT_LIMIT, type MessageOf } from "../../protocol";

/** The window granted after a put and topped up as bytes are written (v1 §9A.4: 4 MiB on direct sessions). */
export const UPLOAD_WINDOW = 4 * 1024 * 1024;
/** A held command waits at most this long without any new byte of its files before its handler decides (and refuses). */
export const UPLOAD_IDLE_MS = 10 * 60_000;

const HEX = /^[0-9a-f]{64}$/;
const hexOf = (id: string): string | null => {
  const hex = id.startsWith("sha256:") ? id.slice(7) : "";
  return HEX.test(hex) ? hex : null;
};

/** What the server answers on the session for a put or a chunk (none: nothing to say yet). */
export type UploadReply = MessageOf<"content.stored"> | MessageOf<"content.credit"> | MessageOf<"content.gone">;

interface Writer {
  req: string;
  owner: string;
  id: string;
  hex: string;
  size: number;
  have: number;
  /** Bytes this server still lets the sender send. */
  credit: number;
  file: FileHandle | null;
  closed: boolean;
}

export interface UploadsOptions {
  /** `<data>/uploads`. */
  dir: string;
  log?: (line: string) => void;
  now?: () => number;
  window?: number;
}

export class Uploads {
  private readonly writers = new Map<string, Writer>();
  /** The writer of each id (one at a time). */
  private readonly byId = new Map<string, Writer>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** When each id last got a byte (or was put), for the held command's idle rule. */
  private readonly touched = new Map<string, number>();
  /** Ids whose last upload in this process was refused (the bytes did not hash to the id), until put again. */
  private readonly refusedIds = new Set<string>();
  private readonly now: () => number;
  private readonly window: number;

  constructor(private readonly options: UploadsOptions) {
    this.now = options.now ?? Date.now;
    this.window = options.window ?? UPLOAD_WINDOW;
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  }

  /** The finished, checked file of an id, or null. */
  complete(id: string): { path: string; size: number } | null {
    const hex = hexOf(id);
    if (!hex) return null;
    const path = join(this.options.dir, hex);
    try {
      const info = statSync(path);
      return info.isFile() ? { path, size: info.size } : null;
    } catch { return null; }
  }

  /** Whether the last upload of an id was refused (its bytes did not hash to it) and none came since. */
  refused(id: string): boolean { return this.refusedIds.has(id); }

  /** How many bytes of an id are here (finished: its size). */
  have(id: string, size: number): number {
    const hex = hexOf(id);
    if (!hex) return 0;
    if (this.complete(id)) return size;
    const writer = this.byId.get(id);
    if (writer && writer.size === size) return writer.have;
    try { return Math.min(size, statSync(this.partPath(hex, size)).size); } catch { return 0; }
  }

  /** When an id last made progress (ms), or null when nothing of it came in this process. */
  lastProgress(id: string): number | null { return this.touched.get(id) ?? null; }

  /**
   * Resolves `ready` once every id is complete, `closed` when `closed` settles first, `idle` when none of them got a byte
   * for `idleMs`, `refused` as soon as one of them was refused (its bytes did not hash to it): the handler then decides,
   * and refuses what is missing.
   */
  async whenComplete(ids: string[], closed: Promise<void>, idleMs = UPLOAD_IDLE_MS): Promise<"ready" | "closed" | "idle" | "refused"> {
    const start = this.now();
    for (;;) {
      const missing = ids.filter((id) => !this.complete(id));
      if (!missing.length) return "ready";
      if (missing.some((id) => this.refusedIds.has(id))) return "refused";
      const last = Math.max(start, ...missing.map((id) => this.touched.get(id) ?? 0));
      const left = last + idleMs - this.now();
      if (left <= 0) return "idle";
      const outcome = await new Promise<"tick" | "closed">((resolve) => {
        const wake = () => { clearTimeout(timer); for (const id of missing) this.waiters.get(id)?.delete(wake); resolve("tick"); };
        const timer = setTimeout(wake, Math.min(left, 30_000));
        timer.unref?.();
        for (const id of missing) { let set = this.waiters.get(id); if (!set) this.waiters.set(id, (set = new Set())); set.add(wake); }
        void closed.then(() => { clearTimeout(timer); for (const id of missing) this.waiters.get(id)?.delete(wake); resolve("closed"); });
      });
      if (outcome === "closed") return "closed";
    }
  }

  /** A `content.put` from session `owner`: what is here, and the window for the rest. */
  async put(owner: string, message: MessageOf<"content.put">): Promise<UploadReply[]> {
    const hex = hexOf(message.id);
    if (!hex || message.size > CONTENT_PUT_LIMIT) return [{ t: "content.gone", req: message.req, id: message.id, reason: "too-large" }];
    this.refusedIds.delete(message.id);
    this.touch(message.id);
    if (this.complete(message.id)) return [{ t: "content.stored", req: message.req, id: message.id, have: message.size }];
    // A newer put of the same id takes it over; a put again under the same req starts that req over.
    const previous = this.byId.get(message.id);
    if (previous) await this.closeWriter(previous);
    const old = this.writers.get(message.req);
    if (old) await this.closeWriter(old);
    const path = this.partPath(hex, message.size);
    let have = 0;
    try { have = (await stat(path)).size; } catch { have = 0; }
    if (have > message.size) { await rm(path, { force: true }); have = 0; }
    const writer: Writer = { req: message.req, owner, id: message.id, hex, size: message.size, have, credit: this.window, file: null, closed: false };
    this.writers.set(message.req, writer);
    this.byId.set(message.id, writer);
    if (have === message.size) return this.finish(writer);
    return [{ t: "content.stored", req: message.req, id: message.id, have }, { t: "content.credit", req: message.req, bytes: this.window }];
  }

  /** A `content.chunk` of an upload from session `owner`. */
  async chunk(owner: string, message: MessageOf<"content.chunk">): Promise<UploadReply[]> {
    const writer = this.writers.get(message.req);
    if (!writer || writer.closed || writer.owner !== owner || this.byId.get(writer.id) !== writer) return [];
    const bytes = message.bytes;
    if (message.offset !== writer.have || writer.have + bytes.length > writer.size || bytes.length > writer.credit) {
      // Not where this server is: tell the sender where it is (it goes on from there, a new window with it).
      writer.credit = this.window;
      return [{ t: "content.stored", req: writer.req, id: writer.id, have: writer.have }, { t: "content.credit", req: writer.req, bytes: this.window }];
    }
    writer.file ??= await open(this.partPath(writer.hex, writer.size), "a", 0o600);
    await writer.file.write(bytes, 0, bytes.length, null);
    writer.have += bytes.length;
    writer.credit -= bytes.length;
    this.touch(writer.id);
    if (writer.have === writer.size) return this.finish(writer);
    const out: UploadReply[] = [];
    // Top the window up once half of it is used, so the sender never waits on a round trip.
    if (writer.credit <= this.window / 2) {
      const grant = this.window - writer.credit;
      writer.credit += grant;
      out.push({ t: "content.credit", req: writer.req, bytes: grant });
    }
    return out;
  }

  /** The session `owner` ended: its writers stop (their parts stay for a resume). */
  async ended(owner: string): Promise<void> {
    for (const writer of [...this.writers.values()]) if (writer.owner === owner) await this.closeWriter(writer);
  }

  /** Finished uploads and parts on disk (diagnostics, tests). */
  list(): string[] {
    try { return readdirSync(this.options.dir).sort(); } catch { return []; }
  }

  private partPath(hex: string, size: number): string { return join(this.options.dir, `${hex}-${size}.part`); }

  private touch(id: string): void {
    this.touched.set(id, this.now());
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }

  private async closeWriter(writer: Writer): Promise<void> {
    if (writer.closed) return;
    writer.closed = true;
    if (this.writers.get(writer.req) === writer) this.writers.delete(writer.req);
    if (this.byId.get(writer.id) === writer) this.byId.delete(writer.id);
    const file = writer.file;
    writer.file = null;
    await file?.close().catch(() => undefined);
  }

  private async finish(writer: Writer): Promise<UploadReply[]> {
    const file = writer.file;
    writer.file = null;
    if (file) { await file.sync().catch(() => undefined); await file.close().catch(() => undefined); }
    await this.closeWriter(writer);
    const part = this.partPath(writer.hex, writer.size);
    const digest = await hashFile(part);
    if (digest !== writer.hex) {
      await rm(part, { force: true });
      this.refusedIds.add(writer.id);
      this.touch(writer.id);
      this.options.log?.(`uploads: ${writer.id} refused: its bytes hash to sha256:${digest.slice(0, 12)}…`);
      return [{ t: "content.gone", req: writer.req, id: writer.id, reason: "changed" }];
    }
    await rename(part, join(this.options.dir, writer.hex));
    this.options.log?.(`uploads: ${writer.id} in (${writer.size} bytes)`);
    this.touch(writer.id);
    return [{ t: "content.stored", req: writer.req, id: writer.id, have: writer.size }];
  }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}
