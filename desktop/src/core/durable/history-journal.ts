// Small durable transactions are authoritative until a background checkpoint commits them.
// Full-history JSON encoding, disk writes and fsync never run on the core event loop.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, openSync, fsyncSync, closeSync, writeSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";

type Row = { id: string; [key: string]: unknown };
type Patch = { path: (string | number)[]; value?: unknown; remove?: true; length?: number };
interface Transaction { order: string[]; changes: { id: string; patches: Patch[] }[] }
const journals = new Map<string, WeakRef<HistoryJournal>>();
const suffix = ".journal";
const transactionName = (sequence: number) => String(sequence).padStart(16, "0") + ".json";

// Atomic, fully written, fsynced journal entry. Unlike a replace-in-place log, a partial
// transaction can never be mistaken for an acknowledged one after a crash.
function commitTransaction(file: string, text: string) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error("History journal write made no progress");
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, file);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(file), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally { rmSync(temp, { force: true }); }
}

// Unlike structuredClone, this shares immutable strings. A 90 MB unchanged report is not
// copied/encoded on each event. Objects/arrays are copied so later in-place edits are detected.
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => snapshot(item) ?? null);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, snapshot(item)]));
}
function changes(before: unknown, after: unknown, path: Patch["path"] = [], out: Patch[] = []): Patch[] {
  if (before === after) return out;
  if (after === undefined) { out.push({ path, remove: true }); return out; }
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) !== Array.isArray(after)) {
    out.push({ path, value: snapshot(after) }); return out;
  }
  if (Array.isArray(after) && Array.isArray(before)) {
    for (let i = 0; i < after.length; i++) changes(before[i], after[i] ?? null, [...path, i], out);
    if (before.length !== after.length) out.push({ path, length: after.length });
  } else {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) changes(a[key], b[key], [...path, key], out);
  }
  return out;
}

// Self-contained: also runs in the worker. Absolute assignments/deletions (never increments or
// relative appends) make replay idempotent if a crash lands after checkpoint rename but before
// journal pruning. Array lengths and complete row order are explicit for the same reason.
export function applyHistoryTransaction(rows: Map<string, any>, transaction: Transaction): any[] {
  for (const change of transaction.changes) {
    let row = rows.get(change.id);
    for (const patch of change.patches) {
      if (!patch.path.length && patch.length === undefined) { row = patch.remove ? undefined : patch.value; continue; }
      if (!row || typeof row !== "object") row = typeof patch.path[0] === "number" ? [] : {};
      let parent = row;
      const end = patch.length === undefined ? patch.path.length - 1 : patch.path.length;
      for (let i = 0; i < end; i++) {
        const key = patch.path[i]!;
        if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== "object") {
          Object.defineProperty(parent, key, { value: typeof patch.path[i + 1] === "number" || (i + 1 === end && patch.length !== undefined) ? [] : {}, enumerable: true, writable: true, configurable: true });
        }
        parent = parent[key];
      }
      if (patch.length !== undefined) parent.length = patch.length;
      else if (patch.remove) delete parent[patch.path.at(-1)!];
      else Object.defineProperty(parent, patch.path.at(-1)!, { value: patch.value, enumerable: true, writable: true, configurable: true });
    }
    if (row !== undefined) rows.set(change.id, row); else rows.delete(change.id);
  }
  const keep = new Set(transaction.order);
  for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id);
  return transaction.order.map(id => {
    if (!rows.has(id)) throw new Error(`History transaction refers to missing row ${id}`);
    return rows.get(id);
  });
}

// Kept in this module so bundled/packaged cores need no adjacent worker asset. No application
// bootstrap, profile access or inherited app imports run in the worker.
function checkpointWorker() {
  const { parentPort } = require("node:worker_threads");
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const apply = (globalThis as any).applyHistoryTransaction as typeof applyHistoryTransaction;
  function syncDirectory(directory: string) {
    if (process.platform === "win32") return;
    const fd = fs.openSync(directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  parentPort.on("message", ({ id, file, sequence }: { id: number; file: string; sequence: number }) => {
    let temp: string | undefined;
    try {
      const directory = file + ".journal";
      const names = fs.readdirSync(directory).filter((name: string) => /^\d{16}\.json$/.test(name) && Number(name.slice(0, 16)) <= sequence).sort();
      let list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      if (!Array.isArray(list)) throw new Error("History checkpoint is not an array");
      const rows = new Map<string, any>(list.filter((row: any) => row && typeof row.id === "string").map((row: any) => [row.id, row]));
      for (const name of names) list = apply(rows, JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
      // Preserve the existing legacy array file. Journal replay remains authoritative until
      // both this rename AND its directory fsync succeed; failed writes never prune entries.
      temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        const bytes = Buffer.from(JSON.stringify(list));
        for (let offset = 0; offset < bytes.length;) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw new Error("History checkpoint write made no progress");
          offset += written;
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, file); temp = undefined;
      syncDirectory(path.dirname(file));
      for (const name of names) fs.unlinkSync(path.join(directory, name));
      syncDirectory(directory);
      parentPort.postMessage({ id });
    } catch (error) {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      parentPort.postMessage({ id, error: String(error) });
    }
  });
}
let worker: Worker | undefined;
let requestId = 0;
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
function checkpoint(file: string, sequence: number): Promise<void> {
  if (!worker) {
    const started = new Worker(`globalThis.applyHistoryTransaction = ${applyHistoryTransaction.toString()}; (${checkpointWorker.toString()})();`, { eval: true });
    worker = started;
    const fail = (error: Error) => {
      if (worker !== started) return;
      worker = undefined;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    started.on("error", fail);
    started.on("exit", code => fail(new Error(`History checkpoint worker exited (${code})`)));
    started.on("message", ({ id, error }: { id: number; error?: string }) => {
      const waiter = pending.get(id); pending.delete(id);
      if (error) waiter?.reject(new Error(error)); else waiter?.resolve();
      if (!pending.size) started.unref();
    });
    started.unref();
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject }); worker!.ref();
    worker!.postMessage({ id, file, sequence });
  });
}

/** A bounded-content reader may decline a stale checkpoint instead of loading private history. */
export async function hasPendingHistory(file: string): Promise<boolean> {
  try {
    const directory = await opendir(file + suffix);
    for await (const entry of directory) if (/^\d{16}\.json$/.test(entry.name)) return true;
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Checkpoint plus committed transactions. Only used at load/recovery, never for each update. */
export function readHistory(file: string): Row[] {
  const stamp = () => { try { const s = statSync(file); return `${s.ino}:${s.mtimeMs}:${s.size}`; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw e; } };
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = stamp();
    try {
      let list = before === "missing" ? [] : JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(list)) throw new Error("History checkpoint is not an array");
      const rows = new Map<string, Row>(list.filter((row: any) => row && typeof row.id === "string").map((row: Row) => [row.id, row]));
      const directory = file + suffix;
      const names = existsSync(directory) ? readdirSync(directory).filter(name => /^\d{16}\.json$/.test(name)).sort() : [];
      for (const name of names) list = applyHistoryTransaction(rows, JSON.parse(readFileSync(join(directory, name), "utf8")));
      if (stamp() === before) return list;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && stamp() === before) throw error;
    }
  }
  throw new Error("History checkpoint changed during recovery; retry the read");
}

export class HistoryJournal {
  static forFile(file: string, initialRows?: Row[]): HistoryJournal {
    file = resolve(file);
    const existing = journals.get(file)?.deref(); if (existing && (!existing.closing || existing.inFlight || existing.completed < existing.sequence)) return existing;
    for (const [key, ref] of journals) if (!ref.deref()) journals.delete(key);
    const journal = new HistoryJournal(file, initialRows); journals.set(file, new WeakRef(journal)); return journal;
  }
  private state = new Map<string, unknown>();
  private order: string[] = [];
  private sequence = 0;
  private completed = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private retryMs = 1_000;
  private closing = false;
  private constructor(private file: string, initialRows?: Row[]) {
    const rows = (initialRows ?? readHistory(file)).filter(row => row && typeof row.id === "string");
    for (const row of rows) this.state.set(row.id, snapshot(row));
    this.order = rows.map(row => row.id);
    const directory = file + suffix;
    if (existsSync(directory)) this.sequence = Math.max(0, ...readdirSync(directory).filter(name => /^\d{16}\.json$/.test(name)).map(name => Number(name.slice(0, 16))));
  }
  commit(list: unknown[], changedIds?: ReadonlySet<string>): void {
    if (this.closing) throw new Error("History persistence is closing");
    const rows = list as Row[];
    if (rows.some(row => !row || typeof row.id !== "string") || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("History rows need unique string identities");
    const transaction: Transaction = { order: rows.map(row => row.id), changes: [] };
    for (const row of rows) {
      if (this.state.has(row.id) && changedIds && !changedIds.has(row.id)) continue;
      const patches = changes(this.state.get(row.id), row);
      if (patches.length) transaction.changes.push({ id: row.id, patches });
    }
    if (!transaction.changes.length && transaction.order.length === this.order.length && transaction.order.every((id, i) => id === this.order[i])) return;
    const next = this.sequence + 1;
    const newDirectory = !existsSync(fileDirectory(this.file));
    mkdirSync(fileDirectory(this.file), { recursive: true });
    if (newDirectory && process.platform !== "win32") {
      const fd = openSync(dirname(this.file), "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    // The durable receipt. A write/fsync failure throws to the caller BEFORE its state/events
    // are acknowledged; memory advances only after commit. The large checkpoint is off-thread.
    commitTransaction(join(fileDirectory(this.file), transactionName(next)), JSON.stringify(transaction));
    applyHistoryTransaction(this.state, transaction);
    this.order = transaction.order; this.sequence = next;
    this.schedule(500);
  }
  private schedule(delay: number) {
    if (this.timer || this.inFlight || this.closing) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {}); }, delay);
    this.timer.unref?.();
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.inFlight) await this.inFlight;
    if (this.completed >= this.sequence) return;
    const through = this.sequence;
    const work = checkpoint(this.file, through);
    this.inFlight = work;
    try { await work; this.completed = through; this.retryMs = 1_000; }
    catch (error) { this.retryMs = Math.min(this.retryMs * 2, 30_000); throw error; }
    finally {
      if (this.inFlight === work) this.inFlight = null;
      if (this.completed < this.sequence) this.schedule(this.retryMs);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    try { await this.flush(); } catch (error) { this.closing = false; throw error; }
  }
}
function fileDirectory(file: string) { return file + suffix; }
