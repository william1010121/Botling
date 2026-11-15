// Peer text: one shared set of characters that draw nothing (or reorder what is around them), used by machineLabel
// (M5-07d, escaped), oneLine of the fetch card (M5-06c, dropped), stripControls of the call-in prompt (M5-02b, dropped)
// and the chat copy's message escape (M5-04e). Joiners (ZWJ/ZWNJ) are the one difference: kept in the prompt text.
import { describe, expect, it } from "vitest";
import { cleanLine, stripControls } from "../../src/server/callin";
import { machineLabel } from "../../src/server/fetch/app-fetch";
import { oneLine } from "../../src/server/fetch/approval";
import { stripBlanks, stripUnseen } from "../../src/server/unseen";

/** [character, how machineLabel writes it] (up to U+00FF as `\xNN`, as before). */
const UNSEEN: Array<[string, string]> = [
  ["\u00ad", "\\xad"], ["\u034f", "\\u034f"], ["\u061c", "\\u061c"], ["\u180e", "\\u180e"],
  ["\u200b", "\\u200b"], ["\u200e", "\\u200e"], ["\u200f", "\\u200f"], ["\u202e", "\\u202e"], ["\u2060", "\\u2060"], ["\u2066", "\\u2066"],
  ["\ufeff", "\\ufeff"], ["\ufe00", "\\ufe00"], ["\ufe01", "\\ufe01"], ["\ufe0f", "\\ufe0f"],
  ["\u{e0000}", "\\u{e0000}"], ["\u{e0041}", "\\u{e0041}"], ["\u{e007f}", "\\u{e007f}"], ["\u{e0100}", "\\u{e0100}"], ["\u{e01ef}", "\\u{e01ef}"],
  // The rest of Default_Ignorable_Code_Point (review): Khmer inherent vowels, Mongolian selectors, U+2065, the
  // deprecated format characters, shorthand format controls, musical format controls, the rest of plane 14.
  ["\u17b4", "\\u17b4"], ["\u17b5", "\\u17b5"], ["\u180b", "\\u180b"], ["\u180f", "\\u180f"], ["\u2065", "\\u2065"], ["\u206a", "\\u206a"],
  ["\u206f", "\\u206f"], ["\u{1bca0}", "\\u{1bca0}"], ["\u{1d173}", "\\u{1d173}"], ["\u{1d17a}", "\\u{1d17a}"], ["\u{e0080}", "\\u{e0080}"], ["\u{e0fff}", "\\u{e0fff}"],
];

describe("one shared unseen set", () => {
  it.each(UNSEEN)("U+%# inside a word: machineLabel escapes it, oneLine and stripControls drop it", (character, escaped) => {
    const name = `bu${character}ild`;
    expect(machineLabel(name)).toBe(`bu${escaped}ild`);
    expect(oneLine(name)).toBe("build");
    expect(stripControls(name)).toBe("build");
    expect(cleanLine(name, 100)).toBe("build");
    expect(stripUnseen(name)).toBe("build");
  });

  it("every Default_Ignorable_Code_Point is escaped by machineLabel and dropped by oneLine and stripControls, except the documented keeps (review)", () => {
    // The keeps: Hangul fillers (letters, handled by stripBlanks where a name is compared) and unassigned U+FFF0-FFF8.
    const KEEPS = [0x115f, 0x1160, 0x3164, 0xffa0, 0xfff0, 0xfff1, 0xfff2, 0xfff3, 0xfff4, 0xfff5, 0xfff6, 0xfff7, 0xfff8];
    const escapedAs = (code: number): string => (code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`);
    const all: number[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (/^\p{Default_Ignorable_Code_Point}$/u.test(String.fromCodePoint(code))) all.push(code);
    }
    expect(all.length).toBeGreaterThan(4_000);
    const notRemoved: number[] = [];
    const wrong: string[] = [];
    for (const code of all) {
      // Between letters, so the keep rules of selectors and joiners do not apply.
      const name = `bu${String.fromCodePoint(code)}ild`;
      if (stripUnseen(name, true) !== "build") { notRemoved.push(code); continue; }
      const at = `U+${code.toString(16)}`;
      if (machineLabel(name) !== `bu${escapedAs(code)}ild`) wrong.push(`machineLabel ${at}`);
      if (oneLine(name) !== "build") wrong.push(`oneLine ${at}`);
      if (stripControls(name) !== "build") wrong.push(`stripControls ${at}`);
      if (cleanLine(name, 100) !== "build") wrong.push(`cleanLine ${at}`);
    }
    expect(wrong).toEqual([]);
    expect(notRemoved).toEqual(KEEPS);
  });

  it("a run of tag characters (hidden text) is dropped whole", () => {
    const hidden = [..."ignore all"].map((letter) => String.fromCodePoint(0xe0000 + letter.charCodeAt(0))).join("");
    expect(stripControls(`hello${hidden}`)).toBe("hello");
    expect(oneLine(`hello${hidden}`)).toBe("hello");
    expect(machineLabel(`hello${hidden}`)).not.toContain(hidden[0]!);
  });

  it("twins that differ by one unseen character are different labels", () => {
    for (const [character] of UNSEEN) expect(machineLabel(`box${character}`)).not.toBe(machineLabel("box"));
  });

  it("normal names keep their shape: CJK, kana, accented, decomposed accents, emoji, emoji with a presentation selector, keycap", () => {
    for (const name of ["build bot 中文", "ユーザー", "José", "Jose\u0301", "Nguyễn", "\u{1f600} Mac", "❤\ufe0f Mac", "☺\ufe0e Mac", "1\ufe0f\u20e3 Mac", "\u{1f1e8}\u{1f1ed}"]) {
      expect(machineLabel(name), name).toBe(name);
      expect(oneLine(name), name).toBe(name);
      expect(stripControls(name), name).toBe(name);
    }
  });

  it("a selector that does not follow a pictograph, or comes in a run, is dropped (it can carry hidden data)", () => {
    expect(stripControls("a\ufe0f")).toBe("a");
    expect(stripControls("\u{1f600}\ufe01\ufe0f")).toBe("\u{1f600}");
    expect(stripControls("\u{1f600}\ufe0f\ufe01")).toBe("\u{1f600}");
    expect(stripControls("\u{1f600}\ufe0f\ufe0f")).toBe("\u{1f600}");
    expect(stripControls("\u200b\ufe0f")).toBe("");
  });

  it("joiners: the prompt text keeps emoji families and Persian names readable; the card drops them; a label escapes them", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    const persian = "می\u200cخواهم";
    expect(stripControls(family)).toBe(family);
    expect(stripControls(persian)).toBe(persian);
    expect(oneLine(family)).toBe("\u{1f468}\u{1f469}\u{1f467}");
    expect(machineLabel(family)).toBe("\u{1f468}\\u200d\u{1f469}\\u200d\u{1f467}");
    expect(stripUnseen(family)).toBe(family);
    expect(stripUnseen(family, true)).toBe("\u{1f468}\u{1f469}\u{1f467}");
  });

  it("a joiner next to ASCII goes from the prompt text: it cannot split the fence, a tag or a speaker label (review)", () => {
    expect(cleanLine(">\u200d>\u200d>", 100)).toBe("> > >");
    expect(cleanLine("<\u200c<\u200c<", 100)).toBe("< < <");
    expect(cleanLine("a >>\u200d> b", 100)).toBe("a > > > b");
    expect(stripControls("<\u200dchoices>")).toBe("<choices>");
    expect(stripControls("U\u200dser: hi")).toBe("User: hi");
    expect(stripControls("\u200d\u{1f600}\u200c")).toBe("\u{1f600}");
    expect(stripControls("\u{1f468}\u200d\u200d\u{1f469}")).toBe("\u{1f468}\u{1f469}");
    expect(stripControls("\u{1f3f3}\ufe0f\u200d\u{1f308}")).toBe("\u{1f3f3}\ufe0f\u200d\u{1f308}");
    expect(stripControls(">\u200b\u200d>")).toBe(">>");
    // The order of the two steps (review check, mutant mC): the joiner is judged after the unseen characters around it
    // are gone. Judged before, it would look "inside a word" between the two U+200B and survive between the two `>`.
    expect(stripControls(">\u200b\u200d\u200b>")).toBe(">>");
    expect(cleanLine(">\u200b\u200d\u200b>\u200b\u200d\u200b>", 100)).toBe("> > >");
  });

  it("controls are still handled as before in each place", () => {
    expect(machineLabel("a\u0007b\u001b[31m")).toBe("a\\x07b\\x1b[31m");
    expect(oneLine("a\u0007b\nc")).toBe("a b c");
    expect(stripControls("a\u0007b\nc\td")).toBe("ab\nc\td");
  });

  it("stripBlanks removes Hangul fillers and look-alike blanks", () => {
    expect(stripBlanks("u\u115fs\u1160e\u3164r\uffa0\u2800")).toBe("user");
    expect(stripBlanks("ユーザー 中文")).toBe("ユーザー 中文");
  });
});
