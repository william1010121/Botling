// @vitest-environment jsdom
// A plugin's rows in the "@" list (ccb.composer.mentionSource): they come first, a name typed in full needs no list, a source that
// throws offers nothing, and a row's own `insert` is what goes into the box.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../../../Web/src/composer";
import { setComposerHost } from "../../../../Web/src/composer-host";
import { PluginHost, type PluginSpec } from "../../../../Web/src/plugins";
import type { ChatState } from "../../../../Web/src/types";

let composer: Composer;
afterEach(() => { composer?.view.destroy(); setComposerHost(null); document.body.replaceChildren(); });

const state = (mentions: string[] = []) => ({ botID: "A", botName: "A", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {}, mentions, allMentions: mentions } as unknown as ChatState);
const type = (text: string) => { composer.setText(text); composer.view.dispatch({ selection: { anchor: text.length } }); };
const names = () => [...document.querySelectorAll(".mention-list .mention-name")].map((node) => node.textContent);
const listHidden = () => (document.querySelector(".mention-list") as HTMLElement).hidden;
const key = (name: string) => composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
const make = () => { composer = new Composer(document.body); composer.update(state()); return composer; };

describe("addMentionSource", () => {
  it("opens the list after @ even when the chat has no bots to call, shows the row's name and hint, and Return puts its `insert` in the box", () => {
    make();
    composer.addMentionSource((query) => [{ name: "Deploy", about: "進行中 · building", insert: "@Deploy " }].filter((row) => row.name.toLowerCase().startsWith(query)));
    type("@de");
    expect(names()).toEqual(["@Deploy"]);
    expect(document.querySelector(".mention-list .mention-hint")?.textContent).toBe("進行中 · building");
    key("Enter");
    expect(composer.text).toBe("@Deploy ");
    expect(composer.view.state.selection.main.head).toBe(8);
    expect(listHidden()).toBe(true);
  });

  it("takes a row with no `insert` as '@name ' like a bot", () => {
    make();
    composer.addMentionSource(() => [{ name: "Plain" }]);
    type("@");
    key("Enter");
    expect(composer.text).toBe("@Plain ");
  });

  it("puts its rows before the bots' rows", () => {
    make().update(state(["Zed-bot", "Claude"]));
    composer.addMentionSource(() => [{ name: "Deploy" }]);
    type("@");
    expect(names()[0]).toBe("@Deploy");
    expect(names()).toEqual(expect.arrayContaining(["@Zed-bot", "@Claude"]));
  });

  it("drops a row twice named (compared without case), a row with no name, and anything past 8 rows", () => {
    make();
    composer.addMentionSource(() => [{ name: "Same" }, { name: "same" }, { name: "" }, { name: 5 as unknown as string }, ...Array.from({ length: 20 }, (_, n) => ({ name: `row${n}` }))]);
    type("@");
    expect(names()).toHaveLength(8);
    expect(names()[0]).toBe("@Same");
  });

  it("hides the list when the full name of a row is typed, so Return sends the message", () => {
    make();
    composer.addMentionSource(() => [{ name: "Deploy" }]);
    type("@Deploy");
    expect(listHidden()).toBe(true);
    type("@Deplo");
    expect(listHidden()).toBe(false);
  });

  it("offers nothing from a source that throws or returns a non-list, and the other sources still answer", () => {
    make();
    composer.addMentionSource(() => { throw new Error("broken"); });
    composer.addMentionSource(() => "oops" as never);
    composer.addMentionSource(() => [{ name: "Fine" }]);
    type("@");
    expect(names()).toEqual(["@Fine"]);
  });

  it("is removed by the function it returns, and the open list is drawn again without it", () => {
    make();
    const remove = composer.addMentionSource(() => [{ name: "Gone" }]);
    type("@");
    expect(names()).toEqual(["@Gone"]);
    remove();
    expect(names()).toEqual([]);
    expect(listHidden()).toBe(true);
  });

  it("does not ask for rows inside a word (a@b) or after @@ (the full list of bots)", () => {
    make();
    const source = vi.fn(() => [{ name: "Deploy" }]);
    composer.addMentionSource(source);
    source.mockClear();
    type("a@d");
    expect(source).not.toHaveBeenCalled();
    composer.update(state(["Zed"]));
    type("@@");
    expect(source).not.toHaveBeenCalled();
    expect(names()).toEqual(["@Zed"]);
  });
});

describe("through the plugin host (ccb.composer.mentionSource)", () => {
  const spec: PluginSpec = { name: "test.mentions", version: "1.0.0", source: "", styles: [], settings: {}, commands: [] };
  const load = async (activate: (ccb: never) => unknown) => {
    composer = new Composer(document.body);
    composer.update(state());
    const host = new PluginHost({
      composer: {
        element: composer.root, view: composer.view, getText: () => composer.text, insert: (text) => composer.insert(text), addExtension: (extension) => composer.addExtension(extension),
        showPopover: (content) => composer.showPopover(content), mentionSource: (source) => composer.addMentionSource(source), chips: { add: (chip) => composer.addChip(chip), list: () => composer.chipsHere() },
      },
      redraw: () => {},
    });
    await host.sync([spec], async () => activate as never);
    return host;
  };

  it("lends the rows to the box, and unloading the plugin takes them away", async () => {
    const host = await load((ccb: { composer: { mentionSource(source: () => { name: string }[]): unknown } }) => { ccb.composer.mentionSource(() => [{ name: "FromPlugin" }]); });
    type("@");
    expect(names()).toEqual(["@FromPlugin"]);
    await host.sync([], async () => (() => {}) as never);
    type("@");
    expect(names()).toEqual([]);
  });

  it("keeps a plugin whose source throws from breaking the box", async () => {
    await load((ccb: { composer: { mentionSource(source: () => never): unknown } }) => { ccb.composer.mentionSource(() => { throw new Error("boom"); }); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => type("@x")).not.toThrow();
    expect(names()).toEqual([]);
  });
});
