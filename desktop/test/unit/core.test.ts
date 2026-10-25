// Spike 2 + Phase 1: the built core process, driven over its stdio transport like main drives it
// over parentPort: requests, responses, events with seq, stop with no late events, cancellation,
// restart recovery. Uses the fake CLI, so no real claude usage.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { alive, pidsIn, sleep, tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const WELCOME = "0B07E11C-0000-4000-8000-00000000C0DE";

const harnesses: CoreHarness[] = [];
const core = (dataDir: string, env?: Record<string, string>) => {
  const harness = new CoreHarness(dataDir, env);
  harnesses.push(harness);
  return harness;
};
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});


describe("core process", () => {
  it("streams a reply as events with gapless seq numbers", async () => {
    const c = core(tempDir("core"));
    const snapshot = await c.call({ type: "chat.snapshot" });
    expect(snapshot.bots.map((bot: { id: string }) => bot.id)).toEqual([MAIN, "DEC0DE00-0000-4000-8000-00000000DEC0"]);
    expect(snapshot.chat.messages[0].cards[0].id).toBe("c-counter");
    const { turnId, messageId } = await c.call({ type: "chat.send", botId: MAIN, text: "hello there" });
    const finished = await until(() => c.of("turn.finished")[0], { what: "turn.finished" });
    expect(finished.event).toMatchObject({ turnId, messageId, status: "done", text: "You said: hello there" });
    const deltas = c.of("turn.delta").map((e) => (e.event as { text: string }).text).join("");
    expect(deltas).toBe("You said: hello there");
    const seqs = c.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => snapshot.seq + i + 1));
    expect(new Set(c.events.map((e) => e.epoch))).toEqual(new Set([snapshot.epoch]));
    // Persisted.
    // Persisted in the Swift app's chat.json format: a list of lines, dates in seconds since 2001.
    const saved = JSON.parse(readFileSync(join(c.dataDir, "main", "chat.json"), "utf8"));
    expect(saved.at(-1)).toMatchObject({ id: messageId, role: "bot", state: "done", text: "You said: hello there" });
    expect(saved.at(-1).date).toBeGreaterThan(8e8);
    expect(saved.at(-1).date).toBeLessThan(2e9);
  });

  it("refuses bad input with an error response; a second send while busy joins the first (1.x steering)", async () => {
    const c = core(tempDir("core"), { FAKE_CLAUDE_MODE: "slow" });
    c.post({ v: 10, id: "bad", cmd: { type: "shell.run", command: "ls" } });
    c.post({ v: 11, id: "old", cmd: { type: "chat.snapshot" } });
    c.child.stdin.write("not json\n");
    await until(() => c.responses.get("bad") && c.responses.get("old"));
    expect(c.responses.get("bad")).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(c.responses.get("old")).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    const first = await c.call({ type: "chat.send", botId: MAIN, text: "one" });
    await until(() => c.of("turn.delta").length >= 2);
    const second = await c.call({ type: "chat.send", botId: MAIN, text: "two" });
    expect(second.turnId).not.toBe(first.turnId);
    // The first turn is cut off (its words so far stay), the second runs.
    await until(() => c.of("turn.finished").find((e) => (e.event as { turnId: string }).turnId === first.turnId));
    expect(c.of("turn.finished")[0]!.event).toMatchObject({ status: "stopped" });
    await expect(c.call({ type: "chat.send", botId: "NO-SUCH-BOT", text: "x" })).rejects.toThrow(/not_found/);
    await c.call({ type: "turn.stop", botId: MAIN, turnId: second.turnId });
  });

  it("stop ends the whole tree (even one ignoring SIGTERM) and no event for the turn follows", async () => {
    const dir = tempDir("core");
    const pidsFile = join(dir, "pids");
    const c = core(dir, { FAKE_CLAUDE_MODE: "stubborn", FAKE_CLAUDE_PIDS: pidsFile });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "go" });
    await until(() => c.of("turn.delta").length >= 5, { what: "some deltas" });
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    const stopped = await c.call({ type: "turn.stop", botId: MAIN, turnId });
    expect(stopped.stopped).toBe(true);
    // The fake ignores the interrupt, then SIGTERM, so its tree was ended with SIGKILL.
    expect(stopped.forced).toBe(true);
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    const finish = c.of("turn.finished");
    expect(finish).toHaveLength(1);
    expect(finish[0]!.event).toMatchObject({ status: "stopped" });
    // Nothing for this turn after turn.finished — watch a while longer.
    await sleep(500);
    const after = c.events.filter((e) => e.seq > finish[0]!.seq && "turnId" in e.event && e.event.turnId === turnId);
    expect(after).toEqual([]);
    // The stopped text is exactly the deltas that were delivered.
    const delivered = c.of("turn.delta").map((e) => (e.event as { text: string }).text).join("");
    expect((finish[0]!.event as { text: string }).text).toBe(delivered);
    // Stopping again is a no-op.
    expect((await c.call({ type: "turn.stop", botId: MAIN, turnId })).stopped).toBe(false);
  });

  it("quitting during a turn ends its whole tree quickly (no polite wait), even one ignoring SIGTERM", async () => {
    const dir = tempDir("core");
    const pidsFile = join(dir, "pids");
    const c = core(dir, { FAKE_CLAUDE_MODE: "stubborn", FAKE_CLAUDE_PIDS: pidsFile });
    await c.call({ type: "chat.send", botId: MAIN, text: "go" });
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    const started = Date.now();
    await c.kill("SIGTERM");
    expect(Date.now() - started).toBeLessThan(3_000); // Main gives the core 4 s before it goes.
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, "main", "chat.json"), "utf8"));
    expect(saved.at(-1)).toMatchObject({ role: "bot", state: "stopped", interrupted: true });
  });

  it("a CLI that crashes mid-reply fails the turn instead of hanging", async () => {
    const c = core(tempDir("core"), { FAKE_CLAUDE_MODE: "crash" });
    await c.call({ type: "chat.send", botId: MAIN, text: "go" });
    const finished = await until(() => c.of("turn.finished")[0]);
    expect(finished.event).toMatchObject({ status: "failed" });
  });

  it("cancelling turn.await ends the wait, not the turn", async () => {
    const c = core(tempDir("core"), { FAKE_CLAUDE_MODE: "slow" });
    const { turnId } = await c.call({ type: "chat.send", botId: MAIN, text: "go" });
    const waitId = c.send({ type: "turn.await", botId: MAIN, turnId });
    await sleep(100);
    c.post({ v: 10, cancel: waitId });
    const response = await until(() => c.responses.get(waitId));
    expect(response).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const before = c.of("turn.delta").length;
    await sleep(200);
    expect(c.of("turn.delta").length).toBeGreaterThan(before); // Still streaming.
    await c.call({ type: "turn.stop", botId: MAIN, turnId });
  });

  it("card saves are checked by the core: unknown card, non-JSON and null are refused", async () => {
    const c = core(tempDir("core"));
    await c.call({ type: "chat.snapshot" });
    const card = { botId: MAIN, messageId: WELCOME };
    await expect(c.call({ type: "card.save", ...card, cardId: "c-nope", data: "{}" })).rejects.toThrow(/not_found/);
    await expect(c.call({ type: "card.save", ...card, cardId: "c-counter", data: "not json" })).rejects.toThrow(/bad_request/);
    await expect(c.call({ type: "card.save", ...card, cardId: "c-counter", data: "null" })).rejects.toThrow(/bad_request/);
    await expect(c.call({ type: "card.action", ...card, cardId: "c-counter", name: "runShell", value: "ls" })).rejects.toThrow(/forbidden/);
    expect(await c.call({ type: "card.save", ...card, cardId: "c-counter", data: '{"count":2}' })).toEqual({ saved: true });
    expect(c.of("card.updated")[0]!.event).toMatchObject({ cardId: "c-counter", data: '{"count":2}' });
  });

  it("after a core crash mid-reply: the reply is marked interrupted (not re-sent) and the orphaned CLI tree is ended", async () => {
    const dir = tempDir("core");
    const pidsFile = join(dir, "pids");
    const first = core(dir, { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_PIDS: pidsFile });
    const { messageId } = await first.call({ type: "chat.send", botId: MAIN, text: "go" });
    await until(() => first.of("turn.delta").length >= 3);
    await sleep(700); // Let the throttled save write some text.
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    await first.kill("SIGKILL"); // A crash: no shutdown, the CLI's group survives it.
    expect(pids.some(alive)).toBe(true);

    const second = core(dir, { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_PIDS: pidsFile });
    const snapshot = await second.call({ type: "chat.snapshot" });
    const message = snapshot.chat.messages.find((m: { id: string }) => m.id === messageId);
    expect(message.state).toBe("failed");
    expect(message.interrupted).toBe(true);
    expect(message.text).toMatch(/Interrupted: the core restarted/);
    expect(snapshot.chat.running).toBeNull();
    expect(snapshot.epoch).not.toBe(first.events[0]!.epoch);
    await until(() => pids.every((pid) => !alive(pid)), { what: "leftover tree ended" });
    expect(second.stderr).toMatch(/ended agent process groups/);
    expect(pidsIn(pidsFile)).toEqual(pids); // No new CLI was started: nothing was re-sent.
  });

  it("an unreadable chat file is not silently replaced: the bot says so and refuses messages", async () => {
    const dir = tempDir("core");
    mkdirSync(join(dir, "main"), { recursive: true });
    writeFileSync(join(dir, "main", "chat.json"), "{ half a fi");
    const c = core(dir);
    const snapshot = await c.call({ type: "chat.snapshot" });
    expect(snapshot.bots[0].problem).toMatch(/cannot be read/);
    expect(snapshot.chat.messages).toEqual([]);
    await expect(c.call({ type: "chat.send", botId: MAIN, text: "hello" })).rejects.toThrow(/conflict/);
    await c.kill("SIGTERM");
    expect(readFileSync(join(dir, "main", "chat.json"), "utf8")).toBe("{ half a fi");
  });
});
