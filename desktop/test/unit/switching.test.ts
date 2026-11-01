// Switching a head's model, effort or Codex model (Phase 5a; 1.x's `switchModel`, `restart(_:)`): asleep,
// the next wake has it (a "Switched to" line); awake, a change the head takes in place is applied just before
// its next message ("Switched → …"); any other goes on in the same session after a restart ("Restarted → …"),
// and is told so with that message.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

describe("switching models", () => {
  it("asleep: a Switched to line; awake: the model switches in place (set_model), an effort change restarts in the same session", async () => {
    const dir = tempDir("switch");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log"), FAKE_CLAUDE_INPUT: join(dir, "input.log"), FAKE_CLAUDE_CONTROLS: join(dir, "controls.log") });
    harnesses.push(c);
    await c.call({ type: "bot.configure", botId: MAIN, model: "sonnet" });
    expect((await c.chat()).messages.at(-1)).toMatchObject({ role: "divider", text: "Switched to Sonnet" });
    let sent = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    const first = lines(join(dir, "start.log")).at(-1);
    expect(first.args[first.args.indexOf("--model") + 1]).toBe("sonnet");
    // Awake, a new model goes in through set_model before the next message: same process, no restart.
    await c.call({ type: "bot.configure", botId: MAIN, model: "opus" });
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "again" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    expect(lines(join(dir, "start.log"))).toHaveLength(1);
    expect(lines(join(dir, "controls.log")).map((entry) => entry.request)).toEqual([{ subtype: "set_model", model: "opus" }]);
    expect((await c.chat()).messages.some((m: any) => m.role === "divider" && m.text === "Switched → Opus")).toBe(true);
    // An effort change is not taken in place (yet): it starts again in the same session, and is told so.
    await c.call({ type: "bot.configure", botId: MAIN, efforts: { claude: "high" } });
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "once more" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    const starts = lines(join(dir, "start.log"));
    expect(starts).toHaveLength(2);
    const second = starts[1].args as string[];
    expect(second[second.indexOf("--model") + 1]).toBe("opus");
    expect(second[second.indexOf("--effort") + 1]).toBe("high");
    expect(second).toContain("--resume");
    expect((await c.chat()).messages.some((m: any) => m.role === "divider" && m.text === "Restarted → High effort")).toBe(true);
    expect(lines(join(dir, "input.log")).some((entry) => String(entry.text).startsWith("(App: Botling restarted you in this same conversation (high effort); carry on as before."))).toBe(true);
  });

  it("a model claude refuses to switch to in place starts it again in the same session on that model", async () => {
    const dir = tempDir("switch-refused");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log"), FAKE_CLAUDE_SET_MODEL: "refuse" });
    harnesses.push(c);
    let sent = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    await c.call({ type: "bot.configure", botId: MAIN, model: "opus" });
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "again" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    const starts = lines(join(dir, "start.log"));
    expect(starts).toHaveLength(2);
    expect(starts[1].args[starts[1].args.indexOf("--model") + 1]).toBe("opus");
    expect(starts[1].args).toContain("--resume");
    expect((await c.chat()).messages.some((m: any) => m.role === "divider" && m.text === "Restarted → Opus")).toBe(true);
  });
});

describe("Codex's models (model/list)", () => {
  it("lists what the local Codex offers, hidden ones left out, once per run", async () => {
    const dir = tempDir("models");
    const c = new CoreHarness(dir, {});
    harnesses.push(c);
    const { models } = await c.call({ type: "codex.models" });
    expect(models).toEqual([
      { id: "gpt-6-luna", name: "GPT-6 Luna", isDefault: true, efforts: ["low", "medium", "high"] },
      { id: "gpt-6-sol", name: "GPT-6 Sol", isDefault: false, efforts: ["medium", "xhigh"] },
    ]);
    expect((await c.call({ type: "codex.models" })).models).toHaveLength(2);
  });
});
