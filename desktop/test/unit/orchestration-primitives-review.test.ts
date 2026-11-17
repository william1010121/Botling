// M7-O03a review: three guards of PluginWorkers (plugin-workers.ts) that no test turned red when removed (the review's
// own mutants R4, R5, R6 in .bot/artifacts/v3-m7/M7-O03a-review.md). Each test here fails when its guard is taken out.
import { describe, expect, it } from "vitest";
import type { AppAnswer } from "../../src/core/plugins";
import { PluginWorkers, type WorkerPort } from "../../src/core/orchestration/plugin-workers";

const ALL = ["orchestrate", "exec", "files", "bots"];
const params = { bot: "main", instructions: "Do it", name: "n" };

function book(opts: { botWritten?: boolean; atOnce?: number; granted?: () => boolean; warn?: (text: string) => void; quota?: () => { atOnce?: number; perDay?: number }; now?: () => number } = {}) {
  const started: Record<string, unknown>[] = [], sent: string[] = [];
  const answers: ((answer: AppAnswer) => void)[] = [];
  const port: WorkerPort = {
    id: "main",
    start: async (args) => { started.push(args); return { task_id: `T${started.length}`, run: 1 }; },
    send: async (id) => { sent.push(id); return { ok: true, how: "newRun", run: 2 }; },
    stop: async () => true,
  };
  const warns: string[] = [];
  const workers = new PluginWorkers({
    world: { granted: opts.granted ?? (() => true), workers: () => port, made: () => true, quota: opts.quota ?? (() => ({ atOnce: opts.atOnce ?? 4 })) },
    facts: () => ({ name: "p", identity: "a".repeat(64), permissions: ALL, botWritten: opts.botWritten ?? false }),
    ask: () => new Promise<AppAnswer>((resolve) => answers.push(resolve)),
    tell: () => {},
    warn: (_plugin, text) => { warns.push(text); opts.warn?.(text); },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { workers, started, sent, answers, warns };
}

describe("PluginWorkers guards the review found untested", () => {
  it("re-reads the threshold once the card is answered: a setting lowered while the card waits warns, and the worker still starts (R4)", async () => {
    // One card at a time per plugin (G2), so the threshold moves another way: the user's setting is lowered while the card waits.
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
    await expect(second).resolves.toMatchObject({ taskId: "T2" });
    expect(t.started).toHaveLength(2);
    expect(t.warns).toHaveLength(1);
  });

  it("checks the grant again on every send: a plugin whose grant is gone sends nothing (R5)", async () => {
    let granted = true;
    const t = book({ granted: () => granted });
    await t.workers.start("p", params);
    granted = false;
    await expect(t.workers.send("p", "T1", "more")).rejects.toThrow("has not been allowed to orchestrate");
    expect(t.sent).toEqual([]);
  });

  it("a send that starts an idle worker again takes a place: past the threshold it warns, and still goes through (R6)", async () => {
    const t = book({ atOnce: 1 });
    await t.workers.start("p", params);
    t.workers.ended("T1", 1, "completed", "done");
    await t.workers.start("p", params);
    expect(t.warns).toEqual([]);
    await expect(t.workers.send("p", "T1", "again")).resolves.toMatchObject({ run: 2 });
    expect(t.sent).toEqual(["T1"]);
    expect(t.warns).toHaveLength(1);
  });

  it("re-arms the warning when the place is taken, not when the card is asked: a dip under the threshold while the card waits makes its answer a new crossing", async () => {
    const t = book({ botWritten: true, atOnce: 1 });
    for (const n of [0, 1]) {
      const started = t.workers.start("p", params);
      await Promise.resolve();
      t.answers[n]!({ index: 0 });
      await started;
    }
    expect(t.warns).toHaveLength(1); // 2 at work, past 1
    const third = t.workers.start("p", params);
    await Promise.resolve();
    expect(t.answers).toHaveLength(3);
    t.workers.ended("T2", 1, "completed", "done"); // back to 1 at work while the card waits
    t.answers[2]!({ index: 0 });
    await expect(third).resolves.toMatchObject({ taskId: "T3" });
    expect(t.warns).toHaveLength(2);
    expect(t.warns[1]).toMatch(/2 workers at work at once \(more than 1\)/);
  });

  it("a warning that fails, or a threshold setting that throws, never stops a start or a send", async () => {
    const t = book({ atOnce: 1, warn: () => { throw new Error("no window"); } });
    await t.workers.start("p", params);
    await expect(t.workers.start("p", params)).resolves.toMatchObject({ taskId: "T2" });
    expect(t.warns).toHaveLength(1);
    // The settings break after a warning was given (so the re-arm reads them too).
    let broken = false;
    const u = book({ quota: () => { if (broken) throw new Error("bad settings"); return { atOnce: 1 }; } });
    await u.workers.start("p", params);
    await u.workers.start("p", params);
    expect(u.warns).toHaveLength(1);
    broken = true;
    u.workers.ended("T1", 1, "completed", "done");
    await expect(u.workers.start("p", params)).resolves.toMatchObject({ taskId: "T3" });
    await expect(u.workers.send("p", "T1", "again")).resolves.toMatchObject({ run: 2 });
    expect(u.started).toHaveLength(3);
  });

  it("a send that takes a place again re-arms the warning first: a dip and a crossing through a send is told again", async () => {
    const t = book({ atOnce: 1 });
    await t.workers.start("p", params);
    await t.workers.start("p", params);
    expect(t.warns).toHaveLength(1);
    t.workers.ended("T2", 1, "completed", "done"); // 1 at work
    await expect(t.workers.send("p", "T2", "again")).resolves.toMatchObject({ run: 2 });
    expect(t.warns).toHaveLength(2);
  });

  it("the day's warning re-arms once the starts of the last 24 hours are back under the threshold, and is told again on the next crossing", async () => {
    let now = 1_000_000_000_000;
    const t = book({ quota: () => ({ atOnce: 10, perDay: 1 }), now: () => now });
    await t.workers.start("p", params);
    await t.workers.start("p", params);
    expect(t.warns).toEqual([expect.stringMatching(/2 workers in the last 24 hours \(more than 1\)/)]);
    now += 25 * 3_600_000; // the two starts leave the day
    await t.workers.start("p", params);
    expect(t.warns).toHaveLength(1);
    await t.workers.start("p", params);
    expect(t.warns).toHaveLength(2);
    expect(t.warns[1]).toMatch(/2 workers in the last 24 hours/);
  });
});
