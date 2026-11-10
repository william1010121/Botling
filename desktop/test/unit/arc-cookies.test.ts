// "Import logins from Arc" (2026-11-10): Chromium's macOS cookie encryption (v10, AES-128-CBC under a PBKDF2 key from
// the Safe Storage password, the SHA-256 host prefix from database version 24), each row as Electron's cookie, and
// the import over a made-up User Data folder. Every fixture is made here; no real browser data is read.
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { chromiumTimeToUnix, convertCookieRow, decryptCookieValue, findProfiles, readCookieRows, safeStorageKey, type CookieDetails, type CookieRow } from "../../src/main/chromium-cookies";
import { importArcLogins, resultText } from "../../src/main/arc-import";

const PASSWORD = "fixture-password";
const KEY = safeStorageKey(PASSWORD);
const NOW = 1_800_000_000;
const toChromium = (unix: number) => BigInt(Math.round((unix + 11_644_473_600) * 1_000_000));

function encrypt(value: string, hostKey: string, version: number, key = KEY): Buffer {
  const plain = version >= 24 ? Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(value, "utf8")]) : Buffer.from(value, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

const row = (over: Partial<CookieRow> & { plain?: string; version?: number } = {}): CookieRow => {
  const host = over.host_key ?? ".example.com";
  return {
    host_key: host, name: "sid", value: "", path: "/", expires_utc: toChromium(NOW + 3600), is_secure: 1, is_httponly: 1,
    has_expires: 1, is_persistent: 1, samesite: 1, encrypted_value: encrypt(over.plain ?? "secret-1", host, over.version ?? 24), ...over,
  };
};

describe("Chromium cookie decryption", () => {
  it("makes the key as Chromium does (PBKDF2-SHA1, saltysalt, 1003, 16 bytes)", () => {
    expect(KEY.length).toBe(16);
    expect(safeStorageKey(PASSWORD).equals(KEY)).toBe(true);
    expect(safeStorageKey("other").equals(KEY)).toBe(false);
  });
  it("reads a v10 value and cuts the host hash from version 24", () => {
    expect(decryptCookieValue(encrypt("hello", ".a.com", 24), KEY, ".a.com", 24)).toBe("hello");
    expect(decryptCookieValue(encrypt("hello", ".a.com", 23), KEY, ".a.com", 23)).toBe("hello");
  });
  it("refuses a wrong key, another host's hash, and a value without v10", () => {
    expect(decryptCookieValue(encrypt("hello", ".a.com", 24, safeStorageKey("nope")), KEY, ".a.com", 24)).toBeNull();
    expect(decryptCookieValue(encrypt("hello", ".a.com", 24), KEY, ".b.com", 24)).toBeNull();
    expect(decryptCookieValue(Buffer.from("plain text value here"), KEY, ".a.com", 24)).toBeNull();
  });
});

describe("a row as Electron's cookie", () => {
  it("keeps the domain, path, flags, SameSite and expiry", () => {
    const got = convertCookieRow(row({ path: "/app", samesite: 2 }), KEY, 24, NOW);
    expect(got).toEqual({ ok: true, cookie: {
      url: "https://example.com/app", name: "sid", value: "secret-1", domain: ".example.com", path: "/app",
      secure: true, httpOnly: true, sameSite: "strict", expirationDate: NOW + 3600,
    } satisfies CookieDetails });
  });
  it("a host-only cookie has no domain; an http one an http URL", () => {
    const got = convertCookieRow(row({ host_key: "login.example.com", is_secure: 0, is_httponly: 0, samesite: -1 }), KEY, 24, NOW);
    expect(got.ok && got.cookie).toMatchObject({ url: "http://login.example.com/", secure: false, httpOnly: false, sameSite: "unspecified" });
    expect(got.ok && "domain" in got.cookie).toBe(false);
  });
  it("skips an expired cookie and keeps a session cookie without an expiry", () => {
    expect(convertCookieRow(row({ expires_utc: toChromium(NOW - 10) }), KEY, 24, NOW)).toEqual({ ok: false, reason: "expired" });
    const session = convertCookieRow(row({ expires_utc: 0, has_expires: 0, is_persistent: 0 }), KEY, 24, NOW);
    expect(session.ok && session.cookie.expirationDate).toBeUndefined();
  });
  it("SameSite=None without Secure becomes unspecified; an old plain value is kept", () => {
    const none = convertCookieRow(row({ samesite: 0, is_secure: 0 }), KEY, 24, NOW);
    expect(none.ok && none.cookie.sameSite).toBe("unspecified");
    const plain = convertCookieRow(row({ encrypted_value: Buffer.alloc(0), value: "plain" }), KEY, 24, NOW);
    expect(plain.ok && plain.cookie.value).toBe("plain");
    expect(convertCookieRow(row(), safeStorageKey("wrong"), 24, NOW)).toEqual({ ok: false, reason: "undecryptable" });
  });
  it("times count microseconds from 1601", () => {
    expect(chromiumTimeToUnix(toChromium(NOW))).toBeCloseTo(NOW, 3);
    expect(chromiumTimeToUnix(0)).toBe(0);
  });
});

describe("importing from a User Data folder", () => {
  const folders: string[] = [];
  afterAll(async () => { for (const folder of folders) await rm(folder, { recursive: true, force: true }); });

  async function cookiesDb(file: string, version: number, rows: CookieRow[]) {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)");
    db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
    db.exec("CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER, source_scheme INTEGER, source_port INTEGER)");
    const insert = db.prepare("INSERT INTO cookies VALUES (0, ?, '', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, 2, 443)");
    for (const r of rows) insert.run(r.host_key, r.name, r.value ?? "", r.encrypted_value ?? Buffer.alloc(0), r.path ?? "/", r.expires_utc ?? 0, r.is_secure ?? 0, r.is_httponly ?? 0, r.has_expires ?? 0, r.is_persistent ?? 0, r.samesite ?? -1);
    db.close();
  }

  async function userData() {
    const root = await mkdtemp(join(tmpdir(), "arc-fixture-"));
    folders.push(root);
    await writeFile(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Work" } } } }));
    await mkdir(join(root, "Default", "Network"), { recursive: true });
    await mkdir(join(root, "Profile 2"), { recursive: true });
    await mkdir(join(root, "System Profile"), { recursive: true });
    await cookiesDb(join(root, "Default", "Network", "Cookies"), 24, [row(), row({ name: "old", expires_utc: toChromium(NOW - 5) }), row({ name: "bad", encrypted_value: encrypt("x", ".other.com", 24) })]);
    await cookiesDb(join(root, "Profile 2", "Cookies"), 21, [row({ host_key: ".work.test", name: "w", plain: "work-1", version: 21 })]);
    return root;
  }

  it("finds the profiles with their names and reads a database from a copy", async () => {
    const root = await userData();
    const profiles = await findProfiles(root);
    expect(profiles.map((p) => [p.dir, p.name])).toEqual([["Default", "Personal"], ["Profile 2", "Work"]]);
    const read = await readCookieRows(profiles[0]!.cookies);
    expect(read.version).toBe(24);
    expect(read.rows.map((r) => r.name)).toEqual(["sid", "old", "bad"]);
  });

  it("imports every picked profile and counts what it skipped", async () => {
    const root = await userData();
    const set: CookieDetails[] = [];
    const result = await importArcLogins({ userData: root, password: async () => PASSWORD, pick: async (all) => all, setCookie: async (c) => { set.push(c); }, now: () => NOW });
    expect(result).toMatchObject({ status: "done", imported: 2, profiles: 2, skipped: 2 });
    expect(set.map((c) => [c.url, c.name, c.value])).toEqual([["https://example.com/", "sid", "secret-1"], ["https://work.test/", "w", "work-1"]]);
    expect(result.text).toBe(resultText(2, 2, 2));
    expect(result.text).toContain("passkeys are not imported");
    expect(result.text).not.toContain("secret-1");
  });

  it("one picked profile; a refused Keychain or a cancelled pick imports nothing", async () => {
    const root = await userData();
    const set: CookieDetails[] = [];
    const one = await importArcLogins({ userData: root, password: async () => PASSWORD, pick: async (all) => [all[1]!], setCookie: async (c) => { set.push(c); }, now: () => NOW });
    expect(one).toMatchObject({ status: "done", imported: 1, profiles: 1, skipped: 0 });
    let asked = false;
    expect((await importArcLogins({ userData: root, password: async () => { asked = true; return PASSWORD; }, pick: async () => null, setCookie: async () => {} })).status).toBe("cancelled");
    expect(asked).toBe(false);
    expect((await importArcLogins({ userData: root, password: async () => null, pick: async (all) => all, setCookie: async () => {} })).status).toBe("failed");
    expect((await importArcLogins({ userData: join(root, "missing"), password: async () => PASSWORD, pick: async (all) => all, setCookie: async () => {} })).status).toBe("failed");
  });
});
