// "Import logins from Arc" (the browser pane's ⋯ menu): Arc's cookies, its signed-in sessions, copied into the pane's
// session (persist:botling-web). Everything stays on this Mac: the Keychain password (macOS asks you to allow it),
// the key and the decrypted values live only in memory and go only to session.cookies.set; nothing is logged or
// sent. Saved passwords and passkeys are not imported: Electron has no password store and passkeys cannot be
// exported. The reading and decrypting is chromium-cookies.ts.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { convertCookieRow, findProfiles, readCookieRows, safeStorageKey, type ChromiumProfile, type CookieDetails } from "./chromium-cookies";

export const ARC_USER_DATA = join(homedir(), "Library", "Application Support", "Arc", "User Data");
export const NOT_IMPORTED = "Saved passwords and passkeys are not imported (this browser has no password store, and passkeys cannot be exported).";

export interface ArcImportDeps {
  userData?: string;
  /** The "Arc Safe Storage" Keychain password; null when it cannot be had (refused, not found). */
  password(): Promise<string | null>;
  /** The profiles to import, given the ones found (more than one); null cancels. */
  pick(profiles: ChromiumProfile[]): Promise<ChromiumProfile[] | null>;
  setCookie(cookie: CookieDetails): Promise<void>;
  flush?(): Promise<void>;
  now?: () => number;
}

export type ArcImportResult =
  | { status: "done"; imported: number; profiles: number; skipped: number; text: string }
  | { status: "cancelled" | "failed"; text: string };

/** Counts only: never a cookie's name or value. */
export function resultText(imported: number, profiles: number, skipped: number): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return `${n(imported, "cookie", "cookies")} imported from ${n(profiles, "profile", "profiles")}, ${skipped} skipped. ${NOT_IMPORTED}`;
}

export async function importArcLogins(deps: ArcImportDeps): Promise<ArcImportResult> {
  const found = await findProfiles(deps.userData ?? ARC_USER_DATA);
  if (!found.length) return { status: "failed", text: "No Arc profile with cookies was found on this Mac." };
  const chosen = found.length > 1 ? await deps.pick(found) : found;
  if (!chosen || !chosen.length) return { status: "cancelled", text: "Nothing was imported." };
  const password = await deps.password();
  if (!password) return { status: "failed", text: "Arc's key was not given (the Keychain request was refused or not found), so nothing was imported." };
  const key = safeStorageKey(password);
  const now = (deps.now ?? (() => Date.now() / 1000))();
  let imported = 0, skipped = 0, profiles = 0;
  for (const profile of chosen) {
    let read: Awaited<ReturnType<typeof readCookieRows>>;
    try { read = await readCookieRows(profile.cookies); } catch { continue; }
    profiles++;
    for (const row of read.rows) {
      const converted = convertCookieRow(row, key, read.version, now);
      if (!converted.ok) { skipped++; continue; }
      try { await deps.setCookie(converted.cookie); imported++; } catch { skipped++; }
    }
  }
  key.fill(0);
  await deps.flush?.().catch(() => {});
  if (!profiles) return { status: "failed", text: "Arc's cookies could not be read." };
  return { status: "done", imported, profiles, skipped, text: resultText(imported, profiles, skipped) };
}

/** The Keychain password of "Arc Safe Storage" (macOS shows its own Allow prompt). */
export function arcKeychainPassword(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-w", "-s", "Arc Safe Storage"], { timeout: 120_000 }, (error, stdout) => {
      const password = String(stdout ?? "").replace(/\n$/, "");
      resolve(error || !password ? null : password);
    });
  });
}
