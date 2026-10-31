// The update check (src/main/updates.ts) on top of electron-updater: what counts as newer, when main looks (on by
// default, at most every 6 hours, Check now always), the download and the restart. electron-updater itself is
// replaced by a stand-in; no network, no real install.
import { describe, expect, it } from "vitest";
import { CHECK_EVERY_MS, Updater, compareVersions, parseVersion, releaseView, type UpdateInfoLike, type UpdaterLike } from "../../src/main/updates";

const page = (version: string) => `https://github.com/william1010121/Botling/releases/tag/v${version}`;
const info = (version: string, extra: Partial<UpdateInfoLike> = {}): UpdateInfoLike => ({ version, releaseName: `Botling ${version}`, releaseDate: "2026-10-01T00:00:00Z", files: [{ url: `Botling-2-${version}-mac-arm64.zip` }], ...extra });

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

describe("releaseView", () => {
  it("is the release's page (always this repository's), name, date and download", () => {
    expect(releaseView(info("2.1.0"))).toEqual({ version: "2.1.0", name: "Botling 2.1.0", url: page("2.1.0"), publishedAt: "2026-10-01T00:00:00Z", asset: "Botling-2-2.1.0-mac-arm64.zip" });
    expect(releaseView(info("2.1.0", { releaseName: null, files: [], releaseDate: undefined }))).toMatchObject({ name: "Botling 2.1.0", asset: null, publishedAt: null });
  });
});

describe("Updater", () => {
  function make(enabled: boolean, opts: { newest?: UpdateInfoLike | null; unavailable?: string | null; current?: string; fail?: Error } = {}) {
    let saved: { checkedAt: number; newer: any } | null = null;
    let now = 1_000_000;
    const calls = { check: 0, download: 0, install: [] as unknown[][] };
    let downloaded: ((info: UpdateInfoLike) => void) | null = null;
    let progress: ((progress: { percent: number }) => void) | null = null;
    let midDownload: (() => void) | null = null;
    const newest = opts.newest === undefined ? info("2.0.2") : opts.newest;
    const fake: UpdaterLike = {
      autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
      checkForUpdates: async () => { calls.check++; if (opts.fail) throw opts.fail; return newest ? { isUpdateAvailable: true, updateInfo: newest } : null; },
      downloadUpdate: async () => { calls.download++; progress?.({ percent: 42.4 }); midDownload?.(); downloaded?.(newest!); return []; },
      quitAndInstall: (...args) => { calls.install.push(args); },
      on: ((event: string, listener: never) => { if (event === "download-progress") progress = listener; else downloaded = listener; }) as UpdaterLike["on"],
    };
    const updater = new Updater({
      current: opts.current ?? "2.0.0", updater: fake, enabled: async () => enabled, unavailable: () => opts.unavailable ?? null,
      load: () => saved, save: (state) => { saved = state; }, now: () => now,
    });
    return { updater, fake, calls, onDownload: (fn: () => void) => { midDownload = fn; }, tick: (ms: number) => { now += ms; } };
  }

  it("never downloads or installs by itself, and a stable build ignores prereleases", () => {
    const { fake } = make(true);
    expect(fake).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false });
    expect(make(true, { current: "2.0.0-local-trial.1" }).fake.allowPrerelease).toBe(true);
  });
  it("off: looks only when asked (Check now)", async () => {
    const { updater, calls } = make(false);
    expect(await updater.check(false)).toEqual({ current: "2.0.0", enabled: false, newer: null, checkedAt: null, error: null, installError: null, readyVersion: null, downloadPercent: null });
    expect(calls.check).toBe(0);
    const view = await updater.check(true);
    expect(view.newer?.version).toBe("2.0.2");
    expect(calls.check).toBe(1);
    expect(updater.releasePage()).toBe(page("2.0.2"));
  });
  it("on: at most every 6 hours", async () => {
    const { updater, calls, tick } = make(true);
    await updater.check(false);
    await updater.check(false);
    expect(calls.check).toBe(1);
    tick(CHECK_EVERY_MS);
    await updater.check(false);
    expect(calls.check).toBe(2);
  });
  it("nothing when this build is the newest, or the feed says there is no update", async () => {
    expect((await make(true, { newest: info("2.0.0") }).updater.check(true)).newer).toBeNull();
    expect((await make(true, { newest: null }).updater.check(true)).newer).toBeNull();
  });
  it("a failure is said, not thrown", async () => {
    const { updater } = make(true, { fail: new Error("offline") });
    expect((await updater.check(false)).error).toBe("Could not check for updates: offline");
    expect(updater.releasePage()).toBeNull();
  });
  it("download is an explicit step; restart installs only what was downloaded", async () => {
    const { updater, calls } = make(true);
    expect(() => updater.restart()).toThrow(/Nothing is downloaded/);
    await expect(updater.download()).rejects.toThrow(/no newer release/);
    await updater.check(true);
    const view = await updater.download();
    expect(calls.download).toBe(1);
    expect(view.readyVersion).toBe("2.0.2");
    await updater.download();
    expect(calls.download).toBe(1);
    expect(calls.install).toHaveLength(0);
    updater.restart();
    expect(calls.install).toEqual([[true, true]]);
  });
  it("reports the download's progress while it runs, and none before or after", async () => {
    const { updater, onDownload } = make(true);
    await updater.check(true);
    expect(updater.view(true).downloadPercent).toBeNull();
    const seen: (number | null | undefined)[] = [];
    onDownload(() => seen.push(updater.view(true).downloadPercent));
    await updater.download();
    expect(seen).toEqual([42]);
    expect(updater.view(true)).toMatchObject({ readyVersion: "2.0.2", downloadPercent: null });
  });
  it("where it cannot update itself (a development run, a Linux .deb) it says why and downloads nothing", async () => {
    const { updater, calls } = make(true, { unavailable: "this Linux package (.deb) cannot update itself." });
    const view = await updater.check(true);
    expect(view).toMatchObject({ newer: { version: "2.0.2" }, installError: "this Linux package (.deb) cannot update itself." });
    await expect(updater.download()).rejects.toThrow(/\.deb/);
    expect(calls.download).toBe(0);
  });
});
