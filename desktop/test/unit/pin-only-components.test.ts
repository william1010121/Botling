// Pin-only components (an about.md `Pin only: yes` line): status things that exist to be pinned to the strip. The bots are not told
// about them and do not list them as their own; the pin picker still gets them (`cardLibrary().pinOnly`), every bot's. A flag with no
// Command does nothing: without one there is nothing to pin, and the component would be invisible everywhere.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BotCards } from "../../src/core/bot/cards";
import { ComponentLibrary, componentKnowledgeFor, knowledgeFull } from "../../src/core/components/library";
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

  it("a pin-only component never goes on a bot's list: not drawn into it, not given first; the note's insert menu does not call it the bot's", () => {
    const { bot, saved } = cards(["table"]);
    bot.drewComponents(["cpu", "clock"]);
    expect(bot.componentList).toEqual(["table", "clock"]);
    expect(saved.at(-1)).toEqual(["table", "clock"]);
    const first = cards(null);
    (first.bot as any).host.records = [{ role: "bot", displays: [{ name: "cpu", data: "null" }, { name: "table", data: "{}" }] }];
    first.bot.giveFirstComponents();
    expect(first.bot.componentList).not.toContain("cpu");
    expect(first.bot.componentList).toContain("table");
    const menu = bot.noteComponents()!;
    expect(menu.components.find((entry) => entry.name === "cpu")).toMatchObject({ offered: false });
    expect(menu.components.find((entry) => entry.name === "table")).toMatchObject({ offered: true });
  });
});
