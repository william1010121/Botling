// @vitest-environment jsdom
// @bot in a Note cell: a name of a bot of the left column, written as @Name, is drawn as a chip that opens that bot's chat
// (src/ui-text.js setBots / inline / openAnchor). Run through bot-links-run.test.ts (vitest.config.mts only collects *.test.ts here).
import { afterEach, describe, expect, it, vi } from "vitest";
import { inline, setBots, openAnchor } from "../src/ui-text.js";

afterEach(() => setBots([]));
const chips = (html) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("a.n-bot")].map((a) => [a.dataset.bot, a.textContent]);

describe("@Name in a cell", () => {
  it("a bot's name after @ is a chip that names the bot; the typed spelling stays, and other text is as before", () => {
    setBots([{ id: "b1", name: "EEG" }, { id: "b2", name: "Youtube Video" }]);
    expect(chips(inline("2. @EEG 的進度"))).toEqual([["b1", "@EEG"]]);
    expect(chips(inline("@eeg and @Youtube Video."))).toEqual([["b1", "@eeg"], ["b2", "@Youtube Video"]]);
    expect(inline("2. @EEG 的進度")).toContain(" 的進度");
    expect(inline("no mention **here**")).toBe("no mention <strong>here</strong>");
  });

  it("no bot list, an unknown name, or a bare @ stays plain text", () => {
    expect(inline("@EEG")).toBe("@EEG");
    setBots([{ id: "b1", name: "EEG" }]);
    expect(inline("@nobody and @ and a@")).toBe("@nobody and @ and a@");
  });

  it("the longest name wins, and a name must end where a word ends (but CJK text may follow directly)", () => {
    setBots([{ id: "b1", name: "EEG" }, { id: "b2", name: "EEG Lab" }]);
    expect(chips(inline("@EEG Lab notes"))).toEqual([["b2", "@EEG Lab"]]);
    expect(chips(inline("@EEG Labs"))).toEqual([["b1", "@EEG"]]);
    expect(chips(inline("@EEGx and @EEG-2 and @EEG_"))).toEqual([]);
    expect(chips(inline("@EEG的進度"))).toEqual([["b1", "@EEG"]]);
  });

  it("a name that comes after a letter (an e-mail address) is not a mention", () => {
    setBots([{ id: "b1", name: "EEG" }]);
    expect(chips(inline("write to me@EEG now"))).toEqual([]);
  });

  it("code, math, images and the text of a link are left alone", () => {
    setBots([{ id: "b1", name: "EEG" }]);
    expect(chips(inline("`@EEG` and $@EEG$"))).toEqual([]);
    expect(inline("`@EEG`")).toBe("<code>@EEG</code>");
    const linked = inline("[see @EEG](https://example.com/x)");
    expect(chips(linked)).toEqual([]);
    expect(linked.match(/<a /g)).toHaveLength(1);
    expect(chips(inline("![@EEG](note-assets/x.png) then @EEG"))).toEqual([["b1", "@EEG"]]);
  });

  it("two bots with one name (any case) are ambiguous: neither is linked", () => {
    setBots([{ id: "b1", name: "EEG" }, { id: "b2", name: "eeg" }, { id: "b3", name: "Other" }]);
    expect(chips(inline("@EEG @Other"))).toEqual([["b3", "@Other"]]);
  });

  it("names and ids from the app are escaped, and names like constructor or __proto__ are just names", () => {
    setBots([{ id: 'x"><i>', name: "A&B" }, { id: "b2", name: "constructor" }, { id: "b3", name: "bad\nname" }, { id: "", name: "Empty" }, { id: "b5", name: "" }, null, 7]);
    const html = inline("@A&B @constructor @__proto__ @toString @bad @Empty");
    expect(html).not.toContain("<i>");
    expect(chips(html)).toEqual([['x"><i>', "@A&B"], ["b2", "@constructor"]]);
  });

  it("setBots takes anything: not a list clears, and it says whether the list changed", () => {
    expect(setBots([{ id: "b1", name: "EEG" }])).toBe(true);
    expect(setBots([{ id: "b1", name: "EEG" }])).toBe(false);
    expect(setBots(null)).toBe(true);
    expect(inline("@EEG")).toBe("@EEG");
  });
});

describe("clicking a chip", () => {
  const anchor = (html) => new DOMParser().parseFromString(html, "text/html").querySelector("a");
  it("opens that bot's chat through botling.openChat, and never as a link", () => {
    setBots([{ id: "b1", name: "EEG" }]);
    const ccb = { commands: { execute: vi.fn() }, openLink: vi.fn(), notify: vi.fn() };
    openAnchor(ccb, "B0", anchor(inline("@EEG")));
    expect(ccb.commands.execute).toHaveBeenCalledWith("botling.openChat", "b1");
    expect(ccb.openLink).not.toHaveBeenCalled();
  });

  it("an ordinary link still opens as a link; an app that cannot run the command says so", async () => {
    const ccb = { commands: { execute: vi.fn() }, openLink: vi.fn(async () => ({})), notify: vi.fn() };
    openAnchor(ccb, "B0", anchor(inline("[x](https://example.com)")));
    await Promise.resolve();
    expect(ccb.openLink).toHaveBeenCalledWith("https://example.com", { botId: "B0" });
    expect(ccb.commands.execute).not.toHaveBeenCalled();
    setBots([{ id: "b1", name: "EEG" }]);
    const old = { notify: vi.fn() };
    openAnchor(old, "B0", anchor(inline("@EEG")));
    expect(old.notify).toHaveBeenCalledTimes(1);
  });
});
