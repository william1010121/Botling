// A Claude bot is told the built-in components only; every other one is reached through a `<card>`, whose worker is given the whole list with each
// usage (component-via-cards, 2026-11-18). Two layers: the knowledge a bot is told (`componentKnowledgeFor`, `knowledgeFull`, `knowledgeChanges`), and a real
// bot (`BotCards`) with a library: what its wake note holds, what a card worker is given, and when the old whole list is still told.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { componentKnowledgeFor, knowledgeChanges, knowledgeFull, VIA_CARDS_NOTE } from "../../src/core/components/library";
import { CARD_BRIEF_MAX, CARD_OTHERS_MAX, cardInstructions, cardSystemPrompt } from "../../src/core/worker-cards";
import { tempDir } from "../helpers";
import { writeLibrary } from "../fixtures/components";

const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";

/** A library of the shape `componentKnowledgeFor` reads: names, one line each, a command for `gitlog`, three built-ins (the tag), the preview card among them. */
function fake(names: string[], builtIn: string[] = ["inline-chart", "inline-report-block", "網頁預覽卡片"]) {
  const first: Record<string, string> = { "inline-chart": "Inline chart", "inline-report-block": "Inline report block", "網頁預覽卡片": "Preview card" };
  return {
    names,
    command: (name: string) => (name === "gitlog" ? "git log" : null),
    summaries: (of: string[]) => names.filter((name) => of.includes(name)).map((name) => `- ${name}: ${first[name] ?? `${name} card`}`).join("\n"),
    pinOnly: () => false,
    builtInNames: () => builtIn,
  };
}
const NAMES = ["inline-chart", "inline-report-block", "網頁預覽卡片", "status", "todo", "gitlog", "eeg-board"];

describe("componentKnowledgeFor with the cards", () => {
  it("lists the built-ins and the preview card only; the bot's own other components and the shelf are left out and counted", () => {
    const k = componentKnowledgeFor(fake(NAMES), ["status", "網頁預覽卡片", "inline-chart", "inline-report-block"], false, true);
    expect(k.own.map((entry) => entry.name)).toEqual(["inline-chart", "inline-report-block", "網頁預覽卡片"]);
    expect(k.others).toEqual([]);
    // status (its own), todo, gitlog, eeg-board (the shelf).
    expect(k.viaCards).toEqual({ hidden: 4 });
  });

  it("only the tag decides what stays in the note: an inline-report-block with no `Built-in: yes` line and an untagged preview card are the card worker's, wherever the bot's list is", () => {
    const names = ["inline-chart", "inline-report-block", "web-preview", "status", "todo"];
    const k = componentKnowledgeFor(fake(names, ["inline-chart"]), ["status"], false, true);
    expect(k.own.map((entry) => entry.name)).toEqual(["inline-chart"]);
    expect(k.viaCards).toEqual({ hidden: 4 });
    // The bot's own list changes nothing of what it is told (its cached front stays put), a tagged one on or off it is the same.
    expect(componentKnowledgeFor(fake(names, ["inline-chart"]), [], false, true)).toEqual(k);
    expect(componentKnowledgeFor(fake(names, ["inline-chart"]), ["status", "todo", "web-preview"], false, true)).toEqual(k);
  });

  it("a head that writes only <card> (cardsOnly) has the inline blocks left out of its note, and no example is promised; one that draws itself keeps both", () => {
    const drawing = componentKnowledgeFor(fake(NAMES), ["status", "網頁預覽卡片", "inline-chart", "inline-report-block"], true, true);
    expect(drawing.examples).toBe(true);
    expect(drawing.own.map((entry) => entry.name)).toEqual(expect.arrayContaining(["inline-chart", "inline-report-block"]));
    // The whole list (the cards switched off) promises examples only to a head whose prompt carries them.
    expect(componentKnowledgeFor(fake(NAMES), ["status"], true, false).examples).toBe(true);
    expect(componentKnowledgeFor(fake(NAMES), ["status"], true, false, true).examples).toBeUndefined();
    const k = componentKnowledgeFor(fake(NAMES), ["status", "網頁預覽卡片", "inline-chart", "inline-report-block"], true, true, true);
    expect(k.own.map((entry) => entry.name)).toEqual(["網頁預覽卡片"]);
    expect(k.viaCards).toEqual({ hidden: 6 });
    expect(k.examples).toBeUndefined();
    expect(knowledgeFull(k)).not.toContain("carry examples for");
    expect(knowledgeFull(k)).not.toContain("- inline-chart");
    expect(knowledgeFull(k)).not.toContain("- inline-report-block");
  });

  it("without the cards it is the whole list, as before", () => {
    const k = componentKnowledgeFor(fake(NAMES), ["status", "網頁預覽卡片", "inline-chart", "inline-report-block"]);
    expect(k.viaCards).toBeUndefined();
    expect(k.own.map((entry) => entry.name)).toEqual(["inline-chart", "inline-report-block", "網頁預覽卡片", "status"]);
    expect(k.others.map((entry) => entry.name)).toEqual(["todo", "gitlog", "eeg-board"]);
  });

  it("the note keeps the show mechanics and the built-in lines, says one line about the rest, and names none of them", () => {
    const text = knowledgeFull(componentKnowledgeFor(fake(NAMES), ["status", "inline-chart", "inline-report-block", "網頁預覽卡片"], false, true));
    expect(text).toContain("(App: Components in the chat, one line each below.");
    expect(text).not.toContain("/ 20 yours");
    expect(text).toContain("<show name=\"name\" command=\"git diff --stat\"></show>");
    expect(text).toContain("\n- inline-chart (JSON): Inline chart");
    expect(text).toContain("\n- 網頁預覽卡片 (JSON): Preview card");
    for (const hidden of ["- status", "- todo", "- gitlog", "- eeg-board", "Also in the shared library"]) expect(text, hidden).not.toContain(hidden);
    expect(text.endsWith(VIA_CARDS_NOTE(4))).toBe(true);
    expect(VIA_CARDS_NOTE(4)).toContain("4 other components in the library are not listed here");
    expect(VIA_CARDS_NOTE(4)).toContain('<card title="…">what to show and where its data is</card>');
    expect(VIA_CARDS_NOTE(0)).toContain("Any other component is not listed here");
  });

  it("is much shorter than the whole list on a big library", () => {
    const many = [...NAMES.slice(0, 3), ...Array.from({ length: 40 }, (_, i) => `component-${i}`)];
    const whole = knowledgeFull(componentKnowledgeFor(fake(many), many.slice(0, 20)));
    const lean = knowledgeFull(componentKnowledgeFor(fake(many), many.slice(0, 20), false, true));
    expect(lean.length).toBeLessThan(whole.length);
    expect(whole.length - lean.length).toBeGreaterThan(30 * 30);
  });
});

describe("knowledgeChanges with the cards", () => {
  const lean = (names: string[], mine: string[]) => componentKnowledgeFor(fake(names), mine, false, true);
  const whole = (names: string[], mine: string[]) => componentKnowledgeFor(fake(names), mine);

  it("a component that is not built in appears, changes or goes: nothing to tell (the bot never heard of it)", () => {
    const told = lean(NAMES, ["status"]);
    expect(knowledgeChanges(lean([...NAMES, "weather"], ["status"]), told)).toBeNull();
    expect(knowledgeChanges(lean(NAMES, ["status", "todo"]), told)).toBeNull();
    expect(knowledgeChanges(lean(NAMES.filter((name) => name !== "todo"), ["status"]), told)).toBeNull();
  });

  it("a bot that went from the whole list to the cards (or back) is told the whole note again, not a diff", () => {
    const toCards = knowledgeChanges(lean(NAMES, ["status"]), whole(NAMES, ["status"]));
    expect(toCards).toBe(knowledgeFull(lean(NAMES, ["status"])));
    const back = knowledgeChanges(whole(NAMES, ["status"]), lean(NAMES, ["status"]));
    expect(back).toBe(knowledgeFull(whole(NAMES, ["status"])));
  });
});

describe("a bot with the cards", () => {
  function bot(settings: Record<string, unknown> | null, folderName = "flux-k8s", library: Record<string, string> | null = null) {
    const dir = tempDir("component-cards");
    const folder = tempDir("component-cards-flux");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeLibrary(dir);
    // The two inline blocks and the preview card are built in by the library's tag.
    const extra: Record<string, string> = library ?? {
      "inline-chart": 'Inline chart: a chart inside the words.\nBuilt-in: yes\nBuilt-in order: 1\nData: {"type": "bar"}',
      "inline-report-block": "Inline report block: a short report inside the words.\nBuilt-in: yes\nBuilt-in order: 2\nData: {}",
      "網頁預覽卡片": "Preview card: a web page.\nBuilt-in: yes\nBuilt-in order: 3\nData: {\"url\": \"http://x\"}",
    };
    for (const [name, about] of Object.entries(extra)) {
      const at = join(dir, "plugins", "ccb-components", "components", name);
      mkdirSync(at, { recursive: true });
      writeFileSync(join(at, "template.html"), "<div></div>");
      writeFileSync(join(at, "about.md"), about);
    }
    // The default (no key) is on; writeLibrary turned it off for the other tests.
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings ?? {}));
    saveProjectRow(dir, { id: FLUX, name: folderName, folder, avatar: "cloud" });
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    const flux = ((core as unknown as { bots: Map<string, Bot> }).bots.get(FLUX)!) as unknown as { setComponentList(names: string[]): void; componentNote(): string; cards: any; options: any; workers: any };
    flux.setComponentList(["status", "todo", "網頁預覽卡片"]);
    return { core, flux, folder, dir };
  }

  it("is told the built-ins and the preview card only: status, todo and gitlog are not in its wake note", async () => {
    const { core, flux } = bot(null);
    try {
      const note = flux.componentNote();
      expect(flux.cards.reachesByCards()).toBe(true);
      expect(note).toContain("(App: Components in the chat, one line each below.");
      expect(note).toContain("- inline-chart (JSON): ");
      expect(note).toContain("- inline-report-block (JSON): ");
      expect(note).toContain("- 網頁預覽卡片 (JSON): ");
      expect(note).not.toContain("- status");
      expect(note).not.toContain("- todo");
      expect(note).not.toContain("- gitlog");
      expect(note).toMatch(/\d+ other components in the library are not listed here\. To show data with one, write <card /);
      // Said once; Maintainer giving it a component is no news to it.
      expect(flux.componentNote()).toBe("");
    } finally { await core.shutdown(); }
  });

  it("settings.json componentsViaCards:false gives it the whole list again, as does a native-workers bot (no card could start)", async () => {
    for (const settings of [{ componentsViaCards: false }, { claudeWorkers: "native" }]) {
      const { core, flux } = bot(settings);
      try {
        expect(flux.cards.reachesByCards()).toBe(false);
        const note = flux.componentNote();
        expect(note).toContain("\n- status (JSON): ");
        expect(note).toContain("\n- todo (JSON): ");
        expect(note).toContain("Also in the shared library");
        expect(note).not.toContain("are not listed here");
      } finally { await core.shutdown(); }
    }
  });

  it("the card worker is given every component of the bot's, its own and the built-in ones, each with its whole usage, and the rest in a line each", async () => {
    const { core, flux, folder } = bot(null);
    try {
      const brief = flux.cards.cardBrief();
      expect(brief.scriptsDir).toBe(join(folder, ".bot", "card-scripts"));
      for (const own of ["- status:", "- todo:", "- inline-chart:", "- inline-report-block:", "- 網頁預覽卡片:"]) expect(brief.components, own).toContain(own);
      // The whole about.md, not its first line.
      expect(brief.components).toContain('Data: {"ok": true}');
      expect(brief.components).toContain('Data: {"items": ["buy milk"]}');
      // The shelf: one line, no usage. `choices` is nobody's to pick.
      expect(brief.others).toContain("- gitlog: Git log card: how many commits there are; More shows one commit.");
      expect(brief.others).not.toContain("Detail command");
      expect(brief.components).not.toContain("- choices:");
      expect(cardInstructions({ title: "Todos", prompt: "Show my todos." })).toContain("Show my todos.");
      const text = cardSystemPrompt(brief);
      expect(text).toContain('Data: {"items": ["buy milk"]}');
      expect(text).toContain(join(folder, ".bot", "card-scripts"));
    } finally { await core.shutdown(); }
  });

  it("the catalog brief gives every usable component one line, even one the whole-usage brief leaves out, and its whole usage as a file the worker reads", async () => {
    const { core, flux, folder } = bot(null);
    try {
      const brief = flux.cards.cardCatalogBrief();
      expect(brief.usageDir).toBe(join(folder, ".bot", "card-usage"));
      expect(brief.others).toBe("");
      // One line each: the bot's own, the built-ins and the shelf (gitlog is nobody's own); `choices` is nobody's to pick.
      for (const line of ["- status (JSON): ", "- todo (JSON): ", "- inline-chart (JSON): ", "- gitlog (command): "]) expect(brief.components, line).toContain(line);
      expect(brief.components).not.toContain("- choices");
      // Lines only: the usage itself is in the file.
      expect(brief.components).not.toContain('Data: {"items": ["buy milk"]}');
      expect(readFileSync(join(brief.usageDir, "todo.md"), "utf8")).toContain('Data: {"items": ["buy milk"]}');
      expect(readFileSync(join(brief.usageDir, "gitlog.md"), "utf8")).toContain("- gitlog: ");
      expect(existsSync(join(brief.usageDir, "choices.md"))).toBe(false);
      const text = cardSystemPrompt(brief);
      expect(text).toContain(`${brief.usageDir}/<name>.md`);
      expect(text).toContain("Components you may use, one line each:");
    } finally { await core.shutdown(); }
  });

  it("a pin-only component has no line and no usage file; a usage folder that cannot be made gives no catalog brief (the caller falls back to the usages up front)", async () => {
    const { core, flux, folder } = bot(null, "flux-pinned", { "inline-chart": "Inline chart.\nBuilt-in: yes\nData: {}", pinned: "A pin.\nPin only: yes\nCommand: echo hi\n", plain: "A plain card.\nData: {}" });
    try {
      const brief = flux.cards.cardCatalogBrief();
      expect(brief.components).toContain("- plain (JSON): ");
      expect(brief.components).not.toContain("pinned");
      expect(existsSync(join(brief.usageDir, "pinned.md"))).toBe(false);
      expect(existsSync(join(brief.usageDir, "plain.md"))).toBe(true);
      // A file where the folder should be: nothing can be written there.
      rmSync(brief.usageDir, { recursive: true });
      writeFileSync(brief.usageDir, "not a folder");
      expect(flux.cards.cardCatalogBrief()).toBeNull();
      const whole = flux.cards.cardBrief();
      expect(`${whole.components}\n${whole.others}`).toContain("- plain");
    } finally { await core.shutdown(); }
  });

  it("a component whose usage is too big for the whole-usage brief (grouped-bar-errorbar, 2026-11-18: no data format in the worker's instructions) is still read in full from its file", async () => {
    const big = `Grouped bars with error bars.\nSizes: 2x2\nData: ${JSON.stringify({ groups: ["a"], series: [{ name: "s", values: [1], err: [0.1] }] })}\n${"filler line of usage\n".repeat(4000)}`;
    const { core, flux } = bot(null, "flux-big", { "grouped-bar-errorbar": big });
    try {
      // Not on the bot's list, and bigger than CARD_BRIEF_MAX: the whole-usage brief gives it a line or nothing at all, never its data format.
      const whole = flux.cards.cardBrief();
      expect(whole.components).not.toContain('"series"');
      const brief = flux.cards.cardCatalogBrief();
      expect(brief.components).toContain("- grouped-bar-errorbar (JSON): Grouped bars with error bars.");
      expect(readFileSync(join(brief.usageDir, "grouped-bar-errorbar.md"), "utf8")).toContain('"series"');
    } finally { await core.shutdown(); }
  });

  it("the usage files follow the library: a changed usage is rewritten, a component that is gone loses its file", async () => {
    const { core, flux, folder } = bot(null, "flux-files", { extra: "Extra card.\nData: {}" });
    try {
      const dir = join(folder, ".bot", "card-usage");
      flux.cards.cardCatalogBrief();
      expect(existsSync(join(dir, "extra.md"))).toBe(true);
      writeFileSync(join(dir, "stale-component.md"), "old");
      writeFileSync(join(dir, "notes.txt"), "not a usage file");
      flux.cards.cardCatalogBrief();
      expect(existsSync(join(dir, "stale-component.md"))).toBe(false);
      expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    } finally { await core.shutdown(); }
  });

  it("the rules a card report is checked against: scripts of the project's .bot/card-scripts, and the components that fill themselves from a Command:", async () => {
    const { core, flux, folder } = bot(null);
    try {
      const rules = flux.cards.cardRules();
      expect(rules).toMatchObject({ scriptsDir: join(folder, ".bot", "card-scripts"), folder });
      expect(rules.hasCommand("gitlog")).toBe(true);
      expect(rules.hasCommand("status")).toBe(false);
    } finally { await core.shutdown(); }
  });
  it("the card rules check a component's JSON against the library's live template: a kind its KINDS lists is known, one it does not list is not, a component with no schema is never checked", async () => {
    const { core, flux, dir } = bot(null);
    try {
      const rules = flux.cards.cardRules();
      const own = join(dir, "plugins", "ccb-components", "components", "inline-chart", "template.html");
      writeFileSync(own, "var MAX = 12, KINDS = ['bars', 'heatmap'];");
      expect(rules.validate!("inline-chart", '{"kind":"heatmap"}')).toBeNull();
      expect(rules.validate!("inline-chart", '{"kind":"targets"}')).toMatch(/kind "targets" is unknown \(bars \/ heatmap\)/);
      // Maintainer adds a kind to the live template: the next report is checked against it, no restart.
      writeFileSync(own, "var MAX = 12, KINDS = ['bars', 'heatmap', 'targets'];");
      expect(rules.validate!("inline-chart", '{"kind":"targets","target":1,"items":[{"label":"a","median":1,"p90":2}]}')).toBeNull();
      expect(rules.validate!("not-in-the-library", "{not json")).toBeNull();
    } finally { await core.shutdown(); }
  });
  it("the library with only inline-chart tagged (inline-report-block without the Built-in tag, the preview card named web-preview): the tag decides, so only inline-chart is built in; the other two are no bot's own until they are tagged or on its list", async () => {
    const shipped = {
      "inline-chart": 'Inline chart: a chart inside the words.\nBuilt-in: yes\nData: {"type": "bar"}',
      "inline-report-block": "Inline report block: a short report inside the words.\nData: {}",
      "web-preview": "Web preview card: a page.\nData: {\"path\": \"/x.html\"}",
    };
    const { core, flux } = bot(null, "flux-k8s", shipped);
    try {
      flux.setComponentList(["status"]);
      const note = flux.componentNote();
      expect(note).toContain("- inline-chart (JSON): ");
      for (const left of ["- inline-report-block", "- web-preview", "- status"]) expect(note, left).not.toContain(left);
      const brief = flux.cards.cardBrief();
      for (const name of ["inline-chart", "status"]) expect(brief.components, name).toContain(`- ${name}:`);
      // The untagged ones are the shelf: a line, no usage up front.
      expect(brief.others).toContain("- inline-report-block");
      expect(flux.workers.componentUsage({ name: "inline-chart" }, "coordinator")).toMatchObject({ yours: true });
      for (const name of ["inline-report-block", "web-preview", "todo"]) expect(flux.workers.componentUsage({ name }, "coordinator")).toMatchObject({ yours: false });
    } finally { await core.shutdown(); }
  });

  it("a big library: the worker's usage is cut between components, never inside one; what did not fit is listed in a line", async () => {
    const lib: Record<string, string> = { "inline-chart": "Inline chart: c.\nBuilt-in: yes\nData: {}" };
    for (let i = 0; i < 5; i++) lib[`big-${i}`] = `Big ${i}: a card.\n${"x".repeat(25_000)}\nEND-big-${i}`;
    const { core, flux } = bot(null, "flux-k8s", lib);
    try {
      flux.setComponentList(["big-0", "big-1", "big-2", "big-3", "big-4"]);
      const brief = flux.cards.cardBrief();
      expect(brief.components.length).toBeLessThanOrEqual(CARD_BRIEF_MAX);
      const whole = [0, 1, 2, 3, 4].filter((i) => brief.components.includes(`- big-${i}:`));
      expect(whole.length).toBeGreaterThan(0);
      expect(whole.length).toBeLessThan(5);
      for (const i of whole) expect(brief.components, `big-${i} whole`).toContain(`END-big-${i}`);
      for (const i of [0, 1, 2, 3, 4].filter((index) => !whole.includes(index))) { expect(brief.others).toContain(`- big-${i}: Big ${i}: a card.`); expect(brief.components).not.toContain(`END-big-${i}`); }
      expect(brief.components).toContain("- inline-chart:");
      // The instructions are not cut again: the whole components went in as they were.
      expect(cardSystemPrompt(brief)).not.toContain("…cut");
    } finally { await core.shutdown(); }
  });
  it("the one-line list of the rest of the library has its own limit; the lines beyond it are counted", async () => {
    const lib: Record<string, string> = { "inline-chart": "Inline chart: c.\nBuilt-in: yes\nData: {}" };
    for (let i = 0; i < 300; i++) lib[`shelf-${i}`] = `Shelf ${i}: ${"y".repeat(100)}\nData: {}`;
    const { core, flux } = bot(null, "flux-k8s", lib);
    try {
      const brief = flux.cards.cardBrief();
      expect(brief.others.length).toBeLessThanOrEqual(CARD_OTHERS_MAX + 100);
      expect(brief.others).toMatch(/\(…and \d+ more components in the library\)$/);
      expect(brief.others).toContain("- shelf-0:");
    } finally { await core.shutdown(); }
  });
});
