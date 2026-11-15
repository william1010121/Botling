// 2.x -> 3.x attachments (M6-05, Q-M6-C2 / D74).
//
// A 2.x line names its files by `file:` URL (`attachments: {url, kind}[]`). A file INSIDE the 2.x folder is copied into
// `<dataDir>/imported/<sourceHash>/<newBotId>/<n>-<file name>` and the line points at the copy, so Botling 3 never reads
// the 2.x folder after the import and rollback never depends on 3.x. A file OUTSIDE stays where it is (any 3.x file
// attachment is referenced in place). Total copied is limited (default 2 GiB); the rest are listed, not copied.
//
// The 2.x folder is strictly read only here (the rule of M6-01d's review): sources are opened for reading only
// (`O_RDONLY | O_NOFOLLOW`, and only the device/inode that was planned), every decision uses REAL paths with the on-disk
// case (symlinks resolved, `realpathSync.native`) and the target is checked against the source by real path before a
// byte is written; `plugin-secrets.json` is never copied.
import {
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import type { ChatRecord } from "../../core/store/records";
import { pathOfFileRef } from "../content/files";
import type { IdMapRow } from "./id-map";
import { readChat, type Read2xBot } from "./reader-2x";

export const MEDIA_IMPORT_LIMIT = 2 * 2 ** 30;

/** `inside`: copied. `outside`: referenced in place. `missing`: not a file any more. `over`: past the limit.
 * `secret`: a Botling 2 secrets file, never copied. */
export type MediaState = "inside" | "outside" | "missing" | "over" | "secret";

export interface MediaEntry {
  botNewId: string;
  /** The URL exactly as the 2.x line has it. */
  url: string;
  /** The path the URL names. */
  path: string;
  /** Its real path (symlinks resolved); null when it cannot be resolved to a regular file. */
  real: string | null;
  size: number;
  /** Device and inode of the planned file: the copy reads exactly this file or nothing (no swap after planning). */
  dev?: number;
  ino?: number;
  state: MediaState;
}

export interface MediaPlan {
  /** The 2.x folder's real path. */
  sourceReal: string;
  limit: number;
  entries: MediaEntry[];
  over: { count: number; bytes: number };
}

export interface MediaCopyResult {
  /** Old URL -> new `file:` URL, for the files copied. */
  map: Map<string, string>;
  /** Files that were `inside` in the plan but could not be copied (gone since, no space, ...). */
  failed: Array<{ path: string; reason: string }>;
  count: number;
  bytes: number;
}

/**
 * Real path with the on-disk case (`realpathSync.native`): the JS `realpathSync` keeps the case it was given, so on a
 * case-insensitive volume `/x/V2` and `/x/v2` would compare as different folders although they are one.
 */
function realPath(path: string): string {
  return realpathSync.native(path);
}

/** The nearest existing ancestor's real path plus the missing tail (the target may not exist yet). */
function realPathOrNearest(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realPath(current), ...tail);
  } catch {
    return join(current, ...tail);
  }
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const root = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(root);
}

function isSecretsFile(real: string, sourceReal: string): boolean {
  return real.toLowerCase() === join(sourceReal, "plugin-secrets.json").toLowerCase();
}

/** Every attachment of every imported line, classified by real path. Reads only (stat, realpath, chat.json). */
export function planMedia(
  bots: readonly Read2xBot[],
  idMap: readonly IdMapRow[],
  sourceRoot: string,
  limit: number = MEDIA_IMPORT_LIMIT,
): MediaPlan {
  const sourceReal = realPath(sourceRoot);
  const newIdOf = new Map(idMap.map((row) => [row.oldId, row.newId]));
  const entries: MediaEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let full = false;
  const over = { count: 0, bytes: 0 };

  for (const bot of bots) {
    const botNewId = newIdOf.get(bot.id);
    if (!botNewId) continue;
    for (const record of readChat(bot).chat) {
      for (const file of record.attachments ?? []) {
        if (typeof file?.url !== "string" || seen.has(file.url)) continue;
        const path = pathOfFileRef(file.url);
        if (!path || !/^file:/i.test(file.url)) continue; // only `file:` URLs name local files
        seen.add(file.url);
        let real: string | null = null;
        let size = 0;
        let dev: number | undefined;
        let ino: number | undefined;
        try {
          real = realPath(path);
          const stat = statSync(real);
          if (!stat.isFile()) real = null;
          else {
            size = stat.size;
            dev = stat.dev;
            ino = stat.ino;
          }
        } catch {
          real = null;
        }
        let state: MediaState;
        if (real === null) state = "missing";
        else if (!isInside(real, sourceReal)) state = "outside";
        else if (isSecretsFile(real, sourceReal)) state = "secret";
        else if (full || total + size > limit) {
          // Chat order: once one file does not fit, every later inside file is over too.
          full = true;
          state = "over";
          over.count += 1;
          over.bytes += size;
        } else {
          total += size;
          state = "inside";
        }
        entries.push({ botNewId, url: file.url, path, real, size, ...(dev !== undefined ? { dev, ino } : {}), state });
      }
    }
  }
  return { sourceReal, limit, entries, over };
}

function safeSegment(text: string, fallback: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 && cleaned.length <= 200 ? cleaned : fallback;
}

function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_");
  const bytes = Buffer.from(cleaned);
  return bytes.length <= 160 ? cleaned : bytes.subarray(0, 160).toString("utf8").replace(/�/g, "");
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Copies the planned file to `temp`, reading only the planned file: opened read-only and without following a final
 * link, then checked to be the same device/inode and size as when it was planned; at most `size` bytes are read.
 */
function copyPlanned(entry: MediaEntry, temp: string): void {
  const src = openSync(entry.real!, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(src);
    if (!stat.isFile() || stat.size !== entry.size || (entry.dev !== undefined && (stat.dev !== entry.dev || stat.ino !== entry.ino))) {
      throw new Error("the file changed since the import was planned");
    }
    const out = openSync(temp, "wx", 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let done = 0;
      while (done < entry.size) {
        const read = readSync(src, buffer, 0, Math.min(buffer.length, entry.size - done), done);
        if (read === 0) throw new Error("the file changed while it was copied");
        let written = 0;
        while (written < read) written += writeSync(out, buffer, written, read - written);
        done += read;
      }
      if (fstatSync(src).size !== entry.size) throw new Error("the file changed while it was copied");
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(src);
  }
}

/**
 * Copies each `inside` file to `<dataDir>/imported/<sourceHash>/<newBotId>/<n>-<file name>` (the source opened read
 * only, copied to a temporary name, then renamed). Refuses a data folder that is, holds or lies inside the 2.x folder
 * by real path before anything is written. Returns old URL -> new `file:` URL.
 */
export function copyMedia(plan: MediaPlan, dataDir: string, sourceHash: string): MediaCopyResult {
  const result: MediaCopyResult = { map: new Map(), failed: [], count: 0, bytes: 0 };
  const targetReal = realPathOrNearest(dataDir);
  if (isInside(targetReal, plan.sourceReal) || isInside(plan.sourceReal, targetReal)) {
    throw new Error("The import's source and target must be separate folders.");
  }
  const todo = plan.entries.filter((entry) => entry.state === "inside" && entry.real !== null);
  if (todo.length === 0) return result;

  const hashDir = join(resolve(dataDir), "imported", safeSegment(sourceHash, "source"));
  // No link on the way, before and after the folder is made: `<dataDir>/imported/<hash>` must really be there (an old
  // link could lead into the source or anywhere else).
  const expected = join(realPathOrNearest(dataDir), "imported", safeSegment(sourceHash, "source"));
  const linked = (real: string) => real !== expected || isInside(real, plan.sourceReal);
  if (linked(realPathOrNearest(hashDir))) throw new Error("The import's source and target must be separate folders.");
  mkdirSync(hashDir, { recursive: true, mode: 0o700 });
  if (linked(realPath(hashDir))) throw new Error("The import's source and target must be separate folders.");
  const counters = new Map<string, number>();
  for (const entry of todo) {
    const botDir = join(hashDir, safeSegment(entry.botNewId, "bot"));
    const n = (counters.get(botDir) ?? 0) + 1;
    counters.set(botDir, n);
    const dest = join(botDir, `${n}-${safeFileName(basename(entry.real!))}`);
    const temp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mkdirSync(botDir, { recursive: true, mode: 0o700 });
      if (realPath(botDir) !== join(realPath(hashDir), safeSegment(entry.botNewId, "bot"))) throw new Error("the bot's folder is a link");
      // A second run (after a crash) keeps the copy the first run made: a line already imported may point at it, and a
      // `pin: path` on it must keep its inode.
      const existing = lstatOrNull(dest);
      if (existing?.isFile() && existing.size === entry.size) {
        result.map.set(entry.url, pathToFileURL(dest).toString());
        result.count += 1;
        result.bytes += entry.size;
        continue;
      }
      copyPlanned(entry, temp);
      renameSync(temp, dest);
      result.map.set(entry.url, pathToFileURL(dest).toString());
      result.count += 1;
      result.bytes += entry.size;
    } catch (error) {
      rmSync(temp, { force: true });
      result.failed.push({ path: entry.path, reason: String((error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message ?? error) });
    }
  }
  return result;
}

/** A copy of `record` whose attachment URLs use `map`; every other field is unchanged. */
export function remapAttachments(record: ChatRecord, map: ReadonlyMap<string, string>): ChatRecord {
  if (!record.attachments?.length) return record;
  return { ...record, attachments: record.attachments.map((file) => ({ ...file, url: map.get(file.url) ?? file.url })) };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[unit]}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function withHome(path: string, home: string): string {
  const shown = home && (path === home || path.startsWith(home + sep)) ? `~${path.slice(home.length)}` : path;
  // A file name may hold a line break or a terminal escape: the report and the CLI's output show it escaped.
  // eslint-disable-next-line no-control-regex
  return shown.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** The report's media lines (M6-05): nothing when the import had no attachments to speak of. */
export function mediaReport(plan: MediaPlan, copied: MediaCopyResult, options: { home?: string } = {}): string[] {
  const home = options.home ?? homedir();
  const lines: string[] = [];
  if (copied.count > 0) {
    lines.push(`Copied ${plural(copied.count, "attachment", "attachments")} (${formatBytes(copied.bytes)}) into Botling 3's folder.`);
  }
  if (plan.over.count > 0) {
    lines.push(
      `Not copied (over the ${formatBytes(plan.limit)} import limit): ${plural(plan.over.count, "file", "files")} (${formatBytes(plan.over.bytes)}); they open from the Botling 2 folder while it is there.`,
    );
  }
  const secrets = plan.entries.filter((entry) => entry.state === "secret").length;
  if (secrets > 0) lines.push(`Not copied (private to Botling 2): ${plural(secrets, "file", "files")}.`);
  const missing = [...plan.entries.filter((entry) => entry.state === "missing").map((entry) => entry.path)];
  if (missing.length > 0) {
    lines.push(`Missing in Botling 2 already: ${plural(missing.length, "file", "files")} (listed below).`);
    for (const path of missing) lines.push(`  ${withHome(path, home)}`);
  }
  if (copied.failed.length > 0) {
    lines.push(`Could not be copied: ${plural(copied.failed.length, "file", "files")} (listed below).`);
    for (const failure of copied.failed) lines.push(`  ${withHome(failure.path, home)}`);
  }
  return lines;
}
