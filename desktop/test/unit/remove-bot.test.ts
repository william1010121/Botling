// A bot removes a project or bot from Botling when the user asks (`<remove-bot name="…" path="…"/>`). It is
// destructive, so the app first shows a card; only "Remove" does what the left column's Remove does (the bot leaves
// the list and stops; nothing on disk is deleted). Itself, the main bot, Maintainer, unknown and ambiguous names are refused.
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { Bot, streamingText } from "../../src/core/bot";
import { parseReply, unsupportedRequest } from "../../src/core/reply";
import { botPrompts, desktopPrompts, subBotRule, workerSubBotRule, REMOVE_BOT_RULE } from "../../src/core/prompts";
import { saveProjectRow } from "../../src/core/projects";
import { MAINTAINER_ID } from "../../src/core/maintainer";
import { tempDir } from "../helpers";

import { MAIN_BOT_ID } from "../../src/core/store/records";
const ASKER = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const LOWER = "98BDBF26-850C-4521-AEB4-CCF9073E8BD1";
const UPPER = "98BDBF26-850C-4521-AEB4-CCF9073E8BD2";
const SUB = "A1B2C3D4-0000-4000-8000-000000000001";

function fixture() {
  const dir = tempDir("remove-bot");
  const asker = tempDir("remove-bot-asker");
  const lower = tempDir("remove-bot-dafaji");
  const upper = tempDir("remove-bot-DaFaJi");
  for (const f of [asker, lower, upper]) { mkdirSync(join(f, ".bot"), { recursive: true }); writeFileSync(join(f, "keep.txt"), "x"); }
  saveProjectRow(dir, { id: ASKER, name: "swordgale", folder: asker, avatar: "triangle" });
  saveProjectRow(dir, { id: LOWER, name: "dafaji", folder: lower, avatar: "triangle" });
  saveProjectRow(dir, { id: UPPER, name: "DaFaJi", folder: upper, avatar: "triangle" });
  saveProjectRow(dir, { id: SUB, name: "Data fetch", folder: asker, avatar: "triangle", job: "Fetch", parent: ASKER, createdAt: 1_700_000_000_000 });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { dir, asker, lower, upper, core };
}
const bots = (core: Core): Map<string, Bot> => (core as any).bots;

/** Asks as `botId`; the cards and notices that bot's chat shows, and the notes queued for its head. */
function ask(core: Core, botId: string, request: { name: string; path?: string }) {
  const bot = bots(core).get(botId)!;
  const notices: { text: string; choices?: { label: string }[]; pick?: (index: number) => void }[] = [];
  const notes: string[] = [];
  vi.spyOn(bot, "appNotice").mockImplementation(((text: string, choices?: { label: string }[], pick?: (index: number) => void) => { notices.push({ text, choices, pick }); return `n${notices.length}`; }) as any);
  vi.spyOn(bot, "queueNote").mockImplementation((note: string) => { notes.push(note); });
  (core as any).removeBotRequested(bot, request);
  return { notices, notes };
}

describe("the <remove-bot> tag", () => {
  it("is read outside code, with or without a path, and never shows in the chat", () => {
    const parsed = parseReply('Asked the app.\n<remove-bot name="DaFaJi" path="~/Project/DaFaJi"/>');
    expect(parsed.body).toBe("Asked the app.");
    expect(parsed.requests).toEqual([{ kind: "removeBot", name: "DaFaJi", path: "~/Project/DaFaJi" }]);
    expect(parseReply("<remove-bot name='dafaji'></remove-bot>").requests).toEqual([{ kind: "removeBot", name: "dafaji" }]);
    expect(parseReply('<remove-bot path="/a" name="x"/>').requests).toEqual([{ kind: "removeBot", name: "x", path: "/a" }]);
    expect(parseReply('`<remove-bot name="A"/>`').requests).toEqual([]);
    expect(parseReply('```\n<remove-bot name="A"/>\n```').requests).toEqual([]);
    expect(parseReply('<remove-bot name=" "/>').requests).toEqual([]);
    expect(parseReply('<remove-sub-bot name="A"/>').requests).toEqual([{ kind: "removeSubBot", name: "A" }]);
    expect(streamingText('Removing.\n<remove-bot name="Da')).toBe("Removing.");
    expect(unsupportedRequest({ kind: "removeBot", name: "A" })).toMatch(/removing/);
  });
});

describe("a bot's <remove-bot>", () => {
  it("shows a card first and removes nothing until the user confirms; then it is the left column's Remove (files kept)", async () => {
    const h = fixture();
    try {
      const remove = vi.spyOn(h.core, "removeBot");
      const { notices, notes } = ask(h.core, MAIN_BOT_ID, { name: "DaFaJi", path: h.upper });
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain("DaFaJi");
      expect(notices[0]!.text).toContain(h.upper);
      expect(notices[0]!.choices!.map((c) => c.label)).toEqual(["Remove project", "Keep"]);
      expect(notes.join("\n")).toMatch(/Nothing is removed until/);
      expect(remove).not.toHaveBeenCalled();
      expect(bots(h.core).has(UPPER)).toBe(true);
      notices[0]!.pick!(0);
      await vi.waitFor(() => expect(bots(h.core).has(UPPER)).toBe(false));
      expect(remove).toHaveBeenCalledWith(UPPER);
      expect(bots(h.core).has(LOWER)).toBe(true);
      expect(h.core.snapshot().bots.some((bot) => bot.id === UPPER)).toBe(false);
      expect(existsSync(join(h.upper, "keep.txt"))).toBe(true);
      expect(existsSync(join(h.upper, ".bot"))).toBe(true);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("keeps the bot when the user picks Keep, and says so to the head", async () => {
    const h = fixture();
    try {
      const remove = vi.spyOn(h.core, "removeBot");
      const { notices, notes } = ask(h.core, ASKER, { name: "dafaji", path: h.lower });
      notices[0]!.pick!(1);
      expect(remove).not.toHaveBeenCalled();
      expect(bots(h.core).has(LOWER)).toBe(true);
      expect(notes.join("\n")).toMatch(/chose to keep/);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a project bot may ask too, and its sub bots go with the removed bot as with the menu", async () => {
    const h = fixture();
    try {
      const { notices } = ask(h.core, LOWER, { name: "swordgale" });
      notices[0]!.pick!(0);
      await vi.waitFor(() => expect(bots(h.core).has(ASKER)).toBe(false));
      expect(bots(h.core).has(SUB)).toBe(false);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("tells same-named bots apart by path, and refuses when the name alone is ambiguous", async () => {
    const h = fixture();
    try {
      const amb = ask(h.core, MAIN_BOT_ID, { name: "dafaji" });
      expect(amb.notices[0]!.choices).toBeUndefined();
      expect(amb.notices[0]!.text).toMatch(/No bot was removed: .*more than one/);
      expect(amb.notes.join("\n")).toContain(h.lower);
      expect(amb.notes.join("\n")).toContain(h.upper);
      vi.restoreAllMocks();
      const one = ask(h.core, MAIN_BOT_ID, { name: "dafaji", path: `${h.lower}/` });
      expect(one.notices[0]!.text).toContain(h.lower);
      expect(one.notices[0]!.choices).toBeDefined();
      vi.restoreAllMocks();
      const wrong = ask(h.core, MAIN_BOT_ID, { name: "dafaji", path: "/nowhere" });
      expect(wrong.notices[0]!.text).toMatch(/No bot was removed/);
      expect(wrong.notices[0]!.choices).toBeUndefined();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("refuses itself, the main bot, Maintainer, its own parent, a sub bot and an unknown name, with no card", async () => {
    const h = fixture();
    try {
      const remove = vi.spyOn(h.core, "removeBot");
      const cases: [string, { name: string; path?: string }][] = [
        [ASKER, { name: "swordgale" }],
        [ASKER, { name: bots(h.core).get(MAIN_BOT_ID)!.profile.name }],
        [MAIN_BOT_ID, { name: bots(h.core).get(MAIN_BOT_ID)!.profile.name }],
        [ASKER, { name: bots(h.core).get(MAINTAINER_ID)!.profile.name }],
        [SUB, { name: "swordgale" }],
        [MAIN_BOT_ID, { name: "Data fetch" }],
        [MAIN_BOT_ID, { name: "Nope" }],
      ];
      for (const [asker, request] of cases) {
        const { notices, notes } = ask(h.core, asker, request);
        expect(notices).toHaveLength(1);
        expect(notices[0]!.choices).toBeUndefined();
        expect(notices[0]!.text).toMatch(/^No bot was removed/);
        expect(notes.join("\n")).toMatch(/No bot was removed/);
        vi.restoreAllMocks();
      }
      expect(remove).not.toHaveBeenCalled();
      for (const id of [ASKER, MAIN_BOT_ID, MAINTAINER_ID, SUB]) expect(bots(h.core).has(id)).toBe(true);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("does nothing on a late confirm when the bot is already gone", async () => {
    const h = fixture();
    try {
      const { notices } = ask(h.core, MAIN_BOT_ID, { name: "DaFaJi", path: h.upper });
      await h.core.removeBot(UPPER);
      const remove = vi.spyOn(h.core, "removeBot");
      notices[0]!.pick!(0);
      expect(remove).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("is acted on when it comes in a reply's requests, as a card", async () => {
    const h = fixture();
    try {
      const bot = bots(h.core).get(MAIN_BOT_ID)!;
      const cards: string[] = [];
      vi.spyOn(bot, "appNotice").mockImplementation(((text: string) => { cards.push(text); return "n"; }) as any);
      vi.spyOn(bot, "queueNote").mockImplementation(() => {});
      const left = (h.core as any).projectRequests(bot, parseReply(`<remove-bot name="DaFaJi" path="${h.upper}"/>`).requests);
      expect(left).toEqual([]);
      await vi.waitFor(() => expect(cards.some((text) => text.includes("DaFaJi"))).toBe(true));
      expect(bots(h.core).has(UPPER)).toBe(true);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});

describe("the instructions", () => {
  it("say how to remove a bot, only when the user asks, never in code", () => {
    expect(REMOVE_BOT_RULE).toContain('<remove-bot name="');
    expect(REMOVE_BOT_RULE).toContain('path="');
    expect(REMOVE_BOT_RULE).toMatch(/only when the user asks/i);
    expect(REMOVE_BOT_RULE).toMatch(/never write the tag inside code or examples/i);
    for (const rule of [subBotRule, workerSubBotRule]) expect(rule).toContain(REMOVE_BOT_RULE);
  });
  it.each(["claude", "codex", "agy"] as const)("a %s main bot and project bot are told, and the main bot no longer sends the user to right-click to remove", (engine) => {
    for (const role of ["main", "manager"] as const) {
      const p = { id: `${role}-id`, name: "P", role, folder: "/p/repo", memoryPath: ".bot/memory.md", job: null, instructions: "X" };
      const prompts = botPrompts({ profile: p, engine, heads: null, language: "en", workingFolder: null });
      for (const workers of [true, false]) {
        const system = desktopPrompts(prompts, p, engine, workers).system;
        expect(system).toContain("<remove-bot name=");
        expect(system).not.toMatch(/To remove or rename a bot, tell the user to right-click/);
      }
    }
  });
});
