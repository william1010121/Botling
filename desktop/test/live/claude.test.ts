// The long-lived head against the real `claude` CLI. Opt-in (`npm run test:live`): it spends a
// little usage — three short turns in all. "Harmless" mode: --safe-mode (no CLAUDE.md, hooks,
// plugins), no MCP servers, no session saved to ~/.claude, and only the tools named in
// BOTLING_HARMLESS_TOOLS exist. The one tool request is denied, so nothing runs.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { alive, sleep, tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const live = process.env.BOTLING_LIVE_CLAUDE === "1";
const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGTERM");
});
const env = (extra: Record<string, string> = {}) => ({
  BOTLING_AGENT: "claude", BOTLING_HARMLESS: "1", BOTLING_QUIT_TIDY_MS: "0", ...(process.env.BOTLING_MODEL ? { BOTLING_MODEL: process.env.BOTLING_MODEL } : {}), ...extra,
});
const headPid = (c: CoreHarness) => Number(/head started pid (\d+)/.exec(c.stderr)?.[1]);

describe.skipIf(!live)("real claude CLI, long-lived head", () => {
  it("streams a short reply through one stream-json process that stays for the next message", async () => {
    const c = new CoreHarness(tempDir("live"), env());
    harnesses.push(c);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "Reply with exactly the two letters OK and nothing else." });
    const finished = await until(() => c.of("turn.finished")[0], { timeout: 90_000, what: "claude to finish" });
    expect(finished.event).toMatchObject({ turnId, status: "done" });
    expect((finished.event as { text: string }).text).toMatch(/OK/);
    expect(c.of("turn.delta").length).toBeGreaterThan(0);
    await sleep(500);
    expect(alive(headPid(c))).toBe(true); // Still there for the next message.
    console.log(`deltas: ${c.of("turn.delta").length}, first after ${c.of("turn.delta")[0]!.at - c.events[0]!.at} ms`);
  }, 120_000);

  it("asks before a tool it may not use; Don't allow refuses it and the turn goes on", async () => {
    // Not `echo`: claude runs read-only commands like echo without asking (seen in the first run
    // of this test). A mkdir needs approval; it is denied, so nothing is made.
    const dir = tempDir("live");
    const c = new CoreHarness(dir, env({ BOTLING_HARMLESS_TOOLS: "Bash", BOTLING_APPROVAL_TIMEOUT_MS: "60000" }));
    harnesses.push(c);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "Use the Bash tool to run exactly this command: mkdir botling-live-check — then say in one short sentence what happened." });
    const question = await until(
      () => c.of("message.added").map((e) => (e.event as { message: any }).message).find((m) => m.approval),
      { timeout: 90_000, what: "an approval request" },
    );
    expect(question.approval.tool).toBe("Bash");
    expect(question.text).toContain("mkdir botling-live-check");
    const deny = question.choices.findIndex((choice: { action: string }) => choice.action === "deny");
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: deny })).toEqual({ accepted: true });
    const finished = await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === turnId), { timeout: 90_000, what: "the turn to end" });
    expect(finished.event).toMatchObject({ status: "done" });
    expect(existsSync(join(dir, "main", "botling-live-check"))).toBe(false);
    console.log(`after the denial claude said: ${(finished.event as { text: string }).text.slice(0, 200)}`);
  }, 120_000);

  it("Stop interrupts mid-reply: nothing for the turn follows", async () => {
    const c = new CoreHarness(tempDir("live"), env());
    harnesses.push(c);
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "Write the numbers from 1 to 400 in words, one per line, with no other text." });
    await until(() => c.of("turn.delta").length >= 3, { timeout: 90_000, what: "claude to start streaming" });
    const stopped = await c.call({ type: "turn.stop", botId: MAIN, turnId });
    expect(stopped.stopped).toBe(true);
    const finish = c.of("turn.finished");
    expect(finish).toHaveLength(1);
    expect(finish[0]!.event).toMatchObject({ status: "stopped" });
    await sleep(1_500);
    expect(c.events.filter((e) => e.seq > finish[0]!.seq && "turnId" in e.event && (e.event as { turnId: string }).turnId === turnId)).toEqual([]);
    console.log(`stopped after ${c.of("turn.delta").length} deltas; interrupt honoured: ${!stopped.forced && stopped.killed.length === 0}; head alive: ${alive(headPid(c))}`);
  }, 120_000);
});
