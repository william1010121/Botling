// Text as a call-in frame carries it (M5-01 review F1, M5-02b): the limits count the JSON-escaped UTF-8 bytes of a
// string (`"` and `\` take 2, a control character 2 or 6, a lone surrogate 6, CJK 3), never characters, so a text that is
// cut to a limit here always parses (`callin.reply`, `callin.ask`) and always fits one peer frame.

/** `callin.ask.transcript`, in escaped bytes (contract/index.ts `CALLIN_TRANSCRIPT_BYTES`). */
export const CALLIN_TRANSCRIPT_LIMIT = 64 * 1024;
/** `callin.reply` text, in escaped bytes (contract/index.ts `CALLIN_REPLY_BYTES`). */
export const CALLIN_REPLY_LIMIT = 200 * 1024;
/** `callin.reply` `failed.why`, in UTF-16 units (zod `.max`). */
export const CALLIN_WHY_LIMIT = 1_000;
/** `callin.reply` `guest.name`, in UTF-16 units (zod `.max`). */
export const CALLIN_NAME_LIMIT = 200;

const encoder = new TextEncoder();

/** The UTF-8 bytes of `text` as JSON writes it into a frame (the quotes not counted). */
export const escapedBytes = (text: string): number => encoder.encode(JSON.stringify(text)).length - 2;

/** `escapedBytes` of one code point (`ch` is one element of `for (const ch of text)`), without encoding it. */
function pointBytes(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code < 0x20) return code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6; // a lone surrogate is written as \udXXX
  return code < 0x10000 ? 3 : 4;
}

/**
 * `text` cut at a character boundary so that `text` + `marker` is at most `limit` escaped bytes (the text itself when it
 * already fits). Keeps the start; the marker says it was cut.
 */
export function cutEscaped(text: string, limit: number, marker = ""): string {
  if (escapedBytes(text) <= limit) return text;
  const budget = limit - escapedBytes(marker);
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const bytes = pointBytes(ch);
    if (used + bytes > budget) break;
    used += bytes;
    end += ch.length;
  }
  return text.slice(0, end) + marker;
}

/**
 * `lines` joined with "\n", the OLDEST lines dropped until the whole is at most `limit` escaped bytes (M5-02c: a call-in's
 * transcript slice keeps the newest lines, which carry the ask). A single newest line that alone is over the limit is cut
 * to fit, keeping its start. "" for no lines.
 */
export function cutOldest(lines: readonly string[], limit: number): string {
  let start = lines.length;
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // The "\n" between two lines is 2 escaped bytes.
    const bytes = escapedBytes(lines[i]!) + (start < lines.length ? 2 : 0);
    if (used + bytes > limit) break;
    used += bytes;
    start = i;
  }
  if (start === lines.length) return lines.length ? cutEscaped(lines[lines.length - 1]!, limit) : "";
  return lines.slice(start).join("\n");
}

/**
 * `text` cut to at most `max` UTF-16 units (what zod's string `.max` counts), at a code point boundary so no surrogate
 * pair is split. `oneLine` counts user-perceived characters, and one of those can be many units (an emoji family is 11).
 */
export function cutUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  for (const ch of text) {
    if (end + ch.length > max) break;
    end += ch.length;
  }
  return text.slice(0, end);
}
