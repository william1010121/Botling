// A head removes one of its own sub bots when the user asks (`<remove-sub-bot name="…"/>`), the same way the UI's
// "Close sub bot" does; another bot's sub bot or an unknown name is refused out loud.
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { Bot, streamingText } from "../../src/core/bot";
import { parseReply, unsupportedRequest } from "../../src/core/reply";
import { botPrompts, desktopPrompts, subBotRule, workerSubBotRule } from "../../src/core/prompts";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const OTHER = "98BDBF26-850C-4521-AEB4-CCF9073E8BD1";
const SUB = "A1B2C3D4-0000-4000-8000-000000000001";
const OTHER_SUB = "A1B2C3D4-0000-4000-8000-000000000002";

function fixture() {
  const dir = tempDir("remove-sub-bot");
  const folder = tempDir("remove-sub-bot-project");
  const otherFolder = tempDir("remove-sub-bot-other");
  for (const f of [folder, otherFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: PROJECT, name: "swordgale", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: OTHER, name: "other", folder: otherFolder, avatar: "triangle" });
  saveProjectRow(dir, { id: SUB, name: "Data fetch", folder, avatar: "triangle", job: "Fetch the data", parent: PROJECT, createdAt: 1_700_000_000_000 });
  saveProjectRow(dir, { id: OTHER_SUB, name: "Elsewhere", folder: otherFolder, avatar: "triangle", job: "Other job", parent: OTHER, createdAt: 1_700_000_000_000 });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { dir, folder, core };
}
const bots = (core: Core): Map<string, Bot> => (core as any).bots;

describe("the <remove-sub-bot> tag", () => {
  it("is read outside code and never shows in the chat", () => {
    const parsed = parseReply('Removed it.\n<remove-sub-bot name="Data fetch"/>');
    expect(parsed.body).toBe("Removed it.");
    expect(parsed.requests).toEqual([{ kind: "removeSubBot", name: "Data fetch" }]);
    expect(parseReply("<remove-sub-bot name='Data fetch'></remove-sub-bot>").requests).toEqual([{ kind: "removeSubBot", name: "Data fetch" }]);
    expect(parseReply('`<remove-sub-bot name="A"/>`').requests).toEqual([]);
    expect(parseReply('<remove-sub-bot name=" "/>').requests).toEqual([]);
    expect(streamingText('Removing.\n<remove-sub-bot name="Da')).toBe("Removing.");
    expect(unsupportedRequest({ kind: "removeSubBot", name: "A" })).toMatch(/sub bot/);
  });
});

describe("a head's <remove-sub-bot>", () => {
  async function ask(core: Core, botId: string, name: string) {
    const bot = bots(core).get(botId)!;
    const notices: string[] = [];
    vi.spyOn(bot, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as any);
    vi.spyOn(bot, "queueNote").mockImplementation(() => {});
    await (core as any).removeSubBotRequested(bot, { name });
    return notices;
  }

  it("removes its own sub bot as the UI's Close does, keeping its files, and says so in the chat", async () => {
    const h = fixture();
    try {
      const close = vi.spyOn(h.core, "closeSubBot");
      const notices = await ask(h.core, PROJECT, "data FETCH");
      expect(close).toHaveBeenCalledWith(SUB);
      expect(bots(h.core).has(SUB)).toBe(false);
      expect(h.core.snapshot().bots.some((bot) => bot.id === SUB)).toBe(false);
      expect(notices.join("\n")).toContain('Closed the sub bot "Data fetch"');
      expect(existsSync(join(h.folder, ".bot"))).toBe(true);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("refuses another bot's sub bot and an unknown name, out loud", async () => {
    const h = fixture();
    try {
      const notices = await ask(h.core, PROJECT, "Elsewhere");
      expect(bots(h.core).has(OTHER_SUB)).toBe(true);
      expect(notices.join("\n")).toContain('No sub bot was removed: you have no sub bot named "Elsewhere"');
      vi.restoreAllMocks();
      const unknown = await ask(h.core, PROJECT, "Nope");
      expect(unknown.join("\n")).toContain('No sub bot was removed: you have no sub bot named "Nope"');
      expect(bots(h.core).has(SUB)).toBe(true);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("is acted on when it comes in a reply's requests", async () => {
    const h = fixture();
    try {
      const bot = bots(h.core).get(PROJECT)!;
      vi.spyOn(bot, "appNotice").mockImplementation((() => "n") as any);
      vi.spyOn(bot, "queueNote").mockImplementation(() => {});
      const left = (h.core as any).projectRequests(bot, parseReply('<remove-sub-bot name="Data fetch"/>').requests);
      expect(left).toEqual([]);
      await vi.waitFor(() => expect(bots(h.core).has(SUB)).toBe(false));
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});

describe("the head instructions", () => {
  it.each([["subBotRule", subBotRule], ["workerSubBotRule", workerSubBotRule]])("%s says how to remove one of its sub bots, only when asked", (_n, rule) => {
    expect(rule).toContain('<remove-sub-bot name="');
    expect(rule).toMatch(/only when the user asks/i);
  });
  it.each(["claude", "codex", "agy"] as const)("a %s project bot is told", (engine) => {
    const p = { id: "manager-id", name: "P", role: "manager" as const, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };
    const prompts = botPrompts({ profile: p, engine, heads: null, language: "en", workingFolder: null });
    for (const workers of [true, false]) expect(desktopPrompts(prompts, p, engine, workers).system).toContain("<remove-sub-bot name=");
  });
});
