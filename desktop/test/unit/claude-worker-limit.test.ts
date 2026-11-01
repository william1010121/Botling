// Claude workers are each a claude process of their own: at most `claudeWorkerLimit` (settings.json, default 4) are at work
// at once; one more is accepted, listed at work with a line saying it waits, and starts when another worker's run ends or
// is stopped. Words for one that waits join the run it starts with; stopping it takes it out of the queue.
import { afterEach, describe, expect, it } from "vitest";
import { claudeHarness } from "../claude-workers-fake";
import { DEFAULT_CLAUDE_WORKER_LIMIT } from "../../src/core/agent/claude-workers";
import { claudeWorkerLimit } from "../../src/core/settings";

const harnesses: ReturnType<typeof claudeHarness>[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.workers.close(); });
const open = (maxRunning?: number) => { const h = claudeHarness(undefined, { maxRunning }); harnesses.push(h); return h; };

describe("the Claude worker limit", () => {
  it("defaults to 4 and reads settings.json's claudeWorkerLimit (1–16)", () => {
    expect(DEFAULT_CLAUDE_WORKER_LIMIT).toBe(4);
    expect(claudeWorkerLimit({})).toBe(4);
    expect(claudeWorkerLimit({ claudeWorkerLimit: 2 } as any)).toBe(2);
    expect(claudeWorkerLimit({ claudeWorkerLimit: 99 } as any)).toBe(16);
    expect(claudeWorkerLimit({ claudeWorkerLimit: 0 } as any)).toBe(4);
  });

  it("queues a worker beyond the limit and starts it when a slot frees", async () => {
    const h = open(2);
    const a: any = await h.workers.tool("app_handoff", { instructions: "A", name: "A" });
    const b: any = await h.workers.tool("app_handoff", { instructions: "B", name: "B" });
    const c: any = await h.workers.tool("app_handoff", { instructions: "C", name: "C" });
    expect(h.heads).toHaveLength(2);
    expect(h.workers.listWorkers().find((w) => w.id === c.task_id)!.state).toBe("running");
    expect(h.items).toContainEqual(expect.objectContaining({ kind: "subagentText", parent: c.task_id, text: expect.stringMatching(/Waiting for a free worker slot/) }));
    // Words for it while it waits join its first run.
    expect(h.workers.sendToWorker(c.task_id, "Also D.")).toEqual({ ok: true, how: "steered", run: 1 });
    h.result(h.heads[0]!, "A done.");
    expect(h.heads).toHaveLength(3);
    expect(h.heads[2]!.sent[0]!.text).toBe("C\n\nAlso D.");
    expect(h.reports.map((r) => r.id)).toEqual([a.task_id]);
    void b;
  });

  it("a stopped waiting worker leaves the queue; stopping a running one lets the next start", async () => {
    const h = open(1);
    const a: any = await h.workers.tool("app_handoff", { instructions: "A" });
    const b: any = await h.workers.tool("app_handoff", { instructions: "B" });
    const c: any = await h.workers.tool("app_handoff", { instructions: "C" });
    expect(await h.workers.stopWorker(b.task_id)).toBe(true);
    expect(h.workers.listWorkers().find((w) => w.id === b.task_id)!.state).toBe("stopped");
    expect(await h.workers.stopWorker(a.task_id)).toBe(true);
    expect(h.heads).toHaveLength(2);
    expect(h.heads[1]!.sent[0]!.text).toBe("C");
    void c;
  });
});
