// The public plugin catalog: the botling-plugins repo on GitHub (one folder per plugin, an index.json at its root that
// tools/build-index.mjs writes). What the Plugins page's Explore and Updates read, and where an install from it comes from.
//
// - Only one source is trusted: OFFICIAL (a constant). settings.json `pluginIndexURL` replaces it for testing (another
//   raw.githubusercontent.com repo or branch, or a server on this computer); nothing else is read.
// - index.json is fetched over HTTPS and kept in <data>/plugin-index.json, so the page works offline with the last copy
//   (and says when it is from).
// - A plugin is downloaded as the tarball of exactly the commit its entry records, and only its folder is taken out of it:
//   no link, no path that leaves the folder, no file type but files and folders, nothing over the size limits. Its files
//   are hashed with build-index.mjs's rule (`folderHash`) and refused unless the hash is the entry's. Nothing in it runs:
//   it is a staging folder until the user says Install on the usual install card (maintainer.ts).
// - Redirects are followed only on the same host (GitHub's codeload answers directly; anything else is refused).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { writeFileAtomic } from "../durable/atomic";
import { compareVersions } from "./versions";

/** The catalog Botling trusts by default. */
export const OFFICIAL = { owner: "william1010121", repo: "botling-plugins", ref: "main" } as const;
export const OFFICIAL_INDEX_URL = `https://raw.githubusercontent.com/${OFFICIAL.owner}/${OFFICIAL.repo}/${OFFICIAL.ref}/index.json`;
/** The settings.json key that points the catalog elsewhere, for testing. */
export const INDEX_URL_SETTING = "pluginIndexURL";

/** Limits on what is downloaded and what one plugin may hold. */
export const LIMITS = { indexBytes: 2_000_000, tarballBytes: 60_000_000, unpackedBytes: 250_000_000, pluginBytes: 50_000_000, pluginFiles: 5_000 } as const;

export type Fetch = (url: string, init: { redirect: "manual"; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

/** Where the index and the tarballs come from. */
export interface CatalogSource {
  indexURL: string;
  official: boolean;
  /** The tarball of `commit` (the whole repo at that commit). */
  tarball(commit: string): string;
  /** The page a plugin's folder is shown on, for the install card and the installed plugin's "from". */
  folderPage(commit: string, path: string): string;
}

/** The source for `override` (settings.json `pluginIndexURL`), else the official one; an override Botling won't read is an error. */
export function catalogSource(override: unknown): CatalogSource {
  const text = typeof override === "string" ? override.trim() : "";
  if (!text || text === OFFICIAL_INDEX_URL) return githubSource(OFFICIAL.owner, OFFICIAL.repo, OFFICIAL.ref, true);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`${INDEX_URL_SETTING} is not a URL: ${text.slice(0, 200)}`); }
  const github = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_./-]+)\/index\.json$/.exec(url.pathname);
  if (url.protocol === "https:" && url.hostname === "raw.githubusercontent.com" && github && !url.search && !url.hash) return githubSource(github[1]!, github[2]!, github[3]!, false);
  if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname.endsWith("/index.json")) {
    return {
      indexURL: url.href, official: false,
      tarball: (commit) => new URL(`tarball/${commit}.tar.gz`, url).href,
      folderPage: (commit, path) => new URL(`tree/${commit}/${path}`, url).href,
    };
  }
  throw new Error(`${INDEX_URL_SETTING} must be an index.json on raw.githubusercontent.com (https) or on this computer (http://127.0.0.1).`);
}

function githubSource(owner: string, repo: string, ref: string, official: boolean): CatalogSource {
  return {
    indexURL: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/index.json`, official,
    tarball: (commit) => `https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`,
    folderPage: (commit, path) => `https://github.com/${owner}/${repo}/tree/${commit}/${path}`,
  };
}

// ---------------------------------------------------------------------------------------------
// The index

/** One plugin in index.json (build-index.mjs's entry), as far as Botling uses it. */
export interface CatalogEntry {
  name: string;
  displayName: string;
  description: string;
  version: string;
  license: string | null;
  permissions: string[];
  parts: string[];
  minAppVersion: string | null;
  engines: string | null;
  path: string;
  files: number;
  size: number;
  sha256: string;
  /** The commit the folder is recorded at; "" until it is released (not installable yet). */
  commit: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/;
const str = (value: unknown, limit: number): string | null => (typeof value === "string" ? value.slice(0, limit) : null);

/** The entries of an index.json Botling can use (a malformed entry is left out); throws when the file is not an index at all. */
export function parseIndex(value: unknown): CatalogEntry[] {
  const index = value as { schema?: unknown; plugins?: unknown } | null;
  if (!index || typeof index !== "object" || index.schema !== 1 || !Array.isArray(index.plugins)) throw new Error("index.json is not a plugin index (schema 1 with a plugins list).");
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of index.plugins.slice(0, 500) as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    const name = str(raw.name, 214), version = str(raw.version, 100), path = str(raw.path, 214), sha256 = str(raw.sha256, 64), commit = str(raw.commit, 40) ?? "";
    if (!name || !NAME.test(name) || !version || compareVersions(version, version) === null || !path || !FOLDER.test(path) || path === "tools") continue;
    if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || (commit && !/^[0-9a-f]{40}$/.test(commit)) || seen.has(name)) continue;
    seen.add(name);
    const engines = (raw.engines && typeof raw.engines === "object" ? (raw.engines as Record<string, unknown>).ccb ?? (raw.engines as Record<string, unknown>).botling : null);
    const minApp = str(raw.minAppVersion, 100);
    entries.push({
      name, version, path, sha256, commit,
      displayName: str(raw.displayName, 200) || name,
      description: str(raw.description, 2_000) ?? "",
      license: str(raw.license, 100),
      permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((p): p is string => typeof p === "string").slice(0, 20).map((p) => p.slice(0, 40)) : [],
      parts: Array.isArray(raw.parts) ? raw.parts.filter((p): p is string => typeof p === "string").slice(0, 8).map((p) => p.slice(0, 40)) : [],
      minAppVersion: minApp && compareVersions(minApp, minApp) !== null ? minApp : null,
      engines: typeof engines === "string" ? engines.slice(0, 100) : null,
      files: typeof raw.files === "number" && Number.isFinite(raw.files) ? raw.files : 0,
      size: typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : 0,
    });
  }
  return entries;
}

/** What the catalog knows now: the entries (fresh or from the cache), when they were fetched, and the last fetch's problem. */
export interface CatalogState {
  url: string;
  official: boolean;
  entries: CatalogEntry[];
  /** When the entries were fetched (ms); null: never. */
  fetchedAt: number | null;
  /** The last fetch failed, so the entries (if any) are the cached copy. */
  fromCache: boolean;
  error: string | null;
  /** The last fetch could not reach the server at all (no network, DNS, refused). */
  offline: boolean;
}

interface CacheFile { url: string; fetchedAt: number; index: unknown }

export function readCache(file: string, url: string): { entries: CatalogEntry[]; fetchedAt: number } | null {
  try {
    const cache = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    if (cache.url !== url || typeof cache.fetchedAt !== "number") return null;
    return { entries: parseIndex(cache.index), fetchedAt: cache.fetchedAt };
  } catch {
    return null;
  }
}

/** An error the fetch could not get past: `offline` when the server was not reached at all. */
export class FetchProblem extends Error {
  constructor(message: string, readonly offline = false) { super(message); }
}

/**
 * GETs `url` over HTTPS (or http on this computer, for a test server), following a redirect only to the same host,
 * reading at most `limit` bytes. Anything else is a FetchProblem.
 */
export async function safeGet(fetcher: Fetch, url: string, limit: number, timeoutMs: number): Promise<Buffer> {
  let current = new URL(url);
  const host = current.host;
  const local = current.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(current.hostname);
  if (current.protocol !== "https:" && !local) throw new FetchProblem(`Refused ${current.protocol} (HTTPS only).`);
  for (let hop = 0; hop < 4; hop++) {
    let response: Response;
    try {
      response = await fetcher(current.href, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "Botling" } });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new FetchProblem(`${current.host} did not answer in ${Math.round(timeoutMs / 1000)} s.`, true);
      throw new FetchProblem(`Can't reach ${current.host}: ${(error as Error)?.message ?? error}`, true);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = location ? new URL(location, current) : null;
      if (!next || next.host !== host || next.protocol !== current.protocol) throw new FetchProblem(`Refused a redirect to another host (${next?.host ?? "nowhere"}).`);
      current = next;
      continue;
    }
    if (response.status !== 200) throw new FetchProblem(`${current.host} answered ${response.status}.`);
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > limit) throw new FetchProblem(`The download is too large (${declared} bytes; at most ${limit}).`);
    const chunks: Buffer[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) { await reader.cancel().catch(() => {}); throw new FetchProblem(`The download is too large (over ${limit} bytes).`); }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  }
  throw new FetchProblem("Too many redirects.");
}

/** The catalog: its index (fetched, cached, offline) for one source. */
export class Catalog {
  private state: CatalogState;
  private loading: Promise<CatalogState> | null = null;

  constructor(readonly source: CatalogSource, private readonly cacheFile: string, private readonly fetcher: Fetch = (url, init) => fetch(url, init), private readonly now: () => number = Date.now) {
    const cached = readCache(cacheFile, source.indexURL);
    this.state = { url: source.indexURL, official: source.official, entries: cached?.entries ?? [], fetchedAt: cached?.fetchedAt ?? null, fromCache: !!cached, error: null, offline: false };
  }

  get current(): CatalogState { return this.state; }
  get busy(): boolean { return !!this.loading; }

  entry(name: string): CatalogEntry | undefined {
    return this.state.entries.find((entry) => entry.name === name);
  }

  /** Fetches index.json again (one fetch at a time); on failure the cached entries stay, with the problem. */
  refresh(): Promise<CatalogState> {
    this.loading ??= (async () => {
      try {
        const body = await safeGet(this.fetcher, this.source.indexURL, LIMITS.indexBytes, 20_000);
        let value: unknown;
        try { value = JSON.parse(body.toString("utf8")); } catch { throw new FetchProblem("index.json is not valid JSON."); }
        const entries = parseIndex(value);
        const fetchedAt = this.now();
        try { writeFileAtomic(this.cacheFile, JSON.stringify({ url: this.source.indexURL, fetchedAt, index: value } satisfies CacheFile)); } catch { /* kept in memory */ }
        this.state = { ...this.state, entries, fetchedAt, fromCache: false, error: null, offline: false };
      } catch (error) {
        const offline = error instanceof FetchProblem && error.offline;
        this.state = { ...this.state, fromCache: this.state.fetchedAt !== null, error: (error as Error).message, offline };
      } finally {
        this.loading = null;
      }
      return this.state;
    })();
    return this.loading;
  }

  /** Fetched within `maxAge` ms (or being fetched): no need to fetch now. */
  fresh(maxAge: number): boolean {
    return this.busy || (this.state.fetchedAt !== null && !this.state.fromCache && this.now() - this.state.fetchedAt < maxAge);
  }

  /** Downloads `entry`'s folder at its commit into a new folder under `staging` and checks its hash (`downloadPlugin`). */
  async download(entry: CatalogEntry, staging: string): Promise<{ work: string; folder: string }> {
    if (!entry.commit) throw new Error(`"${entry.displayName}" has no released commit in the index yet.`);
    const tarball = await safeGet(this.fetcher, this.source.tarball(entry.commit), LIMITS.tarballBytes, 120_000);
    return stagePlugin(tarball, entry, staging);
  }
}

// ---------------------------------------------------------------------------------------------
// The folder hash (tools/build-index.mjs): for every file, sorted by path, "<path>\0<sha256 of the file>\n", hashed again.

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Every file under `dir`, as build-index.mjs lists them (anything that is not a folder counts as a file). */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** build-index.mjs's `sha256` of a plugin folder. */
export function folderHash(dir: string): string {
  const files = listFiles(dir).map((file) => relative(dir, file).split(sep).join("/")).sort();
  return sha(files.map((file) => `${file}\0${sha(readFileSync(join(dir, file)))}\n`).join(""));
}

// ---------------------------------------------------------------------------------------------
// Tarballs (ustar with pax headers, as git archive writes them)

export interface TarEntry { path: string; type: "file" | "dir" | "link" | "other"; data: Buffer; mode: number }

const field = (block: Buffer, start: number, length: number) => {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString("utf8");
};
const octal = (block: Buffer, start: number, length: number) => {
  const text = field(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("The archive is damaged (a size is not a number).");
  return text ? parseInt(text, 8) : 0;
};

/** The pax records of an extended header ("<len> key=value\n" each). */
function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(data.subarray(at, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > data.length) throw new Error("The archive is damaged (a pax header).");
    const record = data.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}

/** Reads every entry of an uncompressed tar archive. */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  while (at + 512 <= archive.length) {
    const block = archive.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const size = octal(block, 124, 12);
    const flag = String.fromCharCode(block[156] ?? 0);
    const start = at + 512;
    if (start + size > archive.length) throw new Error("The archive is cut short.");
    const data = archive.subarray(start, start + size);
    at = start + Math.ceil(size / 512) * 512;
    if (flag === "x") { pax = paxRecords(data); continue; }
    if (flag === "g") continue;
    if (flag === "L") { longName = field(data, 0, data.length); continue; }
    const prefix = field(block, 257, 6).startsWith("ustar") ? field(block, 345, 155) : "";
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    pax = {};
    longName = null;
    const type = flag === "0" || flag === "\0" || flag === "7" ? "file" : flag === "5" ? "dir" : flag === "1" || flag === "2" ? "link" : "other";
    entries.push({ path: name, type, data: type === "file" ? data : Buffer.alloc(0), mode: octal(block, 100, 8) });
  }
  return entries;
}

/** A path inside the plugin folder Botling writes: relative, no "..", no ".", no empty or odd parts. */
export function safeRelative(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Takes `entry.path` out of a gzipped tarball of the repo into a new folder under `staging` and checks it: only files and
 * folders, every path inside the folder, under the size limits, and its hash the entry's. The folder is removed on any problem.
 */
export function stagePlugin(gzipped: Buffer, entry: CatalogEntry, staging: string, work = join(staging, `${entry.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)): { work: string; folder: string } {
  let archive: Buffer;
  try { archive = gunzipSync(gzipped, { maxOutputLength: LIMITS.unpackedBytes }); } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? "The download unpacks to too much." : "The download is not a gzipped tar archive.");
  }
  const entries = readTar(archive);
  // git archive puts everything under one top folder (<repo>-<commit>/).
  const top = entries.find((candidate) => candidate.path.includes("/"))?.path.split("/")[0] ?? "";
  const prefix = `${top}/${entry.path}/`;
  const mine = entries.filter((candidate) => candidate.path === prefix.slice(0, -1) || candidate.path.startsWith(prefix));
  if (!top || !mine.some((candidate) => candidate.type === "file")) throw new Error(`The download has no folder "${entry.path}".`);
  const folder = join(work, entry.name);
  mkdirSync(folder, { recursive: true });
  try {
    let bytes = 0, files = 0;
    const root = resolve(folder);
    for (const item of mine) {
      const inner = item.path.slice(prefix.length).replace(/\/$/, "");
      if (!inner) continue;
      if (!safeRelative(inner)) throw new Error(`The download has a path that leaves the plugin folder: ${item.path.slice(0, 200)}`);
      const target = resolve(root, inner);
      if (!target.startsWith(root + sep)) throw new Error(`The download has a path that leaves the plugin folder: ${item.path.slice(0, 200)}`);
      if (item.type === "link") throw new Error(`The download has a link (${inner.slice(0, 200)}); plugins from the catalog may not have links.`);
      if (item.type === "other") throw new Error(`The download has something that is not a file or a folder (${inner.slice(0, 200)}).`);
      if (item.type === "dir") { mkdirSync(target, { recursive: true }); continue; }
      bytes += item.data.length;
      files += 1;
      if (bytes > LIMITS.pluginBytes) throw new Error(`The plugin is too large (over ${LIMITS.pluginBytes / 1_000_000} MB).`);
      if (files > LIMITS.pluginFiles) throw new Error(`The plugin has too many files (over ${LIMITS.pluginFiles}).`);
      mkdirSync(resolve(target, ".."), { recursive: true });
      // Only the executable bit is kept (a script an MCP server runs), never setuid or group/other write.
      writeFileSync(target, item.data, { flag: "wx", mode: item.mode & 0o111 ? 0o755 : 0o644 });
    }
    const hash = folderHash(folder);
    if (hash !== entry.sha256) throw new HashMismatch(entry, hash);
    return { work, folder };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/** The downloaded folder is not the one the index recorded. */
export class HashMismatch extends Error {
  constructor(entry: CatalogEntry, readonly actual: string) {
    super(`The downloaded "${entry.displayName}" does not match the index (its files hash to ${actual.slice(0, 12)}…, the index says ${entry.sha256.slice(0, 12)}…). It was not installed.`);
  }
}
