// Text as a call-in frame carries it (M5-01 review F1, M5-02b): the limits count the JSON-escaped UTF-8 bytes of a
// string (`"` and `\` take 2, a control character 2 or 6, a lone surrogate 6, CJK 3), never characters, so a text that is
// cut to a limit here always parses (`callin.reply`, `callin.ask`) and always fits one peer frame.

/** `callin.ask.transcript`, in escaped bytes (contract/index.ts `CALLIN_TRANSCRIPT_BYTES`). */
export const CALLIN_TRANSCRIPT_LIMIT = 64 * 1024;
/** `callin.reply` text, in escaped bytes (contract/index.ts `CALLIN_REPLY_BYTES`). */
export const CALLIN_REPLY_LIMIT = 200 * 1024;
/** `callin.reply` `failed.why`, in characters. */
export const CALLIN_WHY_LIMIT = 1_000;

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
