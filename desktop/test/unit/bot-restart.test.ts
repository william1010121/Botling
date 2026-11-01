// "Restart bot" (the left column's row menu): the head's process starts again in the same session just
// before the bot's next message ("Restarted → …"), with the app's current instructions told with it.
// Asleep, nothing runs now; the next wake has them. Busy, it waits like a model change does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { BotMenu } from "../../src/renderer/Rail";
import { RENDERER_COMMANDS } from "../../src/contract";
import type { BotView } from "../../src/contract";

const harnesses: CoreHarness[] = [];
afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

describe("bot.restart", () => {
  it("is a renderer command", () => { expect(RENDERER_COMMANDS.has("bot.restart")).toBe(true); });

  it("awake: starts again in the same session before the next message, told the current instructions", async () => {
    const dir = tempDir("restart-bot");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log"), FAKE_CLAUDE_INPUT: join(dir, "input.log") });
    harnesses.push(c);
    let sent = await c.call({ type: "chat.send", botId: MAIN, text: "hello" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    expect(await c.call({ type: "bot.restart", botId: MAIN })).toEqual({ restart: "next-message" });
    expect(lines(join(dir, "start.log"))).toHaveLength(1);
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "again" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    const starts = lines(join(dir, "start.log"));
    expect(starts).toHaveLength(2);
    expect(starts[1].args).toContain("--resume");
    expect((await c.chat()).messages.some((m: any) => m.role === "divider" && m.text === "Restarted → manual restart")).toBe(true);
    const note = lines(join(dir, "input.log")).map((entry) => String(entry.text)).find((text) => text.startsWith("(App: Botling restarted you in this same conversation"));
    expect(note).toContain("current instructions");
    // Once: the turn after has no second restart.
    sent = await c.call({ type: "chat.send", botId: MAIN, text: "third" });
    await until(() => c.of("turn.finished").some((e: any) => e.event.turnId === sent.turnId));
    expect(lines(join(dir, "start.log"))).toHaveLength(2);
  });

  it("asleep: nothing starts now", async () => {
    const dir = tempDir("restart-bot-asleep");
    const c = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, "start.log") });
    harnesses.push(c);
    expect(await c.call({ type: "bot.restart", botId: MAIN })).toEqual({ restart: "asleep" });
    expect(lines(join(dir, "start.log"))).toHaveLength(0);
  });
});

describe("row menu", () => {
  const bot: BotView = { id: "p1", name: "botling", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
  const menu = (lang: string | null) => renderToStaticMarkup(createElement(BotMenu, { bot, at: { x: 0, y: 0 }, onRemove() {}, onClose() {}, pinned: false, onTogglePin() {}, onRestart() {}, lang }));
  it("has Restart bot, in English and Traditional Chinese", () => {
    expect(menu(null)).toContain("Restart bot");
    expect(menu("zh-Hant")).toContain("重新啟動 Bot");
  });
});
