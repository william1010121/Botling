// Phase 5b: the update check (src/main/updates.ts) — which GitHub releases count, the order of versions,
// and when main looks (off by default, at most every 6 hours, Check now always).
import { describe, expect, it } from "vitest";
import { CHECK_EVERY_MS, Updater, compareVersions, parseVersion, pickUpdate } from "../../src/main/updates";

const page = (tag: string) => `https://github.com/william1010121/Botling/releases/tag/${tag}`;
const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, name: `Botling ${tag}`, html_url: page(tag), draft: false, prerelease: false, published_at: "2026-10-01T00:00:00Z", assets: [], ...extra });

describe("versions", () => {
  it("orders as semver does", () => {
    const order = ["2.0.0-dev.0", "2.0.0-dev.1", "2.0.0-rc.1", "2.0.0", "2.0.1", "2.1.0", "10.0.0"];
    for (let index = 1; index < order.length; index++) {
      expect(compareVersions(parseVersion(order[index - 1]!)!, parseVersion(order[index]!)!), `${order[index - 1]} < ${order[index]}`).toBeLessThan(0);
    }
    expect(compareVersions(parseVersion("v2.0.0")!, parseVersion("2.0.0")!)).toBe(0);
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("2.0")).toBeNull();
  });
});

describe("pickUpdate", () => {
  const feed = [
    release("v1.19.0", { assets: [{ name: "botling-1.19.0-macOS.zip" }] }), // the Swift app's: never
    release("v2.1.0", { draft: true }),
    release("v2.0.2", { assets: [{ name: "Botling-2-2.0.2-win-x64.exe" }, { name: "Botling-2-2.0.2-mac-arm64.zip" }] }),
    release("v2.0.1"),
    release("v2.0.3-rc.1", { prerelease: true }),
    release("v2.0.9", { html_url: "https://evil.example/releases/tag/v2.0.9" }),
    { tag_name: 3, html_url: page("x") }, null, "junk",
  ];
  it("takes the newest published 2.x release with this platform's download", () => {
    expect(pickUpdate(feed, "2.0.0", "darwin", "arm64")).toEqual({
      version: "2.0.2", name: "Botling v2.0.2", url: page("v2.0.2"), publishedAt: "2026-10-01T00:00:00Z", asset: "Botling-2-2.0.2-mac-arm64.zip",
    });
    expect(pickUpdate(feed, "2.0.0", "linux", "x64")?.asset).toBeNull();
  });
  it("offers prereleases only to a prerelease build", () => {
    expect(pickUpdate(feed, "2.0.0-dev.0", "darwin", "arm64")?.version).toBe("2.0.3-rc.1");
  });
  it("nothing when this build is the newest, or the feed is not a list", () => {
    expect(pickUpdate(feed, "2.0.2", "darwin", "arm64")).toBeNull();
    expect(pickUpdate({ message: "API rate limit exceeded" }, "2.0.0", "darwin", "arm64")).toBeNull();
    expect(pickUpdate(feed, "not a version", "darwin", "arm64")).toBeNull();
  });
});

describe("Updater", () => {
  function make(enabled: boolean, feed: unknown | (() => never) = [release("v2.0.2")]) {
    let saved: { checkedAt: number; newer: any } | null = null;
    let now = 1_000_000;
    let fetches = 0;
    const updater = new Updater({
      current: "2.0.0", platform: "darwin", arch: "arm64",
      enabled: async () => enabled,
      fetchFeed: async () => { fetches++; return typeof feed === "function" ? (feed as () => never)() : feed; },
      load: () => saved, save: (state) => { saved = state; }, now: () => now,
    });
    return { updater, fetches: () => fetches, tick: (ms: number) => { now += ms; } };
  }
  it("off: looks only when asked (Check now)", async () => {
    const { updater, fetches } = make(false);
    expect(await updater.check(false)).toEqual({ current: "2.0.0", enabled: false, newer: null, checkedAt: null, error: null });
    expect(fetches()).toBe(0);
    const view = await updater.check(true);
    expect(view.newer?.version).toBe("2.0.2");
    expect(fetches()).toBe(1);
    expect(updater.releasePage()).toBe(page("v2.0.2"));
  });
  it("on: at most every 6 hours", async () => {
    const { updater, fetches, tick } = make(true);
    await updater.check(false);
    await updater.check(false);
    expect(fetches()).toBe(1);
    tick(CHECK_EVERY_MS);
    await updater.check(false);
    expect(fetches()).toBe(2);
  });
  it("a failure is said, not thrown", async () => {
    const { updater } = make(true, () => { throw new Error("offline"); });
    expect((await updater.check(false)).error).toBe("Could not reach GitHub Releases: offline");
    expect(updater.releasePage()).toBeNull();
  });
});
