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
// Steps (`turn.steps`, a line's `steps`, a sub-agent's `steps`) are cut from the oldest end: the newest steps are what a reader
// needs. A `subagent.updated` is never dropped whole (a dropped one froze the rail row until a resync, 440 times in one run).
// `components.updated` loses its biggest templates first when the record is over a frame.
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

/**
 * Drops the oldest steps until `whole` fits (keeps at least none): the longest newest run that fits is kept. Each step is
 * measured once and the kept run is found by one walk from the newest end, so a body with hundreds of steps is not
 * serialised again for every try (the check at the end is the only whole-body measure, and it normally passes at once).
 */
function cutSteps(whole: Record<string, unknown>, holder: Record<string, unknown>, limit: number): void {
  const steps = holder.steps;
  if (!Array.isArray(steps) || !steps.length) return;
  const sizes = steps.map((step) => bytes(step));
  // What the body costs with no step: the whole minus every step and the commas between them.
  const rest = bytes(whole) - sizes.reduce((sum, size) => sum + size, 0) - (steps.length - 1);
  let start = steps.length;
  let used = rest;
  while (start > 0) {
    const next = used + sizes[start - 1] + (start < steps.length ? 1 : 0);
    if (next > limit) break;
    used = next;
    start -= 1;
  }
  holder.steps = steps.slice(start);
  // The sum is exact for canonical JSON; should it ever be off, step the start forward until the real size fits.
  while (start < steps.length && bytes(whole) > limit) {
    start += 1;
    holder.steps = steps.slice(start);
  }
}

/**
 * Components over the limit: the biggest templates leave the record first, so the rest still reach the page. The body then
 * carries `partial: true` (the contract's `components.updated`): the page keeps the ones it has for the names left out.
 */
function cutComponents(whole: Record<string, unknown>, limit: number): void {
  const components = whole.components;
  if (typeof components !== "object" || components === null) return;
  const sizes = Object.entries(components as Record<string, unknown>).map(([name, info]) => ({ name, size: bytes(info) + bytes(name) + 2 }));
  sizes.sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : 1));
  let over = bytes(whole) - limit;
  const left = { ...(components as Record<string, unknown>) };
  let cut = false;
  for (const { name, size } of sizes) {
    if (over <= 0) break;
    delete left[name];
    cut = true;
    over -= size;
  }
  whole.components = left;
  if (cut) {
    whole.partial = true;
    // The marker takes room too ("partial":true plus a comma): drop one more template if that tipped it over.
    for (const { name } of sizes) {
      if (bytes(whole) <= limit) break;
      if (Object.hasOwn(left, name)) delete left[name];
    }
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
    case "subagent.updated": {
      // A sub-agent's view holds up to 500 steps of 10 KB output each: the oldest steps go, as in a turn's steps.
      const subagent = copy.subagent as Record<string, unknown> | undefined;
      if (subagent) {
        cutSteps(copy, subagent, limit);
        // The longer text is cut first: a short result must not be cut because the prompt is the one that is too long.
        const size = (key: string) => (typeof subagent[key] === "string" ? Buffer.byteLength(subagent[key] as string) : 0);
        for (const key of size("result") >= size("prompt") ? ["result", "prompt"] : ["prompt", "result"]) cutText(copy, subagent, key, limit);
      }
      break;
    }
    case "components.updated":
      cutComponents(copy, limit);
      break;
    default:
      break;
  }
  return { body: copy, full, dropped: bytes(copy) > limit };
}
