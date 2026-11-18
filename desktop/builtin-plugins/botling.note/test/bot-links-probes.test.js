// @vitest-environment jsdom
// Probes for the guards of the @Name chips that bot-links.test.js leaves open (review mutants of bot/note-bot-links).
// Run through bot-links-probes-run.test.ts (vitest.config.mts only collects *.test.ts here).
import { afterEach, describe, expect, it } from "vitest";
import { inline, setBots } from "../src/ui-text.js";

afterEach(() => setBots([]));
const chips = (html) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("a.n-bot")].map((a) => [a.dataset.bot, a.textContent]);

describe("@Name guards", () => {
  it("a name that ends in a letter ends at a word even when the page spells it with an entity (A&B → A&amp;B)", () => {
    setBots([{ id: "b1", name: "A&B" }]);
    expect(chips(inline("@A&Bx"))).toEqual([]);
    expect(chips(inline("@A&B, ok"))).toEqual([["b1", "@A&B"]]);
  });

  it("a name that ends in a symbol needs no boundary after it; one that ends in a letter does (digit, underscore, hyphen)", () => {
    setBots([{ id: "b1", name: "C++" }, { id: "b2", name: "EEG" }]);
    expect(chips(inline("@C++x and @C++-x"))).toEqual([["b1", "@C++"], ["b1", "@C++"]]);
    expect(chips(inline("@EEG2"))).toEqual([]);
  });

  it("a digit or an underscore before the @ is not a mention either (like a letter)", () => {
    setBots([{ id: "b1", name: "EEG" }]);
    expect(chips(inline("a1@EEG and x_@EEG"))).toEqual([]);
    expect(chips(inline("(@EEG) and \"@EEG\""))).toEqual([["b1", "@EEG"], ["b1", "@EEG"]]);
  });

  it("a name that itself holds an @ is one chip; the @ inside it is not read again", () => {
    setBots([{ id: "b1", name: "a @b" }, { id: "b2", name: "b" }]);
    expect(chips(inline("@a @b"))).toEqual([["b1", "@a @b"]]);
    expect(inline("@a @b").match(/<a /g)).toHaveLength(1);
  });

  it("the text and the address of a link are left alone, also when the text holds other marks", () => {
    setBots([{ id: "b1", name: "EEG" }]);
    expect(chips(inline("[a *b* @EEG](https://e.com/x)"))).toEqual([]);
    expect(chips(inline("[x](https://e.com/@EEG)"))).toEqual([]);
    expect(chips(inline("[x](https://e.com/) @EEG"))).toEqual([["b1", "@EEG"]]);
  });

  it("a mention next to code or math is still a chip, and the code itself is untouched", () => {
    setBots([{ id: "b1", name: "EEG" }]);
    const html = inline("@EEG `a@EEG` @EEG");
    expect(chips(html)).toEqual([["b1", "@EEG"], ["b1", "@EEG"]]);
    expect(html).toContain("<code>a@EEG</code>");
  });

  it("a name with a control character is never a bot name, so it cannot match the placeholder the renderer keeps code in", () => {
    setBots([{ id: "b1", name: "\u00000\u0000" }]);
    expect(chips(inline("@`c`"))).toEqual([]);
    expect(inline("@`c`")).toBe("@<code>c</code>");
  });
});
