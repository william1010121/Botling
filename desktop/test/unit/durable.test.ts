// Spike 5: durable jobs survive a core crash, are never delivered twice, and an uncertain delivery
// is marked instead of re-sent. Real processes, real SIGKILL.
import { beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { JobStore } from "../../src/core/durable/jobs";
import { withFileLock } from "../../src/core/durable/atomic";
import { desktop, sleep, tempDir } from "../helpers";

const worker = join(desktop, ".tmp", "durable-worker.cjs");
beforeAll(async () => {
  await build({ entryPoints: [join(desktop, "test/fixtures/durable-worker.ts")], bundle: true, platform: "node", format: "cjs", outfile: worker, logLevel: "silent" });
});

function run(store: string, log: string, mode: string) {
  const child = spawn(process.execPath, [worker, store, log, mode], { stdio: ["ignore", "pipe", "inherit"] });
  const lines: string[] = [];
  const waiters: [RegExp, (line: string) => void][] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    for (const [pattern, resolve] of waiters) if (pattern.test(line)) resolve(line);
  });
  return {
    child,
    lines,
    waitFor: (pattern: RegExp) => new Promise<string>((resolve) => {
      const seen = lines.find((line) => pattern.test(line));
      if (seen) resolve(seen); else waiters.push([pattern, resolve]);
    }),
    exited: new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
  };
}

const deliveries = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split(" ")[0]!) : []);
const seed = (store: string, n: number) => {
  const jobs = new JobStore(store);
  return Array.from({ length: n }, (_, i) => jobs.create(`req-${i}`, `task ${i}`).id);
};

describe("durable jobs", () => {
  it("a job claimed when the core is killed becomes delivery_uncertain and is never sent", async () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    const log = join(dir, "deliveries.log");
    const ids = seed(store, 5);
    const first = run(store, log, "hang-after-claim");
    const claimed = (await first.waitFor(/^CLAIMED /)).split(" ")[1];
    expect(claimed).toBe(ids[0]);
    first.child.kill("SIGKILL");
    await first.exited;

    const second = run(store, log, "drain");
    expect(await second.exited).toBe(0);
    expect(second.lines[0]).toBe(`RECOVERED ${ids[0]}`);
    expect(deliveries(log)).toEqual(ids.slice(1)); // Each other job once; the uncertain one never.
    const states = Object.fromEntries(new JobStore(store).list().map((job) => [job.id, job.state]));
    expect(states[ids[0]!]).toBe("delivery_uncertain");
    expect(ids.slice(1).every((id) => states[id] === "delivered")).toBe(true);

    // A third start changes nothing and sends nothing.
    const third = run(store, log, "drain");
    expect(await third.exited).toBe(0);
    expect(third.lines).toEqual(["RECOVERED ", "DRAINED 0"]);
    expect(deliveries(log)).toEqual(ids.slice(1));
  });

  it("delivered-but-unconfirmed (killed between deliver and confirm) is marked, not re-sent", async () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    const log = join(dir, "deliveries.log");
    const ids = seed(store, 3);
    const first = run(store, log, "hang-after-deliver");
    await first.waitFor(/^DELIVERED /);
    first.child.kill("SIGKILL");
    await first.exited;
    const second = run(store, log, "drain");
    expect(await second.exited).toBe(0);
    expect(deliveries(log)).toEqual(ids); // ids[0] exactly once, from the first run.
    expect(new JobStore(store).list().find((job) => job.id === ids[0])!.state).toBe("delivery_uncertain");
  });

  it("three cores racing over 60 jobs deliver each exactly once", async () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    const log = join(dir, "deliveries.log");
    const ids = seed(store, 60);
    const workers = [run(store, log, "race"), run(store, log, "race"), run(store, log, "race")];
    expect(await Promise.all(workers.map((w) => w.exited))).toEqual([0, 0, 0]);
    const sent = deliveries(log);
    expect(sent.length).toBe(60);
    expect(new Set(sent)).toEqual(new Set(ids));
    expect(new JobStore(store).list().every((job) => job.state === "delivered")).toBe(true);
  });

  it("killing a writer at random moments never leaves a torn or empty store", async () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    const log = join(dir, "deliveries.log");
    let last = 0;
    for (let round = 0; round < 15; round++) {
      const writer = run(store, log, "create-forever");
      await writer.waitFor(/^RECOVERED/);
      await sleep(20 + Math.random() * 60);
      writer.child.kill("SIGKILL");
      await writer.exited;
      const count = new JobStore(store).list().length; // Parses, or this throws.
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(last).toBeGreaterThan(0);
  });

  it("a lock left by a dead process is broken; a live holder's is respected", async () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    writeFileSync(`${store}.lock`, JSON.stringify({ pid: 999_999, boot: "gone", at: Date.now() }));
    expect(new JobStore(store).list()).toEqual([]);
    writeFileSync(`${store}.lock`, JSON.stringify({ pid: process.pid, boot: "someone-else", at: Date.now() }));
    expect(() => withFileLock(store, () => 1, { timeoutMs: 200 })).toThrow(/Could not lock/);
  });

  it("an unreadable store is reported, never treated as empty", () => {
    const dir = tempDir("durable");
    const store = join(dir, "jobs.json");
    writeFileSync(store, "{ torn");
    expect(() => new JobStore(store).claimNext()).toThrow(/Cannot read/);
    expect(readFileSync(store, "utf8")).toBe("{ torn");
  });
});
