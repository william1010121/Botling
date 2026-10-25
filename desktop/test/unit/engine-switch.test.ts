// Phase 5c: switching a head's engine through a memory handoff (1.x's `switchEngine`, `setHeads`,
// `handOver(reason: .engine)`). Asleep: "Switched to …" and the next wake starts on the other CLI.
// Awake: just before the next message the old head writes the handoff into memory.md, ends, a divider
// "Handoff → …", the new engine's head starts in a new session and reads it (Codex is given the memory
// and the recent chat); a reply that is more than OK shows; then the message goes on.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

async function say(c: CoreHarness, text: string) {
  const sent = await c.call({ type: "chat.send", botId: MAIN, text });
  await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId), { timeout: 20_000, what: `the reply to ${text}` });
}

describe("switching a head's engine", () => {
  it("asleep: Switched to Codex, and the next wake is a Codex head in a new session", async () => {
    const dir = tempDir("engine-asleep");
    const c = new CoreHarness(dir, { FAKE_CODEX_INPUT: join(dir, "codex.log"), FAKE_CLAUDE_INPUT: join(dir, "claude.log") });
    harnesses.push(c);
    expect(await c.call({ type: "heads.set", botId: MAIN, engines: ["codex"] })).toEqual({ engines: ["codex"] });
    expect((await c.chat()).messages.at(-1)).toMatchObject({ role: "divider", text: "Switched to Codex" });
    const settings = JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8"));
    expect(settings.engine).toBe("codex");
    expect(settings.heads.engines).toEqual(["codex"]);
    await say(c, "hello");
    expect(lines(join(dir, "claude.log"))).toEqual([]);
    expect(lines(join(dir, "codex.log")).some((entry) => JSON.stringify(entry).includes("hello"))).toBe(true);
    const reply = (await c.chat()).messages.findLast((m: any) => m.role === "bot");
    expect(reply.engine).toBe("codex");
  });

  it("awake Claude → Codex: the handoff into memory.md, a Handoff divider, the Codex head reads it, then the message", async () => {
    const dir = tempDir("engine-awake");
    const c = new CoreHarness(dir, { FAKE_CODEX_INPUT: join(dir, "codex.log"), FAKE_CLAUDE_INPUT: join(dir, "claude.log"), FAKE_HANDOFF_WORK: "Finish the parser." });
    harnesses.push(c);
    await say(c, "first");
    // Awake on Claude; the switch waits for the next message (nothing is said yet).
    await c.call({ type: "heads.set", botId: MAIN, engines: ["codex"] });
    expect((await c.chat()).messages.some((m: any) => m.role === "divider")).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).engine).toBe("codex");
    await say(c, "second");
    const claude = lines(join(dir, "claude.log")).map((entry) => String(entry.text));
    // Claude wrote the handoff with its own note (1.x's BotPrompts.handoff, Claude's words).
    expect(claude.some((text) => text.startsWith('(App: The model is about to change. Write what you are working on and what comes next into the "In progress" section of '))).toBe(true);
    expect(claude.some((text) => /(^|\n)second$/.test(text))).toBe(false);
    const messages = (await c.chat()).messages;
    const divider = messages.findIndex((m: any) => m.role === "divider" && m.text === "Handoff → Codex");
    expect(divider).toBeGreaterThan(0);
    // The Codex head read the handoff (its resume note, then the saved memory and the chat as history).
    const codex = lines(join(dir, "codex.log")).map((entry) => JSON.stringify(entry));
    const resume = codex.findIndex((text) => text.includes("You just took over with a new model"));
    expect(resume).toBeGreaterThanOrEqual(0);
    expect(codex[resume]).toContain("Saved memory snapshot from");
    expect(codex[resume]).toContain("Finish the parser.");
    expect(codex[resume]).toContain("Historical chat context for continuity");
    // (The waiting message is in that history too, as 1.x's `withSavedMemory(leavingOut: nil)` has it; it is delivered after.)
    expect(codex.findLastIndex((text) => text.includes("second"))).toBeGreaterThan(resume);
    // Its words about the work it carries on with show after the divider; the message's reply after that.
    const tookOver = messages.findIndex((m: any) => m.role === "bot" && m.text === "Took over: Finish the parser.");
    expect(tookOver).toBeGreaterThan(divider);
    const last = messages.findLast((m: any) => m.role === "bot");
    expect(last.engine).toBe("codex");
    expect(messages.indexOf(last)).toBeGreaterThan(tookOver);
  });

  it("awake Codex → Claude: a worker writes the handoff, then Claude reads memory.md itself", async () => {
    const dir = tempDir("engine-back");
    const c = new CoreHarness(dir, { FAKE_CODEX_INPUT: join(dir, "codex.log"), FAKE_CLAUDE_INPUT: join(dir, "claude.log"), FAKE_CODEX_WORKER_MS: "50" });
    harnesses.push(c);
    await c.call({ type: "heads.set", botId: MAIN, engines: ["codex"] });
    await say(c, "first");
    await c.call({ type: "heads.set", botId: MAIN, engines: ["claude"] });
    await say(c, "second");
    const codex = lines(join(dir, "codex.log")).map((entry) => JSON.stringify(entry));
    expect(codex.some((text) => text.includes("The model is about to change. Use app_handoff"))).toBe(true);
    const claude = lines(join(dir, "claude.log")).map((entry) => String(entry.text));
    const resume = claude.findIndex((text) => text.startsWith("(App: You just took over with a new model. Read "));
    expect(resume).toBe(0);
    // Claude reads memory.md itself: no snapshot is pasted in.
    expect(claude[0]).not.toContain("Saved memory snapshot");
    const messages = (await c.chat()).messages;
    expect(messages.some((m: any) => m.role === "divider" && m.text === "Handoff → Claude")).toBe(true);
    expect(messages.some((m: any) => m.role === "bot" && m.text === "Took over: Finish the parser.")).toBe(true);
    expect(messages.findLast((m: any) => m.role === "bot").engine).toBe("claude");
  });

  it("two heads: turning off the one it runs on hands over to the other; turning it back on before the message cancels", async () => {
    const dir = tempDir("engine-two");
    const c = new CoreHarness(dir, { FAKE_CODEX_INPUT: join(dir, "codex.log"), FAKE_CLAUDE_INPUT: join(dir, "claude.log") });
    harnesses.push(c);
    await c.call({ type: "heads.set", botId: MAIN, engines: ["claude", "codex"] });
    await say(c, "/solo first");
    await c.call({ type: "heads.set", botId: MAIN, engines: ["codex"] });
    // Back on before the next message: no handoff, two heads again.
    await c.call({ type: "heads.set", botId: MAIN, engines: ["claude", "codex"] });
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).engine).toBe("claude");
    await c.call({ type: "heads.set", botId: MAIN, engines: ["codex"] });
    await say(c, "second");
    const messages = (await c.chat()).messages;
    expect(messages.filter((m: any) => m.role === "divider" && m.text.startsWith("Handoff →")).map((m: any) => m.text)).toEqual(["Handoff → Codex"]);
    expect(messages.findLast((m: any) => m.role === "bot").engine).toBe("codex");
    expect((await c.call({ type: "bot.settings", botId: MAIN })).engines).toEqual(["codex"]);
  });
});
