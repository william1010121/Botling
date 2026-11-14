// A front end's uploads to its server (M2 step 12, protocol v1 §9A.9, D40). Each file is hashed as it is read (SHA-256
// in pieces, sha256.ts), then sent: `content.put {req, id, size, type, name}`, the server answers `content.stored{have}`
// and a `content.credit` window, and binary `content.chunk`s follow from `have`, never beyond the window. When the
// session ends the upload waits; on the next session it puts again and goes on from what the server has (no restart from
// 0). The command naming the file (a `chat.send` with `files`) is written to the outbox once the hash is known; the
// server holds it until the bytes are in.
//
// - A file above 500 MB, or empty, is refused here before anything is sent.
// - `content.gone{changed}`: the server found the bytes do not hash to the id (refused, never kept); `denied`: this device
//   may not upload; `too-large`: the server's limit. These end the upload ("failed"). `offline` waits for the next session.
// - Memory: the file is read 1 MiB at a time, for hashing and again for sending; nothing keeps the whole file.
// Pure TypeScript, isomorphic; the link is a small port (FeLink has it).
import { UPLOAD_LIMIT } from "../contract";
import type { MessageOf } from "../protocol";
import { Sha256 } from "./sha256";

/** The bytes of a file to upload (a browser `Blob`, a Node buffer, a test array). */
export interface UploadSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type UploadAnswer = MessageOf<"content.stored"> | MessageOf<"content.credit"> | MessageOf<"content.gone">;

/** What the uploader needs of FeLink. */
export interface UploadLink {
  readonly attached: boolean;
  newReq(): string;
  postUpload(message: MessageOf<"content.put"> | MessageOf<"content.chunk">): boolean;
  onUpload(req: string, listener: (message: UploadAnswer) => void): () => void;
  on(listener: (event: { type: string; attached?: boolean }) => void): () => void;
}

export type UploadState = "hashing" | "waiting" | "uploading" | "done" | "failed" | "removed";

export interface UploadView {
  key: string;
  name: string;
  type: string;
  size: number;
  id: string | null;
  state: UploadState;
  /** Bytes the server confirmed it holds (or sent and in its window). */
  sent: number;
  error?: string;
  /** How many times a session put it (1 = no resume needed). */
  puts: number;
  /** Where each put after the first went on from (`have`): the resume points. */
  resumedAt: number[];
}

export const UPLOAD_CHUNK = 64 * 1024;
const READ_BYTES = 1024 * 1024;
export const TOO_LARGE_TEXT = "This file is larger than 500 MB, the most a page can send.";

interface Job {
  view: UploadView;
  source: UploadSource;
  /** Resolves with the id once hashed (rejects when it fails or is removed first). */
  idReady: Promise<string>;
  resolveId(id: string): void;
  rejectId(error: Error): void;
  req: string | null;
  off: (() => void) | null;
  credit: number;
  offset: number;
  pumping: boolean;
  /** The first `content.stored` of the current put is still to come (it is the resume point). */
  fresh: boolean;
  buffer: { at: number; bytes: Uint8Array } | null;
}

export class Uploader {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;
  private readonly offLink: () => void;
  private readonly listeners = new Set<(view: UploadView) => void>();
  private readonly chunkBytes: number;

  constructor(private readonly link: UploadLink, options: { chunkBytes?: number } = {}) {
    this.chunkBytes = Math.max(1, Math.min(options.chunkBytes ?? UPLOAD_CHUNK, 128 * 1024));
    this.offLink = link.on((event) => {
      if (event.type !== "attached") return;
      for (const job of this.jobs.values()) {
        if (event.attached) this.begin(job);
        else this.detach(job);
      }
    });
  }

  /** Hears every change of an upload (state, progress). */
  onChange(listener: (view: UploadView) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Starts an upload; refused at once (state `failed`) above 500 MB or when empty. */
  add(file: { name: string; type: string; source: UploadSource }): UploadView {
    const key = `u${++this.counter}-${Date.now().toString(36)}`;
    let resolveId!: (id: string) => void;
    let rejectId!: (error: Error) => void;
    const idReady = new Promise<string>((resolve, reject) => { resolveId = resolve; rejectId = reject; });
    idReady.catch(() => undefined);
    const size = file.source.size;
    const view: UploadView = { key, name: file.name || "file", type: file.type || "application/octet-stream", size, id: null, state: "hashing", sent: 0, puts: 0, resumedAt: [] };
    const job: Job = { view, source: file.source, idReady, resolveId, rejectId, req: null, off: null, credit: 0, offset: 0, pumping: false, fresh: false, buffer: null };
    this.jobs.set(key, job);
    if (size > UPLOAD_LIMIT) { this.fail(job, TOO_LARGE_TEXT); return { ...view }; }
    if (size < 1) { this.fail(job, "This file is empty."); return { ...view }; }
    void this.hash(job);
    return { ...view };
  }

  /** The id of an upload once hashed (waits for it). */
  id(key: string): Promise<string> {
    const job = this.jobs.get(key);
    return job ? job.idReady : Promise.reject(new Error("no such upload"));
  }

  get(key: string): UploadView | null {
    const job = this.jobs.get(key);
    return job ? { ...job.view, resumedAt: [...job.view.resumedAt] } : null;
  }

  list(): UploadView[] { return [...this.jobs.values()].map((job) => ({ ...job.view, resumedAt: [...job.view.resumedAt] })); }

  /** Stops an upload and forgets it (the server keeps what it has; a later put of the same file goes on from there). */
  remove(key: string): void {
    const job = this.jobs.get(key);
    if (!job) return;
    this.detach(job);
    this.jobs.delete(key);
    job.rejectId(new Error("removed"));
    job.view.state = "removed";
    this.changed(job);
  }

  close(): void {
    this.offLink();
    for (const job of this.jobs.values()) this.detach(job);
    this.jobs.clear();
  }

  private changed(job: Job): void {
    const view = { ...job.view, resumedAt: [...job.view.resumedAt] };
    for (const listener of [...this.listeners]) listener(view);
  }

  private fail(job: Job, error: string): void {
    this.detach(job);
    job.view.state = "failed";
    job.view.error = error;
    job.rejectId(new Error(error));
    this.changed(job);
  }

  private async hash(job: Job): Promise<void> {
    const hash = new Sha256();
    try {
      for (let at = 0; at < job.view.size; at += READ_BYTES) {
        if (!this.jobs.has(job.view.key)) return;
        hash.update(await job.source.read(at, Math.min(READ_BYTES, job.view.size - at)));
      }
    } catch (error) {
      this.fail(job, `This file could not be read: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    if (!this.jobs.has(job.view.key)) return;
    job.view.id = `sha256:${hash.hex()}`;
    job.view.state = "waiting";
    job.resolveId(job.view.id);
    this.changed(job);
    if (this.link.attached) this.begin(job);
  }

  /** A session is attached: put (again) and go on from what the server has. */
  private begin(job: Job): void {
    if (job.view.state !== "waiting" && job.view.state !== "uploading") return;
    if (!job.view.id || !this.link.attached) return;
    this.detach(job);
    const req = this.link.newReq();
    job.req = req;
    job.credit = 0;
    job.fresh = true;
    job.off = this.link.onUpload(req, (message) => this.answer(job, req, message));
    job.view.puts += 1;
    if (!this.link.postUpload({ t: "content.put", req, id: job.view.id, size: job.view.size, type: job.view.type.slice(0, 200), name: job.view.name.slice(0, 1_000) })) { this.detach(job); return; }
    job.view.state = "uploading";
    this.changed(job);
  }

  private detach(job: Job): void {
    job.off?.();
    job.off = null;
    job.req = null;
    job.credit = 0;
    if (job.view.state === "uploading") { job.view.state = "waiting"; this.changed(job); }
  }

  private answer(job: Job, req: string, message: UploadAnswer): void {
    if (job.req !== req) return;
    switch (message.t) {
      case "content.stored":
        if (message.have >= job.view.size) {
          job.view.sent = job.view.size;
          job.view.state = "done";
          job.off?.(); job.off = null; job.req = null;
          this.changed(job);
          return;
        }
        if (job.fresh && job.view.puts > 1) job.view.resumedAt.push(message.have);
        job.fresh = false;
        job.offset = message.have;
        job.view.sent = message.have;
        job.credit = 0;
        this.changed(job);
        return;
      case "content.credit":
        job.credit += message.bytes;
        void this.pump(job, req);
        return;
      case "content.gone":
        if (message.reason === "offline") { this.detach(job); return; }
        this.fail(job, message.reason === "changed" ? "The server refused this file: its bytes did not match their hash."
          : message.reason === "denied" ? "This device may not send files." : TOO_LARGE_TEXT);
        return;
    }
  }

  private async pump(job: Job, req: string): Promise<void> {
    if (job.pumping) return;
    job.pumping = true;
    try {
      while (job.req === req && job.credit > 0 && job.offset < job.view.size && this.jobs.has(job.view.key)) {
        const offset = job.offset;
        const length = Math.min(this.chunkBytes, job.credit, job.view.size - offset);
        const bytes = await this.bytesAt(job, offset, length);
        if (job.req !== req || job.offset !== offset) break;
        if (!this.link.postUpload({ t: "content.chunk", req, offset, bytes })) break;
        job.offset = offset + bytes.length;
        job.credit -= bytes.length;
        job.view.sent = job.offset;
        if (job.offset === job.view.size || (job.offset % READ_BYTES) < this.chunkBytes) this.changed(job);
      }
    } catch (error) {
      this.fail(job, `This file could not be read: ${String((error as Error)?.message ?? error)}`);
    } finally {
      job.pumping = false;
    }
  }

  /** `length` bytes at `offset`, from a 1 MiB read kept between chunks. */
  private async bytesAt(job: Job, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const held = job.buffer;
    if (!held || offset < held.at || offset + length > held.at + held.bytes.length) {
      const at = offset;
      job.buffer = { at, bytes: await job.source.read(at, Math.min(READ_BYTES, job.view.size - at)) };
    }
    const buffer = job.buffer!;
    return new Uint8Array(buffer.bytes.subarray(offset - buffer.at, offset - buffer.at + length));
  }
}
