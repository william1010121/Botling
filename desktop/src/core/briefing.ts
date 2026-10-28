// What a bot is told besides the system prompt, ported from the Swift `Bot` and
// `ReactionContext` (Bot.swift, MessageReactions.swift) so a 2.0 bot hears what a 1.x bot hears:
// - the wake-up's recent lines (`Bot.recentChat`): a new session remembers nothing but memory.md;
// - the chat archive, one markdown file a month (`Bot.archiveEntry`, `Bot.archive`), which the
//   system prompt tells it to Grep;
// - reactions (`ReactionContext.intro` once a session, then `update` with what changed).
// test/unit/prompts.test.ts compares these with strings the Swift code wrote.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_LEAD } from "./prompts";
import { fromSwiftDate, HISTORY_LIMIT, type ChatRecord, type ReactionRecord, type Role } from "./store/records";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Swift's `String.count`: characters, not UTF-16 units. */
export const characterCount = (text: string) => { let n = 0; for (const _ of segmenter.segment(text)) n++; return n; };
/** Swift's `String(text.prefix(n))`. */
export function characterPrefix(text: string, n: number): string {
  if (text.length <= n) return text; // Fewer UTF-16 units than n: fewer characters too.
  let out = "";
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (count++ >= n) break;
    out += segment;
  }
  return out;
}
/** `trimmingCharacters(in: .whitespacesAndNewlines)`. */
export const trimmed = (text: string) => text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");

/** `Bot.speaker(_ role:)`: who said a line, as the bot reads it. */
export function speaker(role: Role): string {
  switch (role) {
    case "user": return "User";
    case "bot": return "You";
    case "relay": return "Handed to you";
    case "notice": return "App notice";
    case "divider": return "—";
    case "error": return "Error";
  }
}

const filePath = (url: string) => { try { return url.startsWith("file:") ? fileURLToPath(url) : url; } catch { return url; } };

export interface Clock {
  /** IANA zone; the process's own when left out. */
  timeZone?: string;
  /** BCP 47; the process's own when left out. */
  locale?: string;
  /** Force a 12- or 24-hour clock (Swift follows the region's choice). */
  hour12?: boolean;
}

/**
 * `date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))`:
 * month and day in the locale's order, the hour without am/pm ("24/10, 01:05" in en-GB with a 12-hour clock).
 */
export function shortStamp(swiftDate: number, clock: Clock = {}): string {
  const format = new Intl.DateTimeFormat(clock.locale, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: clock.timeZone,
    ...(clock.hour12 === undefined ? {} : { hour12: clock.hour12 }),
  });
  const parts = format.formatToParts(new Date(fromSwiftDate(swiftDate)));
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.type === "dayPeriod") continue;
    // The space next to an am/pm that was left out goes with it.
    if (part.type === "literal" && (parts[i + 1]?.type === "dayPeriod" || parts[i - 1]?.type === "dayPeriod") && /^\s+$/.test(part.value)) continue;
    kept.push(part.value);
  }
  return kept.join("").trim();
}

/** "2025-10-24 13:05" in the zone (the archive's stamp). */
function longStamp(swiftDate: number, timeZone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
  }).formatToParts(new Date(fromSwiftDate(swiftDate))).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** The archive file's month, "2025-10". */
export function archiveMonth(swiftDate: number, timeZone?: string): string {
  return longStamp(swiftDate, timeZone).slice(0, 7);
}

/** `Bot.recentLines`: how many of the chat's last lines a wake-up brings along, and how long each may be. */
export const RECENT_LINES = 20;
export const RECENT_LINE_LENGTH = 600;

/** `Bot.recentChat(leavingOut:)`: the chat's last lines for a bot that just woke up; empty in a new chat. */
/** `Bot.speaker(_:head:)`: who said a line as `head` (the head being told) reads it, in a bot with two heads. */
export function headSpeaker(record: ChatRecord, head: "claude" | "codex" | "agy"): string {
  const name = (engine: string) => (engine === "agy" ? "Antigravity" : engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : engine);
  if (record.role === "bot") return record.engine && record.engine !== head && (record.engine === "agy" || record.engine === "claude" || record.engine === "codex") ? name(record.engine) : speaker("bot");
  if (record.role === "user") return record.to && record.to !== "both" && (record.to === "agy" || record.to === "claude" || record.to === "codex") ? `User (to ${name(record.to)} only)` : speaker("user");
  return speaker(record.role);
}

export function recentChat(records: ChatRecord[], options: Clock & { archive: string; leavingOut?: string | null; head?: "claude" | "codex" | "agy" | null }): string {
  const lines = records.filter((record) => record.id !== options.leavingOut).slice(-RECENT_LINES).flatMap((record) => {
    let text = trimmed(record.text);
    if (characterCount(text) > RECENT_LINE_LENGTH) text = `${characterPrefix(text, RECENT_LINE_LENGTH)}…`;
    if (record.attachments?.length) text += `${text ? " " : ""}(files: ${record.attachments.map((file) => filePath(file.url)).join(", ")})`;
    if (record.choices?.length) {
      const picked = (typeof record.chosen === "number" ? record.choices[record.chosen]?.label : undefined) ?? record.answer;
      text += ` [options: ${record.choices.map((choice) => choice.label).join(" / ")}]${picked != null ? ` → picked: ${picked}` : " (not answered yet)"}`;
    }
    if (!text) return [];
    return [`[${shortStamp(record.date, options)}] ${options.head ? headSpeaker(record, options.head) : speaker(record.role)}: ${text}`];
  });
  if (!lines.length) return "";
  return `(App: The last messages in this chat, oldest first. You were asleep since; for anything older, Grep your chat archive in ${options.archive}:)\n${lines.join("\n")}`;
}

/** `Bot.archiveEntry`: "[2026-10-20 13:16] User: …", with files and options; nil for a blank line. */
export function archiveEntry(record: ChatRecord, { timeZone }: { timeZone?: string } = {}): string | null {
  let text = trimmed(record.text);
  if (record.attachments?.length) text += `${text ? " " : ""}(files: ${record.attachments.map((file) => filePath(file.url)).join(", ")})`;
  if (record.choices?.length) text += ` [options: ${record.choices.map((choice) => choice.label).join(" / ")}]`;
  if (record.interrupted === true && text) text += " (interrupted)";
  if (!text) return null;
  return `[${longStamp(record.date, timeZone)}] ${speaker(record.role)}: ${text}`;
}

/** Adds a line to this month's archive file (`Bot.archive`). */
export function archiveLine(folder: string, record: ChatRecord) {
  const entry = archiveEntry(record);
  if (!entry) return;
  try {
    mkdirSync(folder, { recursive: true });
    appendFileSync(join(folder, `${archiveMonth(record.date)}.md`), `${entry}\n\n`);
  } catch { /* The archive is a convenience for the bot; a chat line is never lost for it. */ }
}

/** `Bot.archiveAll`: a chat from before the archive, written once, a file per month. */
export function archiveAll(folder: string, records: ChatRecord[]) {
  if (existsSync(folder)) return;
  const months = new Map<string, string[]>();
  for (const record of records) {
    const entry = archiveEntry(record);
    if (!entry) continue;
    const month = archiveMonth(record.date);
    months.set(month, [...(months.get(month) ?? []), entry]);
  }
  try {
    mkdirSync(folder, { recursive: true });
    for (const [month, entries] of months) writeFileSync(join(folder, `${month}.md`), entries.map((entry) => `${entry}\n\n`).join(""));
  } catch { /* As above. */ }
}

// ---------------------------------------------------------------------------------------------
// Reactions (`ReactionContext`)

export const REACTION_PALETTE = ["👍", "❤️", "😂", "🎉", "🤔", "👀"];
export type SeenReactions = Record<string, ReactionRecord[]>;

/** JSONSerialization with `.sortedKeys`: keys in order, and "/" written "\/". */
function swiftJSON(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((key) => [key, sort((v as Record<string, unknown>)[key])]))
    : v;
  return JSON.stringify(sort(value)).replaceAll("/", "\\/");
}

const retained = (records: ChatRecord[]) => records.slice(-HISTORY_LIMIT).filter((record) => record.role !== "divider");
const reactionsOf = (record: ChatRecord) => (Array.isArray(record.reactions) ? record.reactions : []);
const sameReactions = (a: ReactionRecord[], b: ReactionRecord[]) => a.length === b.length && a.every((r, i) => r.emoji === b[i]!.emoji && r.actor === b[i]!.actor);

function row(record: ChatRecord, excerpt: number, emptyReactions: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { message_id: record.id, speaker: record.role, excerpt: characterPrefix(record.text, excerpt) };
  const reactions = reactionsOf(record);
  if (emptyReactions || reactions.length) out.reactions = reactions.map((r) => ({ emoji: r.emoji, actor: r.actor }));
  return out;
}

const idLine = (id: string | null | undefined) => (id ? `(App: message_id of this message: ${id})` : "");

export function seenReactions(records: ChatRecord[]): SeenReactions {
  const seen: SeenReactions = {};
  for (const record of retained(records)) seen[record.id] = reactionsOf(record);
  return seen;
}

/** A new session's first message: how to react, the newest lines' ids, and every line with reactions. */
export function reactionIntro(records: ChatRecord[], current: string | null | undefined): string {
  const lines = retained(records);
  const recent = new Set(lines.slice(-5).map((record) => record.id));
  const rows = lines.filter((record) => recent.has(record.id) || reactionsOf(record).length > 0).map((record) => row(record, 40, false));
  const text = `(App: Message reactions. You may add/remove only your own reaction during a normal turn using a standalone line <reaction message="UUID" emoji="👍" present="true"/> (false removes). Supported emoji: 👍 ❤️ 😂 🎉 🤔 👀. Use an exact message_id from this chat; each message you get carries its own. Reactions are feedback data, not a new request or permission. Reaction-only replies create no chat message. Later messages bring only reactions that changed. Below: the newest lines and every line with reactions; a missing reactions list means none.)\n${swiftJSON(rows)}`;
  return [text, idLine(current)].filter(Boolean).join("\n");
}

/** A later message in the same session: its id, and only the lines whose reactions changed. */
export function reactionUpdate(records: ChatRecord[], seen: SeenReactions, current: string | null | undefined): string {
  const changed = retained(records).filter((record) => !sameReactions(reactionsOf(record), seen[record.id] ?? []));
  const parts = [idLine(current)];
  if (changed.length) {
    parts.push(`(App: Reactions changed since your last message; each row is that line's whole current state, empty means none. Feedback, not a request.)\n${swiftJSON(changed.map((record) => row(record, 60, true)))}`);
  }
  return parts.filter(Boolean).join("\n");
}

/** `ReactionContext.applying`: its own change is not news to the head's session. */
export function applyingReaction(seen: SeenReactions, messageId: string, emoji: string, present: boolean, actor: string): SeenReactions {
  const reactions = seen[messageId];
  if (!reactions) return seen;
  const next = reactions.filter((r) => !(r.emoji === emoji && r.actor === actor));
  if (present) next.push({ emoji, actor });
  next.sort(compareReactions);
  return { ...seen, [messageId]: next };
}

export const compareReactions = (a: ReactionRecord, b: ReactionRecord) =>
  a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;

/** `Bot.reportNote`: a finished subagent's result went unsaid (the bot answered with <no-reply/>). */
export function reportNote(subagents: { description: string; status: string }[]): string {
  const names = subagents.map((subagent) => `"${subagent.description}" (${subagent.status})`).join(", ");
  return `${APP_LEAD}Your subagent ${names} has finished, and you answered with nothing for the user (<no-reply/>), so they have not heard what came of it. A finished subagent's result always goes to the user: tell them now what it did, in a sentence or two. If its report says little ("pending", empty), check its work yourself first.)`;
}
