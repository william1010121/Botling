// Switching a head's model, effort or Codex model (Phase 5a; 1.x's `switchModel`, `restart(_:)`): asleep,
// the next wake has it (a "Switched to" line); awake, it goes on in the same session on it just before its
// next message ("Restarted → …"), and is told so with that message.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

describe("switching models", () => {
  it("asleep: a Switched to line; awake: the same session on the new model before the next message", async () => {
    const dir = tempDir("switch");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log"), FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    harnesses.push(c);
    await c.call({ type: "bot.configure", botId: MAIN, model: "sonnet" });
    expect((await c.chat()).messages.at(-1)).toMatchObject({ role: "divider", text: "Switched to Sonnet" });
    let sent = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    const first = lines(join(dir, "start.log")).at(-1);
    expect(first.args[first.args.indexOf("--model") + 1]).toBe("sonnet");
    await c.call({ type: "bot.configure", botId: MAIN, model: "opus" });
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "again" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    const starts = lines(join(dir, "start.log"));
    expect(starts).toHaveLength(2);
    const second = starts[1].args as string[];
    expect(second[second.indexOf("--model") + 1]).toBe("opus");
    expect(second).toContain("--resume");
    expect((await c.chat()).messages.some((m: any) => m.role === "divider" && m.text === "Restarted → Opus")).toBe(true);
    expect(lines(join(dir, "input.log")).some((entry) => String(entry.text).startsWith("(App: Botling restarted you in this same conversation (Opus); carry on as before.)"))).toBe(true);
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
