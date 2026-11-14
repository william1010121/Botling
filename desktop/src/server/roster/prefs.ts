// Cluster preferences (protocol v1 §17, §4.7; M3 step 5): one last-writer-wins register per key, ordered by
// `(hlc, writer)` (protocol/prefs.ts `comparePrefVersions`), in server.db's `prefs` table (schema v1: key, value as
// canonical JSON, hlc as `{"ms","c"}` JSON, writer). The only multi-writer state besides the roster.
//
// - A local write (`set`) takes an hlc above every version this server has seen and above its clock, writer = this
//   server, so it wins over every row it has seen (§17).
// - Rows from peers (`merge`) are kept per key only when they win; order and duplicates never matter. A row's writer
//   must be a server the roster knows (rows are not signed: they come only over full peer sessions, which only valid
//   servers get; the writer check keeps a typo'd or made-up writer out).
// - Listeners hear every changed row (gossip pushes them at once).
import { canonicalJson, comparePrefVersions, mergePrefs, PrefKey, PrefRow, prefsDigest, type PrefVersion } from "../../protocol";
import type { RosterBackend } from "./store";

export interface PrefsStoreOptions {
  self: string;
  now?: () => number;
  /** Whether `writer` may write a row (a server the roster knows). Default: anyone. */
  knownWriter?: (writer: string) => boolean;
  log?: (line: string) => void;
}

export class PrefsStore {
  private rowsByKey = new Map<string, PrefRow>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(rows: PrefRow[]) => void>();
  private readonly now: () => number;

  private constructor(private readonly backend: RosterBackend, private readonly options: PrefsStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  static async open(backend: RosterBackend, options: PrefsStoreOptions): Promise<PrefsStore> {
    const store = new PrefsStore(backend, options);
    const reader = backend.openReader();
    let skipped = 0;
    try {
      for (const row of reader.prepare("SELECT key, value, hlc, writer FROM prefs").all()) {
        try {
          const parsed = PrefRow.safeParse({ key: String(row.key), value: JSON.parse(String(row.value)), hlc: JSON.parse(String(row.hlc)), writer: String(row.writer) });
          if (parsed.success) store.rowsByKey.set(parsed.data.key, parsed.data); else skipped++;
        } catch { skipped++; }
      }
    } finally {
      reader.close();
    }
    if (skipped) options.log?.(`prefs: ${skipped} stored rows are malformed and were skipped`);
    return store;
  }

  /** Every register, sorted by key. */
  rows(): PrefRow[] { return [...this.rowsByKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); }
  get(key: string): PrefRow | null { return this.rowsByKey.get(key) ?? null; }
  versions(): PrefVersion[] { return this.rows().map(({ key, hlc, writer }) => ({ key, hlc, writer })); }
  /** `prefs.have` (§4.7). */
  digest(): Promise<string> { return prefsDigest(this.versions()); }

  onChange(listener: (rows: PrefRow[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  idle(): Promise<void> { return this.queue.then(() => undefined, () => undefined); }

  /** A local write (the window or CLI over the local socket): wins over every version seen here. */
  set(key: string, value: unknown): Promise<PrefRow> {
    return this.serial(async () => {
      PrefKey.parse(key);
      let ms = this.now();
      let c = 0;
      for (const row of this.rowsByKey.values()) {
        if (row.hlc.ms > ms || (row.hlc.ms === ms && row.hlc.c >= c)) { ms = row.hlc.ms; c = row.hlc.c + 1; }
      }
      if (c > 0xffff) { ms += 1; c = 0; }
      const row = PrefRow.parse({ key, value: value === undefined ? null : value, hlc: { ms, c }, writer: this.options.self });
      await this.commit([row]);
      return row;
    });
  }

  /** Rows from a peer: each kept only when it wins its key. Returns the rows that changed here. */
  merge(incoming: readonly unknown[]): Promise<PrefRow[]> {
    return this.serial(async () => {
      const valid: PrefRow[] = [];
      for (const raw of incoming) {
        const parsed = PrefRow.safeParse(raw);
        if (!parsed.success) continue;
        if (this.options.knownWriter && !this.options.knownWriter(parsed.data.writer)) continue;
        valid.push(parsed.data);
      }
      const merged = mergePrefs(this.rowsByKey.values(), valid);
      const changed = [...merged.values()].filter((row) => {
        const held = this.rowsByKey.get(row.key);
        return !held || comparePrefVersions(held, row) < 0;
      });
      if (changed.length) await this.commit(changed);
      return changed;
    });
  }

  private async commit(rows: PrefRow[]): Promise<void> {
    await this.backend.submit((tx) => {
      const put = tx.prepare("INSERT INTO prefs (key, value, hlc, writer) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, writer = excluded.writer");
      for (const row of rows) put.run(row.key, canonicalJson(row.value), canonicalJson(row.hlc), row.writer);
    });
    for (const row of rows) this.rowsByKey.set(row.key, row);
    for (const listener of this.listeners) {
      try { listener(rows); } catch (error) { this.options.log?.(`prefs: a change listener failed: ${String((error as Error)?.message ?? error)}`); }
    }
  }

  private serial<T>(act: () => Promise<T>): Promise<T> {
    const run = this.queue.then(act, act);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
