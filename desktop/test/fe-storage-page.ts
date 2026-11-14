// The test page of M2 step 7 (test/acceptance/web-v3/idb-storage.test.ts), bundled for headless Chromium and WebKit:
// M1's storage cases on the IndexedDB storage, and the crash loop that writes outbox items until the browser is killed.
// Every readwrite transaction's `complete` is counted (a listener added when the transaction is made, so it runs before
// the storage's own handler), which lets the page check that a write never resolves before its `complete`.
import { IdbFeStorage, type OutboxItem, type StoredState } from "../src/fe-link";
import { runStorageCases, type CaseResult } from "./fe-storage-cases";

let completed = 0;
const transaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
  const tx = transaction.apply(this, args);
  if (tx.mode === "readwrite") tx.addEventListener("complete", () => { completed += 1; });
  return tx;
} as IDBDatabase["transaction"];

const CASES_DB = "botling3-fe-cases";

async function storageCases(): Promise<CaseResult[]> {
  return runStorageCases({
    open: () => IdbFeStorage.open({ name: CASES_DB }),
    wipe: () => IdbFeStorage.wipe(CASES_DB),
    completedWrites: () => completed,
  });
}

/** The item the crash loop writes as number n (the test checks what it finds on reopen against this). */
export function crashItem(n: number, epoch: string): OutboxItem {
  return {
    slot: { origin: "phone", originEpoch: epoch, target: "bot:b1", n },
    cmd: { type: "chat.send", botId: "b1", text: `message ${n} ${"x".repeat((n * 37) % 1500)}` } as unknown as OutboxItem["cmd"],
    createdAt: n,
    state: "waiting",
  };
}

declare global {
  interface Window {
    __counted(n: number, afterComplete: boolean): Promise<void>;
  }
}

/**
 * Writes item n with the counter n+1 in one write, for n = 1, 2, …, forever. After each write resolves it reports n as
 * counted (not awaited: the next write starts at once, so a kill can land while one is in flight).
 */
async function crashLoop(name: string, epoch: string): Promise<void> {
  const storage = await IdbFeStorage.open({ name });
  await storage.write([{ op: "epoch", epoch }]);
  for (let n = 1; ; n += 1) {
    const before = completed;
    await storage.write([{ op: "put", item: crashItem(n, epoch) }, { op: "counter", target: "bot:b1", next: n + 1 }]);
    void window.__counted(n, completed === before + 1);
  }
}

async function load(name: string): Promise<StoredState> {
  const storage = await IdbFeStorage.open({ name });
  try { return await storage.load(); } finally { await storage.close(); }
}

Object.assign(window, { __storageCases: storageCases, __crashLoop: crashLoop, __load: load, __ready: true });
