// Hashing pinned files in a worker thread (protocol v1 §9A.2, D44): the SHA-256 of the whole file (its content id) and
// one SHA-256 per 1 MiB chunk, in one read pass. M0 measured 100–270 MB/s for both on a busy Mac, 5–10 ms per 1 MiB
// `update`: on the server's event loop that would stall the writer and every session, so it runs here.
//
// The worker is an inline CommonJS script (`eval: true`), so the bundled server (out/server/main.cjs) needs no second
// file. It reads through one descriptor and reports the descriptor's stat signature before and after, so a caller can
// tell a file that changed while it was read. Jobs run one at a time per worker; the worker is unref'd while idle and
// never keeps the process alive.
import { Worker } from "node:worker_threads";
import type { StatSig } from "./pin";

export const CHUNK_BYTES = 1024 * 1024;

export interface HashResult {
  /** `sha256:<hex>`. */
  id: string;
  size: number;
  /** The raw 32-byte digests of each 1 MiB chunk, one after another, in base64. */
  chunkHashes: string;
  before: StatSig;
  after: StatSig;
  ms: number;
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { openSync, readSync, closeSync, fstatSync } = require("node:fs");
const CHUNK = ${CHUNK_BYTES};
const sig = (s) => ({ size: Number(s.size), mtimeNs: String(s.mtimeNs), ino: String(s.ino) });
parentPort.on("message", ({ job, path }) => {
  const started = Date.now();
  let fd = -1;
  try {
    fd = openSync(path, "r");
    const before = sig(fstatSync(fd, { bigint: true }));
    const whole = createHash("sha256");
    const chunks = [];
    const buf = Buffer.allocUnsafe(CHUNK);
    let size = 0;
    for (;;) {
      let n = 0;
      while (n < CHUNK) { const r = readSync(fd, buf, n, CHUNK - n, null); if (r === 0) break; n += r; }
      if (n === 0) break;
      const part = buf.subarray(0, n);
      whole.update(part);
      chunks.push(createHash("sha256").update(part).digest());
      size += n;
      if (n < CHUNK) break;
    }
    const after = sig(fstatSync(fd, { bigint: true }));
    parentPort.postMessage({ job, ok: true, id: "sha256:" + whole.digest("hex"), size, chunkHashes: Buffer.concat(chunks).toString("base64"), before, after, ms: Date.now() - started });
  } catch (error) {
    parentPort.postMessage({ job, ok: false, error: String((error && error.message) || error) });
  } finally {
    if (fd >= 0) try { closeSync(fd); } catch {}
  }
});
`;

interface Job { job: number; path: string; resolve(result: HashResult): void; reject(error: Error): void }

/** One hashing worker with a FIFO queue. */
export class Hasher {
  private worker: Worker | null = null;
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private counter = 0;
  private closed = false;

  get pending(): number { return this.queue.length + (this.running ? 1 : 0); }

  hash(path: string): Promise<HashResult> {
    if (this.closed) return Promise.reject(new Error("hasher closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({ job: ++this.counter, path, resolve, reject });
      this.next();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.on("message", (message: { job: number; ok: boolean; error?: string } & HashResult) => {
      const job = this.running;
      if (!job || job.job !== message.job) return;
      this.running = null;
      if (message.ok) job.resolve({ id: message.id, size: message.size, chunkHashes: message.chunkHashes, before: message.before, after: message.after, ms: message.ms });
      else job.reject(new Error(message.error ?? "hash failed"));
      this.next();
    });
    worker.on("error", (error) => this.failWorker(error));
    worker.on("exit", (code) => { if (this.worker === worker) this.failWorker(new Error(`hash worker exited (${code})`)); });
    this.worker = worker;
    return worker;
  }

  private failWorker(error: Error): void {
    this.worker = null;
    const job = this.running;
    this.running = null;
    job?.reject(error);
    if (!this.closed) this.next();
  }

  private next(): void {
    if (this.running || this.closed) return;
    const job = this.queue.shift();
    if (!job) { this.worker?.unref(); return; }
    const worker = this.ensureWorker();
    worker.ref();
    this.running = job;
    worker.postMessage({ job: job.job, path: job.path });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error("hasher closed"));
    this.running?.reject(new Error("hasher closed"));
    this.running = null;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
