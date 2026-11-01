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
