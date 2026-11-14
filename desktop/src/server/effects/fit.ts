// Oversized lines (protocol v1 §5.2, §8.1): an entry must fit one frame (`ENTRY_BYTES_LIMIT`, about 252 KiB), while a
// 2.x line may hold up to 400,000 characters (about 1.2 MB of UTF-8 in the worst case) and a turn's steps up to 500.
//
// Choice: cut, and keep the whole text elsewhere. An entry whose body is too big carries the text cut at a character
// boundary, followed by a visible note saying how much is missing; the whole text goes into `fulltext` (server.db, the
// same transaction, key = the line id or "turn:<turnId>"). Why not split one line over several entries: a line is one
// `message.added`/`message.updated` (§8.1) and every reader (snap, history, the renderer) shows one line per id; a split
// would need a new entry kind and reassembly on every front end. The cut text is what the log, snap and history show;
// the engine always got the whole text (a user's message goes to the core from the effect row, never from the entry),
// the core keeps the whole line in its own store, and the 2.x exports (`chat.json`, src/server/exports) are written
// from the core's own records (the bot store's `rows`, never these entries), so bots read the whole text. A later step can offer the whole text on demand through the content path (§9A).
//
// Steps (`turn.steps`, a line's `steps`) are cut from the oldest end: the newest steps are what a reader needs.
import { canonicalJson } from "../../protocol";
import { ENTRY_BYTES_LIMIT } from "../log";

/** Room for the entry's own fields around its body (stream, logId, seq, hlc, slot, hash, kind). */
const ENTRY_FIELDS = 1_024;
export const BODY_BYTES_LIMIT = ENTRY_BYTES_LIMIT - ENTRY_FIELDS;

export function cutNote(missing: number): string {
  return `\n\n… (${missing} more characters are not shown here; the whole text is kept with the bot's chat)`;
}

export interface Fitted {
  body: Record<string, unknown>;
  /** The whole text, when the body's text had to be cut. */
  full: string | null;
  /** Nothing could make it fit (never for the kinds below); the caller logs and skips it. */
  dropped: boolean;
}

const bytes = (value: unknown) => Buffer.byteLength(canonicalJson(value));

/** The longest prefix of `text` whose UTF-8 size is at most `budget` bytes, never splitting a surrogate pair. */
export function prefixWithin(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (Buffer.byteLength(text) <= budget) return text;
  let low = 0;
  let high = Math.min(text.length, budget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let end = low;
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** Cuts `holder[key]` (a string) so that `whole` fits `limit`; returns the original text, or null when it was not cut. */
function cutText(whole: Record<string, unknown>, holder: Record<string, unknown>, key: string, limit: number): string | null {
  const text = holder[key];
  if (typeof text !== "string") return null;
  const over = bytes(whole) - limit;
  if (over <= 0) return null;
  const textBytes = Buffer.byteLength(text);
  // The note itself takes room; its number has at most 7 digits here (≤ 400,000 characters).
  const keep = prefixWithin(text, textBytes - over - Buffer.byteLength(cutNote(9_999_999)) - 64);
  holder[key] = keep + cutNote(text.length - keep.length);
  return text;
}

/** Drops the oldest steps until `whole` fits (keeps at least none). */
function cutSteps(whole: Record<string, unknown>, holder: Record<string, unknown>, limit: number): void {
  const steps = holder.steps;
  if (!Array.isArray(steps) || !steps.length) return;
  let kept = steps.slice();
  while (kept.length && bytes(whole) > limit) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 4)));
    holder.steps = kept;
  }
}

/**
 * Makes an entry body of `kind` fit one frame. Kinds with text (`message.added/updated`, `turn.finished`,
 * `turn.interrupted`) cut it; kinds with steps drop the oldest. Bodies that already fit come back unchanged (same object).
 */
export function fitBody(kind: string, body: Record<string, unknown>, limit = BODY_BYTES_LIMIT): Fitted {
  if (bytes(body) <= limit) return { body, full: null, dropped: false };
  const copy = structuredClone(body);
  let full: string | null = null;
  switch (kind) {
    case "message.added":
    case "message.updated": {
      const message = copy.message as Record<string, unknown> | undefined;
      if (message) {
        cutSteps(copy, message, limit);
        full = cutText(copy, message, "text", limit);
      }
      break;
    }
    case "turn.finished":
    case "turn.interrupted":
      full = cutText(copy, copy, "text", limit);
      break;
    case "turn.steps":
      cutSteps(copy, copy, limit);
      break;
    default:
      break;
  }
  return { body: copy, full, dropped: bytes(copy) > limit };
}
