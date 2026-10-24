// Spike 2 + Phase 1: the built core process, driven over its stdio transport like main drives it
// over parentPort: requests, responses, events with seq, stop with no late events, cancellation,
// restart recovery. Uses the fake CLI, so no real claude usage.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { alive, desktop, fakeCli, pidsIn, sleep, tempDir, until } from "../helpers";
import type { EventEnvelope, ResponseEnvelope, Outbound } from "../../src/contract";

const coreScript = join(desktop, "out", "core", "main.cjs");

class CoreHarness {
  child: ChildProcessWithoutNullStreams;
  events: (EventEnvelope & { at: number })[] = [];
  responses = new Map<string, ResponseEnvelope>();
  stderr = "";
  private counter = 0;

  constructor(readonly dataDir: string, env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [coreScript], {
      env: { ...process.env, BOTLING_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, ...env },
      stdio: "pipe",
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Outbound;
      if ("event" in message) this.events.push({ ...message, at: Date.now() });
      else this.responses.set(message.id, message);
    });
  }

  post(value: unknown) {
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  send(cmd: unknown, id = `r${++this.counter}`) {
    this.post({ v: 1, id, cmd });
    return id;
  }

  async call(cmd: unknown): Promise<any> {
    const id = this.send(cmd);
    const response = await until(() => this.responses.get(id), { what: `response to ${JSON.stringify(cmd)}` });
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result;
  }

  of(type: string) {
    return this.events.filter((e) => e.event.type === type);
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.child.kill(signal);
    return new Promise((resolve) => this.child.once("exit", resolve));
  }
}

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
    expect(snapshot.messages[0].cards[0].id).toBe("c-counter");
    const { turnId, messageId } = await c.call({ type: "chat.send", text: "hello there" });
    const finished = await until(() => c.of("turn.finished")[0], { what: "turn.finished" });
    expect(finished.event).toMatchObject({ turnId, messageId, status: "done", text: "You said: hello there" });
    const deltas = c.of("turn.delta").map((e) => (e.event as { text: string }).text).join("");
    expect(deltas).toBe("You said: hello there");
    const seqs = c.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => snapshot.seq + i + 1));
    expect(new Set(c.events.map((e) => e.epoch))).toEqual(new Set([snapshot.epoch]));
    // Persisted.
    const saved = JSON.parse(readFileSync(join(c.dataDir, "chat.json"), "utf8"));
    expect(saved.messages.at(-1)).toMatchObject({ id: messageId, state: "done", text: "You said: hello there" });
  });

  it("refuses bad input with an error response, and a second send while busy", async () => {
    const c = core(tempDir("core"), { FAKE_CLAUDE_MODE: "slow" });
    c.post({ v: 1, id: "bad", cmd: { type: "shell.run", command: "ls" } });
    c.post({ v: 9, id: "old", cmd: { type: "chat.snapshot" } });
    c.child.stdin.write("not json\n");
    await until(() => c.responses.get("bad") && c.responses.get("old"));
    expect(c.responses.get("bad")).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(c.responses.get("old")).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    const { turnId } = await c.call({ type: "chat.send", text: "one" });
    await expect(c.call({ type: "chat.send", text: "two" })).rejects.toThrow(/conflict/);
    await c.call({ type: "turn.stop", turnId });
  });

  it("stop ends the whole tree (even one ignoring SIGTERM) and no event for the turn follows", async () => {
    const dir = tempDir("core");
    const pidsFile = join(dir, "pids");
    const c = core(dir, { FAKE_CLAUDE_MODE: "stubborn", FAKE_CLAUDE_PIDS: pidsFile });
    const { turnId } = await c.call({ type: "chat.send", text: "go" });
    await until(() => c.of("turn.delta").length >= 5, { what: "some deltas" });
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    const stopped = await c.call({ type: "turn.stop", turnId });
    expect(stopped.stopped).toBe(true);
    expect(stopped.forced).toBe(true); // The fake ignores SIGTERM, so SIGKILL was needed.
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
    expect((await c.call({ type: "turn.stop", turnId })).stopped).toBe(false);
  });

  it("a CLI that crashes mid-reply fails the turn instead of hanging", async () => {
    const c = core(tempDir("core"), { FAKE_CLAUDE_MODE: "crash" });
    await c.call({ type: "chat.send", text: "go" });
    const finished = await until(() => c.of("turn.finished")[0]);
    expect(finished.event).toMatchObject({ status: "failed" });
  });

  it("cancelling turn.await ends the wait, not the turn", async () => {
    const c = core(tempDir("core"), { FAKE_CLAUDE_MODE: "slow" });
    const { turnId } = await c.call({ type: "chat.send", text: "go" });
    const waitId = c.send({ type: "turn.await", turnId });
    await sleep(100);
    c.post({ v: 1, cancel: waitId });
    const response = await until(() => c.responses.get(waitId));
    expect(response).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const before = c.of("turn.delta").length;
    await sleep(200);
    expect(c.of("turn.delta").length).toBeGreaterThan(before); // Still streaming.
    await c.call({ type: "turn.stop", turnId });
  });

  it("card saves are checked by the core: unknown card, non-JSON and null are refused", async () => {
    const c = core(tempDir("core"));
    await c.call({ type: "chat.snapshot" });
    await expect(c.call({ type: "card.save", messageId: "m-welcome", cardId: "c-nope", data: "{}" })).rejects.toThrow(/not_found/);
    await expect(c.call({ type: "card.save", messageId: "m-welcome", cardId: "c-counter", data: "not json" })).rejects.toThrow(/bad_request/);
    await expect(c.call({ type: "card.save", messageId: "m-welcome", cardId: "c-counter", data: "null" })).rejects.toThrow(/bad_request/);
    await expect(c.call({ type: "card.action", messageId: "m-welcome", cardId: "c-counter", name: "runShell", value: "ls" })).rejects.toThrow(/forbidden/);
    expect(await c.call({ type: "card.save", messageId: "m-welcome", cardId: "c-counter", data: '{"count":2}' })).toEqual({ saved: true });
    expect(c.of("card.updated")[0]!.event).toMatchObject({ cardId: "c-counter", data: '{"count":2}' });
  });

  it("after a core crash mid-reply: the reply is marked interrupted (not re-sent) and the orphaned CLI tree is ended", async () => {
    const dir = tempDir("core");
    const pidsFile = join(dir, "pids");
    const first = core(dir, { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_PIDS: pidsFile });
    const { messageId } = await first.call({ type: "chat.send", text: "go" });
    await until(() => first.of("turn.delta").length >= 3);
    await sleep(700); // Let the throttled save write some text.
    const pids = await until(() => (pidsIn(pidsFile).length >= 2 ? pidsIn(pidsFile) : null));
    await first.kill("SIGKILL"); // A crash: no shutdown, the CLI's group survives it.
    expect(pids.some(alive)).toBe(true);

    const second = core(dir, { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_PIDS: pidsFile });
    const snapshot = await second.call({ type: "chat.snapshot" });
    const message = snapshot.messages.find((m: { id: string }) => m.id === messageId);
    expect(message.state).toBe("failed");
    expect(message.text).toMatch(/Interrupted: the core restarted/);
    expect(snapshot.running).toBeNull();
    expect(snapshot.epoch).not.toBe(first.events[0]!.epoch);
    await until(() => pids.every((pid) => !alive(pid)), { what: "leftover tree ended" });
    expect(second.stderr).toMatch(/ended agent process groups/);
    expect(pidsIn(pidsFile)).toEqual(pids); // No new CLI was started: nothing was re-sent.
  });

  it("an unreadable chat file is not silently replaced", async () => {
    const dir = tempDir("core");
    writeFileSync(join(dir, "chat.json"), "{ half a fi");
    const c = core(dir);
    const code = await new Promise((resolve) => c.child.once("exit", resolve));
    expect(code).not.toBe(0);
    expect(readFileSync(join(dir, "chat.json"), "utf8")).toBe("{ half a fi");
  });
});
