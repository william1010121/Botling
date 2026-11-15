// The daily byte limit of `FetchSource` (§16, M7-S87): per-day, per-bot byte counts, persisted in `server.db` `meta`
// (`fetchDailyBytes:<day>`). `flush` commits the pending increments through one queue, so writes stay serialised.
import { DAY_MS, type FetchSourceOptions } from "./source-shared";

export type DailyLimitDeps = Pick<FetchSourceOptions, "store" | "reader"> & { log: (line: string) => void };

export class DailyLimit {
  private readonly dailyBytes = new Map<number, Map<string, number>>();
  private readonly pendingDaily = new Map<number, Map<string, number>>();
  private dailyFlushQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DailyLimitDeps) {}

  private loadDay(day: number): Map<string, number> {
    let map = this.dailyBytes.get(day);
    if (map) return map;
    map = new Map();
    try {
      const row = this.deps.reader().prepare("SELECT value FROM meta WHERE key = ?").get(`fetchDailyBytes:${day}`) as
        | { value?: string }
        | undefined;
      if (row?.value) {
        const parsed = JSON.parse(String(row.value)) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "number" && Number.isFinite(v) && v >= 0) map.set(k, v);
          }
        }
      }
    } catch { /* ignore malformed meta */ }
    this.dailyBytes.set(day, map);
    return map;
  }

  get(key: string, at: number): number {
    const day = Math.floor(at / DAY_MS);
    return this.loadDay(day).get(key) ?? 0;
  }

  add(key: string, at: number, delta: number): void {
    const day = Math.floor(at / DAY_MS);
    const dayMap = this.loadDay(day);
    dayMap.set(key, (dayMap.get(key) ?? 0) + delta);
    let pending = this.pendingDaily.get(day);
    if (!pending) { pending = new Map(); this.pendingDaily.set(day, pending); }
    pending.set(key, (pending.get(key) ?? 0) + delta);
  }

  flush(): Promise<void> {
    const snapshot = new Map<number, Map<string, number>>();
    for (const [day, map] of this.pendingDaily) {
      if (map.size > 0) snapshot.set(day, new Map(map));
    }
    this.pendingDaily.clear();
    if (snapshot.size === 0) return this.dailyFlushQueue;
    this.dailyFlushQueue = this.dailyFlushQueue.then(async () => {
      await this.deps.store.submit((tx) => {
        for (const [day, deltas] of snapshot) {
          const metaKey = `fetchDailyBytes:${day}`;
          const existing = tx.prepare("SELECT value FROM meta WHERE key = ?").get(metaKey) as { value?: string } | undefined;
          const counts: Record<string, number> = {};
          if (existing?.value) {
            try {
              const parsed = JSON.parse(String(existing.value)) as Record<string, unknown>;
              if (parsed && typeof parsed === "object") {
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v === "number" && Number.isFinite(v) && v >= 0) counts[k] = v;
                }
              }
            } catch { /* overwrite corrupt value */ }
          }
          for (const [k, delta] of deltas) {
            counts[k] = (counts[k] ?? 0) + delta;
          }
          tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .run(metaKey, JSON.stringify(counts));
        }
      });
    }).catch((error) => {
      this.deps.log(`fetch: persisting daily byte counts failed: ${String((error as Error)?.message ?? error)}`);
    });
    return this.dailyFlushQueue;
  }
}
