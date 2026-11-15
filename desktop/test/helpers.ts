import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const desktop = resolve(__dirname, "..");
export const fakeCli = join(desktop, "test", "fixtures", "fake-claude.mjs");
export const fakeCodex = join(desktop, "test", "fixtures", "fake-codex.mjs");

/** A fresh temp folder inside desktop/.cache/test-data (never the system temp, never ~). */
export function tempDir(name: string): string {
  const base = join(desktop, ".cache", "test-data");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${name}-`));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asserts two byte sequences are equal. Use it instead of `expect(a).toEqual(b)` for anything past a few KiB:
 * vitest's deep equality walks a Buffer one element at a time (about 5 s per MiB), this compares in one call and
 * names the first differing offset. */
export function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  const a = Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength);
  if (a.equals(b)) return;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  throw new Error(`bytes differ: got ${a.length} bytes, expected ${b.length}; first difference at offset ${at}`);
}

/** Every app-managed worker's record in the members' worker-ledger.json files under `dir` (any bot, any member). */
export function ledgerRecords(dir: string): any[] {
  const found: any[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(folder, entry.name));
      else if (entry.name === "worker-ledger.json") found.push(...JSON.parse(readFileSync(join(folder, entry.name), "utf8")).records);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function pidsIn(file: string): number[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").map(Number).filter((n) => n > 0);
}

export async function until<T>(fn: () => T | Promise<T>, { timeout = 10_000, every = 25, what = "condition" } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

/** A chat line in the Swift app's chat.json format (dates in seconds since 2001). */
export function swiftLine(fields: Record<string, unknown> & { id: string; role: string; text: string }): Record<string, unknown> {
  return { date: (Date.now() - Date.UTC(2001, 0, 1)) / 1000, ...fields };
}
