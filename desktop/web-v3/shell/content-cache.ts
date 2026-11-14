// The phone/browser page's content cache (M2 step 11, protocol v1 §9A.6, D39 decided by the user on 2026-11-14):
// posters, thumbnails and small images (≤ 2 MB) by hash in Cache Storage `botling3-content`, 200 MB in total, least
// recently used first out; the whole cache is deleted on sign-out, on unpairing and when the page learns this device
// was revoked. Nothing expires by time (a hash names one content forever); whether a reference may still be read is
// never cached (each line asks the server, §9A.7).
//
// Lives in the shell (the page's own origin): the chat frame has an opaque origin and no Cache Storage. Keys are
// synthetic same-origin URLs `<page>/__content/<hex>`; the LRU index (size, last use) is one JSON entry in the same
// cache, rewritten after a change and at most every TOUCH_WRITE_MS for mere uses, and rebuilt from the entries'
// Content-Length when it is missing.

export const CONTENT_CACHE_NAME = "botling3-content";
export const CONTENT_CACHE_CAP = 200 * 1024 * 1024;
/** The largest single item kept (images ≤ 2 MB, §9A.6; posters and thumbnails are far smaller). */
export const CONTENT_ITEM_MAX = 2 * 1024 * 1024;
const TOUCH_WRITE_MS = 2_000;
const INDEX = "index.json";

/** The part of the Cache Storage API this uses (the unit tests pass a fake). */
export interface CacheLike {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<ReadonlyArray<{ url: string }>>;
}
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  delete(name: string): Promise<boolean>;
}

interface Item { size: number; used: number; type: string }

export interface ContentCacheOptions {
  caches?: CachesLike;
  /** Where the synthetic keys live (default: this page's `__content/` folder). */
  base?: string;
  cap?: number;
  now?: () => number;
}

export interface CacheUsage { bytes: number; count: number; cap: number }

const hexOf = (id: string): string | null => (/^sha256:([0-9a-f]{64})$/.exec(id)?.[1] ?? null);

export class ContentCache {
  private items = new Map<string, Item>();
  private cache: CacheLike | null = null;
  private opening: Promise<CacheLike | null> | null = null;
  private touchTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly caches: CachesLike | null;
  private readonly base: string;
  readonly cap: number;
  private readonly now: () => number;

  constructor(options: ContentCacheOptions = {}) {
    this.caches = options.caches ?? ((globalThis as { caches?: CachesLike }).caches ?? null);
    this.base = options.base ?? new URL("__content/", (globalThis as { location?: { href: string } }).location?.href ?? "http://localhost/").href;
    this.cap = Math.max(1, options.cap ?? CONTENT_CACHE_CAP);
    this.now = options.now ?? Date.now;
  }

  /** False where the browser has no Cache Storage (an insecure origin): the page then simply caches nothing. */
  get available(): boolean { return !!this.caches; }

  private key(hex: string): string { return `${this.base}${hex}`; }

  /** Runs `fn` after every earlier change (puts, evictions and clears never interleave). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private open(): Promise<CacheLike | null> {
    if (this.cache) return Promise.resolve(this.cache);
    if (!this.caches) return Promise.resolve(null);
    this.opening ??= (async () => {
      try {
        const cache = await this.caches!.open(CONTENT_CACHE_NAME);
        await this.loadIndex(cache);
        this.cache = cache;
        return cache;
      } catch { return null; } finally { this.opening = null; }
    })();
    return this.opening;
  }

  private async loadIndex(cache: CacheLike): Promise<void> {
    this.items = new Map();
    const saved = await cache.match(this.key(INDEX)).then((response) => response?.json() as Promise<Record<string, Item>> | undefined).catch(() => undefined);
    const keys = (await cache.keys()).map((request) => request.url.slice(this.base.length)).filter((hex) => /^[0-9a-f]{64}$/.test(hex));
    for (const hex of keys) {
      const known = saved?.[hex];
      if (known && Number.isFinite(known.size)) { this.items.set(hex, known); continue; }
      // No index row (an index lost to a crash): the entry's own length, and "used long ago".
      const response = await cache.match(this.key(hex));
      const size = Number(response?.headers.get("content-length") ?? 0);
      this.items.set(hex, { size: Number.isFinite(size) ? size : 0, used: 0, type: response?.headers.get("content-type") ?? "application/octet-stream" });
    }
    // Index rows whose entry is gone (deleted by the browser under pressure) are dropped above by building from keys.
  }

  private async writeIndex(cache: CacheLike): Promise<void> {
    const body = JSON.stringify(Object.fromEntries(this.items));
    await cache.put(this.key(INDEX), new Response(body, { headers: { "Content-Type": "application/json" } }));
  }

  private scheduleTouchWrite(): void {
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      void this.serial(async () => { if (this.cache) await this.writeIndex(this.cache); }).catch(() => undefined);
    }, TOUCH_WRITE_MS);
  }

  /** The cached bytes of `id` (marks it used), or null. */
  async get(id: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
    const hex = hexOf(id);
    if (!hex) return null;
    const cache = await this.open();
    if (!cache || !this.items.has(hex)) return null;
    const response = await cache.match(this.key(hex)).catch(() => undefined);
    if (!response) { this.items.delete(hex); return null; }
    const item = this.items.get(hex)!;
    item.used = this.now();
    this.scheduleTouchWrite();
    return { bytes: await response.arrayBuffer(), type: item.type };
  }

  /** Whether `id` is cached (no use mark). */
  async has(id: string): Promise<boolean> {
    const hex = hexOf(id);
    return !!hex && !!(await this.open()) && this.items.has(hex);
  }

  /**
   * Keeps the bytes of `id` (they must be its bytes: the caller fetched them by that hash's URL). Items above
   * CONTENT_ITEM_MAX or the whole cap are not kept. Evicts least recently used items while the total is above the cap.
   */
  put(id: string, bytes: ArrayBuffer, type: string): Promise<boolean> {
    const hex = hexOf(id);
    if (!hex || bytes.byteLength === 0 || bytes.byteLength > Math.min(CONTENT_ITEM_MAX, this.cap)) return Promise.resolve(false);
    return this.serial(async () => {
      const cache = await this.open();
      if (!cache) return false;
      await cache.put(this.key(hex), new Response(bytes, { headers: { "Content-Type": type, "Content-Length": String(bytes.byteLength) } }));
      this.items.set(hex, { size: bytes.byteLength, used: this.now(), type });
      await this.evict(cache, hex);
      await this.writeIndex(cache);
      return true;
    });
  }

  private async evict(cache: CacheLike, keep: string): Promise<void> {
    let total = this.total();
    if (total <= this.cap) return;
    const order = [...this.items.entries()].filter(([hex]) => hex !== keep).sort((a, b) => a[1].used - b[1].used);
    for (const [hex, item] of order) {
      if (total <= this.cap) break;
      await cache.delete(this.key(hex)).catch(() => false);
      this.items.delete(hex);
      total -= item.size;
    }
  }

  private total(): number { let sum = 0; for (const item of this.items.values()) sum += item.size; return sum; }

  async usage(): Promise<CacheUsage> {
    await this.open();
    return { bytes: this.total(), count: this.items.size, cap: this.cap };
  }

  /** Deletes the whole cache (sign-out, unpairing, revocation). Safe to call when nothing was ever cached. */
  clear(): Promise<void> {
    return this.serial(async () => {
      if (this.touchTimer) { clearTimeout(this.touchTimer); this.touchTimer = null; }
      this.items = new Map();
      this.cache = null;
      await this.caches?.delete(CONTENT_CACHE_NAME).catch(() => false);
    });
  }
}

/** Deletes the page's content cache without an instance (the sign-out path before anything was opened). */
export async function clearContentCache(caches: CachesLike | null = (globalThis as { caches?: CachesLike }).caches ?? null): Promise<void> {
  await caches?.delete(CONTENT_CACHE_NAME).catch(() => false);
}
