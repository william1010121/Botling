// The characters that draw nothing, or change how the text around them is drawn, in text that came from a peer, a
// user or a file. One set for every place that cleans such text (code-standards 4): the machine label of `app_fetch`
// (escaped, because it is also a match key), the fetch card's `oneLine` and the call-in prompt's `stripControls`
// (dropped), and the chat copy's message escape (escaped). Control characters (C0, C1, line separators) stay with each
// caller: what to do with a newline differs. Everything here is in `server/`; nothing crosses a boundary.

/** Soft hyphen, combining grapheme joiner, Arabic letter mark, Mongolian vowel separator, zero-width space and the left-to-right / right-to-left marks, bidi embeddings and overrides, word joiner and invisible operators, bidi isolates, BOM, and the tag characters and variation selector supplement (astral). */
const ALWAYS = "\\u00ad\\u034f\\u061c\\u180e\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}";
/** Variation selectors U+FE00–FE0F: dropped, except one U+FE0E / U+FE0F that picks how a pictograph is drawn (see `keeps`). */
const SELECTORS = "\\ufe00-\\ufe0f";
/** ZWNJ and ZWJ: invisible, but they make emoji families and some Persian and Indic words, so the prompt text keeps them. */
const JOINERS = "\\u200c\\u200d";

const WITHOUT_JOINERS = new RegExp(`[${ALWAYS}${SELECTORS}]`, "gu");
const WITH_JOINERS = new RegExp(`[${ALWAYS}${SELECTORS}${JOINERS}]`, "gu");
const PICTOGRAPH_END = /\p{Extended_Pictographic}$/u;
const KEYCAP_END = /[0-9#*]$/u;

/**
 * Whether the variation selector at `at` is the one that belongs to an emoji: a single U+FE0E / U+FE0F straight after
 * a pictograph (a red heart), or after a keycap base that a keycap mark follows (a boxed digit). A run of selectors, or one after any
 * other character, can carry hidden data and does not stay.
 */
function keeps(whole: string, at: number): boolean {
  const code = whole.charCodeAt(at);
  if (code !== 0xfe0e && code !== 0xfe0f) return false;
  const next = whole.charCodeAt(at + 1);
  if (next >= 0xfe00 && next <= 0xfe0f) return false;
  const before = whole.slice(0, at);
  return PICTOGRAPH_END.test(before) || (KEYCAP_END.test(before) && next === 0x20e3);
}

/**
 * `text` with each unseen character replaced by `replace(character)`. `joiners`: also treat ZWJ and ZWNJ as unseen
 * (a match key must show every difference; a card line drops them; the prompt text keeps them).
 */
export function mapUnseen(text: string, joiners: boolean, replace: (character: string) => string): string {
  return text.replace(joiners ? WITH_JOINERS : WITHOUT_JOINERS, (character, at: number, whole: string) => (keeps(whole, at) ? character : replace(character)));
}

/** `text` without the unseen characters. */
export const stripUnseen = (text: string, joiners = false): string => mapUnseen(text, joiners, () => "");

/** Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille blank (U+2800): letters, not format characters, that show as empty space. */
const BLANKS = /[\u115f\u1160\u3164\uffa0\u2800]/gu;

/** `text` without the blank look-alikes: for comparing a name with a fixed word, never for showing it. */
export const stripBlanks = (text: string): string => text.replace(BLANKS, "");
