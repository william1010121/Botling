// The shared worker contract (shared-core spec §5.3): one suite every engine's worker adapter must pass, on streams
// recorded from the real CLIs (test/fixtures/worker-streams) replayed through the adapter and the shared WorkerCore
// (test/worker-streams/replay.ts). Every assertion reads only shared output — the core's items, its ledger records and
// the reports it hands the coordinator — so it is the same for every engine.
//
// Engines: every test/worker-streams/adapter-*.ts is loaded (adapter-claude.ts: S1, adapter-agy.ts: S2,
// adapter-codex.ts and adapter-editor.ts: S3); an engine without one is listed as a todo. The reference adapter
// (replay.ts `referenceRegistration`, claude stream-json) also runs on the claude and editor recordings, so the
// harness and the contract are exercised on their own; replay.ts's header shows how to write a registration.
// test:changed runs this suite when replay.ts, an adapter-*.ts or an engine's worker code changes (claude-workers.ts,
// agy-workers.ts, agy-acp.ts, codex.ts, component-editor.ts, stream.ts) or anything under src/core/worker-core.
//
// The three historical bugs must turn it red for EVERY engine (spec §5.3 acceptance). WORKER_CONTRACT_BUG puts them
// back at the shared seams, without editing code:
//   WORKER_CONTRACT_BUG=delta        each streamed chunk becomes its own step (TextBlocks)        → C1 red
//   WORKER_CONTRACT_BUG=tool-failed  a failed tool fails a run that ended normally (classifyRun)  → C2 red
//   WORKER_CONTRACT_BUG=request      the adapter's `request` events are dropped                    → C5 red
//   e.g. WORKER_CONTRACT_BUG=delta npx vitest run test/unit/worker-core-contract.test.ts
// An adapter-level regression is checked the same way by hand: put the bug back in the adapter (claude: no
// `request` case; agy: one textWhole per agent_message_chunk; …) and run this file: C1 / C2 / C5 must fail.
import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexItem } from "../../src/core/agent/codex";
import {
  agentState, chipStatus, deniedNote, NO_REPORT, STOPPED_REPORT, stepFailed, subagentStatus, UNRESOLVED_REPORT, workerRequestId,
  type WorkerEvent, type WorkerLedgerRecord,
} from "../../src/core/worker-core";
import {
  loadFixtures, MemoryStore, referenceRegistration, replay, withoutText,
  type Expectation, type Fixture, type ReplayOptions, type ReplayRegistration, type ReplayResult,
} from "../worker-streams/replay";

const bugs = vi.hoisted(() => new Set((process.env.WORKER_CONTRACT_BUG ?? "").split(",").map((bug) => bug.trim()).filter(Boolean)));

vi.mock("../../src/core/worker-core/text", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/worker-core/text")>();
  if (!bugs.has("delta")) return real;
  class ChunkPerStep extends real.TextBlocks {
    add(event: WorkerEvent) { return event.type === "textDelta" ? [{ text: event.text, phase: null }] : super.add(event); }
  }
  return { ...real, TextBlocks: ChunkPerStep };
});

vi.mock("../../src/core/worker-core/classify", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/worker-core/classify")>();
  if (!bugs.has("tool-failed")) return real;
  return { ...real, classifyRun: (facts: Parameters<typeof real.classifyRun>[0]) => {
    const verdict = real.classifyRun(facts);
    return verdict.status === "done" && facts.failedTools > 0 ? { ...verdict, status: "failed" as const } : verdict;
  } };
});

const dropRequests = bugs.has("request") ? (event: WorkerEvent) => (event.type === "request" ? null : event) : undefined;

// ------------------------------------------------------------------------------------------------
// Registrations

const ENGINES = ["claude", "codex", "editor", "agy"] as const;
const OWNER: Record<string, string> = { claude: "S1", agy: "S2", codex: "S3", editor: "S3" };
const folder = join(__dirname, "..", "worker-streams");
const loaded: ReplayRegistration[] = [];
for (const file of existsSync(folder) ? readdirSync(folder).filter((name) => /^adapter-.+\.ts$/.test(name)).sort() : []) {
  const module = await import(join(folder, file)) as { registration?: ReplayRegistration; registrations?: ReplayRegistration[] };
  loaded.push(...(module.registrations ?? (module.registration ? [module.registration] : [])));
}
const registrations = [...loaded, referenceRegistration("claude"), referenceRegistration("editor")];

// ------------------------------------------------------------------------------------------------
// Helpers

const fixturesOf = (engine: string, scenario: string): Fixture[] | null => {
  try { return loadFixtures(engine, scenario); } catch { return null; }
};
/** The worker's own items (its steps, ids and counters). */
const own = (items: CodexItem[], id: string) => items.filter((item: any) => item.parent === id || item.id === id || item.request?.scope === id || item.measurement?.workerId === id || item.workerId === id);
const kinds = (items: CodexItem[], kind: string) => items.filter((item) => item.kind === kind) as any[];
const per = <T>(value: T | T[] | undefined, i: number): T | undefined => (Array.isArray(value) ? value[i] : value);
const record = (r: ReplayResult, id: string) => r.ledger.find((x) => x.id === id)!;
const re = (pattern: string) => new RegExp(pattern, "s");

/** The worker's text steps. */
const texts = (r: ReplayResult, id: string) => kinds(own(r.items, id), "subagentText").map((item) => item.text as string).filter((text) => !text.startsWith("Waiting for a free worker slot"));

/** What the bot shows of it — its row, its chip, its registry entry — is its ledger record's, through the real projection. */
function expectShown(r: ReplayResult, id: string) {
  const rec = record(r, id);
  const { book, chats, registry, host } = r.projection;
  const chip = chats.flatMap((chat) => (chat.backgroundTasks ?? []) as { id: string; status: string }[]).find((task) => task.id === id);
  expect({ row: book.get(id)?.status, chip: chip?.status, registry: registry.byNative(host.botId, host.engine, id)?.state })
    .toEqual({ row: subagentStatus(rec), chip: chipStatus(rec), registry: agentState(rec) });
}

function expectReport(r: ReplayResult, id: string, expect_: Expectation, i = 0) {
  const pattern = per(expect_.reports, i) ?? expect_.report;
  const text = record(r, id).report.text ?? "";
  if (pattern) expect(text).toMatch(re(pattern));
  return text;
}

// ------------------------------------------------------------------------------------------------

for (const engine of ENGINES) {
  if (!loaded.some((registration) => registration.engine === engine))
    it.todo(`${engine}: test/worker-streams/adapter-${engine}.ts is not written yet (${OWNER[engine]})`);
}

describe.each(registrations.map((registration) => [registration.label ?? registration.engine, registration] as const))("%s", (_label, registration) => {
  const { engine } = registration;
  /** A contract case: skipped when the registration says so or the recording is missing. */
  const contract = (id: string, title: string, scenario: string, body: (fixtures: Fixture[]) => Promise<void>, missing: string | null = null) => {
    const fixtures = fixturesOf(engine, scenario);
    const why = registration.skip?.[id] ?? missing ?? (!fixtures ? `no ${engine}/${scenario} recording` : null);
    if (why) it.skip(`${id} ${title} (skipped: ${why})`, () => undefined);
    else it(`${id} ${title}`, () => body(fixtures!));
  };
  const run = async (fixtures: Fixture[], options: ReplayOptions = {}) => {
    const r = await replay(registration, fixtures, { events: dropRequests, ...options });
    expect(r.unplayed, "recorded lines never played: the adapter did not start their process").toBe(0);
    return r;
  };

  contract("C1", "chunked text: one step per text block, never a chunk; the report is the last block", "chunked-text", async (fixtures) => {
    const r = await run(fixtures);
    const [id] = r.workers;
    const e = fixtures[0]!.expect;
    const steps = texts(r, id!);
    expect(steps).toHaveLength(per(e.textBlocks, 0) ?? 1);
    const report = expectReport(r, id!, e);
    if (e.reportChars) expect(report).toHaveLength(e.reportChars);
    expect(steps.at(-1)).toBe(report);
    expect(record(r, id!).status).toBe(e.status ?? "done");
  });

  contract("C2", "failed tool then success: the failed step shows, the run is done", "failed-tool-then-success", async (fixtures) => {
    const r = await run(fixtures);
    const [id] = r.workers;
    const e = fixtures[0]!.expect;
    const results = kinds(own(r.items, id!), "toolResult");
    expect(results.filter((item) => item.failed)).toHaveLength(per(e.failedTools, 0) ?? 1);
    expect(record(r, id!).status).toBe("done");
    expectReport(r, id!, e);
    expect(kinds(r.items, "subagentEnded").filter((item) => item.id === id)).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  contract("C3", "empty report: failed, \"ended without a report\"", "empty-report", async (fixtures) => {
    const real = fixtures[0]!.expect.emptyReport === true;
    const r = await run(real ? fixtures : withoutText(fixtures));
    const [id] = r.workers;
    expect(record(r, id!)).toMatchObject({ status: "failed", report: { state: "pending", text: NO_REPORT } });
    expect(texts(r, id!)).toEqual([]);
    expect(kinds(r.items, "subagentEnded").filter((item) => item.id === id)).toEqual([expect.objectContaining({ status: "failed", summary: NO_REPORT })]);
  });

  contract("C4", "multiple workers: steps, counters and words never mix", "multiple-workers", async (fixtures) => {
    const e = fixtures[0]!.expect;
    const r = await run(fixtures);
    expect(r.workers).toHaveLength(e.workers ?? 2);
    const counters = r.workers.map((id) => new Set(kinds(own(r.items, id), "subagentOutput").map((item) => item.counter)));
    r.workers.forEach((id, i) => {
      const rec = record(r, id);
      expect(rec.status).toBe("done");
      const report = expectReport(r, id, e, i);
      expect(texts(r, id).at(-1)).toBe(report);
      expect([...counters[i]!]).toEqual([`thread:${rec.conversationId}:run1`]);
      for (const step of kinds(r.items, "toolUse").filter((item) => item.parent === id)) expect(step.id.startsWith(`${id}:1:`)).toBe(true);
    });
    expect(new Set(r.workers.map((id) => record(r, id).conversationId)).size).toBe(r.workers.length);
  });

  if (registration.kind === "claude-process") {
    contract("C4", "multiple workers past maxRunning: the second waits until the first ends", "multiple-workers", async (fixtures) => {
      const r = await run(fixtures, { maxRunning: 1 });
      const [first, second] = r.workers;
      const ended = r.items.findIndex((item) => item.kind === "subagentEnded" && (item as any).id === first);
      const waiting = r.items.findIndex((item) => item.kind === "subagentText" && (item as any).parent === second && (item as any).text.startsWith("Waiting for a free worker slot"));
      const secondWork = r.items.findIndex((item: any) => item.parent === second && item.kind !== "subagentText");
      expect(waiting).toBeGreaterThanOrEqual(0);
      expect(ended).toBeGreaterThan(waiting);
      if (secondWork >= 0) expect(secondWork).toBeGreaterThan(ended);
      expect(r.workers.map((id) => record(r, id).status)).toEqual(["done", "done"]);
    });
  }

  contract("C5", "usage and speed: scoped requests, one rising counter, costs that add up, stamped measurements", "usage-speed", async (fixtures) => {
    const r = await run(fixtures);
    const [id] = r.workers;
    const e = fixtures[0]!.expect;
    const rec = record(r, id!);
    const requests = kinds(r.items, "request");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.request.scope).toBe(id);
    if (typeof e.requests === "number") expect(requests).toHaveLength(e.requests);
    const outputs = kinds(r.items, "subagentOutput");
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) expect(output.counter).toBe(`thread:${rec.conversationId}:run1`);
    for (let i = 1; i < outputs.length; i++) expect(outputs[i].tokens).toBeGreaterThanOrEqual(outputs[i - 1].tokens);
    if (typeof e.cost === "number") expect(kinds(r.items, "usage").reduce((sum, item) => sum + item.totalCost, 0)).toBeCloseTo(e.cost, 9);
    if (engine !== "agy") {
      const measurements = kinds(r.items, "measurement");
      expect(measurements.length).toBeGreaterThan(0);
      for (const item of measurements) expect(item.measurement.workerId).toBe(id);
    }
  });

  contract("C6", "follow-up: the next run of the same conversation", "failed-tool-then-success", async (fixtures) => {
    const r = await run(fixtures);
    const [id] = r.workers;
    const conversation = record(r, id!).conversationId;
    expect(conversation).toBeTruthy();
    const sent = await r.core.sendToWorker(id!, "One more check, please.");
    expect(sent).toEqual({ ok: true, how: "newRun", run: 2 });
    await r.playMore();
    expect(record(r, id!)).toMatchObject({ run: 2, status: "done", conversationId: conversation });
    expect(new Set(kinds(own(r.items, id!), "subagentOutput").map((item) => item.counter))).toEqual(new Set([`thread:${conversation}:run1`, `thread:${conversation}:run2`]));
  });

  contract("C6", "steer: words into the run under way keep its run and its one end (engines that steer)", "failed-tool-then-success", async (fixtures) => {
    const mid = fixtures[0]!.lines[Math.floor(fixtures[0]!.lines.length / 2)]!.t;
    let steered: unknown = null;
    const r = await run(fixtures, { at: [{ t: mid, run: async (c) => { if (c.core.steersRunning) steered = await c.core.sendToWorker(c.workers[0]!, "Also mention the folder name."); } }] });
    const [id] = r.workers;
    if (!r.core.steersRunning) return; // Antigravity: words wait for the next run (C6 follow-up covers it)
    expect(steered).toEqual({ ok: true, how: "steered", run: 1 });
    expect(record(r, id!)).toMatchObject({ run: 1, status: "done" });
    expect(kinds(r.items, "subagentEnded").filter((item) => item.id === id)).toHaveLength(1);
  });

  contract("C7", "cancel: stopped, no report, and the rest of the recording is dropped", "cancel", async (fixtures) => {
    const e = fixtures[0]!.expect;
    const r = await run(fixtures, { stopAt: e.stopAt ?? Math.max(...fixtures[0]!.lines.map((line) => line.t)) });
    const [id] = r.workers;
    expect(record(r, id!)).toMatchObject({ status: "stopped", report: { state: "none", text: STOPPED_REPORT } });
    expect(r.delivered).toEqual([]);
    const ends = r.items.map((item, i) => [item, i] as const).filter(([item]) => item.kind === "subagentEnded" && (item as any).id === id);
    expect(ends.map(([item]) => (item as any).status)).toEqual(["stopped"]);
    const after = r.items.slice(ends[0]![1] + 1).filter((item: any) => own([item], id!).length && item.kind !== "permissionCancelled");
    expect(after).toEqual([]);
    for (const permission of kinds(own(r.items, id!), "permission")) expect(kinds(r.items, "permissionCancelled").map((item) => item.requestId)).toContain(permission.requestId);
  });

  contract("C8", "restart: interrupted, follow-ups refused while its process lives, then resumed without replay", "failed-tool-then-success", async (fixtures) => {
    const first = await run(fixtures);
    const [id] = first.workers;
    const saved = record(first, id!);
    const running = (processes: WorkerLedgerRecord["processes"]): WorkerLedgerRecord => ({ ...structuredClone(saved), status: "running", report: { state: "none", text: null, status: null, attempts: 0 }, endedAt: null, processes });
    // Found running at load (a crash): interrupted. Its process is this test process: still alive.
    const self = { pid: process.pid, started: (await import("../../src/core/process/kill-tree")).processStartTime(process.pid) ?? "unknown" };
    const crashed = await run(fixtures, { noHandoff: true, store: new MemoryStore([running([self])]) });
    expect(record(crashed, id!)).toMatchObject({ status: "interrupted", interruptedBy: "crash", recovery: "required" });
    expect(crashed.core.listWorkers()[0]).toMatchObject({ id, state: "interrupted" });
    const refused = await crashed.core.sendToWorker(id!, "Continue.");
    expect(refused).toMatchObject({ ok: false });
    // Listed in the restart journal: a restart. Its process is gone: the follow-up resumes the same conversation.
    const restarted = await run(fixtures, { noHandoff: true, store: new MemoryStore([running([{ pid: 2 ** 22 - 7, started: "gone" }])]), restarted: new Set([id!]) });
    expect(record(restarted, id!)).toMatchObject({ status: "interrupted", interruptedBy: "restart" });
    expect(await restarted.core.sendToWorker(id!, "Continue where you were.")).toEqual({ ok: true, how: "newRun", run: saved.run + 1 });
    await restarted.playMore();
    expect(record(restarted, id!)).toMatchObject({ status: "done", conversationId: saved.conversationId });
    expectShown(restarted, id!);
    const written = restarted.source.processes.flatMap((p) => p.written).join("\n");
    expect(written).toContain("Continue where you were.");
    expect(written).not.toContain(saved.instructions);
  });

  contract("C9", "process exits mid-run: failed, the report pending", "process-exit", async (fixtures) => {
    const r = await run(fixtures);
    const [id] = r.workers;
    const rec = record(r, id!);
    expect(rec).toMatchObject({ status: "failed", report: { state: "pending", status: "failed" } });
    expect(rec.report.text?.trim()).toBeTruthy();
    expect(kinds(r.items, "subagentEnded").filter((item) => item.id === id)).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  contract("C10", "approval: worker-scoped request id, the answer reaches the engine, a denial is noted in a done report", "failed-tool-then-success", async (fixtures) => {
    const native = "approval-1";
    const input = { command: "rm -rf build" };
    let requestId = "";
    const r = await run(fixtures, {
      before: async (c) => {
        for (const line of registration.synth!.permission!(native, "Bash", input)) c.inject(0, line);
        await new Promise((resolve) => setImmediate(resolve));
        const asked = kinds(c.items, "permission")[0];
        requestId = asked?.requestId;
        expect(asked).toMatchObject({ requestId: workerRequestId(c.workers[0]!, 1, native), workerId: c.workers[0], input });
        expect(c.core.answer(requestId, false, input, "Not this one.")).toBe(true);
        expect(c.source.processes[0]!.written.some((line) => line.includes(native))).toBe(true);
      },
    });
    const [id] = r.workers;
    expect(requestId).toBe(workerRequestId(id!, 1, native));
    expect(record(r, id!).status).toBe("done");
    expect(record(r, id!).report.text?.startsWith(deniedNote(1))).toBe(true);
  }, registration.synth?.permission ? null : "the registration has no synth.permission line (TODO)");

  contract("C11", "owner moved: the report is routed to the owner, the coordinator never sees it", "failed-tool-then-success", async (fixtures) => {
    const r = await run(fixtures, { answer: "taken", before: (c) => expect(c.core.setWorkerOwner(c.workers[0]!, { botId: "other-bot", name: "Other", agentId: "agent-1" })).toEqual({ ok: true }) });
    const [id] = r.workers;
    expect(record(r, id!).report.state).toBe("routed");
    expectShown(r, id!);
    expect(r.projection.registry.byNative(r.projection.host.botId, r.projection.host.engine, id!)?.state).toBe("idle");
    expect(r.delivered).toEqual([]);
    expect(kinds(r.items, "workerReport")).toEqual([expect.objectContaining({ id, run: 1, status: "completed" })]);
  });

  contract("C12", "delivery: busy stays pending and redelivers once; a checkpoint never made ends unresolved and failed everywhere", "failed-tool-then-success", async (fixtures) => {
    const r = await run(fixtures);
    const [id] = r.workers;
    expect(record(r, id!).report.state).toBe("pending");
    expectShown(r, id!);
    r.port.answer = "taken";
    r.core.redeliver();
    r.core.redeliver();
    expect(r.delivered.filter((d) => d.id === id)).toHaveLength(2); // the busy attempt, then the one that was taken
    expect(record(r, id!).report.state).toBe(registration.ack === "none" ? "acknowledged" : "delivered");
    expectShown(r, id!);

    // Checkpoint policy: the port queues it, shows it in two turns, and no decision comes.
    const c = await replay({ ...registration, ack: "checkpoint" }, fixtures, { answer: "queued", events: dropRequests });
    const [cid] = c.workers;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(c.core.beginReport(cid!, 1)).toBe(true);
      c.core.finishReport(cid!, 1, true);
    }
    const rec = record(c, cid!);
    expect(rec.report.state).toBe("unresolved");
    expect([stepFailed(rec), chipStatus(rec), agentState(rec), subagentStatus(rec)]).toEqual([true, "failed", "failed", "failed"]);
    // Shown failed everywhere: the row (not first-writer-wins: it had completed), the chip, the registry.
    expectShown(c, cid!);
    expect(c.projection.book.get(cid!)?.status).toBe("failed");
    expect(kinds(c.items, "subagentEnded").filter((item) => item.id === cid).at(-1)).toMatchObject({ status: "failed", summary: UNRESOLVED_REPORT });
  });
});
