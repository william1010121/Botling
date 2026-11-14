// The peer cache on the attached server (M3 step 10, protocol v1 §9A.6, §10.5; m3-brief §11 Q5).
//
// - `PeerCacheBudget`: ONE accounted budget (2 GiB by default, lowered in tests) for everything this server keeps of
//   its peers: their bot logs (replica/peer-log-cache.ts) and the chunks of their content (here). Over the cap,
//   items go least recently used first across both, by priority: idle (0), in use (1: a front end is reading it),
//   followed bots last (2).
// - `ChunkCache`: verified 1 MiB chunks of peers' content, sparse, one file per chunk under `<data>/peer-chunks/`, one
//   `chunk_cache` row each. Only bytes that matched the owner's chunk hash are ever put here (peer-content.ts checks
//   before `put`), and every read checks the chunk again against the hash list (a disk that changed under us is a miss,
//   never other bytes). A file above 1/4 of the budget is never kept here: it streams through (peer-content.ts).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PEER_CACHE_BYTES } from "../replica/peer-log-cache";
import type { Db, ServerStore } from "../store";

/** One thing a budget may evict. */
export interface BudgetItem {
  /** 0 idle, 1 in use, 2 followed (evicted last); fractions break ties (the item just written goes later). */
  priority: number;
  usedAt: number;
  bytes: number;
  evict(): void;
}

export interface BudgetSource {
  readonly name: string;
  bytes(): number;
  items(): BudgetItem[];
}

export class PeerCacheBudget {
  private readonly sources: BudgetSource[] = [];
  private enforcing = false;
  /** Items evicted, per source (tests, status). */
  readonly evicted: Record<string, number> = {};

  constructor(readonly capBytes: number = PEER_CACHE_BYTES, private readonly log: (line: string) => void = () => undefined) {}

  register(source: BudgetSource): void { this.sources.push(source); this.evicted[source.name] = 0; }

  get totalBytes(): number { return this.sources.reduce((sum, source) => sum + source.bytes(), 0); }

  /** Over the cap: evict across every source, lowest priority first, then least recently used. */
  enforce(): void {
    if (this.enforcing) return;
    let total = this.totalBytes;
    if (total <= this.capBytes) return;
    this.enforcing = true;
    try {
      const items = this.sources.flatMap((source) => source.items().map((item) => ({ ...item, source: source.name })));
      items.sort((x, y) => x.priority - y.priority || x.usedAt - y.usedAt);
      for (const item of items) {
        if (total <= this.capBytes) break;
        total -= item.bytes;
        this.evicted[item.source] = (this.evicted[item.source] ?? 0) + 1;
        item.evict();
      }
      if (total > this.capBytes) this.log(`peer cache: still ${total} bytes over a cap of ${this.capBytes} after evicting everything it may`);
    } finally {
      this.enforcing = false;
    }
  }
}

/** Which bytes a chunk belongs to: a peer's content id and variant. */
export interface ChunkKey { owner: string; id: string; variant: string }
export const chunkKeyText = (key: ChunkKey) => `${key.owner}\n${key.id}\n${key.variant}`;

interface Kept { bytes: number; usedAt: number; savedUsedAt: number }
interface FileEntry { key: ChunkKey; stream: string | null; chunks: Map<number, Kept> }

export interface ChunkCacheOptions {
  store: Pick<ServerStore, "submit">;
  reader: () => Db;
  dataDir: string;
  budget: PeerCacheBudget;
  now?: () => number;
  log?: (line: string) => void;
  /** Eviction priority of a file (in use, followed); 0 by default. */
  priority?: (key: ChunkKey, stream: string | null) => number;
}

/** `usedAt` is written to the store at most this often per chunk (the order in memory is exact). */
const USED_AT_WRITE_MS = 60_000;

export class ChunkCache implements BudgetSource {
  readonly name = "chunks";
  private readonly files = new Map<string, FileEntry>();
  private total = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  readonly root: string;
  /** Counters (tests, status). */
  readonly counts = { put: 0, hit: 0, miss: 0, badOnDisk: 0, evicted: 0 };

  constructor(private readonly options: ChunkCacheOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.root = join(options.dataDir, "peer-chunks");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.load();
    options.budget.register(this);
  }

  get budget(): PeerCacheBudget { return this.options.budget; }
  bytes(): number { return this.total; }

  /** The chunk indexes kept of a file (tests, status). */
  kept(key: ChunkKey): number[] { return [...(this.files.get(chunkKeyText(key))?.chunks.keys() ?? [])].sort((a, b) => a - b); }
  has(key: ChunkKey, idx: number): boolean { return !!this.files.get(chunkKeyText(key))?.chunks.has(idx); }

  private dir(key: ChunkKey): string {
    const hex = key.id.startsWith("sha256:") ? key.id.slice(7) : key.id.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.root, key.owner.replace(/[^A-Za-z0-9_-]/g, "_"), hex, key.variant.replace(/[^a-z0-9_-]/g, "_"));
  }

  private load(): void {
    let rows: Array<Record<string, unknown>> = [];
    try { rows = this.options.reader().prepare("SELECT owner, id, variant, idx, bytes, usedAt, stream FROM chunk_cache").all() as Array<Record<string, unknown>>; } catch { return; }
    for (const row of rows) {
      const key = { owner: String(row.owner), id: String(row.id), variant: String(row.variant) };
      const entry = this.entry(key, row.stream == null ? null : String(row.stream));
      const usedAt = Number(row.usedAt);
      entry.chunks.set(Number(row.idx), { bytes: Number(row.bytes), usedAt, savedUsedAt: usedAt });
      this.total += Number(row.bytes);
    }
    // Files no row names (a crash between the file and its row) are swept.
    try {
      for (const owner of readdirSync(this.root)) for (const hex of readdirSync(join(this.root, owner))) for (const variant of readdirSync(join(this.root, owner, hex))) {
        const dir = join(this.root, owner, hex, variant);
        const known = [...this.files.values()].find((file) => this.dir(file.key) === dir);
        for (const name of readdirSync(dir)) {
          if (!known || !/^\d+$/.test(name) || !known.chunks.has(Number(name))) rmSync(join(dir, name), { force: true });
        }
      }
    } catch { /* an unreadable folder is swept next start */ }
  }

  private entry(key: ChunkKey, stream: string | null): FileEntry {
    const text = chunkKeyText(key);
    let entry = this.files.get(text);
    if (!entry) { entry = { key, stream, chunks: new Map() }; this.files.set(text, entry); }
    if (stream && !entry.stream) entry.stream = stream;
    return entry;
  }

  /**
   * A kept chunk, checked against `expected` (its SHA-256); null when not kept or when the file on disk no longer
   * matches (then it is dropped).
   */
  get(key: ChunkKey, idx: number, expected: Uint8Array): Buffer | null {
    const entry = this.files.get(chunkKeyText(key));
    const kept = entry?.chunks.get(idx);
    if (!entry || !kept) { this.counts.miss++; return null; }
    let bytes: Buffer;
    try { bytes = readFileSync(join(this.dir(key), String(idx))); } catch { this.drop(key, idx); this.counts.miss++; return null; }
    if (bytes.length !== kept.bytes || !createHash("sha256").update(bytes).digest().equals(Buffer.from(expected))) {
      this.counts.badOnDisk++;
      this.log(`peer content: a cached chunk ${idx} of ${key.id} no longer matches its hash; dropped`);
      this.drop(key, idx);
      return null;
    }
    this.counts.hit++;
    const now = this.now();
    kept.usedAt = now;
    if (now - kept.savedUsedAt >= USED_AT_WRITE_MS) {
      kept.savedUsedAt = now;
      this.write((tx) => { tx.prepare("UPDATE chunk_cache SET usedAt = ? WHERE owner = ? AND id = ? AND variant = ? AND idx = ?").run(now, key.owner, key.id, key.variant, idx); });
    }
    return bytes;
  }

  /** Keeps a chunk that was verified against the owner's chunk hash. */
  put(key: ChunkKey, idx: number, bytes: Uint8Array, stream: string | null = null): void {
    const entry = this.entry(key, stream);
    if (entry.chunks.has(idx)) return;
    const dir = this.dir(key);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${idx}.${process.pid}.tmp`);
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, join(dir, String(idx)));
    } catch (error) {
      this.log(`peer content: chunk ${idx} of ${key.id} not cached: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    const now = this.now();
    entry.chunks.set(idx, { bytes: bytes.length, usedAt: now, savedUsedAt: now });
    this.total += bytes.length;
    this.counts.put++;
    this.write((tx) => {
      tx.prepare("INSERT OR REPLACE INTO chunk_cache (owner, id, variant, idx, bytes, usedAt, stream) VALUES (?, ?, ?, ?, ?, ?, ?)").run(key.owner, key.id, key.variant, idx, bytes.length, now, entry.stream);
    });
    this.options.budget.enforce();
  }

  /** Forgets one chunk (evicted, or bad on disk). */
  drop(key: ChunkKey, idx: number): void {
    const text = chunkKeyText(key);
    const entry = this.files.get(text);
    const kept = entry?.chunks.get(idx);
    if (!entry || !kept) return;
    entry.chunks.delete(idx);
    this.total -= kept.bytes;
    if (!entry.chunks.size) this.files.delete(text);
    try { rmSync(join(this.dir(key), String(idx)), { force: true }); } catch { /* swept at the next start */ }
    this.write((tx) => { tx.prepare("DELETE FROM chunk_cache WHERE owner = ? AND id = ? AND variant = ? AND idx = ?").run(key.owner, key.id, key.variant, idx); });
  }

  /** Forgets every chunk of a content id of an owner (every variant): the owner said it may not be read, or it changed. */
  dropContent(owner: string, id: string): void {
    for (const entry of [...this.files.values()]) {
      if (entry.key.owner !== owner || entry.key.id !== id) continue;
      for (const idx of [...entry.chunks.keys()]) this.drop(entry.key, idx);
    }
  }

  items(): BudgetItem[] {
    const priority = this.options.priority ?? (() => 0);
    const out: BudgetItem[] = [];
    for (const entry of this.files.values()) {
      const p = priority(entry.key, entry.stream);
      for (const [idx, kept] of entry.chunks) {
        out.push({ priority: p, usedAt: kept.usedAt, bytes: kept.bytes, evict: () => { this.counts.evicted++; this.drop(entry.key, idx); } });
      }
    }
    return out;
  }

  /** Resolves once every store write queued so far is done (tests, stop). */
  async flushed(): Promise<void> { await this.writes; }

  private write(command: (tx: Db) => void): void {
    this.writes = this.writes.then(() => this.options.store.submit(command)).catch((error) => {
      this.log(`peer content: a cache write failed: ${String((error as Error)?.message ?? error)}`);
    });
  }
}
