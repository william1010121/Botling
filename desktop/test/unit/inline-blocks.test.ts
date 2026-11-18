// Inline report blocks and charts in the chat (2026-11-17): the built-in components every bot has (the `Built-in: yes` tag of an about.md; off every
// list and every limit), the guidance and the "by size" report rule that go first to the bots settings.json `inlineBlockGuidance` names, and the
// examples they carry. The tag is Maintainer's switch: nothing in the app names a built-in, and a tag change never rewrites a bot's cached front.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error jsdom ships without .d.ts
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { runCli } from "../../reports/cli";
import { BotCards } from "../../src/core/bot/cards";
import { COMPONENT_LIMIT, ComponentLibrary, builtInTag, componentKnowledgeFor, countedComponents, knowledgeChanges, knowledgeFull } from "../../src/core/components/library";
import { INLINE_BLOCK_GUIDANCE, INLINE_HANDOFF_SENTENCE, RESULTS_LIST, RESULTS_LIST_INLINE, REPORT_RULE_ALL_TO_PAGE, REPORT_RULE_BY_SIZE, inlineBlocksFor } from "../../src/core/inline-blocks";
import { MaintainerDesk } from "../../src/core/maintainer";
import { pluginGuideFiles } from "../../src/core/plugin-guide-text";
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
      expect(text).toContain("a report page is made only when the user explicitly asks for a report or a page, or after you asked in the chat and they agreed");
      // The no-lookup sentence covers only the shown examples; any other kind or type is looked up first (2026-11-18: a bot guessed a waterfall as `items`).
      expect(text).toContain("the examples below need no usage lookup");
      expect(text).toContain("for any other kind or type call app_component_usage first");
      expect(text).not.toContain("so you need no usage lookup");
      // The main bot's results rule is its own line (it hands work over), without the list.
      if (role !== "main") {
        // Inline is the default and comes first; a page is for screenshots, previews or a page the user asks for (or agrees to after the bot asks in the chat); never for length.
        expect(text).toContain(`${RESULTS_LIST_INLINE} go into one `);
        // The wording itself, not only the constant by value (review mutants M7, M9 survived): inline by default, and what still goes to a page.
        expect(RESULTS_LIST_INLINE).toContain("go inline in the chat by default");
        for (const page of ["screenshots", "previews", "pages the user asks for", "agrees to after you ask in the chat"]) expect(RESULTS_LIST_INLINE).toContain(page);
        expect(RESULTS_LIST_INLINE).not.toMatch(/long/);
        expect(text).not.toContain(RESULTS_LIST);
      }
      expect(text).toContain("every bot has them, and no request to Maintainer is needed to show one");
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
    expect(without()).toContain(RESULTS_LIST);
  });
  it("Antigravity draws no components: even asked for, it gets neither the guidance nor the shorter list", () => {
    expect(withIt("agy")).toBe(without("agy"));
  });
  it("sits in the cacheable, stable part: the same for any profile name, memory or folder, and about 800 tokens (the chart rule, 2026-11-18, replaced the old chart sentence at about +55; one example per chart kind, +~160)", () => {
    const a = botPrompts({ profile: profile("bot"), inlineBlocks: true }).system;
    const b = botPrompts({ profile: { ...profile("bot"), name: "Other", folder: "/somewhere/else" }, inlineBlocks: true }).system;
    expect(a).toContain(INLINE_BLOCK_GUIDANCE);
    expect(b).toContain(INLINE_BLOCK_GUIDANCE);
    expect(INLINE_BLOCK_GUIDANCE.length).toBeLessThan(3400);
  });
  /** The example lines of the guidance: `label: {json}`, one block each. */
  const examples = () => INLINE_BLOCK_GUIDANCE.split("\n").slice(1).map((line) => ({ line, json: JSON.parse(/: (\{.*\})$/.exec(line)![1]!) }));
  /** Draws a chart with inline-chart's own template (the real validator and drawer) in jsdom: what the chat would show. */
  function drawChart(chart: unknown) {
    const html = readFileSync(join(cardsFolder, "inline-chart", "template.html"), "utf8");
    const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
      runScripts: "dangerously",
      beforeParse(window: unknown) { (window as unknown as { ccb: unknown }).ccb = { data: JSON.stringify(chart), setStatus() {}, onData() {} }; },
    });
    const root = dom.window.document.getElementById("root")!;
    const result = { error: root.querySelector(".err")?.textContent ?? null, drawn: root.querySelector(".ch") !== null };
    dom.window.close();
    return result;
  }

  it("carries one example per kind it names: five report blocks and four inline-chart kinds (bars, waterfall, dumbbell, line), each a one-line block its drawer accepts", () => {
    const all = examples().map((entry) => entry.json);
    // A report block has a `type`, an inline-chart a `kind`.
    expect(all.map((block) => block.type ?? block.kind)).toEqual(["kpi", "progress", "options", "steps", "bars", "waterfall", "dumbbell", "line", "flowchart"]);
    for (const block of all) expect(typeof block.title).toBe("string");
    const blocks = all.filter((block) => block.type !== undefined);
    const charts = all.filter((block) => block.kind !== undefined);
    expect(blocks).toHaveLength(5);
    expect(charts).toHaveLength(4);
    // The guidance names exactly the kinds it gives an example for (a kind named without one is guessed: waterfall `items` instead of `steps`, 2026-11-18).
    const named = /\(kind ([a-z, ]+?) or ([a-z]+)\)/.exec(INLINE_BLOCK_GUIDANCE)!;
    expect([...named[1]!.split(", "), named[2]!].sort()).toEqual(charts.map((chart) => chart.kind).sort());
    // Each chart follows inline-chart's about.md (a known kind) and is drawn by its real template without the error card.
    const about = readFileSync(join(cardsFolder, "inline-chart", "about.md"), "utf8");
    for (const chart of charts) {
      expect(about).toContain(`\`${chart.kind}\``);
      const drawn = drawChart(chart);
      expect(drawn.error, `${chart.kind}: ${drawn.error}`).toBeNull();
      expect(drawn.drawn, chart.kind).toBe(true);
    }
    // The field each kind needs (the one a bot got wrong): bars `items`, waterfall `steps`, dumbbell `rows`, line `x` + `series`.
    const byKind = (kind: string) => charts.find((chart) => chart.kind === kind)!;
    expect(Array.isArray(byKind("bars").items)).toBe(true);
    expect(Array.isArray(byKind("waterfall").steps)).toBe(true);
    expect(Array.isArray(byKind("dumbbell").rows)).toBe(true);
    expect(Array.isArray(byKind("line").x) && Array.isArray(byKind("line").series)).toBe(true);
    // The base of the bars example is one of its items.
    expect(byKind("bars").items.map((item: { label: string }) => item.label)).toContain(byKind("bars").base);
    // The five report blocks pass the report command's own check.
    const dir = tempDir("inline-examples");
    const file = join(dir, "spec.json");
    writeFileSync(file, JSON.stringify({ version: 2, lang: "zh-Hant", kind: "explainer", title: "範例檢查", asOf: "2026-11-17", tldr: "範例區塊檢查。", sections: [{ title: "範例", takeaway: "五個範例都能畫", blocks }], asks: [] }));
    let out = "";
    const code = runCli(["--check", file], { stdout: (text) => { out += text; }, stderr: (text) => { out += text; } });
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toMatchObject({ ok: true, errors: [] });
    expect(code).toBe(0);
  });
  it("the drawer check has teeth: a waterfall written with `items` (what a bot guessed) draws the error card", () => {
    const wrong = drawChart({ kind: "waterfall", title: "x", items: [{ label: "a", value: 1 }] });
    expect(wrong.error).toContain("必須是陣列");
    expect(wrong.error).toContain("steps");
    expect(wrong.drawn).toBe(false);
  });
  it("chart rule: decide what the figure must show first, inline-chart only if it shows that clearly, else a matplotlib PNG shown inline; never a page for a chart", () => {
    expect(INLINE_BLOCK_GUIDANCE).toContain('<show name="inline-chart">{chart}</show>');
    expect(INLINE_BLOCK_GUIDANCE).toContain("Charts: first decide what the figure must show (groups side by side, time axis, error bars, measured vs estimated).");
    expect(INLINE_BLOCK_GUIDANCE).toContain("(kind bars, dumbbell, waterfall or line) only if it shows that clearly; otherwise draw it with Python matplotlib as a PNG shown with ![caption](file://full path)");
    expect(INLINE_BLOCK_GUIDANCE).toContain("read-only in .bot/card-scripts/<name>/ when numbers need gathering; never a page for a chart");
    expect(INLINE_BLOCK_GUIDANCE).not.toContain("a few numbers never need a page");
    // It no longer sends a data chart to a page.
    expect(INLINE_BLOCK_GUIDANCE).not.toMatch(/a data chart \(matplotlib figure\)/);
    expect(REPORT_RULE_BY_SIZE).not.toMatch(/a data figure/);
    expect(REPORT_RULE_BY_SIZE).toContain("a chart into ONE inline chart (inline-chart) or a matplotlib PNG shown inline (the chart rule)");
  });
});

describe("the report rule by size", () => {
  const manifestText = REPORT_SECTION.text;
  const page = (inlineBlocks: boolean, engine: "claude" | "codex" | "agy" = "claude", role: "main" | "manager" | "bot" = "manager") =>
    desktopPrompts(botPrompts({ profile: profile(role), engine, inlineBlocks }), profile(role), engine, true, reportSections(tool), undefined, inlineBlocks);

  it("the manifest still says the sentence the swap replaces (change the swap with the manifest, never one of them)", () => {
    expect(manifestText).toContain(`- ${REPORT_RULE_ALL_TO_PAGE}`);
    expect(REPORT_RULE_BY_SIZE).toMatch(/ONE inline report block/);
    // A page only on the user's ask, or after the bot asked in chat and they agreed (the user, 2026-11-18: "我覺得只有我強制要求要報告。或著是你需要強制的在對話裡面問我要報告並且經過我同意之後才可用"); no length trigger.
    expect(REPORT_RULE_BY_SIZE).toMatch(/^Default is inline; a report page is made only when asked\./);
    expect(REPORT_RULE_BY_SIZE).toMatch(/Make a report page ONLY when the user explicitly asks for a report or a page, or after you asked in the chat \("Do you want this as a report page\?"\) and the user agreed; never on your own, however long the content is/);
    expect(REPORT_RULE_BY_SIZE).toMatch(/long content goes in as several blocks or as text/);
    expect(REPORT_RULE_ALL_TO_PAGE).toMatch(/^A report page is made ONLY when the user explicitly asks for a report or a page, or after you asked in the chat/);
    for (const rule of [REPORT_RULE_BY_SIZE, REPORT_RULE_ALL_TO_PAGE, INLINE_BLOCK_GUIDANCE, INLINE_HANDOFF_SENTENCE, RESULTS_LIST, RESULTS_LIST_INLINE]) {
      expect(rule).not.toMatch(/really long|more than 3 blocks|long read|page is the exception/);
    }
    expect(INLINE_BLOCK_GUIDANCE).toMatch(/Default is inline: a report page is made only when the user explicitly asks for a report or a page, or after you asked in the chat and they agreed \(link only\); long content goes in as several blocks or as text/);
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

describe("what a worker hands back (inline first)", () => {
  const told = (inlineBlocks: boolean, role: "main" | "manager" | "bot" = "manager", engine: "claude" | "codex" | "agy" = "claude", delegation: string | null = null) =>
    desktopPrompts(botPrompts({ profile: profile(role), engine, inlineBlocks }), { ...profile(role), delegation }, engine, true, reportSections(tool), undefined, inlineBlocks).system;
  it("a bot with the guidance tells its workers to hand back the data and a re-runnable script path (never component JSON; the head shows it with a <card>), a page only on request or after the bot asked and the user agreed", () => {
    for (const role of ["manager", "bot"] as const) {
      const text = told(true, role);
      expect(text).toContain(INLINE_HANDOFF_SENTENCE);
      expect(INLINE_HANDOFF_SENTENCE).toMatch(/hands back the data \(numbers or rows, concise\) plus the path of a re-runnable read-only script/);
      expect(INLINE_HANDOFF_SENTENCE).toMatch(/never component JSON; you show it with a <card>/);
      expect(INLINE_HANDOFF_SENTENCE).not.toMatch(/ready-to-paste|inline-chart|inline-report-block/);
      expect(INLINE_HANDOFF_SENTENCE).toContain(".bot/card-scripts/<name>/");
      expect(INLINE_HANDOFF_SENTENCE).toMatch(/A page only if the user asked or agreed when the bot asked/);
      // It ends the Claude workers line (its own line of the prompt), after what is already there.
      expect(text.split("\n").find((line) => line.startsWith("- Hand all real work"))?.endsWith(` ${INLINE_HANDOFF_SENTENCE}`)).toBe(true);
    }
  });
  it("is told to nobody else: no guidance, the main bot, Codex, Antigravity and an onRequest bot get the prompt as it was", () => {
    expect(told(false)).not.toContain("A worker hands back");
    expect(told(true, "main")).not.toContain("A worker hands back");
    expect(told(true, "manager", "codex")).not.toContain("A worker hands back");
    expect(told(true, "manager", "agy")).not.toContain("A worker hands back");
    expect(told(true, "manager", "claude", "onRequest")).not.toContain("A worker hands back");
  });
  it("is about 70 tokens (about 320 characters)", () => {
    expect(INLINE_HANDOFF_SENTENCE.length).toBeLessThan(330);
  });
});

describe("the built-in components every bot has", () => {
  const folderOf = join(cardsFolder, "inline-report-block");
  it("botling.cards ships inline-chart and inline-report-block with the built-in tag (and nothing else); the chart is the user's folder copy plus that one line", () => {
    const lib = new ComponentLibrary(() => [cardsFolder]);
    expect(lib.builtInNames()).toEqual(["inline-chart", "inline-report-block"]);
    expect(lib.builtIn("網頁預覽卡片")).toBe(false);
    for (const name of ["inline-chart", "inline-report-block"]) {
      expect(readFileSync(join(cardsFolder, name, "template.html"), "utf8")).toContain("ccb-kit");
      expect(lib.pinOnly(name)).toBe(false);
      expect(lib.summaries([name])).toContain(`<show name="${name}">`);
      expect(lib.summaries([name]).length).toBeLessThan(400);
    }
    expect(readFileSync(join(cardsFolder, "inline-chart", "about.md"), "utf8")).toContain("## Data format (window.ccb.data)");
  });
  it("ships with botling.cards (template and about), in the library, a JSON component with a one-line summary", () => {
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
      // Only inline-report-block carries the tag: the library, not a list in the app, says which components are built-in.
      writeFileSync(join(root, name, "about.md"), `${name} component.\nData: rows${name === "inline-report-block" ? "\nBuilt-in: yes" : ""}`);
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
    expect(countedComponents(["a", "inline-report-block", "b"], ["inline-report-block"])).toEqual(["a", "b"]);
    expect(countedComponents(["a", "inline-report-block", "b"], [])).toEqual(["a", "inline-report-block", "b"]);
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
  it("one that sits on the list as well (put there before it was tagged) is not counted when drawing adds a component", () => {
    const { bot } = cards([...Array.from({ length: COMPONENT_LIMIT - 1 }, (_, i) => `c${i}`), "inline-report-block"]);
    bot.drewComponents(["clock"]);
    expect(bot.componentList).toContain("clock");
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
      get ownComponentNames() { return library.names.filter((name) => list.includes(name) || library.builtIn(name)); },
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
  const library = { names, command: () => null, summaries: (of: string[]) => `- ${of[0]}: first line`, pinOnly: () => false, builtInNames: () => ["inline-report-block"] };
  it("count only the bot's own against the limit", () => {
    const k = componentKnowledgeFor(library, ["table", "inline-report-block"]);
    expect(knowledgeFull(k)).toContain("Components in the chat: 1 / 20 yours");
    const told = componentKnowledgeFor(library, ["table"]);
    expect(knowledgeChanges(k, told)).toContain("You have 1 / 20.");
  });
  it("say a lookup is not needed for examples the instructions carry, only to a bot that has them", () => {
    const sentence = "a component your instructions already carry examples for (the inline blocks rule) needs no lookup";
    expect(knowledgeFull(componentKnowledgeFor(library, ["table"], true))).toContain(sentence);
    // Only the kinds and types the examples show: any other is looked up first (2026-11-18: a bot guessed a waterfall's fields).
    expect(knowledgeFull(componentKnowledgeFor(library, ["table"], true))).toContain("for any other kind or type call app_component_usage first");
    expect(knowledgeFull(componentKnowledgeFor(library, ["table"], true))).not.toContain("the examples are enough");
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

describe("the built-in tag: Maintainer decides, not the app", () => {
  let tick = 0;
  /** A component folder whose about.md is `about`; every write moves its mtime so `rescan` sees the change. */
  const put = (root: string, name: string, about: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "template.html"), `<p>${name}</p>`);
    const file = join(root, name, "about.md");
    writeFileSync(file, about);
    const at = new Date(Date.now() + ++tick * 5_000);
    utimesSync(file, at, at);
  };
  const newRoot = (label: string) => join(tempDir(label), "components");

  it("builtInTag reads `Built-in: yes` (yes / true / on / 1, any case) and an optional whole-number `Built-in order:`", () => {
    expect(builtInTag("Chart card.\nBuilt-in: yes")).toEqual({ order: 0 });
    expect(builtInTag("Chart card.\n- Built-in: `Yes`\n- Built-in order: 7")).toEqual({ order: 7 });
    expect(builtInTag("Chart card.\nbuilt-in: true\nBuilt-in order: -2")).toEqual({ order: -2 });
    for (const word of ["on", "1"]) expect(builtInTag(`X.\nBuilt-in: ${word}`)).toEqual({ order: 0 });
    // A bad order is the default place, not a refusal of the tag.
    expect(builtInTag("X.\nBuilt-in: yes\nBuilt-in order: first")).toEqual({ order: 0 });
    expect(builtInTag("X.\nBuilt-in: yes\nBuilt-in order: 1.5")).toEqual({ order: 0 });
    // No tag, a no, or only the order line (it is not the tag), a name that merely mentions it: not built-in.
    expect(builtInTag("X.\nBuilt-in order: 3")).toBeNull();
    expect(builtInTag("X.\nBuilt-in: no")).toBeNull();
    expect(builtInTag("X.\nBuilt-in:")).toBeNull();
    expect(builtInTag("Every bot has it, built-in: yes, in the summary line only")).toBeNull();
    expect(builtInTag("")).toBeNull();
    // A pin-only status card (a Command, only the pin strip offers it) is never a bot's.
    expect(builtInTag("X.\nPin only: yes\nCommand: date\nBuilt-in: yes")).toBeNull();
  });

  it("the library derives the built-ins from the tag, in the plugin library as in a built-in plugin, placed by order then name", () => {
    const own = newRoot("tag-own"), shipped = newRoot("tag-shipped");
    put(shipped, "inline-chart", "Chart.\nBuilt-in: yes");
    put(shipped, "plain", "Plain.");
    put(own, "zeta", "Z.\nBuilt-in: yes\nBuilt-in order: 5");
    put(own, "alpha", "A.\nBuilt-in: yes\nBuilt-in order: 5");
    put(own, "first", "F.\nBuilt-in: yes\nBuilt-in order: -1");
    put(own, "status", "S.\nPin only: yes\nCommand: date\nBuilt-in: yes");
    put(own, "off", "O.\nBuilt-in: no");
    const lib = new ComponentLibrary(() => [own, shipped]);
    expect(lib.builtInNames()).toEqual(["first", "inline-chart", "alpha", "zeta"]);
    expect(lib.builtIn("inline-chart")).toBe(true);
    for (const name of ["plain", "off", "status", "missing"]) expect(lib.builtIn(name)).toBe(false);
    // Nothing is built-in without the tag: a library with no tag has none.
    const bare = newRoot("tag-bare");
    put(bare, "inline-report-block", "Report block.");
    expect(new ComponentLibrary(() => [bare]).builtInNames()).toEqual([]);
  });

  it("built-ins with the same order are placed by name, whichever was tagged first", () => {
    const root = newRoot("tag-tie");
    put(root, "zeta", "Z.\nBuilt-in: yes");
    put(root, "alpha", "A.");
    const lib = new ComponentLibrary(() => [root]);
    expect(lib.builtInNames()).toEqual(["zeta"]);
    put(root, "alpha", "A.\nBuilt-in: yes");
    expect(lib.rescan()).toBe(true);
    expect(lib.builtInNames()).toEqual(["alpha", "zeta"]);
  });

  it("the copy that wins decides: a plugin-library copy without the line untags the shipped one, removing it tags it again; both reach the bots through rescan", () => {
    const own = newRoot("tag-shadow"), shipped = newRoot("tag-shadow-built");
    put(shipped, "inline-chart", "Chart.\nBuilt-in: yes");
    const lib = new ComponentLibrary(() => [own, shipped]);
    expect(lib.builtIn("inline-chart")).toBe(true);
    put(own, "inline-chart", "Chart, Maintainer's own copy, not tagged.");
    expect(lib.rescan()).toBe(true);
    expect(lib.builtIn("inline-chart")).toBe(false);
    expect(lib.builtInNames()).toEqual([]);
    put(own, "inline-chart", "Chart, Maintainer's own copy.\nBuilt-in: yes\nBuilt-in order: 2");
    expect(lib.rescan()).toBe(true);
    expect(lib.builtInNames()).toEqual(["inline-chart"]);
    expect(lib.rescan()).toBe(false);
    // The shadow goes away: the shipped copy wins again, tagged (its about.md is another file, so what bots are told changed).
    rmSync(join(own, "inline-chart"), { recursive: true });
    expect(lib.rescan()).toBe(true);
    expect(lib.builtInNames()).toEqual(["inline-chart"]);
    // A component that goes away is no longer built-in, and is read again when it comes back, even with an about.md of the very same mtime.
    const kept = statSync(join(shipped, "inline-chart", "about.md")).mtime;
    rmSync(join(shipped, "inline-chart"), { recursive: true });
    expect(lib.rescan()).toBe(true);
    expect(lib.builtInNames()).toEqual([]);
    put(shipped, "inline-chart", "Chart.\nBuilt-in: yes");
    utimesSync(join(shipped, "inline-chart", "about.md"), kept, kept);
    expect(lib.rescan()).toBe(true);
    expect(lib.builtInNames()).toEqual(["inline-chart"]);
  });

  it("Maintainer's plugin guide says how to tag one, and that bots hear of a change in their next message", () => {
    const guide = pluginGuideFiles()["reference/components.md"];
    expect(guide).toContain("A `Built-in: yes` line (optional `Built-in order: 3`, lowest first)");
    expect(guide).toContain("bots hear of either in their next message");
  });

  it("a bot's component lines put the built-ins first in their order, the rest in the library's order, and count only the rest", () => {
    const root = newRoot("tag-lines");
    for (const name of ["a-own", "b-own", "late", "early"]) put(root, name, `${name} card.\n${name === "late" ? "Built-in: yes\nBuilt-in order: 9" : name === "early" ? "Built-in: yes\nBuilt-in order: 1" : ""}`);
    const lib = new ComponentLibrary(() => [root]);
    const k = componentKnowledgeFor(lib, ["a-own", "b-own", "late", "early"]);
    expect(k.own.map((entry) => entry.name)).toEqual(["early", "late", "a-own", "b-own"]);
    expect(k.builtIn).toEqual(["early", "late"]);
    expect(knowledgeFull(k)).toContain("Components in the chat: 2 / 20 yours");
    // Without a built-in the knowledge is what it always was (no `builtIn` field).
    expect(componentKnowledgeFor(new ComponentLibrary(() => [newRoot("tag-none")]), []).builtIn).toBeUndefined();
  });

  describe("cache: a tag change mid-session never rewrites what a bot was told first", () => {
    function session() {
      const root = newRoot("tag-session");
      put(root, "table", "Table card.");
      put(root, "chart", "Chart card.\nData: numbers");
      const library = new ComponentLibrary(() => [root]);
      const owner: any = { profile: { folder: "/work/site" }, readOnly: false, store: { saveSetting() {} } };
      const host: any = { readOnly: false, records: [], updated() {} };
      const ctx: any = { options: { components: { library } }, id: "bot-1", owner, peers: [], store: owner.store };
      const bot = new BotCards(host, ctx);
      owner.cards = bot;
      bot.componentList = ["table"];
      return { root, library, bot };
    }
    /** What the app does when Maintainer edits a component: the scan sees it, the bot's next message is marked. */
    const maintainerEdits = (library: ComponentLibrary, bot: BotCards) => { expect(library.rescan()).toBe(true); bot.componentsChanged(); };

    it("tagging mid-session reaches the bot as one appended 'what changed' note, untagging as another; the full list comes only with the next fresh session", () => {
      const { root, library, bot } = session();
      const first = bot.componentNote();
      expect(first).toContain("Components in the chat: 1 / 20 yours");
      expect(first).toContain("- table (JSON): ");
      expect(first.split("not yours yet")[1]).toContain("- chart: ");
      expect(bot.componentNote()).toBe("");

      put(root, "chart", "Chart card.\nData: numbers\nBuilt-in: yes");
      maintainerEdits(library, bot);
      const tagged = bot.componentNote();
      expect(tagged).toMatch(/^\(App: Components were updated; only what changed since you were last told, the rest is as before\. You have 1 \/ 20\.\)\nNew on your list:\n- chart \(JSON\): /);
      // Not the whole briefing again, and not a repeat of what it knew.
      expect(tagged).not.toContain("Components in the chat:");
      expect(tagged).not.toContain("- table");
      expect(bot.componentNote()).toBe("");

      put(root, "chart", "Chart card.\nData: numbers");
      maintainerEdits(library, bot);
      const untagged = bot.componentNote();
      expect(untagged).toContain("No longer yours (still in the shared library; ask Maintainer to get one back):\n- chart: ");
      expect(untagged).not.toContain("Components in the chat:");

      // Tagged again, then its next fresh session (a new briefing, as at a wake or a changed prompt): the whole list, with the tag as it is now.
      put(root, "chart", "Chart card.\nData: numbers\nBuilt-in: yes");
      maintainerEdits(library, bot);
      bot.forgetBriefed();
      const fresh = bot.componentNote();
      expect(fresh).toContain("Components in the chat: 1 / 20 yours");
      expect(fresh).toContain("- chart (JSON): ");
      expect(fresh).not.toContain("Components were updated");
    });

    it("a component tagged before the session is in its first note, as its own and not on the shelf; a later untag only appends", () => {
      const { root, library, bot } = session();
      put(root, "chart", "Chart card.\nBuilt-in: yes");
      library.rescan();
      const first = bot.componentNote();
      expect(first).toContain("- chart (JSON): ");
      expect(first.split("not yours yet")[1] ?? "").not.toContain("chart");
      put(root, "chart", "Chart card.");
      maintainerEdits(library, bot);
      const later = bot.componentNote();
      expect(later).toContain("No longer yours");
      expect(later).not.toContain("Components in the chat:");
      expect(bot.briefedComponents!.own.map((entry) => entry.name)).toEqual(["table"]);
    });

    it("no system prompt reads the library, so a tag cannot reach one (claude would start a new session when its prompt changes)", () => {
      const src = (file: string) => readFileSync(new URL(`../../src/core/${file}`, import.meta.url), "utf8");
      for (const file of ["prompts.ts", "inline-blocks.ts"]) expect(src(file), file).not.toMatch(/from "\.\/components\//);
    });
  });
});
