// M7-09a: a plugin's built web part as content, named by one reference in its `plugin:<name>` row (Q-M7-C3, §13.1, §9A).
//
// The row carries `files: {web: "sha256:<hex>"}` (the `files` field the 3.0 row schema reserved and reads as any value),
// the SHA-256 of the bytes of the file the manifest's `ccb.web` names. The bytes are kept beside the data folder as
// `<dir>/<hex>` (content addressed: the name is the hash), so every front end can fetch the code by its hash over the
// content path (`/v3/c/<owner>/<ref>/original?e=srv:<owner>.<rev>&t=<ticket>&p=<plugin>`, remote.ts). The ticket is bound to
// the plugin (M5-17); the row of that plugin is the authority at every use: a ref another plugin's row holds is refused.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import { PluginRow } from "../../protocol/table-rows";
import { readRowBody } from "../replica/tables";
import type { Db } from "../store";

/** The largest web part published as a bundle: what `plugins.web` carries for one web part (5,000,000 characters). */
export const PLUGIN_BUNDLE_MAX_BYTES = 5_000_000;
const REF_RE = /^sha256:([0-9a-f]{64})$/;
const FILE_RE = /^[0-9a-f]{64}(\.[0-9a-f]+\.tmp)?$/;

/** What a row's `files` holds in 3.1: one content reference to the plugin's built web part. */
export interface WebBundle { ref: string; size: number }

/** The reference `files.web` names, or null when `files` holds none (a 3.0 row, a plugin without a web part, any other value). */
export function pluginWebRef(files: unknown): string | null {
  if (!files || typeof files !== "object" || Array.isArray(files)) return null;
  if (!Object.hasOwn(files, "web")) return null;
  const web = (files as { web?: unknown }).web;
  return typeof web === "string" && REF_RE.test(web) ? web : null;
}

/** The path a reference's bytes are kept at; null for anything that is not `sha256:<64 hex>` (never a path from other text). */
export function bundlePath(dir: string, ref: string): string | null {
  const match = REF_RE.exec(ref);
  return match ? join(dir, match[1]!) : null;
}

/** Keeps `bytes` as `<dir>/<hex>` (staged beside it, renamed into place) and returns the reference. */
export function storeWebBundle(dir: string, bytes: Uint8Array): WebBundle {
  const hex = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, hex);
  const staged = join(dir, `${hex}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let written = 0;
    while (written < bytes.byteLength) written += writeSync(fd, bytes, written, bytes.byteLength - written);
  } catch (error) {
    closeSync(fd);
    rmSync(staged, { force: true });
    throw error;
  }
  closeSync(fd);
  try { renameSync(staged, target); } catch (error) { rmSync(staged, { force: true }); throw error; }
  return { ref: `sha256:${hex}`, size: bytes.byteLength };
}

/**
 * Reads the web part a plugin's manifest names (`web`, relative to its `folder`) and keeps it as a bundle. Null when
 * there is none to publish: no web part, a file that is missing, not a regular file inside the folder, or over the cap.
 */
export function bundleOfPlugin(dir: string, folder: string, web: string | undefined, log?: (line: string) => void): WebBundle | null {
  if (!web) return null;
  try {
    const root = realpathSync.native(folder);
    const file = realpathSync.native(join(folder, web));
    if (!file.startsWith(root + sep)) { log?.(`plugin web bundle skipped: ${web} leaves the plugin folder`); return null; }
    const st = lstatSync(file);
    if (!st.isFile() || st.size > PLUGIN_BUNDLE_MAX_BYTES) { log?.(`plugin web bundle skipped: ${web} is not a regular file of at most ${PLUGIN_BUNDLE_MAX_BYTES} bytes`); return null; }
    const bytes = readFileSync(file);
    if (bytes.byteLength > PLUGIN_BUNDLE_MAX_BYTES) return null;
    return storeWebBundle(dir, bytes);
  } catch (error) {
    log?.(`plugin web bundle skipped: ${String((error as Error)?.message ?? error)}`);
    return null;
  }
}

/** The bytes of a reference, only when they still hash to it (the bytes of the hash or nothing); null otherwise. */
export function readWebBundle(dir: string, ref: string): Buffer | null {
  const path = bundlePath(dir, ref);
  if (!path) return null;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > PLUGIN_BUNDLE_MAX_BYTES) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const open = fstatSync(fd);
      if (!open.isFile() || open.ino !== st.ino || open.dev !== st.dev) return null;
      const bytes = readFileSync(fd);
      return `sha256:${createHash("sha256").update(bytes).digest("hex")}` === ref ? bytes : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Removes bundle files (and leftover staging files) whose reference is not in `keep`; other files in the folder stay. */
export function pruneWebBundles(dir: string, keep: ReadonlySet<string>): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!FILE_RE.test(name) || keep.has(`sha256:${name}`)) continue;
    try { rmSync(join(dir, name), { force: true }); removed += 1; } catch { /* the next sync tries again */ }
  }
  return removed;
}

/**
 * Whether `ref` is the web bundle of `plugin` on this server now: its `plugin:<name>` row in `srv:<self>` names it in
 * `files.web`. A missing, tombstoned or malformed row, another plugin's ref, and any read error is refused (fail closed).
 */
export function isPluginWebRef(db: Db, self: string, plugin: string, ref: string): boolean {
  try {
    const row = PluginRow.safeParse(readRowBody(db, `srv:${self}`, `plugin:${plugin}`));
    return row.success && pluginWebRef(row.data.files) === ref;
  } catch {
    return false;
  }
}
