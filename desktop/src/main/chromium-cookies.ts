// Reading a Chromium browser's cookies on macOS (Arc, for "Import logins from Arc" in the browser pane's ⋯ menu,
// arc-import.ts): the profiles under its User Data folder, its Cookies database (read from a copy, the browser may
// hold the file), and each value decrypted and turned into what Electron's session.cookies.set takes.
//
// macOS Chromium encrypts a value with AES-128-CBC, IV of 16 spaces, under a key made with PBKDF2-SHA1 (salt
// "saltysalt", 1003 rounds, 16 bytes) from the "<Browser> Safe Storage" Keychain password; the value starts "v10".
// From database version 24 the plain text starts with SHA-256 of the cookie's host_key (32 bytes), which is checked
// and cut. Nothing here logs or writes a decrypted value: values only go back to the caller, in memory.
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 1601-01-01 to 1970-01-01, in seconds: Chromium's times count microseconds from 1601. */
const WINDOWS_EPOCH_OFFSET = 11_644_473_600;
const IV = Buffer.alloc(16, 0x20);

export function safeStorageKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/**
 * A cookie's value from its encrypted_value: the text, or null when it cannot be read (no v10 prefix, a wrong key,
 * or a host hash that does not match).
 */
export function decryptCookieValue(encrypted: Uint8Array, key: Buffer, hostKey: string, metaVersion: number): string | null {
  const bytes = Buffer.from(encrypted);
  if (bytes.length < 3 + 16 || bytes.subarray(0, 3).toString("latin1") !== "v10") return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, IV);
    plain = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
  } catch { return null; }
  if (metaVersion >= 24) {
    if (plain.length < 32) return null;
    const hash = createHash("sha256").update(hostKey, "utf8").digest();
    if (!plain.subarray(0, 32).equals(hash)) return null;
    plain = plain.subarray(32);
  }
  return plain.toString("utf8");
}

/** One row of the cookies table, as much of it as the import reads (older databases spell secure/httponly so). */
export interface CookieRow {
  host_key: string;
  name: string;
  value?: string | null;
  encrypted_value?: Uint8Array | null;
  path?: string | null;
  expires_utc?: number | bigint | null;
  is_secure?: number | bigint | null;
  secure?: number | bigint | null;
  is_httponly?: number | bigint | null;
  httponly?: number | bigint | null;
  has_expires?: number | bigint | null;
  is_persistent?: number | bigint | null;
  samesite?: number | bigint | null;
}

/** What Electron's `session.cookies.set` takes. */
export interface CookieDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

const num = (value: number | bigint | null | undefined): number => (value === null || value === undefined ? 0 : Number(value));
const SAME_SITE: Record<number, CookieDetails["sameSite"]> = { [-1]: "unspecified", 0: "no_restriction", 1: "lax", 2: "strict" };

/** A Chromium time (µs since 1601) in Unix seconds; 0 stays 0 (no time). */
export function chromiumTimeToUnix(value: number | bigint | null | undefined): number {
  const micro = num(value);
  return micro > 0 ? micro / 1_000_000 - WINDOWS_EPOCH_OFFSET : 0;
}

export type ConvertResult = { ok: true; cookie: CookieDetails } | { ok: false; reason: "expired" | "undecryptable" | "invalid" };

/** A row as a cookie to set: decrypted, its URL made from host, path and secure; expired ones are left out. */
export function convertCookieRow(row: CookieRow, key: Buffer, metaVersion: number, nowSeconds: number): ConvertResult {
  const host = String(row.host_key ?? "");
  const name = String(row.name ?? "");
  const bare = host.replace(/^\./, "");
  if (!bare || /[\s/]/.test(bare)) return { ok: false, reason: "invalid" };
  const expires = chromiumTimeToUnix(row.expires_utc);
  const persistent = num(row.has_expires ?? row.is_persistent ?? (expires > 0 ? 1 : 0)) !== 0 && expires > 0;
  if (persistent && expires <= nowSeconds) return { ok: false, reason: "expired" };
  let value: string | null;
  if (row.encrypted_value && row.encrypted_value.length > 0) value = decryptCookieValue(row.encrypted_value, key, host, metaVersion);
  else value = typeof row.value === "string" ? row.value : null;
  if (value === null) return { ok: false, reason: "undecryptable" };
  const secure = num(row.is_secure ?? row.secure) !== 0;
  const path = row.path && row.path.startsWith("/") ? row.path : "/";
  let sameSite = SAME_SITE[num(row.samesite ?? -1)] ?? "unspecified";
  // SameSite=None needs Secure; Chromium would refuse it otherwise.
  if (sameSite === "no_restriction" && !secure) sameSite = "unspecified";
  const cookie: CookieDetails = {
    url: `${secure ? "https" : "http"}://${bare}${path}`,
    name, value, path, secure,
    httpOnly: num(row.is_httponly ?? row.httponly) !== 0,
    sameSite,
    // A leading dot is a domain cookie; without one it is the host's only (and __Host- cookies must have no domain).
    ...(host.startsWith(".") ? { domain: host } : {}),
    ...(persistent ? { expirationDate: expires } : {}),
  };
  return { ok: true, cookie };
}

/** A profile of the browser: its folder name (Default, Profile 1, …), the name you gave it, and its Cookies file. */
export interface ChromiumProfile { dir: string; name: string; cookies: string }

/** The profiles under a Chromium User Data folder that have a Cookies database (Network/Cookies in newer builds). */
export async function findProfiles(userData: string): Promise<ChromiumProfile[]> {
  let names: Record<string, string> = {};
  try {
    const state = JSON.parse(await readFile(join(userData, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: unknown }> } };
    names = Object.fromEntries(Object.entries(state.profile?.info_cache ?? {}).map(([dir, info]) => [dir, typeof info?.name === "string" ? info.name : dir]));
  } catch { /* no Local State: folder names */ }
  let dirs: string[];
  try { dirs = await readdir(userData); } catch { return []; }
  const out: ChromiumProfile[] = [];
  for (const dir of dirs.filter((each) => each === "Default" || /^Profile \d+$/.test(each)).sort(profileOrder)) {
    for (const file of [join(userData, dir, "Network", "Cookies"), join(userData, dir, "Cookies")]) {
      try { if ((await stat(file)).isFile()) { out.push({ dir, name: names[dir] || dir, cookies: file }); break; } } catch { /* next */ }
    }
  }
  return out;
}
const profileOrder = (a: string, b: string) => (a === "Default" ? -1 : b === "Default" ? 1 : Number(a.slice(8)) - Number(b.slice(8)));

/**
 * The rows of a Cookies database and its version, read from a copy in a private temporary folder (the browser may be
 * holding the file); the copy holds only the encrypted values and is removed before this returns.
 */
export async function readCookieRows(cookiesFile: string): Promise<{ version: number; rows: CookieRow[] }> {
  const folder = await mkdtemp(join(tmpdir(), "botling-cookies-"));
  try {
    const copy = join(folder, "Cookies");
    await copyFile(cookiesFile, copy);
    for (const side of ["-wal", "-journal"]) await copyFile(cookiesFile + side, copy + side).catch(() => {});
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string | number } | undefined;
      // Chromium's times (µs since 1601) are past 2^53: read integers as BigInt.
      const all = db.prepare("SELECT * FROM cookies");
      all.setReadBigInts(true);
      const rows = all.all() as unknown as CookieRow[];
      return { version: Number(meta?.value ?? 0) || 0, rows };
    } finally { db.close(); }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
