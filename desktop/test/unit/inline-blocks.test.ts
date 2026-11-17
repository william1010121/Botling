// Inline report blocks in the chat (2026-11-17): the built-in component every bot has (off every list and every limit), the guidance
// and the "by size" report rule that go first to the bots settings.json `inlineBlockGuidance` names, and the examples they carry.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../reports/cli";
import { BotCards } from "../../src/core/bot/cards";
import { ALWAYS_COMPONENTS, COMPONENT_LIMIT, ComponentLibrary, componentKnowledgeFor, countedComponents, knowledgeChanges, knowledgeFull } from "../../src/core/components/library";
import { INLINE_BLOCK_GUIDANCE, REPORT_RULE_ALL_TO_PAGE, REPORT_RULE_BY_SIZE, inlineBlocksFor } from "../../src/core/inline-blocks";
import { MaintainerDesk } from "../../src/core/maintainer";
import { launchSettings } from "../../src/core/settings";
import { botPrompts, desktopPrompts, type ReportTool } from "../../src/core/prompts";
import { REPORT_SECTION, reportSections } from "../report-section";
import { tempDir } from "../helpers";

const cardsFolder = new URL("../../builtin-plugins/botling.cards/components", import.meta.url).pathname;
const tool: ReportTool = { command: "report-cmd", docs: "/x/report-blocks.md" };
const profile = (role: "main" | "manager" | "bot" = "manager") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: null });
const folder = () => realpathSync(mkdtempSync(join(tmpdir(), "inline-blocks-")));

describe("settings.json inlineBlockGuidance: who gets the guidance", () => {
  it("by default only the Botling source project (a folder with desktop/src/core/prompts.ts)", () => {
    const source = folder(), other = folder();
    mkdirSync(join(source, "desktop", "src", "core"), { recursive: true });
    writeFileSync(join(source, "desktop", "src", "core", "prompts.ts"), "");
    expect(inlineBlocksFor(undefined, source)).toBe(true);
    expect(inlineBlocksFor({}, source)).toBe(true);
    expect(inlineBlocksFor({}, other)).toBe(false);
    expect(inlineBlocksFor({}, null)).toBe(false);
    // A malformed value is the default, not "all".
    expect(inlineBlocksFor({ inlineBlockGuidance: 7 }, other)).toBe(false);
    expect(inlineBlocksFor({ inlineBlockGuidance: { all: true } }, other)).toBe(false);
  });
  it('"all" opens it to every bot, "off" to none (even the source project)', () => {
    const source = folder();
    mkdirSync(join(source, "desktop", "src", "core"), { recursive: true });
    writeFileSync(join(source, "desktop", "src", "core", "prompts.ts"), "");
    expect(inlineBlocksFor({ inlineBlockGuidance: "all" }, folder())).toBe(true);
    expect(inlineBlocksFor({ inlineBlockGuidance: "all" }, null)).toBe(true);
    expect(inlineBlocksFor({ inlineBlockGuidance: "off" }, source)).toBe(false);
  });
  it("a list names project folders by real path: a symlink, a trailing slash and a not-yet-existing subfolder all fold", () => {
    const a = folder(), b = folder(), link = join(folder(), "link");
    symlinkSync(a, link);
    const list = { inlineBlockGuidance: [a, "", 3] };
    expect(inlineBlocksFor(list, a)).toBe(true);
    expect(inlineBlocksFor(list, `${a}/`)).toBe(true);
    expect(inlineBlocksFor(list, link)).toBe(true);
    expect(inlineBlocksFor(list, b)).toBe(false);
    expect(inlineBlocksFor({ inlineBlockGuidance: [link] }, a)).toBe(true);
    expect(inlineBlocksFor({ inlineBlockGuidance: [join(a, "not", "yet")] }, join(link, "not", "yet"))).toBe(true);
    // The nearest existing ancestor can be "/" itself: the first letter of the missing part must survive (it was cut once).
    expect(inlineBlocksFor({ inlineBlockGuidance: ["/inline-blocks-missing-top/x"] }, "/inline-blocks-missing-top/x")).toBe(true);
    expect(inlineBlocksFor({ inlineBlockGuidance: ["/inline-blocks-missing-top/x"] }, "/nline-blocks-missing-top/x")).toBe(false);
    expect(inlineBlocksFor({ inlineBlockGuidance: ["/inline-blocks-missing-top/x"] }, "/oline-blocks-missing-top/x")).toBe(false);
    // An empty or blank entry names nothing (resolve("") is the working folder: it must not match a bot that sits there).
    expect(inlineBlocksFor({ inlineBlockGuidance: ["", "   "] }, process.cwd())).toBe(false);
    // A list does not fall back to the default: the source project is in only when it is named.
    expect(inlineBlocksFor({ inlineBlockGuidance: [] }, a)).toBe(false);
  });
});

describe("the guidance in the prompt", () => {
  const withIt = (engine: "claude" | "codex" | "agy", role: "main" | "manager" | "bot" = "manager") => botPrompts({ profile: profile(role), engine, inlineBlocks: true }).system;
  const without = (engine: "claude" | "codex" | "agy" = "claude") => botPrompts({ profile: profile(), engine }).system;

  it("is told to a bot that has it: the rule, no request needed, and the results list without comparisons", () => {
    for (const engine of ["claude", "codex"] as const) for (const role of ["main", "manager", "bot"] as const) {
      const text = withIt(engine, role);
      expect(text).toContain(INLINE_BLOCK_GUIDANCE);
      expect(text).toContain("yours to use, no request needed");
      expect(text).toContain("A block is not a sentence");
      expect(text).toContain("More than 3 blocks");
      expect(text).toContain("you need no usage lookup");
      // The main bot's results rule is its own line (it hands work over), without the list.
      if (role !== "main") {
        expect(text).toContain("Results meant for the user (reports, screenshots, previews)");
        expect(text).not.toContain("(reports, comparisons, screenshots, previews)");
      }
      expect(text).toContain("every bot has it, and no request to Maintainer is needed");
      expect(text).toContain("is not a request either: it is yours to use");
      // Components still belong to Maintainer otherwise.
      expect(text).toContain('belong to "Maintainer"');
    }
  });
  it("is told to nobody else: the prompt is byte for byte what it was", () => {
    for (const engine of ["claude", "codex", "agy"] as const) {
      const text = botPrompts({ profile: profile(), engine }).system;
      expect(text).not.toContain("Inline blocks");
      expect(text).not.toContain("inline-report-block");
      expect(botPrompts({ profile: profile(), engine, inlineBlocks: false }).system).toBe(text);
    }
    expect(without()).toContain("(reports, comparisons, screenshots, previews)");
  });
  it("Antigravity draws no components: even asked for, it gets neither the guidance nor the shorter list", () => {
    expect(withIt("agy")).toBe(without("agy"));
  });
  it("sits in the cacheable, stable part: the same for any profile name, memory or folder, and about 550 tokens", () => {
    const a = botPrompts({ profile: profile("bot"), inlineBlocks: true }).system;
    const b = botPrompts({ profile: { ...profile("bot"), name: "Other", folder: "/somewhere/else" }, inlineBlocks: true }).system;
    expect(a).toContain(INLINE_BLOCK_GUIDANCE);
    expect(b).toContain(INLINE_BLOCK_GUIDANCE);
    expect(INLINE_BLOCK_GUIDANCE.length).toBeLessThan(2100);
  });
  it("carries five examples, each a one-line block the report command accepts", () => {
    const blocks = INLINE_BLOCK_GUIDANCE.split("\n").slice(1).map((line) => JSON.parse(/: (\{.*\})$/.exec(line)![1]!));
    expect(blocks.map((block) => block.type)).toEqual(["kpi", "progress", "options", "steps", "flowchart"]);
    for (const block of blocks) expect(typeof block.title).toBe("string");
    const dir = tempDir("inline-examples");
    const file = join(dir, "spec.json");
    writeFileSync(file, JSON.stringify({ version: 2, lang: "zh-Hant", kind: "explainer", title: "範例檢查", asOf: "2026-11-17", tldr: "範例區塊檢查。", sections: [{ title: "範例", takeaway: "五個範例都能畫", blocks }], asks: [] }));
    let out = "";
    const code = runCli(["--check", file], { stdout: (text) => { out += text; }, stderr: (text) => { out += text; } });
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, errors: [] });
    expect(code).toBe(0);
  });
});

describe("the report rule by size", () => {
  const manifestText = REPORT_SECTION.text;
  const page = (inlineBlocks: boolean, engine: "claude" | "codex" | "agy" = "claude", role: "main" | "manager" | "bot" = "manager") =>
    desktopPrompts(botPrompts({ profile: profile(role), engine, inlineBlocks }), profile(role), engine, true, reportSections(tool), undefined, inlineBlocks);

  it("the manifest still says the sentence the swap replaces (change the swap with the manifest, never one of them)", () => {
    expect(manifestText).toContain(`- ${REPORT_RULE_ALL_TO_PAGE}`);
    expect(REPORT_RULE_BY_SIZE).toMatch(/ONE inline report block/);
    // Default is inline, a page is the exception (the user, 2026-11-17: "報告只有在真的很長的時候才要開，或者是我特別要求下").
    expect(REPORT_RULE_BY_SIZE).toMatch(/^Default is inline; a report page is the exception\./);
    expect(REPORT_RULE_BY_SIZE).toMatch(/report page ONLY when the content is really long \(more than 3 blocks, a data figure \(matplotlib\) or a long read\) or the user explicitly asks for a report or a page/);
    expect(REPORT_RULE_BY_SIZE).toMatch(/anything else stays in chat/);
    expect(INLINE_BLOCK_GUIDANCE).toMatch(/Default is inline: a report page is the exception, only for really long content \(more than 3 blocks, .*or a long read\) or when the user explicitly asks for a report or a page/);
    expect(INLINE_BLOCK_GUIDANCE).toMatch(/everything else stays in chat/);
  });
  it("a bot with the guidance is told by size; the rest of the page rule is untouched", () => {
    const text = page(true).system;
    expect(text).toContain(REPORT_RULE_BY_SIZE);
    expect(text).not.toContain(REPORT_RULE_ALL_TO_PAGE);
    expect(text).toContain("Build every report page (status, decision, investigation, comparison, plan, results, explainer) from a ReportSpec v2 JSON");
    expect(text).toContain("opens with one sentence that answers the user's question");
  });
  it("any other bot keeps the whole rule, and Codex workers (who only build pages) keep it too", () => {
    expect(page(false).system).toContain(REPORT_RULE_ALL_TO_PAGE);
    expect(page(false).system).not.toContain(REPORT_RULE_BY_SIZE);
    for (const role of ["main", "manager", "bot"] as const) {
      expect(page(true, "claude", role).codexWorkerSystem).toContain(REPORT_RULE_ALL_TO_PAGE);
      expect(page(true, "claude", role).codexWorkerSystem).not.toContain(REPORT_RULE_BY_SIZE);
      expect(page(true, "claude", role).system).toContain(REPORT_RULE_BY_SIZE);
    }
  });
  it("Antigravity keeps the whole rule (no inline blocks there), whatever it is asked for", () => {
    expect(page(true, "agy").system).toContain(REPORT_RULE_ALL_TO_PAGE);
    expect(page(true, "agy").system).not.toContain(REPORT_RULE_BY_SIZE);
  });
  it("a plugin that rewrote the sentence is not half-edited: no match, no change", () => {
    const rewritten = [{ plugin: "botling.report", ...REPORT_SECTION, text: manifestText.replace("settled result", "finished result"), tool }];
    const text = desktopPrompts(botPrompts({ profile: profile(), inlineBlocks: true }), profile(), "claude", true, rewritten as never, undefined, true).system;
    expect(text).toContain("finished result that needs visuals");
    expect(text).not.toContain(REPORT_RULE_BY_SIZE);
  });
});

describe("the built-in component every bot has", () => {
  const folderOf = join(cardsFolder, "inline-report-block");
  it("ships with botling.cards (template and about), in the library, a JSON component with a one-line summary", () => {
    expect(ALWAYS_COMPONENTS).toEqual(["inline-report-block"]);
    expect(readFileSync(join(folderOf, "template.html"), "utf8")).toContain("ccb-kit");
    const lib = new ComponentLibrary(() => [cardsFolder]);
    expect(lib.names).toContain("inline-report-block");
    expect(lib.pinOnly("inline-report-block")).toBe(false);
    const line = lib.summaries(["inline-report-block"]);
    expect(line.length).toBeLessThan(400);
    expect(line).toContain('<show name="inline-report-block">');
    expect(readFileSync(join(folderOf, "about.md"), "utf8")).toContain("## Data format (window.ccb.data)");
  });

  function lib() {
    const root = join(tempDir("always"), "components");
    for (const name of ["table", "clock", "inline-report-block", ...Array.from({ length: 24 }, (_, i) => `c${i}`)]) {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "template.html"), `<p>${name}</p>`);
      writeFileSync(join(root, name, "about.md"), `${name} component.\nData: rows`);
    }
    return new ComponentLibrary(() => [root]);
  }
  function cards(list: string[] | null) {
    const library = lib();
    const saved: unknown[] = [];
    const owner: any = { profile: { folder: "/work/site" }, readOnly: false, store: { saveSetting: (_key: string, value: unknown) => { saved.push(value); } } };
    const host: any = { readOnly: false, records: [], updated() {} };
    const ctx: any = { options: { components: { library } }, id: "bot-1", owner, peers: [], store: owner.store };
    const bot = new BotCards(host, ctx);
    owner.cards = bot;
    bot.componentList = list;
    return { bot, library, saved };
  }

  it("is every bot's, on no list: a bot with a list, an empty list or none is told it as its own", () => {
    for (const list of [["table"], [], null]) {
      const { bot } = cards(list);
      expect(bot.ownComponents()).toContain("inline-report-block");
      const note = bot.componentNote();
      expect(note).toContain("- inline-report-block (JSON): ");
      // Not in the shared shelf (the "not yours yet" part), where the others are.
      expect(note.split("not yours yet")[1] ?? "").not.toContain("inline-report-block");
      expect(note).toContain("not yours yet");
    }
  });
  it("is not counted: 1 / 20 with one of its own, and Maintainer's limit is about the others", () => {
    const { bot } = cards(["table"]);
    expect(bot.componentNote()).toContain("Components in the chat: 1 / 20 yours");
    const full = cards(Array.from({ length: COMPONENT_LIMIT }, (_, i) => `c${i}`));
    expect(full.bot.ownComponents()).toHaveLength(COMPONENT_LIMIT + 1);
    expect(full.bot.componentNote()).toContain("Components in the chat: 20 / 20 yours");
    expect(countedComponents(["a", "inline-report-block", "b"])).toEqual(["a", "b"]);
  });
  it("is never added to a list by drawing it, and does not use up a place when the list is full", () => {
    const { bot, saved } = cards(["table"]);
    bot.drewComponents(["inline-report-block", "clock"]);
    expect(bot.componentList).toEqual(["table", "clock"]);
    expect(saved.at(-1)).toEqual(["table", "clock"]);
    const full = cards(Array.from({ length: COMPONENT_LIMIT - 1 }, (_, i) => `c${i}`));
    full.bot.drewComponents(["inline-report-block", "clock", "table"]);
    expect(full.bot.componentList).toContain("clock");
    expect(full.bot.componentList).not.toContain("table");
    expect(full.bot.componentList).not.toContain("inline-report-block");
  });
  it("the Note's insert menu and the pin picker offer it", () => {
    const { bot } = cards(["table"]);
    expect(bot.noteComponents()!.components.find((entry) => entry.name === "inline-report-block")).toMatchObject({ offered: true });
    expect(bot.cardLibrary()!.offered).toContain("inline-report-block");
  });
  it("Maintainer: giving it is a yes that changes nothing, and it takes no place from the 20", () => {
    const library = lib();
    let list: string[] = Array.from({ length: COMPONENT_LIMIT }, (_, i) => `c${i}`);
    const bot = {
      id: "bot-1", profile: { name: "Main bot" },
      get components() { return list; },
      get ownComponentNames() { return library.names.filter((name) => list.includes(name) || ALWAYS_COMPONENTS.includes(name)); },
      lastAsked: "", setComponentList(names: string[]) { list = names; }, queueNote() {}, appMessage() {}, appNotice() { return "n"; },
    } as never;
    const desk = new MaintainerDesk({ root: tempDir("always-desk"), maintainer: () => ({ queueNote() {} }) as never, mainBot: () => bot, bots: () => [bot], library, plugins: () => null, log: () => {} });
    expect(desk.giveComponent("inline-report-block", bot)).toBe(true);
    expect(list).toHaveLength(COMPONENT_LIMIT);
    expect(list).not.toContain("inline-report-block");
    // With a place left (19 of its own) a 20th is given, though its own list also holds the always-yours one (that is not counted).
    list = Array.from({ length: COMPONENT_LIMIT - 1 }, (_, i) => `c${i}`);
    expect(desk.giveComponent("table", bot)).toBe(true);
    expect(list).toContain("table");
    list = Array.from({ length: COMPONENT_LIMIT }, (_, i) => `c${i}`);
    // The 21st of the bot's own is still refused, and says 20 / 20 (not 21).
    expect(desk.giveComponent("table", bot)).toBe(false);
    expect(desk.askNote("table", "add it", true, bot)).toContain("already has 20 / 20 components");
  });
});

describe("settings.json inlineBlockGuidance reaches the bots' launch settings", () => {
  it("as written (a string or a list), and absent when it is not there", () => {
    expect(launchSettings({ inlineBlockGuidance: "all" } as never).inlineBlockGuidance).toBe("all");
    expect(launchSettings({ inlineBlockGuidance: ["/a"] } as never).inlineBlockGuidance).toEqual(["/a"]);
    expect(launchSettings({} as never).inlineBlockGuidance).toBeUndefined();
  });
});

describe("the component lines", () => {
  const names = ["table", "inline-report-block"];
  const library = { names, command: () => null, summaries: (of: string[]) => `- ${of[0]}: first line`, pinOnly: () => false };
  it("count only the bot's own against the limit", () => {
    const k = componentKnowledgeFor(library, ["table", "inline-report-block"]);
    expect(knowledgeFull(k)).toContain("Components in the chat: 1 / 20 yours");
    const told = componentKnowledgeFor(library, ["table"]);
    expect(knowledgeChanges(k, told)).toContain("You have 1 / 20.");
  });
  it("say a lookup is not needed for examples the instructions carry, only to a bot that has them", () => {
    const sentence = "a component your instructions already carry examples for (the inline blocks rule) needs no lookup";
    expect(knowledgeFull(componentKnowledgeFor(library, ["table"], true))).toContain(sentence);
    expect(knowledgeFull(componentKnowledgeFor(library, ["table"]))).not.toContain("needs no lookup");
    expect(knowledgeFull(componentKnowledgeFor(library, ["table"], false))).toBe(knowledgeFull(componentKnowledgeFor(library, ["table"])));
  });
  it("a bot's note follows settings.json inlineBlockGuidance (launch) and its project folder", () => {
    const make = (guidance: unknown, folder: string) => {
      const lib = new ComponentLibrary(() => [cardsFolder]);
      const owner: any = { profile: { folder }, readOnly: false, store: { saveSetting() {} } };
      const host: any = { readOnly: false, records: [], updated() {} };
      const ctx: any = { options: { components: { library: lib }, launch: () => ({ subagentHourCache: false, inlineBlockGuidance: guidance }) }, id: "bot-1", owner, peers: [], store: owner.store };
      const bot = new BotCards(host, ctx);
      owner.cards = bot;
      bot.componentList = [];
      return bot.componentNote();
    };
    const here = folder();
    expect(make("all", here)).toContain("needs no lookup");
    expect(make([here], here)).toContain("needs no lookup");
    expect(make(undefined, here)).not.toContain("needs no lookup");
    expect(make("off", here)).not.toContain("needs no lookup");
    expect(make([folder()], here)).not.toContain("needs no lookup");
  });
});
