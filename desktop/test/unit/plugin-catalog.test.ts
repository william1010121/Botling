// The public plugin catalog (src/core/plugins/catalog.ts) and installing from it (src/core/plugin-store.ts, maintainer.ts):
// the folder hash is build-index.mjs's, only the plugin's folder is taken out of the commit's tarball, links and paths that
// leave the folder and oversized downloads are refused, a hash that does not match is refused, the index works offline from
// its cache, and install / update / revert / remove go through the usual install card. No network: fetch is a fake.
//
// Fixtures (test/fixtures/plugin-catalog): the real botling-plugins tarball at a93fc02 (`git archive`, as GitHub's codeload
// serves it), its index.json (f942b81, which records a93fc02) and its tools/build-index.mjs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktop, tempDir } from "../helpers";
import {
  Catalog, catalogSource, folderHash, HashMismatch, LIMITS, OFFICIAL_INDEX_URL, parseIndex, readTar, safeGet, safeRelative, stagePlugin,
  type CatalogEntry, type Fetch,
} from "../../src/core/plugins/catalog";
import { PluginStore } from "../../src/core/plugin-store";
import { MaintainerDesk } from "../../src/core/maintainer";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { ComponentLibrary } from "../../src/core/components/library";
import type { PluginStoreView } from "../../src/contract";

const fixtures = join(desktop, "test", "fixtures", "plugin-catalog");
const realTarball = readFileSync(join(fixtures, "botling-plugins-a93fc02.tar.gz"));
const realIndex = JSON.parse(readFileSync(join(fixtures, "index.json"), "utf8"));
const realEntries = parseIndex(realIndex);
const COMMIT = "a93fc02ea058e9c9e3445bff2e10ad01c28cfa8a";

// ---------------------------------------------------------------------------------------------
// A small tar writer for crafted archives (ustar, as git archive writes them).

type TarItem = { path: string; data?: string | Buffer; type?: "0" | "5" | "2" | "1" | "3"; link?: string; mode?: number };
function header(name: string, size: number, type: string, link = "", mode = 0o644): Buffer {
  const block = Buffer.alloc(512);
  const put = (text: string, at: number, length: number) => block.write(text.slice(0, length), at, length, "utf8");
  put(name, 0, 100);
  put(mode.toString(8).padStart(7, "0"), 100, 8);
  put("0000000", 108, 8); put("0000000", 116, 8);
  put(size.toString(8).padStart(11, "0"), 124, 12);
  put("00000000000", 136, 12);
  block.fill(0x20, 148, 156);
  put(type, 156, 1);
  put(link, 157, 100);
  put("ustar\u000000", 257, 8);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(sum.toString(8).padStart(6, "0") + "\u0000 ", 148, 8);
  return block;
}
function pax(records: Record<string, string>): Buffer {
  const body = Object.entries(records).map(([key, value]) => {
    const text = ` ${key}=${value}\n`;
    let length = text.length + 1;
    while (`${length}${text}`.length !== length) length = `${length}${text}`.length;
    return `${length}${text}`;
  }).join("");
  return Buffer.from(body);
}
function tarOf(items: TarItem[], top = "botling-plugins-abc"): Buffer {
  const parts: Buffer[] = [header(`${top}/`, 0, "5", "", 0o755)];
  const add = (block: Buffer, data: Buffer) => { parts.push(block, data, Buffer.alloc((512 - (data.length % 512)) % 512)); };
  for (const item of items) {
    const data = Buffer.from(item.data ?? "");
    const type = item.type ?? "0";
    const name = item.path.startsWith("/") ? item.path : `${top}/${item.path}`;
    if (name.length > 100) { const records = pax({ path: name }); add(header("pax", records.length, "x"), records); }
    add(header(name, type === "0" ? data.length : 0, type, item.link ?? "", item.mode ?? 0o644), type === "0" ? data : Buffer.alloc(0));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** build-index.mjs's rule written out again, independently: "<path>\0<sha256>\n" for each file by path, hashed. */
function expectedHash(files: Record<string, string>): string {
  const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  return sha(Object.keys(files).sort().map((path) => `${path}\0${sha(files[path]!)}\n`).join(""));
}

function demoFiles(version: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "demo", displayName: "Demo", version, description: "A demo.", license: "MIT", engines: { ccb: "^2.0.0" }, ccb: { permissions: ["composer"] } }, null, 2),
    "README.md": `# Demo ${version}\n`,
    ...extra,
  };
}
function demoEntry(version: string, files: Record<string, string>, commit: string, more: Partial<CatalogEntry> = {}): Record<string, unknown> {
  return { name: "demo", displayName: "Demo", description: "A demo.", version, license: "MIT", permissions: ["composer"], engines: { ccb: "^2.0.0" }, minAppVersion: "2.0.0", parts: [], path: "demo", files: Object.keys(files).length, size: 0, sha256: expectedHash(files), commit, ...more };
}
function demoTarball(files: Record<string, string>): Buffer {
  return tarOf(Object.entries(files).map(([path, data]) => ({ path: `demo/${path}`, data })));
}

/** A fake fetch serving `routes` (URL → body, or a function), recording each request; anything else is a 404. */
function fakeFetch(routes: Record<string, string | Buffer | (() => Response | Promise<Response>)>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (typeof route === "function") return route();
    if (route === undefined) return new Response("not found", { status: 404 });
    return new Response(typeof route === "string" ? route : new Uint8Array(route), { status: 200 });
  }) as unknown as Fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}
const offlineFetch: Fetch = async () => { throw new TypeError("fetch failed"); };

const files = (dir: string, base = dir): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? files(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1)]).sort();

// ---------------------------------------------------------------------------------------------

describe("the folder hash is build-index.mjs's", () => {
  it("the five real plugins, taken out of the real commit's tarball, hash to what index.json records", () => {
    expect(realEntries.map((entry) => entry.name)).toEqual(["botling-components-basic", "ccb-laas", "ccb-session-usage", "ccb-teams", "ccb-web-extractors"]);
    const staging = tempDir("catalog-real");
    const root = join(staging, "repo");
    mkdirSync(join(root, "tools"), { recursive: true });
    for (const entry of realEntries) {
      expect(entry.commit).toBe(COMMIT);
      const { folder } = stagePlugin(realTarball, entry, staging);
      expect(folderHash(folder)).toBe(entry.sha256);
      expect(files(folder).length).toBe(entry.files);
      cpSync(folder, join(root, entry.path), { recursive: true });
    }
    // And build-index.mjs itself, run over the same folders, finds index.json up to date (the same hashes, sizes and counts).
    cpSync(join(fixtures, "build-index.mjs"), join(root, "tools", "build-index.mjs"));
    cpSync(join(fixtures, "index.json"), join(root, "index.json"));
    const out = execFileSync(process.execPath, [join(root, "tools", "build-index.mjs"), "--check"], { encoding: "utf8" });
    expect(out).toContain("index.json is up to date (5 plugins)");
  });

  it("matches the rule written out independently (paths sorted, nested folders with / , empty folders not counted)", () => {
    const dir = tempDir("catalog-hash");
    const content = { "package.json": "{}", "a/b/c.txt": "deep", "Z.md": "upper", "a.txt": "x" };
    for (const [path, data] of Object.entries(content)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), data); }
    mkdirSync(join(dir, "empty"));
    expect(folderHash(dir)).toBe(expectedHash(content));
  });
});

describe("taking one plugin's folder out of the commit's tarball", () => {
  it("takes only that folder (no other plugin, no index.json or tools), and keeps an executable bit", () => {
    const staging = tempDir("catalog-one");
    const teams = realEntries.find((entry) => entry.name === "ccb-teams")!;
    const { work, folder } = stagePlugin(realTarball, teams, staging);
    expect(readdirSync(work)).toEqual(["ccb-teams"]);
    expect(files(folder)).toHaveLength(teams.files);
    expect(JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).name).toBe("ccb-teams");
    expect(existsSync(join(work, "index.json"))).toBe(false);

    const content = demoFiles("1.0.0", { "bin/run.sh": "#!/bin/sh\necho hi\n" });
    const archive = tarOf([...Object.entries(content).map(([path, data]) => ({ path: `demo/${path}`, data, mode: path.endsWith(".sh") ? 0o755 : 0o644 })), { path: "other/package.json", data: "{}" }, { path: "index.json", data: "{}" }]);
    const staged = stagePlugin(archive, parseIndex({ schema: 1, plugins: [demoEntry("1.0.0", content, COMMIT)] })[0]!, staging);
    expect(files(staged.folder)).toEqual(["README.md", "bin/run.sh", "package.json"]);
    expect(statSync(join(staged.folder, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(staged.folder, "README.md")).mode & 0o777).toBe(0o644);
  });

  it("reads long paths from pax headers", () => {
    const long = `${"d".repeat(60)}/${"e".repeat(60)}.txt`;
    const entries = readTar(gunzipSync(tarOf([{ path: `demo/${long}`, data: "x" }])));
    expect(entries.map((entry) => entry.path)).toContain(`botling-plugins-abc/demo/${long}`);
  });

  it("refuses paths that leave the folder, links and odd entries, and removes what it wrote", () => {
    const content = demoFiles("1.0.0");
    const entry = parseIndex({ schema: 1, plugins: [demoEntry("1.0.0", content, COMMIT)] })[0]!;
    const base = Object.entries(content).map(([path, data]) => ({ path: `demo/${path}`, data }));
    const cases: [TarItem, RegExp][] = [
      [{ path: "demo/../evil.txt", data: "x" }, /leaves the plugin folder/],
      [{ path: "demo/a/../../evil.txt", data: "x" }, /leaves the plugin folder/],
      [{ path: "demo/./x.txt", data: "x" }, /leaves the plugin folder/],
      [{ path: "demo/link", type: "2", link: "/etc/passwd" }, /has a link/],
      [{ path: "demo/inner", type: "2", link: "README.md" }, /has a link/],
      [{ path: "demo/hard", type: "1", link: "botling-plugins-abc/demo/README.md" }, /has a link/],
      [{ path: "demo/dev", type: "3" }, /not a file or a folder/],
    ];
    for (const [bad, problem] of cases) {
      const staging = tempDir("catalog-bad");
      expect(() => stagePlugin(tarOf([...base, bad]), entry, staging), bad.path).toThrow(problem);
      expect(readdirSync(staging), bad.path).toEqual([]);
    }
    // An absolute path is outside the repo's top folder, so it is never part of the plugin (and nothing is written there).
    const staging = tempDir("catalog-abs");
    const target = join(staging, "outside.txt");
    const staged = stagePlugin(tarOf([...base, { path: target, data: "x" }]), entry, staging);
    expect(files(staged.folder)).toEqual(["README.md", "package.json"]);
    expect(existsSync(target)).toBe(false);
    expect(safeRelative("a/b")).toBe(true);
    for (const bad of ["/abs", "../x", "a/../b", "a//b", "./a", "a\\b", "C:x", ""]) expect(safeRelative(bad), bad).toBe(false);
  });

  it("refuses a folder whose hash is not the index's, and leaves nothing behind", () => {
    const content = demoFiles("1.0.0");
    const entry = parseIndex({ schema: 1, plugins: [demoEntry("1.0.0", content, COMMIT)] })[0]!;
    const staging = tempDir("catalog-mismatch");
    const tampered = demoTarball({ ...content, "README.md": "# Something else\n" });
    expect(() => stagePlugin(tampered, entry, staging)).toThrow(HashMismatch);
    expect(() => stagePlugin(tampered, entry, staging)).toThrow(/does not match the index/);
    expect(readdirSync(staging)).toEqual([]);
    // One file more is a mismatch too.
    expect(() => stagePlugin(demoTarball({ ...content, "extra.js": "run()" }), entry, staging)).toThrow(HashMismatch);
    // A folder that is not in the tarball at all.
    expect(() => stagePlugin(tarOf([{ path: "other/package.json", data: "{}" }]), entry, staging)).toThrow(/has no folder "demo"/);
    expect(() => stagePlugin(Buffer.from("not gzip"), entry, staging)).toThrow(/not a gzipped tar/);
  });
});

describe("downloads", () => {
  it("refuses a redirect to another host, follows one on the same host, and refuses plain http", async () => {
    const elsewhere = fakeFetch({ "https://codeload.github.com/a": () => new Response(null, { status: 302, headers: { location: "https://evil.example/a" } }) });
    await expect(safeGet(elsewhere, "https://codeload.github.com/a", 100, 1000)).rejects.toThrow(/redirect to another host \(evil.example\)/);
    const same = fakeFetch({ "https://codeload.github.com/a": () => new Response(null, { status: 301, headers: { location: "/b" } }), "https://codeload.github.com/b": "ok" });
    expect((await safeGet(same, "https://codeload.github.com/a", 100, 1000)).toString()).toBe("ok");
    expect(same.calls).toEqual(["https://codeload.github.com/a", "https://codeload.github.com/b"]);
    await expect(safeGet(same, "http://codeload.github.com/a", 100, 1000)).rejects.toThrow(/HTTPS only/);
    const downgrade = fakeFetch({ "https://codeload.github.com/a": () => new Response(null, { status: 302, headers: { location: "http://codeload.github.com/a" } }) });
    await expect(safeGet(downgrade, "https://codeload.github.com/a", 100, 1000)).rejects.toThrow(/redirect/);
  });

  it("refuses oversized downloads, by their length or while reading", async () => {
    const declared = fakeFetch({ "https://x.test/big": () => new Response("x".repeat(50), { status: 200, headers: { "content-length": "5000" } }) });
    await expect(safeGet(declared, "https://x.test/big", 100, 1000)).rejects.toThrow(/too large \(5000 bytes/);
    const streamed = fakeFetch({ "https://x.test/big": () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(30)); c.close(); } }), { status: 200 }) });
    await expect(safeGet(streamed, "https://x.test/big", 100, 1000)).rejects.toThrow(/too large \(over 100 bytes/);
    expect(LIMITS.tarballBytes).toBeGreaterThan(realTarball.length);
  });

  it("downloads the tarball of exactly the recorded commit", async () => {
    const fetcher = fakeFetch({ [`https://codeload.github.com/william1010121/botling-plugins/tar.gz/${COMMIT}`]: realTarball });
    const catalog = new Catalog(catalogSource(null), join(tempDir("catalog-dl"), "plugin-index.json"), fetcher);
    const laas = realEntries.find((entry) => entry.name === "ccb-laas")!;
    const { folder } = await catalog.download(laas, tempDir("catalog-dl-staging"));
    expect(fetcher.calls).toEqual([`https://codeload.github.com/william1010121/botling-plugins/tar.gz/${COMMIT}`]);
    expect(folderHash(folder)).toBe(laas.sha256);
    await expect(catalog.download({ ...laas, commit: "" }, tempDir("catalog-dl-staging"))).rejects.toThrow(/no released commit/);
  });
});

describe("the index", () => {
  it("is the official repo's unless settings name a raw.githubusercontent.com index or one on this computer", () => {
    expect(catalogSource(null)).toMatchObject({ indexURL: OFFICIAL_INDEX_URL, official: true });
    expect(OFFICIAL_INDEX_URL).toBe("https://raw.githubusercontent.com/william1010121/botling-plugins/main/index.json");
    const fork = catalogSource("https://raw.githubusercontent.com/me/fork/test-branch/index.json");
    expect(fork).toMatchObject({ official: false });
    expect(fork.tarball("f".repeat(40))).toBe(`https://codeload.github.com/me/fork/tar.gz/${"f".repeat(40)}`);
    expect(catalogSource("http://127.0.0.1:8123/repo/index.json").tarball("abc")).toBe("http://127.0.0.1:8123/repo/tarball/abc.tar.gz");
    for (const bad of ["https://evil.example/index.json", "http://raw.githubusercontent.com/a/b/c/index.json", "https://raw.githubusercontent.com/a/b/c/other.json", "file:///etc/index.json", "nonsense"]) {
      expect(() => catalogSource(bad), bad).toThrow(/pluginIndexURL/);
    }
  });

  it("keeps only well-formed entries", () => {
    const good = demoEntry("1.0.0", demoFiles("1.0.0"), COMMIT);
    const entries = parseIndex({ schema: 1, plugins: [
      good, { ...good, name: "Bad Name" }, { ...good, name: "p2", path: "../x" }, { ...good, name: "p3", sha256: "zz" }, { ...good, name: "p4", commit: "main" },
      { ...good, name: "p5", version: "1.0" }, { ...good, name: "p6", path: "tools" }, { ...good, name: "unreleased", commit: "" }, good,
    ] });
    expect(entries.map((entry) => entry.name)).toEqual(["demo", "unreleased"]);
    expect(() => parseIndex({ plugins: [] })).toThrow(/not a plugin index/);
  });

  it("is cached: offline (or failing), the last copy is used and the page is told why", async () => {
    const dir = tempDir("catalog-cache");
    const cache = join(dir, "plugin-index.json");
    let now = 1_000;
    const online = fakeFetch({ [OFFICIAL_INDEX_URL]: JSON.stringify(realIndex) });
    const first = new Catalog(catalogSource(null), cache, online, () => now);
    expect(first.current).toMatchObject({ entries: [], fetchedAt: null, fromCache: false });
    const fetched = await first.refresh();
    expect(fetched).toMatchObject({ fetchedAt: 1_000, fromCache: false, error: null, offline: false });
    expect(fetched.entries.map((entry) => entry.name)).toEqual(realEntries.map((entry) => entry.name));
    expect(first.fresh(60_000)).toBe(true);
    now = 100_000;
    expect(first.fresh(60_000)).toBe(false);

    // A new start without a network: the cached entries, with when they are from.
    const offline = new Catalog(catalogSource(null), cache, offlineFetch, () => now);
    expect(offline.current).toMatchObject({ fetchedAt: 1_000, fromCache: true });
    const state = await offline.refresh();
    expect(state).toMatchObject({ fetchedAt: 1_000, fromCache: true, offline: true });
    expect(state.error).toMatch(/Can't reach raw.githubusercontent.com/);
    expect(state.entries).toHaveLength(5);

    // The server answers but not with the index: the cache stays, the error says so, not offline.
    const broken = new Catalog(catalogSource(null), cache, fakeFetch({ [OFFICIAL_INDEX_URL]: "<html>" }), () => now);
    expect(await broken.refresh()).toMatchObject({ fromCache: true, offline: false, error: "index.json is not valid JSON." });
    const missing = new Catalog(catalogSource(null), cache, fakeFetch({}), () => now);
    expect(await missing.refresh()).toMatchObject({ fromCache: true, error: "raw.githubusercontent.com answered 404." });

    // Without a cache and offline: nothing to show, and why.
    const empty = new Catalog(catalogSource(null), join(dir, "none.json"), offlineFetch);
    expect(await empty.refresh()).toMatchObject({ entries: [], fetchedAt: null, fromCache: false, offline: true });
    // A cache made for another index URL is not used.
    expect(new Catalog(catalogSource("https://raw.githubusercontent.com/me/fork/main/index.json"), cache, offlineFetch).current.entries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Installing from the catalog through the usual install card (in-process: a fake main bot, no git).

describe("install, update, revert and remove from the catalog", () => {
  beforeEach(() => { vi.stubEnv("BOTLING_GIT_PATH", "/nonexistent/git"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  const C1 = "1".repeat(40), C2 = "2".repeat(40);
  const v1 = demoFiles("1.0.0"), v2 = demoFiles("1.1.0", { "NEW.md": "new\n" });

  function setup(index: Record<string, unknown>, options: { appVersion?: string | null; builtIns?: string | null } = {}) {
    const root = tempDir("catalog-store");
    mkdirSync(join(root, "plugins"), { recursive: true });
    const notices: { text: string; choices?: { label: string }[]; answer?: (index: number) => void }[] = [];
    const main = { id: "MAIN", profile: { name: "Main bot" }, appNotice(text: string, choices?: { label: string }[], answer?: (index: number) => void) { notices.push({ text, choices, answer }); return "n"; } };
    const registry = new PluginRegistry(join(root, "plugins"), join(root, "plugins.json"), new MemorySecretStore(), options.builtIns ?? null);
    const desk = new MaintainerDesk({ root, maintainer: () => null, mainBot: () => main as never, bots: () => [], library: new ComponentLibrary(() => []), plugins: () => ({ registry }) as never, log: () => {} });
    const routes: Record<string, string | Buffer> = {
      [OFFICIAL_INDEX_URL]: JSON.stringify(index),
      [`https://codeload.github.com/william1010121/botling-plugins/tar.gz/${C1}`]: demoTarball(v1),
      [`https://codeload.github.com/william1010121/botling-plugins/tar.gz/${C2}`]: demoTarball(v2),
    };
    const fetcher = fakeFetch(routes);
    const views: PluginStoreView[] = [];
    const store = new PluginStore({ root, desk, registry: () => registry, indexOverride: () => null, appVersion: options.appVersion === undefined ? "2.7.0" : options.appVersion, fetcher, changed: (view) => views.push(view), log: () => {} });
    const entry = (view: PluginStoreView, name = "demo") => view.entries.find((candidate) => candidate.name === name)!;
    return { root, notices, registry, desk, store, routes, fetcher, views, entry };
  }

  it("Install downloads and checks it, then asks on the install card; nothing is in the library until Install", async () => {
    const t = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1)] });
    const view = await t.store.refresh();
    expect(t.entry(view)).toMatchObject({ state: "available", installedVersion: null, status: null, page: `https://github.com/william1010121/botling-plugins/tree/${C1}/demo` });
    const asked = await t.store.install("demo");
    expect(t.entry(asked).status).toEqual({ kind: "asking", message: null });
    // The card: the usual install question, with what was checked.
    const card = t.notices.at(-1)!;
    expect(card.choices!.map((choice) => choice.label)).toEqual(["Install", "Don't install"]);
    expect(card.text).toContain('Install the plugin "Demo" 1.0.0?');
    expect(card.text).toContain(`Source: https://github.com/william1010121/botling-plugins/tree/${C1}/demo`);
    expect(card.text).toContain(`Checked: its files match the index (sha256 ${expectedHash(v1).slice(0, 12)}…) at commit 1111111 of the official botling-plugins repo.`);
    expect(card.text).toContain("It will: read and change what you type in the input box");
    // Not installed (nor loadable) before the answer.
    expect(existsSync(join(t.root, "plugins", "demo"))).toBe(false);
    expect(t.registry.plugin("demo")).toBeUndefined();
    card.answer!(0);
    expect(t.registry.plugin("demo")).toMatchObject({ installedFrom: `https://github.com/william1010121/botling-plugins/tree/${C1}/demo`, enabled: true });
    expect(folderHash(join(t.root, "plugins", "demo"))).toBe(expectedHash(v1));
    expect(t.entry(t.store.view())).toMatchObject({ state: "installed", installedVersion: "1.0.0", status: { kind: "installed", message: null } });
    expect(readdirSync(join(t.root, "install-staging"))).toEqual([]);
    expect(t.notices.at(-1)!.text).toMatch(/^Installed: Demo 1.0.0\./);
    expect(t.entry(t.store.dismiss("demo")).status).toBeNull();
  });

  it("Don't install: nothing changes and the page hears it was declined", async () => {
    const t = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1)] });
    await t.store.refresh();
    await t.store.install("demo");
    t.notices.at(-1)!.answer!(1);
    expect(existsSync(join(t.root, "plugins", "demo"))).toBe(false);
    expect(t.entry(t.store.view()).status).toEqual({ kind: "declined", message: null });
    expect(readdirSync(join(t.root, "install-staging"))).toEqual([]);
  });

  it("a hash mismatch is refused before any card", async () => {
    const t = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1)] });
    t.routes[`https://codeload.github.com/william1010121/botling-plugins/tar.gz/${C1}`] = demoTarball({ ...v1, "README.md": "changed" });
    await t.store.refresh();
    const view = await t.store.install("demo");
    expect(t.entry(view).status!.kind).toBe("failed");
    expect(t.entry(view).status!.message).toMatch(/does not match the index/);
    expect(t.notices).toEqual([]);
    expect(readdirSync(join(t.root, "install-staging"))).toEqual([]);
  });

  it("an app too old for it, or an unreleased entry, is not offered and not downloaded", async () => {
    const t = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1, { minAppVersion: "2.9.0" }), { ...demoEntry("1.0.0", v1, ""), name: "later" }] });
    const view = await t.store.refresh();
    expect(t.entry(view)).toMatchObject({ state: "tooOld" });
    expect(t.entry(view, "later")).toMatchObject({ state: "unreleased", page: null });
    const tried = await t.store.install("demo");
    expect(t.entry(tried).status!.message).toBe('"Demo" needs Botling 2.9.0 or newer; this is 2.7.0.');
    expect(t.fetcher.calls.filter((url) => url.includes("codeload"))).toEqual([]);
    // engines.ccb this Botling does not satisfy counts the same.
    const engines = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1, { engines: { ccb: "^9.0.0" } } as never)] });
    expect(engines.entry(await engines.store.refresh()).state).toBe("tooOld");
  });

  it("the library's own copy (a development copy) is never installed over", async () => {
    const t = setup({ schema: 1, plugins: [demoEntry("1.1.0", v2, C2)] });
    mkdirSync(join(t.root, "plugins", "demo"));
    for (const [path, data] of Object.entries(v1)) writeFileSync(join(t.root, "plugins", "demo", path), data);
    t.registry.rescan(true);
    const view = await t.store.refresh();
    expect(t.entry(view)).toMatchObject({ state: "devCopy", installedVersion: "1.0.0" });
    expect(view.updates).toBe(0);
    const tried = await t.store.install("demo");
    expect(t.entry(tried).status!.message).toMatch(/has its own "demo" \(a development copy\)/);
    expect(t.notices).toEqual([]);
  });

  it("a built-in plugin at the same version or newer stays built in; a newer catalog version is an update", async () => {
    const builtIns = tempDir("catalog-builtins");
    mkdirSync(join(builtIns, "demo"));
    for (const [path, data] of Object.entries(v1)) writeFileSync(join(builtIns, "demo", path), data);
    const same = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1)] }, { builtIns });
    expect(same.entry(await same.store.refresh())).toMatchObject({ state: "builtIn", installedVersion: "1.0.0" });
    const newer = setup({ schema: 1, plugins: [demoEntry("1.1.0", v2, C2)] }, { builtIns });
    const view = await newer.store.refresh();
    expect(newer.entry(view)).toMatchObject({ state: "update", installedVersion: "1.0.0" });
    expect(view.updates).toBe(1);
  });

  it("Update keeps the version it replaces; Revert puts it back (and again undoes that); Remove deletes it but keeps its data", async () => {
    const t = setup({ schema: 1, plugins: [demoEntry("1.0.0", v1, C1)] });
    await t.store.refresh();
    await t.store.install("demo");
    t.notices.at(-1)!.answer!(0);
    const dataFolder = join(t.root, "plugin-data", "demo");
    mkdirSync(dataFolder, { recursive: true });
    writeFileSync(join(dataFolder, "state.json"), "{}");

    // The catalog moves on to 1.1.0.
    t.routes[OFFICIAL_INDEX_URL] = JSON.stringify({ schema: 1, plugins: [demoEntry("1.1.0", v2, C2)] });
    const view = await t.store.refresh();
    expect(t.entry(view)).toMatchObject({ state: "update", installedVersion: "1.0.0" });
    expect(view.updates).toBe(1);
    await t.store.install("demo");
    const card = t.notices.at(-1)!;
    expect(card.text).toContain('Update the plugin "Demo" from 1.0.0 to 1.1.0?');
    card.answer!(0);
    expect(t.registry.plugin("demo")!.manifest.version).toBe("1.1.0");
    expect(folderHash(join(t.root, "plugins", "demo"))).toBe(expectedHash(v2));
    expect(t.desk.previousOf("demo")).toEqual({ version: "1.0.0", source: `https://github.com/william1010121/botling-plugins/tree/${C1}/demo` });
    expect(t.store.view().updates).toBe(0);

    // Revert: 1.0.0 again, with where it came from; 1.1.0 is kept in its place.
    expect(t.desk.revertPlugin("demo")).toBeNull();
    expect(t.registry.plugin("demo")).toMatchObject({ manifest: { version: "1.0.0" }, installedFrom: `https://github.com/william1010121/botling-plugins/tree/${C1}/demo` });
    expect(folderHash(join(t.root, "plugins", "demo"))).toBe(expectedHash(v1));
    expect(t.desk.previousOf("demo")).toMatchObject({ version: "1.1.0" });
    expect(t.entry(t.store.view())).toMatchObject({ state: "update" });
    expect(t.desk.revertPlugin("demo")).toBeNull();
    expect(t.registry.plugin("demo")!.manifest.version).toBe("1.1.0");

    // Remove: the copy and the kept version go; its data folder stays.
    expect(t.desk.removePlugin("demo")).toBeNull();
    expect(t.registry.plugin("demo")).toBeUndefined();
    expect(existsSync(join(t.root, "plugins", "demo"))).toBe(false);
    expect(t.desk.previousOf("demo")).toBeNull();
    expect(readFileSync(join(dataFolder, "state.json"), "utf8")).toBe("{}");
    expect(t.entry(t.store.view())).toMatchObject({ state: "available", installedVersion: null });
    expect(t.desk.revertPlugin("demo")).toMatch(/no previous version/);
  });

  it("Remove leaves the library's own plugins and built-in ones alone", () => {
    const t = setup({ schema: 1, plugins: [] });
    mkdirSync(join(t.root, "plugins", "demo"));
    for (const [path, data] of Object.entries(v1)) writeFileSync(join(t.root, "plugins", "demo", path), data);
    t.registry.rescan(true);
    expect(t.desk.removePlugin("demo")).toMatch(/not a plugin installed from outside/);
    expect(existsSync(join(t.root, "plugins", "demo", "package.json"))).toBe(true);
    expect(t.desk.removePlugin("missing")).toMatch(/not a plugin installed from outside/);
  });
});
