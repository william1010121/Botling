// Spike 2 against the real `claude` CLI. Opt-in (`npm run test:live`): it spends a little usage.
// Two short turns, no tools, no MCP servers, no session saved to ~/.claude.
import { afterEach, describe, expect, it } from "vitest";
import { alive, sleep, tempDir, until } from "../helpers";
import { CoreHarness } from "../core-harness";

const live = process.env.BOTLING_LIVE_CLAUDE === "1";
const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGTERM");
});
const env = { BOTLING_AGENT: "claude", BOTLING_HARMLESS: "1", ...(process.env.BOTLING_MODEL ? { BOTLING_MODEL: process.env.BOTLING_MODEL } : {}) };

describe.skipIf(!live)("real claude CLI", () => {
  it("streams a short reply through the core", async () => {
    const c = new CoreHarness(tempDir("live"), env);
    harnesses.push(c);
    const { turnId } = await c.call({ type: "chat.send", text: "Reply with exactly the two letters OK and nothing else." });
    const finished = await until(() => c.of("turn.finished")[0], { timeout: 90_000, what: "claude to finish" });
    expect(finished.event).toMatchObject({ turnId, status: "done" });
    expect((finished.event as { text: string }).text).toMatch(/OK/);
    expect(c.of("turn.delta").length).toBeGreaterThan(0);
    console.log(`deltas: ${c.of("turn.delta").length}, first after ${c.of("turn.delta")[0]!.at - c.events[0]!.at} ms`);
  }, 120_000);

  it("stops mid-reply: the tree ends and nothing follows", async () => {
    const c = new CoreHarness(tempDir("live"), env);
    harnesses.push(c);
    const { turnId } = await c.call({ type: "chat.send", text: "Write the numbers from 1 to 400 in words, one per line, with no other text." });
    await until(() => c.of("turn.delta").length >= 3, { timeout: 90_000, what: "claude to start streaming" });
    const ps = await import("node:child_process");
    const pid = Number(/turn \S+ started pid (\d+)/.exec(c.stderr)?.[1]);
    const group = ps.execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })
      .split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter(([, g]) => g === pid).map(([p]) => p!);
    expect(group.length).toBeGreaterThan(0);
    const stopped = await c.call({ type: "turn.stop", turnId });
    expect(stopped.stopped).toBe(true);
    const finish = c.of("turn.finished");
    expect(finish).toHaveLength(1);
    expect(finish[0]!.event).toMatchObject({ status: "stopped" });
    await sleep(1_500);
    expect(c.events.filter((e) => e.seq > finish[0]!.seq)).toEqual([]);
    expect(group.filter(alive)).toEqual([]);
    console.log(`stopped after ${c.of("turn.delta").length} deltas; group was ${group.join(",")}; forced=${stopped.forced}`);
  }, 120_000);
});
