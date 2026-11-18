// Invariants 4 and 5 (codex-invariant-review-5e1d656.md):
//  4. Which components are built in, and where they go, is decided by the `Built-in: yes` / `Built-in order:` tag of the winning about.md and nothing
//     else: one projection (`componentRoles`) is read by the head's note, the card worker's catalog, app_component_usage and the UI lists. Taking the tag
//     off takes the component out of all of them (no name is kept in the app).
//  5. A change to a component never touches the front of a conversation's prompt cache: the card worker's system prompt is the same bytes whatever the
//     library says; the catalog is the first message of the card.
import { describe, expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { ComponentLibrary, NOT_BUILT_IN_NOTE, componentKnowledgeFor, componentRoles, knowledgeChanges, knowledgeFull } from "../../src/core/components/library";
import { BotCards } from "../../src/core/bot/cards";
import { CARD_BRIEF_MAX, cardCatalogSection, cardInstructions, cardSystemPrompt, cardSystemRules } from "../../src/core/worker-cards";
import { tempDir } from "../helpers";
import { writeLibrary } from "../fixtures/components";

const FLUX = "6AC64E3A-C7D7-4000-8000-000000000002";
let tick = 0;

function rig(extra: Record<string, string>) {
  const dir = tempDir("builtin-roles");
  const folder = tempDir("builtin-roles-flux");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  writeLibrary(dir);
  const root = join(dir, "plugins", "ccb-components", "components");
  const put = (name: string, about: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "template.html"), "<div></div>");
    const file = join(root, name, "about.md");
    writeFileSync(file, about);
    const at = new Date(Date.now() + ++tick * 5_000);
    utimesSync(file, at, at);
  };
  for (const [name, about] of Object.entries(extra)) put(name, about);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
  saveProjectRow(dir, { id: FLUX, name: "flux", folder, avatar: "cloud" });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const flux = ((core as unknown as { bots: Map<string, Bot> }).bots.get(FLUX)!) as unknown as { cards: any; workers: any; setComponentList(names: string[]): void };
  flux.setComponentList(["status"]);
  const library: ComponentLibrary = flux.cards.context.library;
  const retag = (name: string, about: string) => { put(name, about); expect(library.rescan()).toBe(true); };
  return { core, flux, library, retag };
}

/** The component names of a "- name (kind): line" list, in order. */
const lineNames = (text: string): string[] => text.split("\n").map((line) => /^- (\S+?)(?: \(|:)/.exec(line)?.[1]).filter((name): name is string => !!name);

const ABOUT = (title: string, tag: string) => `${title}.\n${tag}\nData: {}`;

describe("one projection of the tag (componentRoles)", () => {
  it("lists the tagged components placed by order then name, leaves out a pin-only one and the choices protocol, and ranks the rest after them", () => {
    const roles = componentRoles({ names: ["plain", "bbb", "aaa", "choices", "pin"], pinOnly: (name) => name === "pin", builtInNames: () => ["bbb", "aaa", "choices", "pin"] });
    expect(roles.builtIn).toEqual(["bbb", "aaa"]);
    expect(roles.usable).toEqual(["plain", "bbb", "aaa"]);
    expect(roles.order(["plain", "aaa", "bbb"])).toEqual(["bbb", "aaa", "plain"]);
    expect(roles.isBuiltIn("plain")).toBe(false);
  });
});

describe("the tag alone decides: head, worker catalog, usage and UI read the same projection", () => {
  it("two arbitrary components: tagged they are built in everywhere, in the placed order; reverse the order and every reader follows; untag one and it is gone from every reader", async () => {
    const { core, flux, library, retag } = rig({
      alpha: ABOUT("Alpha card", "Built-in: yes\nBuilt-in order: 1"), omega: ABOUT("Omega card", "Built-in: yes\nBuilt-in order: 2"), plain: ABOUT("Plain card", ""),
    });
    try {
      const readers = () => {
        const head = componentKnowledgeFor(library, [], false, true).own.map((entry) => entry.name);
        const catalog = lineNames(flux.cards.cardCatalogBrief().components);
        const whole = lineNames(flux.cards.cardBrief().components);
        const menu = flux.cards.noteComponents().components.map((entry: { name: string }) => entry.name);
        const offered = flux.cards.cardLibrary().offered as string[];
        const usage = (name: string) => flux.workers.componentUsage({ name }, "coordinator").yours as boolean;
        return { head, catalog, whole, menu, offered, usage };
      };
      let now = readers();
      expect(now.head).toEqual(["alpha", "omega"]);
      for (const list of [now.catalog, now.whole, now.menu]) expect(list.slice(0, 2)).toEqual(["alpha", "omega"]);
      expect(now.offered).toEqual(expect.arrayContaining(["alpha", "omega"]));
      expect([now.usage("alpha"), now.usage("omega"), now.usage("plain")]).toEqual([true, true, false]);

      // Reverse the placing: every reader follows at once.
      retag("alpha", ABOUT("Alpha card", "Built-in: yes\nBuilt-in order: 9"));
      now = readers();
      expect(now.head).toEqual(["omega", "alpha"]);
      for (const list of [now.catalog, now.whole, now.menu]) expect(list.slice(0, 2)).toEqual(["omega", "alpha"]);

      // Take the tag off omega: not built in for the head, usage or the worker's front rank; alpha stays.
      retag("omega", ABOUT("Omega card", ""));
      now = readers();
      expect(now.head).toEqual(["alpha"]);
      expect(now.catalog[0]).toBe("alpha");
      expect(now.menu[0]).toBe("alpha");
      expect(now.offered).not.toContain("omega");
      expect([now.usage("alpha"), now.usage("omega")]).toEqual([true, false]);
      expect(flux.workers.componentUsage({ name: "omega" }, "coordinator").note).toContain("Not on your list yet");
    } finally { await core.shutdown(); }
  });

  it("no name is kept in the app: the shipped inline blocks and the preview card are built in only while their about.md carries the tag", async () => {
    const { core, flux, library, retag } = rig({
      "inline-chart": ABOUT("Inline chart", "Built-in: yes"), "inline-report-block": ABOUT("Inline report block", "Built-in: yes"), "網頁預覽卡片": ABOUT("Preview card", "Built-in: yes"),
    });
    try {
      const yours = (name: string) => flux.workers.componentUsage({ name }, "coordinator").yours as boolean;
      const head = () => componentKnowledgeFor(library, flux.cards.ownComponents(), false, true).own.map((entry) => entry.name);
      expect(head().sort()).toEqual(["inline-chart", "inline-report-block", "網頁預覽卡片"].sort());
      expect(["inline-chart", "inline-report-block", "網頁預覽卡片"].map(yours)).toEqual([true, true, true]);
      for (const name of ["inline-chart", "inline-report-block", "網頁預覽卡片"]) retag(name, ABOUT(name, ""));
      expect(head()).toEqual([]);
      expect(["inline-chart", "inline-report-block", "網頁預覽卡片"].map(yours)).toEqual([false, false, false]);
      // The note of a head that reaches components by cards, and what is shown of the library in the worker's catalog, no longer put them first.
      expect(componentKnowledgeFor(library, [], false, true).own).toEqual([]);
      expect(flux.cards.cardLibrary().offered).not.toContain("網頁預覽卡片");
    } finally { await core.shutdown(); }
  });

  it("a new bot's first list is not seeded with an untagged preview card (only what it drew)", async () => {
    const { core, flux } = rig({ "網頁預覽卡片": ABOUT("Preview card", "") });
    try {
      flux.cards.componentList = null;
      flux.cards.giveFirstComponents();
      expect(flux.cards.componentList).not.toContain("網頁預覽卡片");
    } finally { await core.shutdown(); }
  });
});

describe("a component change leaves the card worker's system prompt as it was (the catalog is in the card's first message)", () => {
  it("byte-equal system prompt before and after a new component, an edited chart line and a changed order; the new catalog reaches the next card's message", async () => {
    const { core, flux, library, retag } = rig({ "inline-chart": ABOUT("Inline chart", "Built-in: yes"), extra: ABOUT("Extra card", "") });
    try {
      const card = { title: "Prices", prompt: "Show the prices." };
      const before = flux.workers.cardSystemNow() as string;
      const firstMessage = cardInstructions(card, flux.cards.cardCatalogBrief());
      expect(before).toBe(cardSystemRules(flux.cards.cardRules().scriptsDir));
      expect(before).not.toContain("Extra card");
      expect(firstMessage).toContain("- extra (JSON): Extra card");

      retag("extra2", ABOUT("A brand new component", ""));
      retag("inline-chart", ABOUT("Inline chart, its first line edited", "Built-in: yes\nBuilt-in order: 5"));
      retag("extra", ABOUT("Extra card", "Built-in: yes\nBuilt-in order: -3"));
      expect(library.names).toContain("extra2");

      const after = flux.workers.cardSystemNow() as string;
      expect(after).toBe(before);
      expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
      for (const text of ["A brand new component", "its first line edited", "Extra card"]) expect(after).not.toContain(text);
      // The next card's first message does carry the new catalog, in the new order.
      const next = cardInstructions(card, flux.cards.cardCatalogBrief());
      expect(next).toContain("Show the prices.");
      expect(next).toContain("- extra2 (JSON): A brand new component");
      expect(next).toContain("- inline-chart (JSON): Inline chart, its first line edited");
      expect(next.indexOf("- extra (JSON)")).toBeLessThan(next.indexOf("- inline-chart (JSON)"));
    } finally { await core.shutdown(); }
  });

  it("the fixed rules hold no component list, and the full text a redo worker gets is rules plus catalog", () => {
    const brief = { components: "- a (JSON): A line", others: "", scriptsDir: "/p/.bot/card-scripts", usageDir: "/p/.bot/card-usage" };
    const rules = cardSystemRules(brief.scriptsDir);
    expect(rules).not.toContain("- a (JSON): A line");
    expect(rules).toContain("/p/.bot/card-scripts");
    expect(cardSystemRules(brief.scriptsDir)).toBe(rules);
    const full = cardSystemPrompt(brief);
    expect(full.startsWith(rules)).toBe(true);
    expect(full).toContain("- a (JSON): A line");
    expect(full).toContain("/p/.bot/card-usage/<name>.md");
    // A card message with no catalog is just the card.
    expect(cardInstructions({ title: "T", prompt: "P" })).not.toContain("Components you may use");
  });
});

describe("the card's first message starts with the catalog (every card shares the start)", () => {
  it("the catalog section comes before the card's own words, byte-equal for two different cards", () => {
    const brief = { components: "- a (JSON): A line", others: "", scriptsDir: "/p/.bot/card-scripts", usageDir: "/p/.bot/card-usage" };
    const one = cardInstructions({ title: "One", prompt: "First prompt." }, brief), two = cardInstructions({ title: "Two", prompt: "Second prompt." }, brief);
    const section = cardCatalogSection(brief);
    expect(one.startsWith(section)).toBe(true);
    expect(two.startsWith(section)).toBe(true);
    expect(one.indexOf("First prompt.")).toBeGreaterThan(section.length - 1);
  });
});

describe("what the card worker's brief and the lists leave out, and how they are ordered", () => {
  it("a pin-only component and choices are in no worker catalog even when the bot's list names them", async () => {
    const { core, flux } = rig({ pinned: "A pin.\nPin only: yes\nCommand: echo hi\n", choices: ABOUT("Choices", ""), shown: ABOUT("Shown card", "") });
    try {
      flux.setComponentList(["status", "pinned", "choices", "shown"]);
      const whole = flux.cards.cardBrief();
      expect(whole.components).toContain("- shown:");
      for (const hidden of ["- pinned:", "- choices:"]) { expect(whole.components).not.toContain(hidden); expect(whole.others).not.toContain(hidden); }
      const lines = flux.cards.cardCatalogBrief().components;
      for (const hidden of ["- pinned", "- choices"]) expect(lines).not.toContain(hidden);
    } finally { await core.shutdown(); }
  });

  it("the Note's / menu offers no pin-only component, listed or not; a plain one on the list is offered", async () => {
    const { core, flux } = rig({ pinned: "A pin.\nPin only: yes\nCommand: echo hi\n", shown: ABOUT("Shown card", "") });
    try {
      flux.setComponentList(["status", "pinned", "shown"]);
      const menu = flux.cards.noteComponents().components as { name: string; offered: boolean }[];
      expect(menu.find((entry) => entry.name === "pinned")).toMatchObject({ offered: false });
      expect(menu.find((entry) => entry.name === "shown")).toMatchObject({ offered: true });
      // A bot with no list offers the whole library except the pin-only one.
      flux.cards.componentList = null;
      expect(flux.cards.noteComponents().components.find((entry: { name: string }) => entry.name === "pinned")).toMatchObject({ offered: false });
      expect(flux.cards.cardLibrary().offered).not.toContain("pinned");
    } finally { await core.shutdown(); }
  });

  it("the components whose usage did not fit lead the one-line list, before the rest of the library", async () => {
    const big = `Big card.\nData: {}\n${"filler line of usage\n".repeat(Math.ceil(CARD_BRIEF_MAX / 20) + 500)}`;
    const { core, flux } = rig({ "zzz-big": big, "aaa-shelf": ABOUT("Shelf card", "") });
    try {
      flux.setComponentList(["status", "zzz-big"]);
      const brief = flux.cards.cardBrief();
      expect(brief.components).not.toContain("- zzz-big:");
      const lines = brief.others.split("\n");
      expect(lines[0]).toMatch(/^- zzz-big: Big card/);
      expect(lines.findIndex((line: string) => line.startsWith("- aaa-shelf"))).toBeGreaterThan(0);
    } finally { await core.shutdown(); }
  });

  it("a reply's empty <show> of the app's own cards (choices, the preview card) is no mistake to tell; an empty one of a component is", () => {
    const library = new ComponentLibrary(() => []);
    (library as any).names = ["status", "網頁預覽卡片", "choices"];
    const user = (date: number) => ({ id: `u${date}`, role: "user", text: "hi", date });
    const reply = { id: "b1", role: "bot", text: "x", date: 5, displays: ["status", "網頁預覽卡片", "choices"].map((name) => ({ name, data: "null" })) };
    const records: any[] = [user(1), reply, user(9)];
    const owner: any = { profile: { folder: "/nowhere", id: "bot-1" }, engine: "claude", readOnly: false, store: { saveSetting() {}, directory: "/nowhere" } };
    const bot = new BotCards({ readOnly: false, records, updated() {} } as any, { options: { components: { library } }, id: "bot-1", owner, peers: [], store: owner.store } as any);
    const notes = bot.componentNotes(records[2]).join("\n");
    expect(notes).toContain('<show name="status"></show>');
    expect(notes).not.toContain("網頁預覽卡片");
    expect(notes).not.toContain('<show name="choices">');
  });
});

describe("the guidance's examples and the tag never disagree unannounced (invariant 4, the inline blocks)", () => {
  it("an inline block the tag does not make built in is `yours: false` in the usage tool and named in the note; tagging it makes both agree again, and the change is told", async () => {
    const { core, flux, library, retag } = rig({ "inline-chart": ABOUT("Inline chart", ""), "inline-report-block": ABOUT("Inline report block", "Built-in: yes") });
    try {
      const yours = (name: string) => flux.workers.componentUsage({ name }, "coordinator").yours as boolean;
      const knowledge = (examples = true, cardsOnly = false) => componentKnowledgeFor(library, flux.cards.ownComponents(), examples, false, cardsOnly);
      const told = knowledge();
      expect(told.notBuiltIn).toEqual(["inline-chart"]);
      expect([yours("inline-chart"), yours("inline-report-block")]).toEqual([false, true]);
      expect(knowledgeFull(told)).toContain(NOT_BUILT_IN_NOTE(["inline-chart"]));
      expect(NOT_BUILT_IN_NOTE(["inline-chart"])).toContain("inline-chart");
      // Without the guidance (or for a head that writes only <card>) there is no example to contradict.
      // A tagged one is never named, whichever list the caller passes.
      expect(componentKnowledgeFor(library, [], true).notBuiltIn).toEqual(["inline-chart"]);
      expect(knowledge(false).notBuiltIn).toBeUndefined();
      expect(knowledge(true, true).notBuiltIn).toBeUndefined();
      // Tag it: usage and note agree, and the bot is told the examples apply again.
      retag("inline-chart", ABOUT("Inline chart", "Built-in: yes"));
      const now = knowledge();
      expect(now.notBuiltIn).toBeUndefined();
      expect(yours("inline-chart")).toBe(true);
      expect(knowledgeChanges(now, told)).toContain("Built in again, the examples in your instructions apply: inline-chart");
      // Untag the other: both say so, and the change is told.
      retag("inline-report-block", ABOUT("Inline report block", ""));
      const last = knowledge();
      expect(last.notBuiltIn).toEqual(["inline-report-block"]);
      expect(yours("inline-report-block")).toBe(false);
      expect(knowledgeChanges(last, now)).toContain(NOT_BUILT_IN_NOTE(["inline-report-block"]));
      expect(knowledgeChanges(last, last)).toBeNull();
      // On the bot's own list it is yours whatever the tag says, so nothing disagrees.
      flux.setComponentList(["status", "inline-report-block"]);
      expect(knowledge().notBuiltIn).toBeUndefined();
      expect(yours("inline-report-block")).toBe(true);
    } finally { await core.shutdown(); }
  });
});

describe("choices stays the core's own protocol", () => {
  it("app_component_usage says yours for choices whatever the tag says, and no tag lists it", async () => {
    const { core, flux, library } = rig({ choices: ABOUT("Choices", ""), other: ABOUT("Other card", "") });
    try {
      expect(flux.workers.componentUsage({ name: "choices" }, "coordinator")).toMatchObject({ yours: true });
      expect(flux.workers.componentUsage({ name: "other" }, "coordinator")).toMatchObject({ yours: false });
      expect(componentRoles(library).builtIn).not.toContain("choices");
    } finally { await core.shutdown(); }
  });
});
