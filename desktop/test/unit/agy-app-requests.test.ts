// The main bot on its Antigravity head asks the app for a project or a bot of its own (<new-project>, <new-bot>):
// the app does them itself (server.ts projectRequests), no Claude worker or plugin behind them, so the head may use
// them. Component and plugin requests stay refused there (they set Maintainer, a Claude bot, to work).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { Bot } from "../../src/core/bot";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { Layout } from "../../src/core/store/workspace";
import { tempDir, until } from "../helpers";

const opened: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of opened.splice(0)) await core.shutdown(); });

function open() {
  const dir = tempDir("agy-requests");
  mkdirSync(Layout.mainBot(dir), { recursive: true });
  writeFileSync(join(Layout.mainBot(dir), "bot.json"), JSON.stringify({ engine: "agy", heads: { engines: ["agy"] } }));
  // A new bot is sent its setup turn: no head runs here.
  vi.spyOn(Bot.prototype, "appMessage").mockImplementation(() => "turn");
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  opened.push(core);
  const main: Bot = (core as any).bots.get(MAIN_BOT_ID);
  expect(main.engine).toBe("agy");
  const texts = (role: string) => ((main as any).records as { role: string; text: string }[]).filter((r) => r.role === role).map((r) => r.text);
  return { core, main, texts };
}

describe("an Antigravity main bot's app requests", () => {
  it("<new-project folder> asks on a card instead of saying it cannot", async () => {
    const { main, texts } = open();
    const folder = join(tempDir("agy-project"), "痛點收集");
    mkdirSync(folder, { recursive: true });
    (main as any).showAppReply(`I'll add it.\n<new-project folder="${folder}"/>`);
    expect(texts("notice").join("\n")).not.toMatch(/cannot do this yet/);
    const card = await until(() => (main as any).records.find((r: any) => r.text.startsWith("Add **痛點收集** as a project?")), { what: "the card" });
    expect(card.choices.map((choice: any) => choice.label)).toEqual(["Add as project", "Don't add"]);
  });

  it("<new-bot> makes the bot instead of saying it cannot", async () => {
    const { core, main, texts } = open();
    (main as any).showAppReply(`Created Reader.\n<new-bot name="Reader">Coaches the user's reading every evening at 21:00.</new-bot>`);
    expect(texts("notice").join("\n")).not.toMatch(/cannot do this yet/);
    await until(() => core.snapshot().bots.find((bot) => bot.name === "Reader"), { what: "the new bot" });
  });

  it("a component or plugin request still says it cannot (Maintainer is a Claude bot)", () => {
    const { main, texts } = open();
    (main as any).showAppReply(`Asked.\n<component name="flag">make it red</component>\n<plugin>a timer</plugin>`);
    expect(texts("notice").join("\n")).toMatch(/cannot do this yet, so nothing happened: a component change \("flag"\); a change to Botling \(a plugin\)/);
  });
});
