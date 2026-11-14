// The storage cases the browsers run on IndexedDB (test/fe-storage-cases.ts, M1's fe-link storage tests made portable),
// here against the in-memory and the SQLite storage, so the cases are known to pass on the storages M1 already trusts.
// Also the static checks of M2 step 7 (D45): no `localStorage` in fe-link or web-v3, IndexedDB names start with
// `botling3-`.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_IDB_NAME, IDB_PREFIX, IdbFeStorage, MemoryFeStorage } from "../../src/fe-link";
import { SqliteFeStorage } from "../../src/fe-link/sqlite-storage";
import { runStorageCases, STORAGE_CASES } from "../fe-storage-cases";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("portable storage cases", () => {
  it("pass on the in-memory storage", async () => {
    let storage = new MemoryFeStorage();
    const results = await runStorageCases({ open: async () => storage, wipe: async () => { storage = new MemoryFeStorage(); }, noValidation: true });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(STORAGE_CASES.length);
  });

  it("pass on the SQLite storage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fe-cases-"));
    dirs.push(dir);
    const file = join(dir, "fe.db");
    const results = await runStorageCases({
      open: async () => new SqliteFeStorage(file),
      wipe: async () => { for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true }); },
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});

describe("IndexedDB storage rules (D45)", () => {
  const desktop = join(__dirname, "../..");
  const files = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mts|js|mjs|html)$/.test(name) ? [path] : [];
  });

  it("no localStorage in fe-link or web-v3", () => {
    const checked = [...files(join(desktop, "src/fe-link")), ...files(join(desktop, "web-v3"))];
    expect(checked.length).toBeGreaterThan(0);
    for (const file of checked) expect(readFileSync(file, "utf8"), file).not.toMatch(/localStorage/);
  });

  it("every IndexedDB name starts with botling3-", async () => {
    expect(DEFAULT_IDB_NAME.startsWith(IDB_PREFIX)).toBe(true);
    expect(IDB_PREFIX).toBe("botling3-");
    // Names are refused before the factory is touched.
    await expect(IdbFeStorage.open({ name: "botling-fe", factory: {} as IDBFactory })).rejects.toThrow(/botling3-/);
    await expect(IdbFeStorage.wipe("outbox", {} as IDBFactory)).rejects.toThrow(/botling3-/);
    for (const file of [...files(join(desktop, "src/fe-link")), ...files(join(desktop, "web-v3"))]) {
      for (const m of readFileSync(file, "utf8").matchAll(/indexedDB\.(?:open|deleteDatabase)\(\s*["'`]([^"'`]+)/g)) {
        expect(m[1].startsWith(IDB_PREFIX), `${file}: ${m[1]}`).toBe(true);
      }
    }
  });
});
