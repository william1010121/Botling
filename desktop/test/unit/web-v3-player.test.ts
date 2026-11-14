// M2 step 11: the player rules of the Botling 3 page (web-v3/player.ts, protocol v1 §9A.5) — the 1.5× rule, the
// two-stalls switch, the rate meter — and the content cache's LRU, cap and clear (web-v3/shell/content-cache.ts, §9A.6)
// over a fake Cache Storage.
import { describe, expect, it } from "vitest";
import { chooseVariant, FIRST_GUESS_BPS, formatDuration, formatSize, MAY_BUFFER, ORIGINAL_FACTOR, pathOfPage, RateMeter, slowStart, StallWatch, START_WAIT_MS, STALL_WINDOW_MS } from "../../web-v3/player";
import { CONTENT_CACHE_NAME, CONTENT_ITEM_MAX, ContentCache, type CacheLike, type CachesLike } from "../../web-v3/shell/content-cache";

const M = 1e6;

describe("the 1.5× rule (§9A.5)", () => {
  const video = (original: number | undefined, preview = true) => ({ original: original === undefined ? {} : { bitrate: original }, ...(preview ? { preview: { bitrate: 1.1 * M } } : {}) });

  it("plays the original exactly when the rate is at least 1.5 × its bitrate", () => {
    for (const bitrate of [0.8 * M, 2 * M, 3 * M, 6 * M, 14 * M]) {
      const edge = ORIGINAL_FACTOR * bitrate;
      expect(chooseVariant(video(bitrate), edge).variant).toBe("original");
      expect(chooseVariant(video(bitrate), edge * 1.01).variant).toBe("original");
      const slow = chooseVariant(video(bitrate), edge * 0.99);
      expect(slow).toEqual({ variant: "preview", reason: "rate", badge: "preview" });
    }
  });

  it("uses the path's first guess before anything was measured", () => {
    // tailnet 20 Mbit/s: the edge is 13.3 Mbit/s (20 / 1.5).
    expect(chooseVariant(video(12 * M), new RateMeter("tailnet").bps).variant).toBe("original");
    expect(chooseVariant(video(14 * M), new RateMeter("tailnet").bps).variant).toBe("preview");
    // relay 5 Mbit/s: 3 Mbit/s needs 4.5 (original); 4 Mbit/s needs 6 (preview).
    expect(chooseVariant(video(3 * M), new RateMeter("relay").bps).variant).toBe("original");
    expect(chooseVariant(video(4 * M), new RateMeter("relay").bps).variant).toBe("preview");
    // local: unlimited.
    expect(chooseVariant(video(80 * M), new RateMeter("local").bps).variant).toBe("original");
    expect(FIRST_GUESS_BPS).toEqual({ local: Number.POSITIVE_INFINITY, tailnet: 20e6, relay: 5e6 });
  });

  it("plays the original when there is no preview, and says it may buffer when the rate is short", () => {
    expect(chooseVariant(video(3 * M, false), 50 * M)).toEqual({ variant: "original", reason: "only-original" });
    expect(chooseVariant(video(3 * M, false), 2 * M)).toEqual({ variant: "original", reason: "only-original", badge: MAY_BUFFER });
  });

  it("follows the device's choice while that variant exists; no bitrate means the original", () => {
    expect(chooseVariant(video(3 * M), 1 * M, "original").variant).toBe("original");
    expect(chooseVariant(video(3 * M), 100 * M, "preview").variant).toBe("preview");
    expect(chooseVariant(video(3 * M, false), 100 * M, "preview").variant).toBe("original");
    expect(chooseVariant(video(undefined), 1 * M).variant).toBe("original");
  });
});

describe("the rate meter", () => {
  it("answers the first guess, then a moving average of real reads; tiny or instant reads are ignored", () => {
    const meter = new RateMeter("tailnet");
    expect(meter.bps).toBe(20e6);
    expect(meter.sample(10_000, 100)).toBe(false); // < 32 KiB
    expect(meter.sample(1_000_000, 5)).toBe(false); // < 20 ms
    expect(meter.measured).toBe(false);
    expect(meter.sample(250_000, 1_000)).toBe(true); // 2 Mbit/s
    expect(meter.bps).toBeCloseTo(2e6, -3);
    meter.sample(1_250_000, 1_000); // 10 Mbit/s
    expect(meter.bps).toBeCloseTo(0.3 * 10e6 + 0.7 * 2e6, -3);
  });

  it("is capped below the original's bitrate after two stalls, so the next video starts on the preview", () => {
    const meter = new RateMeter("local");
    expect(chooseVariant({ original: { bitrate: 4 * M }, preview: {} }, meter.bps).variant).toBe("original");
    meter.stalledAt(4 * M);
    expect(meter.bps).toBeLessThan(4 * M);
    expect(chooseVariant({ original: { bitrate: 4 * M }, preview: {} }, meter.bps).variant).toBe("preview");
  });
});

describe("the two-stalls switch (§9A.5)", () => {
  it("switches on the second stall within 30 s, once", () => {
    const watch = new StallWatch();
    watch.playing();
    expect(watch.stall(1_000)).toBe(false);
    expect(watch.stall(1_000 + STALL_WINDOW_MS - 1)).toBe(true);
    expect(watch.stall(1_000 + STALL_WINDOW_MS)).toBe(false);
  });

  it("does not count stalls 30 s apart, the start-up wait, or waits while seeking", () => {
    const watch = new StallWatch();
    expect(watch.stall(0)).toBe(false); // before the first `playing`: start-up
    expect(watch.stall(100)).toBe(false);
    watch.playing();
    expect(watch.stall(1_000)).toBe(false);
    expect(watch.stall(1_000 + STALL_WINDOW_MS)).toBe(false); // the first fell out of the window
    watch.seek(true);
    expect(watch.stall(1_000 + STALL_WINDOW_MS + 10)).toBe(false); // seeking
    watch.seek(false);
    expect(watch.stall(1_000 + STALL_WINDOW_MS + 20)).toBe(true);
  });

  it("starts over after the element got another source", () => {
    const watch = new StallWatch();
    watch.playing();
    watch.stall(0);
    watch.reset();
    expect(watch.stall(10)).toBe(false); // not started again
    watch.playing();
    expect(watch.stall(20)).toBe(false);
    expect(watch.stall(30)).toBe(true);
  });
});

describe("the slow start (WebKit holds the start instead of stalling)", () => {
  it("switches a tapped original that has not started after 4 s when its buffer grew slower than 1.5 × real time", () => {
    // 4 Mbit/s original over 2 Mbit/s: 0.5 media s per s; over 8 Mbit/s: 2 media s per s.
    expect(slowStart(START_WAIT_MS - 1, 0)).toBe(false); // not yet
    expect(slowStart(START_WAIT_MS, 0.5 * (START_WAIT_MS / 1000))).toBe(true);
    expect(slowStart(10_000, 14.9)).toBe(true);
    expect(slowStart(10_000, 15)).toBe(false); // exactly 1.5×: the original fits
    expect(slowStart(START_WAIT_MS, 2 * (START_WAIT_MS / 1000))).toBe(false);
  });

  it("is not the stall count: the start-up wait never counts as a stall", () => {
    const watch = new StallWatch();
    expect(watch.hasStarted).toBe(false);
    expect(watch.stall(0)).toBe(false);
    watch.playing();
    expect(watch.hasStarted).toBe(true);
  });
});

describe("words", () => {
  it("formats durations, sizes and the page's path", () => {
    expect([formatDuration(0), formatDuration(7_400), formatDuration(65_000), formatDuration(3_723_000)]).toEqual(["0:00", "0:07", "1:05", "1:02:03"]);
    expect([formatSize(900), formatSize(820_000), formatSize(7_500_000), formatSize(75_000_000), formatSize(1_200_000_000)]).toEqual(["900 B", "820 KB", "7.5 MB", "75 MB", "1.2 GB"]);
    expect([pathOfPage("127.0.0.1"), pathOfPage("localhost"), pathOfPage("box.tailnet-name.ts.net")]).toEqual(["local", "local", "tailnet"]);
  });
});

// --- content cache ------------------------------------------------------------------------------------------------

class FakeCache implements CacheLike {
  readonly map = new Map<string, { body: ArrayBuffer; headers: Headers }>();
  async match(request: string) { const hit = this.map.get(request); return hit ? new Response(hit.body.slice(0), { headers: hit.headers }) : undefined; }
  async put(request: string, response: Response) { this.map.set(request, { body: await response.arrayBuffer(), headers: new Headers(response.headers) }); }
  async delete(request: string) { return this.map.delete(request); }
  async keys() { return [...this.map.keys()].map((url) => ({ url })); }
}
class FakeCaches implements CachesLike {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string) { let store = this.stores.get(name); if (!store) { store = new FakeCache(); this.stores.set(name, store); } return store; }
  async delete(name: string) { return this.stores.delete(name); }
}

const id = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill).buffer;

describe("the content cache (§9A.6)", () => {
  it("keeps items by hash, evicts least recently used above the cap, never one above 2 MB", async () => {
    let clock = 1;
    const caches = new FakeCaches();
    const cache = new ContentCache({ caches, base: "http://127.0.0.1/v3/__content/", cap: 100_000, now: () => clock++ });
    for (let i = 1; i <= 4; i++) expect(await cache.put(id(i), bytes(30_000, i), "image/jpeg")).toBe(true);
    // 4 × 30 kB > 100 kB: the oldest (1) went.
    expect(await cache.has(id(1))).toBe(false);
    expect((await cache.usage()).bytes).toBe(90_000);
    // Using 2 makes 3 the oldest.
    expect(new Uint8Array((await cache.get(id(2)))!.bytes)[0]).toBe(2);
    await cache.put(id(5), bytes(30_000, 5), "image/jpeg");
    expect([await cache.has(id(2)), await cache.has(id(3)), await cache.has(id(4)), await cache.has(id(5))]).toEqual([true, false, true, true]);
    expect(await cache.put(id(6), bytes(CONTENT_ITEM_MAX + 1), "image/png")).toBe(false);
    expect(await cache.put("pending:abc", bytes(10), "image/png")).toBe(false);
    // A new page (same Cache Storage) reads the index back.
    const again = new ContentCache({ caches, base: "http://127.0.0.1/v3/__content/", cap: 100_000 });
    expect(await again.usage()).toEqual({ bytes: 90_000, count: 3, cap: 100_000 });
    expect((await again.get(id(5)))!.type).toBe("image/jpeg");
  });

  it("rebuilds a lost index from the entries, and clear deletes the whole cache", async () => {
    const caches = new FakeCaches();
    const cache = new ContentCache({ caches, base: "http://127.0.0.1/v3/__content/", cap: 1_000_000 });
    await cache.put(id(7), bytes(1_000), "image/jpeg");
    await caches.stores.get(CONTENT_CACHE_NAME)!.delete("http://127.0.0.1/v3/__content/index.json");
    const again = new ContentCache({ caches, base: "http://127.0.0.1/v3/__content/", cap: 1_000_000 });
    expect(await again.usage()).toEqual({ bytes: 1_000, count: 1, cap: 1_000_000 });
    await again.clear();
    expect(caches.stores.has(CONTENT_CACHE_NAME)).toBe(false);
    expect(await again.get(id(7))).toBeNull();
    expect((await again.usage()).count).toBe(0);
  });

  it("is a no-op without Cache Storage", async () => {
    const cache = new ContentCache({ caches: undefined as unknown as CachesLike, base: "http://x/" });
    // `caches` absent on the global (Node): nothing is kept, nothing throws.
    expect(await cache.put(id(1), bytes(10), "image/png")).toBe(false);
    await cache.clear();
  });
});
