// The ledger and the old journals (shared-core spec 3.2, 3.6): one test per row of the migration table, with records
// shaped as each engine really saves them (claude-workers.json, agy workers.json, codex-threads/<s>.workers.json);
// the interim LegacyStores round-trip them; WorkerLedger imports each journal once and never touches it.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexThreads, type WorkerRecord } from "../../src/core/agent/codex";
import {
  AGY_INTERRUPTED_REPORT, AgyLegacyStore, ClaudeLegacyStore, CodexLegacyStore, fromLegacyAgy, fromLegacyClaude, fromLegacyCodex, importLegacy,
  toLegacyAgy, toLegacyClaude, toLegacyCodex,
} from "../../src/core/worker-core/migrate";
import { readLedgerRecord, trimRecords, WorkerLedger, type WorkerLedgerRecord } from "../../src/core/worker-core/ledger";
import { INTERRUPTED_REPORT } from "../../src/core/worker-core/classify";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const OWNER = { botId: "bot-2", name: "Sub", agentId: "agent-9" };

/** claude-workers.json's record (claude-workers.ts Record_). */
const claude = (over: Record<string, unknown> = {}) => ({
  id: ID, name: "Research", type: null, instructions: "Research only.", sessionId: SESSION, sessionStarted: true, run: 1, status: "completed",
  active: false, reportPending: false, reportDelivered: true, report: "DONE", model: "sonnet", processes: [{ pid: 4242, started: "Mon Nov  1 10:00:00 2026" }],
  interrupted: false, createdAt: 1_700_000_000_000, ...over,
});
/** agy workers.json's record (agy-workers.ts Worker without its live fields). */
const agy = (over: Record<string, unknown> = {}) => ({
  id: ID, engine: "agy", name: "Research", instructions: "Research only.", sessionId: SESSION, run: 1, active: false, cleaning: false, denied: false,
  status: "completed", report: "DONE", reportPending: true, reportDispatching: false, reportDelivered: false, reviewAttempts: 0,
  processes: [{ pid: 5151, started: "Mon Nov  1 10:00:00 2026" }], ...over,
});
/** codex-threads/<s>.workers.json's record. */
const codex = (over: Partial<WorkerRecord> = {}): WorkerRecord => ({ id: ID, name: "Research", instructions: "Research only.", thread: "thread-1", run: 1, wasActive: false, reportPending: false, ...over });

describe("migration: the table of spec 3.6, row by row", () => {
  it("Claude active:true (a crash left it) → interrupted, nothing owed, crash, recovery required", () => {
    expect(fromLegacyClaude(claude({ active: true, status: "running", reportDelivered: false }))).toMatchObject({
      status: "interrupted", report: { state: "none", text: INTERRUPTED_REPORT.crash, status: "interrupted" }, interruptedBy: "crash", recovery: "required",
    });
  });

  it("completed + reportPending && !reportDelivered → done, pending (every engine)", () => {
    expect(fromLegacyClaude(claude({ reportPending: true, reportDelivered: false }))).toMatchObject({ status: "done", report: { state: "pending", text: "DONE", status: "done" } });
    expect(fromLegacyAgy(agy(), "owner")).toMatchObject({ status: "done", report: { state: "pending", text: "DONE", status: "done", attempts: 0 } });
    expect(fromLegacyCodex(codex({ reportPending: true, status: "completed", report: "DONE" }))).toMatchObject({ status: "done", report: { state: "pending", text: "DONE", status: "done" } });
  });

  it("completed + reportDelivered → acknowledged (Claude) / delivered with attempts (agy)", () => {
    expect(fromLegacyClaude(claude())).toMatchObject({ status: "done", report: { state: "acknowledged", attempts: 1 } });
    expect(fromLegacyAgy(agy({ reportDelivered: true, reviewAttempts: 1 }), "owner")).toMatchObject({ status: "done", report: { state: "delivered", attempts: 1 } });
    // Two attempts and still no decision: unresolved.
    expect(fromLegacyAgy(agy({ reportDelivered: true, reviewAttempts: 2 }), "owner")).toMatchObject({ report: { state: "unresolved", attempts: 2 } });
  });

  it("agy reportDispatching → dispatching, status as it was (Codex too)", () => {
    expect(fromLegacyAgy(agy({ reportDispatching: true }), "owner")).toMatchObject({ status: "done", report: { state: "dispatching" } });
    expect(fromLegacyAgy(agy({ status: "failed", reportDispatching: true }), "owner")).toMatchObject({ status: "failed", report: { state: "dispatching" } });
    expect(fromLegacyCodex(codex({ reportPending: true, reportDispatching: true, status: "failed", report: "x" }))).toMatchObject({ status: "failed", report: { state: "dispatching" } });
  });

  it("agy checkpoint → acknowledged with the checkpoint; a move's checkpoint with an owner → routed", () => {
    expect(fromLegacyAgy(agy({ reportPending: false, reportDelivered: true, checkpoint: { outcome: "waiting_dependency", evidence: "tests", dependency_task_id: ID2 } }), "owner"))
      .toMatchObject({ status: "done", report: { state: "acknowledged", checkpoint: { outcome: "waiting_dependency", evidence: "tests", dependencyTaskId: ID2 } } });
    expect(fromLegacyAgy(agy({ reportPending: false, reportDelivered: true, owner: OWNER, checkpoint: { outcome: "moved", evidence: "Delivered to its owner agent-9" } }), "owner"))
      .toMatchObject({ report: { state: "routed" }, owner: OWNER });
  });

  it("failed → failed, report by the flags", () => {
    expect(fromLegacyClaude(claude({ status: "failed", reportPending: true, reportDelivered: false, report: "boom" }))).toMatchObject({ status: "failed", report: { state: "pending", status: "failed", text: "boom" } });
    expect(fromLegacyClaude(claude({ status: "failed" }))).toMatchObject({ status: "failed", report: { state: "acknowledged" } });
    expect(fromLegacyAgy(agy({ status: "failed" }), "owner")).toMatchObject({ status: "failed", report: { state: "pending" } });
    expect(fromLegacyCodex(codex({ reportPending: true, status: "failed", report: "boom" }))).toMatchObject({ status: "failed", report: { state: "pending", status: "failed" } });
  });

  it("stopped, killed → stopped, nothing owed", () => {
    expect(fromLegacyClaude(claude({ status: "stopped", reportPending: false, reportDelivered: false, report: "Stopped by the app; its work was not finished." }))).toMatchObject({ status: "stopped", report: { state: "none", status: "stopped" } });
    expect(fromLegacyAgy(agy({ status: "killed" }), "owner")).toMatchObject({ status: "stopped", report: { state: "none" } });
    expect(fromLegacyAgy(agy({ status: "stopped", reportPending: true }), "owner")).toMatchObject({ status: "stopped", report: { state: "none" } });
  });

  it("interrupted → interrupted, nothing owed, recovery required", () => {
    expect(fromLegacyClaude(claude({ status: "interrupted", interrupted: true, reportDelivered: false, report: INTERRUPTED_REPORT.quit }))).toMatchObject({ status: "interrupted", report: { state: "none", text: INTERRUPTED_REPORT.quit }, recovery: "required" });
    expect(fromLegacyCodex(codex({ reportPending: true, status: "interrupted", report: "x" }))).toMatchObject({ status: "interrupted" });
  });

  it("agy cleanup-failed → failed, report by the flags, cleanup failed, recovery required", () => {
    expect(fromLegacyAgy(agy({ status: "cleanup-failed", report: "Worker process cleanup failed." }), "owner"))
      .toMatchObject({ status: "failed", report: { state: "pending", status: "failed" }, cleanup: "failed", recovery: "required" });
  });

  it("agy recoveryRequired / active / cleaning → interrupted, pending, recovery required", () => {
    for (const flags of [{ active: true, status: "running", reportPending: false }, { cleaning: true, reportPending: false }]) {
      expect(fromLegacyAgy(agy(flags), "owner")).toMatchObject({ status: "interrupted", report: { state: "pending", text: AGY_INTERRUPTED_REPORT, status: "interrupted" }, recovery: "required", interruptedBy: "crash" });
    }
    expect(fromLegacyAgy(agy({ recoveryRequired: true, status: "stopped", report: AGY_INTERRUPTED_REPORT }), "owner")).toMatchObject({ status: "interrupted", report: { state: "pending" }, recovery: "required" });
  });

  it("Codex wasActive:true → interrupted, nothing owed, restartSafe/restartTurn kept in engineData", () => {
    expect(fromLegacyCodex(codex({ wasActive: true, restartSafe: true, restartTurn: "turn-7", isolatedGit: undefined, role: undefined }), "owner-session")).toMatchObject({
      status: "interrupted", report: { state: "none" }, recovery: "required", ownerSessionId: "owner-session", engine: "codex", adapter: "codex-thread",
      engineData: { thread: "thread-1", restartSafe: true, restartTurn: "turn-7" },
    });
  });

  it("new → new, nothing owed", () => {
    expect(fromLegacyClaude(claude({ status: "new", run: 0, reportDelivered: false, report: undefined, sessionStarted: false }))).toMatchObject({ status: "new", run: 0, report: { state: "none", status: null }, conversationId: null });
  });
});

describe("the old records' other fields", () => {
  it("Claude: the session is the conversation once started; session, model in engineData; owner kept", () => {
    expect(fromLegacyClaude(claude({ owner: OWNER }))).toMatchObject({ engine: "claude", adapter: "claude-process", conversationId: SESSION, owner: OWNER, processes: [{ pid: 4242 }], engineData: { sessionId: SESSION, sessionStarted: true, model: "sonnet" } });
    expect(fromLegacyClaude(claude({ sessionStarted: false }))!.conversationId).toBeNull();
    expect(fromLegacyClaude(claude({ id: "not-a-uuid" }))).toBeNull();
    expect(fromLegacyClaude(claude({ sessionId: 7 }))).toBeNull();
  });

  it("agy: a Codex worker over ACP keeps its engine; invalid records are refused", () => {
    expect(fromLegacyAgy(agy({ engine: "codex" }), "o")).toMatchObject({ engine: "codex", adapter: "agy-acp", ownerSessionId: "o" });
    expect(fromLegacyAgy(agy({ run: 0 }), "o")).toBeNull();
    expect(fromLegacyAgy(agy({ cleaning: "no" }), "o")).toBeNull();
  });

  it("Codex: the component editor is a claude engine on its own adapter", () => {
    expect(fromLegacyCodex(codex({ role: "component-editor", editorCheckpoint: "tool-3", editorSessionConfirmed: true }))).toMatchObject({ engine: "claude", adapter: "component-editor", engineData: { role: "component-editor", editorCheckpoint: "tool-3", editorSessionConfirmed: true } });
  });
});

describe("round trips through the old shapes (the interim stores)", () => {
  it("Claude", () => {
    for (const old of [claude(), claude({ reportPending: true, reportDelivered: false }), claude({ status: "failed", owner: OWNER }), claude({ status: "stopped", reportDelivered: false }), claude({ status: "interrupted", interrupted: true, reportDelivered: false })]) {
      const record = fromLegacyClaude(old)!;
      expect(fromLegacyClaude(toLegacyClaude(record))).toEqual({ ...record, createdAt: record.createdAt });
    }
    expect(toLegacyClaude(fromLegacyClaude(claude())!)).toEqual(claude());
  });

  it("agy", () => {
    for (const old of [agy(), agy({ reportDelivered: true, reviewAttempts: 1 }), agy({ reportDelivered: true, reviewAttempts: 2 }), agy({ reportDispatching: true }),
      agy({ status: "cleanup-failed" }), agy({ status: "killed", reportPending: false }), agy({ reportPending: false, reportDelivered: true, checkpoint: { outcome: "complete", evidence: "ok" } }),
      agy({ reportPending: false, reportDelivered: true, owner: OWNER, checkpoint: { outcome: "moved", evidence: "Delivered to its owner agent-9" } }), agy({ active: true, status: "running" })]) {
      const record = fromLegacyAgy(old, "o")!;
      const back = toLegacyAgy(record);
      expect(back).not.toBeNull();
      // agy's file has no place for why a worker was interrupted.
      const { interruptedBy: _why, ...kept } = record;
      expect(fromLegacyAgy(back, "o")).toEqual(kept);
    }
    expect(toLegacyAgy({ ...fromLegacyAgy(agy(), "o")!, status: "new", run: 0 })).toBeNull();
  });

  it("Codex", () => {
    for (const old of [codex(), codex({ reportPending: true, status: "completed", report: "DONE", turn: "turn-1" }), codex({ wasActive: true, restartSafe: true, restartTurn: "t" }),
      codex({ reportPending: true, reportDispatching: true, status: "failed", report: "x", owner: OWNER }), codex({ role: "component-editor", editorCheckpoint: "c" })]) {
      const record = fromLegacyCodex(old, "s");
      expect(fromLegacyCodex(toLegacyCodex(record), "s")).toEqual(record);
    }
  });
});

describe("stores and import", () => {
  const dirs: string[] = [];
  const dir = () => { const d = mkdtempSync(join(tmpdir(), "worker-ledger-")); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("ClaudeLegacyStore reads and writes claude-workers.json (version 1)", () => {
    const file = join(dir(), "claude-workers.json");
    writeFileSync(file, JSON.stringify({ version: 1, workers: [claude(), { junk: true }] }));
    const store = new ClaudeLegacyStore(file);
    const records = store.load();
    expect(records.map((r) => r.id)).toEqual([ID]);
    store.save(records);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, workers: [claude()] });
  });

  it("AgyLegacyStore keeps agy's rules: only when resuming, only its own conversation's file (refused, left in place)", () => {
    const home = dir();
    writeFileSync(join(home, "workers.json"), JSON.stringify({ version: 2, ownerSessionId: "conv-a", workers: [agy()] }));
    expect(new AgyLegacyStore(home, "conv-a").load().map((r) => [r.id, r.ownerSessionId])).toEqual([[ID, "conv-a"]]);
    expect(new AgyLegacyStore(home, "conv-a", { resume: false }).load()).toEqual([]);
    expect(() => new AgyLegacyStore(home, "conv-b").load()).toThrow(/another conversation/);
    expect(new AgyLegacyStore(dir(), "conv-a").load()).toEqual([]);
    const store = new AgyLegacyStore(home, "conv-a");
    store.save(store.load());
    expect(JSON.parse(readFileSync(join(home, "workers.json"), "utf8"))).toEqual({ version: 2, ownerSessionId: "conv-a", workers: [agy()] });
  });

  it("CodexLegacyStore reads and writes codex-threads/<session>.workers.json", () => {
    const threads = new CodexThreads(dir());
    threads.saveWorkers([codex({ id: ID2 }), codex({ reportPending: true, status: "completed", report: "DONE" })], "Owner-Session");
    const store = new CodexLegacyStore(threads, "Owner-Session");
    const records = store.load();
    expect(records.map((r) => [r.id, r.report.state])).toEqual([[ID2, "acknowledged"], [ID, "pending"]]);
    store.save(records);
    expect(threads.workers("Owner-Session").map((r) => r.id)).toEqual([ID, ID2]);
  });

  it("importLegacy reads all three journals and skips ids the ledger has", () => {
    const d = dir();
    const claudeFile = join(d, "claude-workers.json");
    writeFileSync(claudeFile, JSON.stringify({ version: 1, workers: [claude()] }));
    const acpHome = join(d, "acp");
    mkdirSync(acpHome);
    writeFileSync(join(acpHome, "workers.json"), JSON.stringify({ version: 2, ownerSessionId: "conv-a", workers: [agy({ id: ID2 })] }));
    const threads = new CodexThreads(join(d, "codex-threads"));
    threads.saveWorkers([codex({ id: "44444444-4444-4444-8444-444444444444" })], "s");
    const all = importLegacy({ claudeFile, agy: { acpHome, sessionId: "conv-a" }, codex: { threads, session: "s" } }, new Set());
    expect(all.map((r) => r.adapter)).toEqual(["claude-process", "agy-acp", "codex-thread"]);
    expect(importLegacy({ claudeFile, agy: { acpHome, sessionId: "conv-a" } }, new Set([ID])).map((r) => r.id)).toEqual([ID2]);
    expect(importLegacy({ claudeFile: join(d, "missing.json") }, new Set())).toEqual([]);
  });

  it("WorkerLedger imports each journal once, records it, never changes it, and reads its own file after", () => {
    const d = dir();
    const claudeFile = join(d, "claude-workers.json");
    const journal = JSON.stringify({ version: 1, workers: [claude()] });
    writeFileSync(claudeFile, journal);
    const before = statSync(claudeFile).mtimeMs;
    const file = join(d, "worker-ledger.json");
    const ledger = new WorkerLedger(file, { claudeFile });
    expect(ledger.load().map((r) => r.id)).toEqual([ID]);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ version: 3, imported: [{ file: claudeFile, mtimeMs: before }] });
    expect(readFileSync(claudeFile, "utf8")).toBe(journal);
    // The journal changes (a downgraded app wrote it): the ledger does not read it again.
    writeFileSync(claudeFile, JSON.stringify({ version: 1, workers: [claude(), claude({ id: ID2 })] }));
    expect(new WorkerLedger(file, { claudeFile }).load().map((r) => r.id)).toEqual([ID]);
    // A state change saved by the ledger survives a reload.
    const records = new WorkerLedger(file, { claudeFile }).load();
    records[0]!.status = "failed";
    new WorkerLedger(file, { claudeFile }).save(records);
    expect(new WorkerLedger(file, { claudeFile }).load()[0]!.status).toBe("failed");
  });

  it("readLedgerRecord keeps valid records and refuses others", () => {
    const record = fromLegacyClaude(claude())!;
    expect(readLedgerRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(readLedgerRecord({ ...record, v: 2 })).toBeNull();
    expect(readLedgerRecord({ ...record, status: "killed" })).toBeNull();
    expect(readLedgerRecord({ ...record, report: { state: "cleanup-failed" } })).toBeNull();
  });

  it("trimRecords drops the oldest forgettable records only (not running, nothing owed, no cleanup/recovery, not live)", () => {
    const make = (n: number, over: Partial<WorkerLedgerRecord> = {}): WorkerLedgerRecord => ({ ...fromLegacyClaude(claude())!, id: `id-${n}`, ...over });
    const records = [make(0, { status: "running" }), make(1, { report: { state: "pending", text: "x", status: "done", attempts: 0 } }), make(2), make(3, { recovery: "required" }), make(4), make(5)];
    expect(trimRecords(records, 4).map((r) => r.id)).toEqual(["id-0", "id-1", "id-3", "id-5"]);
    expect(trimRecords(records, 5, (id) => id === "id-2").map((r) => r.id)).toEqual(["id-0", "id-1", "id-2", "id-3", "id-5"]);
    expect(trimRecords(records, 10)).toHaveLength(6);
  });
});
