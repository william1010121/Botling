// A Claude bot is told the built-in components only; every other one is reached through a `<card>`, whose worker is given the whole list with each
// usage (component-via-cards, 2026-11-18). Two layers: the knowledge a bot is told (`componentKnowledgeFor`, `knowledgeFull`, `knowledgeChanges`), and a real
// bot (`BotCards`) with a library: what its wake note holds, what a card worker is given, and when the old whole list is still told.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { componentKnowledgeFor, knowledgeChanges, knowledgeFull, VIA_CARDS_NOTE } from "../../src/core/components/library";
import { cardInstructions } from "../../src/core/worker-cards";
import { tempDir } from "../helpers";
import { writeLibrary } from "../fixtures/components";

const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";

/** A library of the shape `componentKnowledgeFor` reads: names, one line each, a command for `gitlog`, two built-ins and the preview card. */
function fake(names: string[]) {
  const first: Record<string, string> = { "inline-chart": "Inline chart", "inline-report-block": "Inline report block", "網頁預覽卡片": "Preview card" };
  return {
    names,
    command: (name: string) => (name === "gitlog" ? "git log" : null),
    summaries: (of: string[]) => names.filter((name) => of.includes(name)).map((name) => `- ${name}: ${first[name] ?? `${name} card`}`).join("\n"),
    pinOnly: () => false,
    builtInNames: () => ["inline-chart", "inline-report-block"],
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
  function bot(settings: Record<string, unknown> | null, folderName = "flux-k8s") {
    const dir = tempDir("component-cards");
    const folder = tempDir("component-cards-flux");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeLibrary(dir);
    // The two inline blocks are built in (the library's tag), the preview card is the app's own built-in.
    const extra: Record<string, string> = {
      "inline-chart": 'Inline chart: a chart inside the words.\nBuilt-in: yes\nBuilt-in order: 1\nData: {"type": "bar"}',
      "inline-report-block": "Inline report block: a short report inside the words.\nBuilt-in: yes\nBuilt-in order: 2\nData: {}",
      "網頁預覽卡片": "Preview card: a web page.\nData: {\"url\": \"http://x\"}",
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
    const flux = ((core as unknown as { bots: Map<string, Bot> }).bots.get(FLUX)!) as unknown as { setComponentList(names: string[]): void; componentNote(): string; cards: any; options: any };
    flux.setComponentList(["status", "todo", "網頁預覽卡片"]);
    return { core, flux, folder };
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
      const text = cardInstructions({ title: "Todos", prompt: "Show my todos." }, brief);
      expect(text).toContain("Show my todos.");
      expect(text).toContain('Data: {"items": ["buy milk"]}');
      expect(text).toContain(join(folder, ".bot", "card-scripts"));
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
});
