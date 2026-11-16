// M7-O03a review: three guards of PluginWorkers (plugin-workers.ts) that no test turned red when removed (the review's
// own mutants R4, R5, R6 in .bot/artifacts/v3-m7/M7-O03a-review.md). Each test here fails when its guard is taken out.
import { describe, expect, it } from "vitest";
import type { AppAnswer } from "../../src/core/plugins";
import { PluginWorkers, type WorkerPort } from "../../src/core/orchestration/plugin-workers";

const ALL = ["orchestrate", "exec", "files", "bots"];
const params = { bot: "main", instructions: "Do it", name: "n" };

function book(opts: { botWritten?: boolean; atOnce?: number; granted?: () => boolean } = {}) {
  const started: Record<string, unknown>[] = [], sent: string[] = [];
  const answers: ((answer: AppAnswer) => void)[] = [];
  const port: WorkerPort = {
    id: "main",
    start: async (args) => { started.push(args); return { task_id: `T${started.length}`, run: 1 }; },
    send: async (id) => { sent.push(id); return { ok: true, how: "newRun", run: 2 }; },
    stop: async () => true,
  };
  const workers = new PluginWorkers({
    world: { granted: opts.granted ?? (() => true), workers: () => port, made: () => true, quota: () => ({ atOnce: opts.atOnce ?? 4 }) },
    facts: () => ({ name: "p", identity: "a".repeat(64), permissions: ALL, botWritten: opts.botWritten ?? false }),
    ask: () => new Promise<AppAnswer>((resolve) => answers.push(resolve)),
    tell: () => {},
  });
  return { workers, started, sent, answers };
}

describe("PluginWorkers guards the review found untested", () => {
  it("re-checks the quota once the card is answered: the room that was there when the card came is gone when it is answered (R4)", async () => {
    // One card at a time per plugin (G2), so the room goes another way: the user's setting is lowered while the card waits.
    const opts = { botWritten: true, atOnce: 2 };
    const t = book(opts);
    const first = t.workers.start("p", params);
    await Promise.resolve();
    t.answers[0]!({ index: 0 });
    await first;
    const second = t.workers.start("p", params);
    await Promise.resolve();
    expect(t.answers).toHaveLength(2);
    opts.atOnce = 1;
    t.answers[1]!({ index: 0 });
    await expect(second).rejects.toThrow("workers at work");
    expect(t.started).toHaveLength(1);
  });

  it("checks the grant again on every send: a plugin whose grant is gone sends nothing (R5)", async () => {
    let granted = true;
    const t = book({ granted: () => granted });
    await t.workers.start("p", params);
    granted = false;
    await expect(t.workers.send("p", "T1", "more")).rejects.toThrow("has not been allowed to orchestrate");
    expect(t.sent).toEqual([]);
  });

  it("a send that would start an idle worker again is refused when the plugin is at its limit at once (R6)", async () => {
    const t = book({ atOnce: 1 });
    await t.workers.start("p", params);
    t.workers.ended("T1", 1, "completed", "done");
    await t.workers.start("p", params);
    await expect(t.workers.send("p", "T1", "again")).rejects.toThrow("workers at work");
    expect(t.sent).toEqual([]);
  });
});
