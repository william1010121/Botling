import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { conversation, generation, pb, usage } from "./agy-db-fixture";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { AgyTurnUsage, agyConversationFile, agyUsage, agyUsageInProfiles, agyWorkerConversation, agyWorkerList, agyWorkerUsage, callTokens, readAgyDatabase } from "../../src/core/agy-usage-db";
import type { AgentRecord } from "../../src/core/agent-registry";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "agy-usage-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("reads each generation's exact tokens, model and time, counting a retried attempt once as its own call", () => {
  const home = temp(), c = conversation(home, "s1");
  c.add(generation({ usage: usage({ input: 1000, output: 300, thinking: 200 }), model: "gemini-3.8-flash", slug: "gemini-3.8-flash-high", seconds: 1_800_000_000 }));
  // Two attempts: the first was retried; the main usage repeats the last attempt (as agy writes it).
  const ok = usage({ input: 900, output: 50, cacheRead: 4000, cacheWrite: 7 });
  c.add(generation({ usage: ok, attempts: [usage({ input: 900, output: 20 }), ok], slug: "gemini-3.8-flash-high", seconds: 1_800_000_060 }));
  // A step repeats a generation's usage with no shared id: not counted again.
  c.step(pb([[9, usage({ input: 1000, output: 300 })]]));
  c.step(null);
  c.db.close();
  const read = readAgyDatabase(agyConversationFile(home, "s1")!, "s1");
  expect(read).toMatchObject({ sessionId: "s1", retries: 1, models: ["gemini-3.8-flash-high"], total: { input: 2800, output: 370, cacheRead: 4000, cacheWrite: 7, reasoning: 200 } });
  expect(read!.calls.map(({ key: _, ...call }) => call)).toEqual([
    { at: 1_800_000_000_000, model: "gemini-3.8-flash-high", input: 1000, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 200, retry: false },
    { at: 1_800_000_060_000, model: "gemini-3.8-flash-high", input: 900, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, retry: true },
    { at: 1_800_000_060_000, model: "gemini-3.8-flash-high", input: 900, output: 50, cacheRead: 4000, cacheWrite: 7, reasoning: 0, retry: false },
  ]);
});

it("uses steps only in a file without generations, and returns null for a missing or unreadable file", () => {
  const home = temp(), dir = join(home, "antigravity-acp", "conversations");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "s2.db"));
  db.exec("CREATE TABLE steps (idx integer, metadata blob, PRIMARY KEY (idx))");
  db.prepare("INSERT INTO steps VALUES (0, ?)").run(pb([[9, usage({ input: 10, output: 5 })], [24, pb([[12, "gemini-4-argon-high"]])]]));
  db.close();
  expect(readAgyDatabase(join(dir, "s2.db"), "s2")).toMatchObject({ total: { input: 10, output: 5 }, models: ["gemini-4-argon-high"] });
  expect(readAgyDatabase(join(dir, "none.db"), "none")).toBeNull();
  const bad = new DatabaseSync(join(dir, "bad.db")); bad.exec("CREATE TABLE other (x)"); bad.close();
  expect(readAgyDatabase(join(dir, "bad.db"), "bad")).toBeNull();
  for (const id of ["../x", "a/b", ".hidden", ""]) expect(agyConversationFile(home, id)).toBeNull();
});

it("gives a turn only the calls written since its mark, reading the new rows", () => {
  const home = temp(), c = conversation(home, "s3");
  c.add(generation({ usage: usage({ input: 1, output: 1 }) }));
  const turns = new AgyTurnUsage(home, () => "s3");
  turns.mark();
  expect(turns.take()).toEqual([]);
  c.add(generation({ usage: usage({ input: 100, output: 40, cacheRead: 5 }) }));
  c.add(generation({ usage: usage({ input: 200, output: 60 }) }));
  expect(callTokens(turns.take())).toEqual({ input: 300, output: 100, cacheRead: 5, cacheWrite: 0 });
  expect(turns.take()).toEqual([]);
  c.db.close();
  // No file yet (a new conversation): its first turn's calls all count.
  const fresh = new AgyTurnUsage(home, () => "s4");
  fresh.mark();
  const d = conversation(home, "s4"); d.add(generation({ usage: usage({ input: 7, output: 3 }) })); d.db.close();
  expect(callTokens(fresh.take())).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });
  expect(callTokens([])).toBeNull();
});

it("reads while agy holds a write transaction, never blocking or changing its file", () => {
  const home = temp(), c = conversation(home, "s5");
  c.add(generation({ usage: usage({ input: 10, output: 2 }) }));
  const file = agyConversationFile(home, "s5")!;
  c.db.exec("BEGIN IMMEDIATE");
  c.add(generation({ usage: usage({ input: 99, output: 9 }) }));
  const before = statSync(file).mtimeMs;
  // Committed rows only, read while the writer is mid-transaction.
  expect(readAgyDatabase(file, "s5")?.total).toMatchObject({ input: 10, output: 2 });
  c.db.exec("COMMIT");
  expect(readAgyDatabase(file, "s5")?.total).toMatchObject({ input: 109, output: 11 });
  expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(before);
  c.db.close();
});

it("finds a session in Botling's agy profiles and reuses a reading until the file changes", () => {
  const data = temp(), home = join(data, "agy-acp", "profile-1"), c = conversation(home, "s6");
  c.add(generation({ usage: usage({ input: 5, output: 5 }) }));
  const first = agyUsageInProfiles(data, "s6");
  expect(first?.total.input).toBe(5);
  expect(agyUsage(home, "s6")).toBe(first);
  c.add(generation({ usage: usage({ input: 6, output: 1 }) }));
  c.db.close();
  expect(agyUsageInProfiles(data, "s6")?.total.input).toBe(11);
  expect(agyUsageInProfiles(data, "missing")).toBeNull();
  expect(agyUsageInProfiles(join(data, "nowhere"), "s6")).toBeNull();
});

it("finds a worker's conversation in its own folder under a head profile", () => {
  const data = temp(), profile = join(data, "agy-acp", "bot-1");
  conversation(profile, "head-s").db.close();
  const c = conversation(join(profile, "workers", "w-1"), "worker-s");
  c.add(generation({ usage: usage({ input: 30, output: 4 }) }));
  c.db.close();
  expect(agyUsageInProfiles(data, "worker-s")).toMatchObject({ sessionId: "worker-s", total: { input: 30, output: 4 } });
  expect(agyUsageInProfiles(data, "head-s")?.sessionId).toBe("head-s");
  expect(agyUsageInProfiles(data, "../worker-s")).toBeNull();
});

it("reads a worker's usage by its worker id, the newest conversation in its folder, with no session id known", () => {
  const data = temp(), worker = join(data, "agy-acp", "bot-1", "workers", "w-2");
  const old = conversation(worker, "first"); old.add(generation({ usage: usage({ input: 1, output: 1 }) })); old.db.close();
  const now = conversation(worker, "second"); now.add(generation({ usage: usage({ input: 70, output: 8 }) })); now.db.close();
  utimesSync(join(worker, "antigravity-acp", "conversations", "first.db"), new Date(1_000_000), new Date(1_000_000));
  expect(agyWorkerConversation(data, "w-2")).toEqual({ home: worker, sessionId: "second" });
  expect(agyWorkerUsage(data, "w-2")).toMatchObject({ sessionId: "second", total: { input: 70, output: 8 } });
  expect(agyWorkerUsage(data, "w-none")).toBeNull();
  expect(agyWorkerUsage(data, "../bot-1")).toBeNull();
});

it("lists an agy head session's workers, taking a null registry session id from the worker's folder", () => {
  const data = temp();
  conversation(join(data, "agy-acp", "bot-1", "workers", "w-old"), "found-s").db.close();
  const record = (nativeId: string, sessionId: string | null, host: string, createdAt: number, engine: "agy" | "codex" = "agy") => ({
    id: `ag-${nativeId}`, nativeId, engine, createdAt, endedAt: null, model: null, state: "completed",
    host: { botId: "bot-1", engine: "agy", kind: "agy-acp", sessionId: host, folder: "/x" },
    handle: { kind: "agy-session", sessionId, acpHome: "", run: 1 },
    summary: { description: `job ${nativeId}` },
  }) as unknown as AgentRecord;
  const list = agyWorkerList([record("w-new", "known-s", "head", 2), record("w-old", null, "head", 1), record("w-x", "x", "other", 0), record("w-c", "c", "head", 3, "codex"), record("w-none", null, "head", 4)], "head", data);
  expect(list.map(({ nativeId, sessionId, name }) => ({ nativeId, sessionId, name }))).toEqual([
    { nativeId: "w-old", sessionId: "found-s", name: "job w-old" },
    { nativeId: "w-new", sessionId: "known-s", name: "job w-new" },
    { nativeId: "w-none", sessionId: null, name: "job w-none" },
  ]);
});
