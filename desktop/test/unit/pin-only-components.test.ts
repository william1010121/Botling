// Pin-only components (an about.md `Pin only: yes` line): status things that exist to be pinned to the strip. The bots are not told
// about them and do not list them as their own; the pin picker still gets them (`cardLibrary().pinOnly`), every bot's. A flag with no
// Command does nothing: without one there is nothing to pin, and the component would be invisible everywhere.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotCards } from "../../src/core/bot/cards";
import { BotWorkers } from "../../src/core/bot/workers";
import { ComponentLibrary, componentKnowledgeFor, knowledgeFull } from "../../src/core/components/library";
import { MaintainerDesk } from "../../src/core/maintainer";
import { slashLists } from "../../src/renderer/payload";
import { tempDir } from "../helpers";

function library(): ComponentLibrary {
  const root = join(tempDir("pin-only"), "components");
  const add = (name: string, about: string) => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "template.html"), `<p>${name}</p>`);
    writeFileSync(join(root, name, "about.md"), about);
  };
  add("table", "A table.\nData: rows");
  add("clock", "Clock.\nCommand: date +%H:%M");
  add("cpu", "CPU load as a gauge.\nCommand: python3 cpu.py\nPin only: yes");
  add("mem", "Memory.\n- Command: python3 mem.py\n- Pin only: true");
  add("lone", "Flagged, but it has no Command.\nPin only: yes");
  add("off", "Not pin only.\nCommand: true\nPin only: no");
  return new ComponentLibrary(() => [root]);
}

describe("the Pin only flag", () => {
  it("is on for a component that says yes/true/on/1 and has a Command, off for the rest", () => {
    const lib = library();
    expect(lib.names.filter((name) => lib.pinOnly(name))).toEqual(["cpu", "mem"]);
    expect(lib.pinOnly("lone")).toBe(false);
    expect(lib.pinOnly("off")).toBe(false);
    expect(lib.pinOnly("ghost")).toBe(false);
  });

  it("keeps a pin-only component out of what a bot is told (its own list and the shared shelf), whatever its list says", () => {
    const lib = library();
    const k = componentKnowledgeFor(lib, ["table", "cpu", "mem"]);
    expect(k.own.map((entry) => entry.name)).toEqual(["table"]);
    expect(k.others.map((entry) => entry.name)).toEqual(["clock", "lone", "off"]);
    const text = knowledgeFull(k);
    expect(text).not.toContain("- cpu");
    expect(text).not.toContain("- mem");
    // The same call with a library that knows nothing of the flag lists everything (a fake library of other tests).
    const plain = componentKnowledgeFor({ names: lib.names, command: (name) => lib.command(name), summaries: (of) => lib.summaries(of) }, ["cpu"]);
    expect(plain.own.map((entry) => entry.name)).toEqual(["cpu"]);
  });

  it("naming one with / tells the bot nothing; a normal one is still described", () => {
    const lib = library();
    expect(lib.mentioned("show /cpu and /mem please")).toEqual([]);
    expect(lib.mentionNote("/cpu")).toBeNull();
    expect(lib.mentioned("use /clock and /cpu")).toEqual(["clock"]);
    expect(lib.mentionNote("use /clock")).toContain("- clock:");
  });
});

describe("a bot's cards: what the picker gets and what the bot is offered", () => {
  /** A BotCards over just enough of a bot (`options.components`, a folder, a store that keeps settings). */
  function cards(list: string[] | null) {
    const lib = library();
    const saved: unknown[] = [];
    const owner: any = { profile: { folder: "/work/site" }, readOnly: false, store: { saveSetting: (_key: string, value: unknown) => { saved.push(value); } } };
    const host: any = { readOnly: false, records: [], updated() {} };
    const ctx: any = { options: { components: { library: lib } }, id: "bot-1", owner, peers: [], store: owner.store };
    const bot = new BotCards(host, ctx);
    owner.cards = bot;
    bot.componentList = list;
    return { bot, lib, saved };
  }

  it("`offered` is the bot's list without pin-only ones; `pinOnly` is every pin-only component of the library, with its Command in `entries`", () => {
    const { bot } = cards(["table", "cpu", "ghost"]);
    const library = bot.cardLibrary()!;
    expect(library.offered).toEqual(["table"]);
    expect(library.pinOnly).toEqual(["cpu", "mem"]);
    expect(library.entries.cpu!.command).toBe("python3 cpu.py");
    // A bot with no list yet is offered the library, still without them.
    expect(cards(null).bot.cardLibrary()!.offered).toEqual(["clock", "lone", "off", "table"]);
  });

  it("a pin-only component never goes on a bot's list: not drawn into it, not given first", () => {
    const { bot, saved } = cards(["table"]);
    bot.drewComponents(["cpu", "clock"]);
    expect(bot.componentList).toEqual(["table", "clock"]);
    expect(saved.at(-1)).toEqual(["table", "clock"]);
    const first = cards(null);
    (first.bot as any).host.records = [{ role: "bot", displays: [{ name: "cpu", data: "null" }, { name: "table", data: "{}" }] }];
    first.bot.giveFirstComponents();
    expect(first.bot.componentList).not.toContain("cpu");
    expect(first.bot.componentList).toContain("table");
  });

  it("the note's insert menu keeps pin-only components (the Note is the user's own) but never calls one the bot's: even a bot.json from before the flag that lists it", () => {
    const { bot } = cards(["table", "cpu"]);
    const menu = bot.noteComponents()!;
    expect(menu.components.find((entry) => entry.name === "cpu")).toMatchObject({ offered: false, command: "python3 cpu.py" });
    expect(menu.components.find((entry) => entry.name === "table")).toMatchObject({ offered: true });
    expect(menu.components.map((entry) => entry.name)).toContain("mem");
    // The bot's own come first, then the rest of the library (pin-only ones among it).
    expect(menu.components[0]!.name).toBe("table");
  });
});

describe("the bot's other doors", () => {
  it("app_component_usage answers nothing for a pin-only name and does not list it in 'The library has'", () => {
    const lib = library();
    const workers = new BotWorkers({ cards: { context: { library: lib }, ownComponents: () => ["table"] } } as never, {} as never);
    const usage = (name: string) => (workers as any).componentUsage({ name }, "coordinator");
    expect(usage("clock")).toMatchObject({ name: "clock" });
    for (const name of ["cpu", "CPU", "mem"]) expect(() => usage(name)).toThrow(/No component named/);
    let said = "";
    try { usage("cpu"); } catch (error) { said = (error as Error).message; }
    // The message names the wanted word first; what the library has comes after it.
    const listed = said.split("The library has: ")[1] ?? "";
    expect(listed).toContain("clock");
    expect(listed).not.toMatch(/\b(cpu|mem)\b/);
  });

  function desk() {
    const root = tempDir("pin-only-desk");
    const lib = library();
    let list: string[] = ["table"];
    const sent: string[] = [];
    const bot = {
      id: "bot-1", profile: { name: "Main bot" },
      get components() { return list; },
      get ownComponentNames() { return lib.names.filter((name) => list.includes(name)); },
      lastAsked: "",
      setComponentList(names: string[]) { list = names; },
      queueNote(text: string) { sent.push(text); },
      appMessage(text: string) { sent.push(text); },
      appNotice(text: string) { sent.push(`notice: ${text}`); return "n"; },
    } as never;
    const maintainer = { queueNote: (text: string) => { sent.push(`maintainer: ${text}`); } };
    const maintainerDesk = new MaintainerDesk({ root, maintainer: () => maintainer as never, mainBot: () => bot, bots: () => [bot], library: lib, plugins: () => null, log: () => {} });
    return { maintainerDesk, bot, sent, list: () => list };
  }

  it("Maintainer does not give a pin-only component to a bot: giveComponent refuses, <give-component> says why, an ask is changed as asked and nothing is added", () => {
    const { maintainerDesk, bot, sent, list } = desk();
    expect(maintainerDesk.giveComponent("cpu", bot)).toBe(false);
    expect(maintainerDesk.giveComponent("clock", bot)).toBe(true);
    expect(list()).toEqual(["table", "clock"]);
    sent.length = 0;
    maintainerDesk.changeList(true, "mem", "Main bot");
    expect(list()).toEqual(["table", "clock"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("pin-only");
    expect(sent[0]).not.toContain("/ 20");
    sent.length = 0;
    const note = maintainerDesk.askNote("cpu", "make the gauge bigger", true, bot);
    expect(note).toContain("pin-only");
    expect(list()).toEqual(["table", "clock"]);
    expect(sent).toEqual([]);
  });
});

describe("the composer's / menu", () => {
  it("lists no pin-only component, in the bot's own part or the library part", () => {
    const names = ["clock", "cpu", "mem", "table"];
    const bot = { components: ["table", "cpu"] } as Parameters<typeof slashLists>[0];
    expect(slashLists(bot, names, ["cpu", "mem"])).toEqual({ slashComponents: ["table"], slashLibrary: ["clock"] });
    expect(slashLists({ ...bot, components: null }, names, ["cpu", "mem"])).toEqual({ slashComponents: ["clock", "table"], slashLibrary: [] });
    // Without the list of pin-only names nothing is left out (a chat of an older page).
    expect(slashLists(bot, names)).toEqual({ slashComponents: ["cpu", "table"], slashLibrary: ["clock", "mem"] });
  });

  it("the library says which components are pin-only (`info().pinOnly`) so the page can leave them out", () => {
    const lib = library();
    expect(lib.names.filter((name) => lib.info(name)!.pinOnly)).toEqual(["cpu", "mem"]);
  });
});
