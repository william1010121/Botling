// The actual core emits identity before any CLI text, including turns waiting in its queue.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Event } from "../../src/contract";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";

const harnesses: CoreHarness[] = [];
const start = (dir: string, env: Record<string, string> = {}) => {
  const core = new CoreHarness(dir, env);
  harnesses.push(core);
  return core;
};
afterEach(async () => {
  for (const core of harnesses.splice(0)) await core.kill("SIGKILL");
});
const ended = (core: CoreHarness, turnId: string) => until(() => core.of("turn.finished").find((entry) => (entry.event as { turnId: string }).turnId === turnId));
const seed = (dir: string, engine: "claude" | "codex") => {
  mkdirSync(join(dir, "main"), { recursive: true });
  writeFileSync(join(dir, "main/bot.json"), JSON.stringify({ engine, heads: { engines: [engine], answerWith: engine } }));
};

describe("core engine identity at submission", () => {
  it.each(["claude", "codex"] as const)("identifies %s before CLI output and preserves it on disk/reload", async (engine) => {
    const dir = tempDir("engine-avatar");
    seed(dir, engine);
    const core = start(dir, { FAKE_CODEX_TURN_MS: "400" });
    const sent = await core.call({ type: "chat.send", botId: MAIN, text: "/say Saved answer" });
    const began = core.of("turn.started").find((entry) => (entry.event as { turnId: string }).turnId === sent.turnId)!;
    expect(Event.parse(began.event)).toMatchObject({ type: "turn.started", head: engine });
    if (engine === "codex") {
      const thinking = await core.chat();
      expect(thinking.runs).toEqual([expect.objectContaining({ turnId: sent.turnId, head: "codex" })]);
      expect(thinking.messages.find((line: { id: string }) => line.id === sent.messageId)?.text ?? "").toBe("");
    }
    await ended(core, sent.turnId);
    const firstReply = core.events.findIndex((entry) => entry.event.type === "message.added" && entry.event.message.id === sent.messageId);
    expect(core.events.indexOf(began)).toBeLessThan(firstReply);
    expect(core.events.filter((entry) => entry.event.type === "message.added" && entry.event.message.id === sent.messageId).every((entry) => entry.event.type === "message.added" && entry.event.message.engine === engine)).toBe(true);
    const saved = JSON.parse(readFileSync(join(dir, "main/chat.json"), "utf8"));
    expect(saved.find((line: { id: string }) => line.id === sent.messageId)).toMatchObject({ engine, text: "Saved answer" });
    await core.kill("SIGKILL");
    // Select the other engine after this reply; history retains its own engine on reload.
    seed(dir, engine === "codex" ? "claude" : "codex");
    const reloaded = start(dir);
    expect((await reloaded.chat()).messages.find((line: { id: string }) => line.id === sent.messageId)).toMatchObject({ engine, text: "Saved answer" });
  });

  it("keeps Codex identity when a message queues during process startup and later begins", async () => {
    const dir = tempDir("engine-avatar-queued");
    seed(dir, "codex");
    const core = start(dir, { FAKE_CODEX_TURN_MS: "400" });
    await core.chat();
    // Both commands reach the core before the child can acknowledge its first turn (steering
    // is not available yet), so the second message follows the production queue path.
    const firstId = core.send({ type: "chat.send", botId: MAIN, text: "/say First" });
    const secondId = core.send({ type: "chat.send", botId: MAIN, text: "/say Queued" });
    const first = await until(() => core.responses.get(firstId));
    const second = await until(() => core.responses.get(secondId));
    if (!first.ok || !second.ok) throw new Error("Messages were not accepted");
    const a = first.result as { turnId: string; messageId: string };
    const b = second.result as { turnId: string; messageId: string };
    expect(a.turnId).not.toBe(b.turnId);
    const waiting = await core.chat();
    expect(waiting.runs).toEqual([expect.objectContaining({ turnId: a.turnId, head: "codex" })]);
    expect(core.of("turn.started").some((entry) => (entry.event as { turnId: string }).turnId === b.turnId)).toBe(false);
    await ended(core, a.turnId);
    const began = await until(() => core.of("turn.started").find((entry) => (entry.event as { turnId: string }).turnId === b.turnId));
    expect(Event.parse(began.event)).toMatchObject({ head: "codex" });
    expect((await core.chat()).runs).toEqual([expect.objectContaining({ turnId: b.turnId, head: "codex" })]);
    await ended(core, b.turnId);
    expect((await core.chat()).messages.filter((line: { role: string }) => line.role === "bot").map((line: { engine: string }) => line.engine)).toEqual(["codex", "codex"]);
  });
});
