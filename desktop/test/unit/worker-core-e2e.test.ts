// The shared worker core end to end (shared-core spec S4b acceptance), through the built core and the fake CLIs, no
// windows: per engine, a worker whose tool fails on the way and which reports anyway, and a worker at work across an
// explicit restart. At every step its row (subagents.json), its chip (chat.json), its registry entry (agents.json) and
// its ledger record (worker-ledger.json) agree, through status.ts. Antigravity cannot run here (its ACP runtime is
// verified by hash); the contract suite replays its recordings through the same core and projection.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ledgerRecords, tempDir, until } from "../helpers";
import { readSubagentRows } from "../subagent-disk";
import { CoreHarness, MAIN } from "../core-harness";
import { agentState, chipStatus, subagentStatus } from "../../src/core/worker-core";

const harnesses: CoreHarness[] = [];
const start = (dir: string) => {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), FAKE_CODEX_INPUT: join(dir, "codex-input.log"), BOTLING_IMPORT_FROM: "", BOTLING_ROUTINE_TICK_MS: "0", BOTLING_UPDATE_PENDING: "0", BOTLING_QUIT_TIDY_MS: "0" });
  harnesses.push(harness);
  return harness;
};
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

async function turn(c: CoreHarness, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text });
  return (await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { what: `the end of "${text}"` })).event as { text: string };
}

const ledger = (dir: string, id: string) => ledgerRecords(dir).find((r) => r.id === id);
/** Its row, chip and registry entry as they are on disk now, and what its ledger record says they should be. */
function shown(dir: string, id: string) {
  const record = ledger(dir, id);
  const row = readSubagentRows(join(dir, "main", "subagents.json")).find((r) => r.id === id);
  const chat = JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8")) as { backgroundTasks?: { id: string; status: string }[] }[];
  const chip = chat.flatMap((m) => m.backgroundTasks ?? []).findLast((t) => t.id === id);
  const agents = existsSync(join(dir, "agents.json")) ? JSON.parse(readFileSync(join(dir, "agents.json"), "utf8")).agents as { nativeId: string; state: string }[] : [];
  const entry = agents.find((a) => a.nativeId === id);
  return {
    actual: { row: row?.status, chip: chip?.status, registry: entry?.state },
    expected: record ? { row: subagentStatus(record), chip: chipStatus(record), registry: agentState(record) } : null,
    record, row,
  };
}
/** Waits until its row, chip and registry entry all show its ledger record's state, and that state is `wanted`. */
async function agree(dir: string, id: string, wanted: (record: any) => boolean, what: string) {
  return until(() => {
    const s = shown(dir, id);
    return s.record && wanted(s.record) && JSON.stringify(s.actual) === JSON.stringify(s.expected) ? s : null;
  }, { what: `${what}: ${JSON.stringify(shown(dir, id).actual)} vs ${JSON.stringify(shown(dir, id).expected)}`, timeout: 15_000 });
}

describe("one worker per engine, a failed tool on the way, one restart: row, chip and registry agree with the ledger", () => {
  it("Claude", async () => {
    const dir = tempDir("e2e-claude");
    const first = start(dir);
    const handed = await turn(first, "/worker /failtool Look up the API");
    const id = /^Handed off: ([0-9a-f-]{36})$/.exec(handed.text)?.[1]!;
    expect(id, handed.text).toBeTruthy();
    // Done despite the failed tool (the user's rule), its report taken: completed, idle, the failed step shown.
    const done = await agree(dir, id, (r) => r.status === "done" && r.report.state === "acknowledged", "the Claude worker done");
    expect(done.actual).toEqual({ row: "completed", chip: "completed", registry: "idle" });
    expect(done.row.steps.some((step: any) => step.failed)).toBe(true);
    expect(done.record.report.text).toContain("Recovered after a failed tool");

    // Its report turn first (a message sent meanwhile would join it).
    await until(() => first.of("turn.finished").some((e) => (e.event as { text: string }).text.includes(`task_id="${id}"`)), { what: "the report turn" });
    // A second one at work when the app restarts: interrupted by the restart, and its coordinator is told its id.
    const slowText = (await turn(first, "/worker /slow")).text;
    const slow = /^Handed off: ([0-9a-f-]{36})$/.exec(slowText)?.[1]!;
    expect(slow, slowText).toBeTruthy();
    await agree(dir, slow, (r) => r.status === "running", "the slow worker at work");
    first.post({ botling: "prepareRestart", id: 701 });
    expect(await until(() => first.responses.get(701 as unknown as string), { what: "the restart checkpoint" })).toMatchObject({ ok: true });
    await first.kill("SIGTERM");
    expect(JSON.parse(readFileSync(join(dir, "restart-continuation.json"), "utf8")).entries[0]).not.toHaveProperty("claudeWorkers");
    const second = start(dir);
    const cut = await agree(dir, slow, (r) => r.status === "interrupted", "the slow worker after the restart");
    expect(cut.record).toMatchObject({ interruptedBy: "restart", recovery: "required" });
    expect(cut.actual).toEqual({ row: "stopped", chip: "interrupted", registry: "interrupted" });
    await until(() => existsSync(join(dir, "claude-input.log")) && readFileSync(join(dir, "claude-input.log"), "utf8").includes(slow), { what: "the continuation note naming it" });
    // The first one is as it was.
    expect(shown(dir, id).actual).toEqual({ row: "completed", chip: "completed", registry: "idle" });
    await second.kill("SIGTERM");
  });

  it("Codex", async () => {
    const dir = tempDir("e2e-codex");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
    const first = start(dir);
    await turn(first, "/worker /failtool Build the parser");
    const id = await until(() => ledgerRecords(dir).find((r) => r.instructions.includes("Build the parser"))?.id, { what: "the Codex worker in the ledger" });
    const done = await agree(dir, id, (r) => r.status === "done" && r.report.state === "acknowledged", "the Codex worker done");
    expect(done.actual).toEqual({ row: "completed", chip: "completed", registry: "idle" });
    expect(done.row.steps.some((step: any) => step.failed)).toBe(true);
    // Its old journal is no longer written.
    expect(existsSync(join(dir, "codex-threads")) ? require("node:fs").readdirSync(join(dir, "codex-threads")).filter((f: string) => f.endsWith(".workers.json")) : []).toEqual([]);

    await turn(first, "/worker /slowworker Long job");
    const slow = await until(() => ledgerRecords(dir).find((r) => r.instructions.includes("Long job"))?.id, { what: "the slow Codex worker" });
    await agree(dir, slow, (r) => r.status === "running", "the slow Codex worker at work");
    first.post({ botling: "prepareRestart", id: 702 });
    expect(await until(() => first.responses.get(702 as unknown as string), { what: "the restart checkpoint" })).toMatchObject({ ok: true });
    await first.kill("SIGTERM");
    const entry = JSON.parse(readFileSync(join(dir, "restart-continuation.json"), "utf8")).entries[0];
    expect(entry).not.toHaveProperty("workers");
    expect(typeof entry.restartedAt).toBe("number");
    expect(ledger(dir, slow)).toMatchObject({ status: "interrupted", interruptedBy: "restart", run: 1 });
    // The next core starts its head (it resumes its thread) to check the worker's original turn. The fake app-server
    // of a new process does not know the old worker thread, so the check cannot confirm it and nothing is replayed:
    // still interrupted, still run 1, shown so everywhere. (Its same-run resume: test/unit/codex-workers-core.test.ts.)
    const second = start(dir);
    await until(() => JSON.parse(readFileSync(join(dir, "restart-continuation.json"), "utf8")).entries[0].state === "dispatched", { what: "the restart entry taken" });
    await until(() => readFileSync(join(dir, "codex-input.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).some((line) => line.kind === "resume"), { what: "its head resumed for the check" });
    const after = await agree(dir, slow, (r) => r.status === "interrupted", "the slow Codex worker after the check");
    expect(after.record).toMatchObject({ run: 1, interruptedBy: "restart" });
    expect(after.actual).toEqual({ row: "stopped", chip: "interrupted", registry: "interrupted" });
    expect(shown(dir, id).actual).toEqual({ row: "completed", chip: "completed", registry: "idle" });
    await second.kill("SIGTERM");
  });
});
