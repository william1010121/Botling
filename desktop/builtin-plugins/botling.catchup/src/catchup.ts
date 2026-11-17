// Catch-up (botling.catchup's program part). UI only: the chat, its archive and the bot's processes never see it;
// the chat page draws it as a message decoration (web.ts). No model is called and nothing is summarized.
//
// Coming back to a chat with more than `catchUpThreshold` (3) unread replies keeps at most three of them
// in the chat, the ones that matter most, and folds the rest behind a small header (`arrive`). The three are
// chosen by rules, in this order, until the slots are full:
//   1. questions still waiting for your pick (a <choices> card): these are never folded, even past three;
//   2. errors (a failure notice);
//   3. replies that carry a card (<show>), newest first;
//   4. the newest bot replies.
// The chosen ones stay ordinary, live messages (their component frames get built); the rest fold as before.
import { isSummaryReply } from "./util";

/** A line of the chat as `chat.messages` gives it (the stored record; only what the picking reads is named). */
export interface ChatRecord {
  id: string;
  role: string;
  text: string;
  /** Swift date (seconds since 2001). */
  date: number;
  engine?: string;
  choices?: { label: string; detail?: string | null }[];
  chosen?: number;
  answer?: string;
  /** A question group (several questions, one Submit); `choices` is then the first one's options. */
  questions?: unknown[];
  picks?: unknown[];
  ignoredAt?: string;
  questionInvalidatedAt?: string;
  displays?: unknown;
}

/**
 * A reply still waiting for your pick: a <choices> card, a question group or a multi-select with no pick,
 * no answer, not ignored (the core's records.ts `isOpenQuestion`). It never folds.
 */
export const isOpenQuestion = (record: ChatRecord): boolean =>
  !!record.choices?.length && record.chosen == null && record.answer == null && record.ignoredAt == null && record.questionInvalidatedAt == null;

export const DEFAULT_THRESHOLD = 3;
/** How many messages stay in view (open questions apart, which never fold). */
export const MAX_CARDS = 3;

export const clampedThreshold = (value: number) => Math.min(50, Math.max(1, Math.round(value)));

/** The roles `Bot.unreadCount` counts. */
const counts = (role: string) => role === "bot" || role === "notice" || role === "error" || role === "relay";

/** The tail holding the last `unread` counted lines, with what lies between them; starts at a counted line. */
export function unreadMessages(messages: ChatRecord[], unread: number): ChatRecord[] {
  if (unread <= 0) return [];
  const taken: ChatRecord[] = [];
  let counted = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    taken.push(messages[i]!);
    if (counts(messages[i]!.role) && ++counted === unread) break;
  }
  while (taken.length && !counts(taken.at(-1)!.role)) taken.pop();
  return taken.reverse();
}

/** Top-level replies and app notices; tools and workers are not messages. */
export const replyCount = (messages: ChatRecord[]) => messages.filter(isSummaryReply).length;

const isFailure = (record: ChatRecord) => record.role === "error";
const hasCard = (record: ChatRecord) => counts(record.role) && Array.isArray(record.displays) && record.displays.length > 0;
const isBotReply = (record: ChatRecord) => record.role === "bot";

/**
 * The messages that stay in view, in chat order: every open question, then errors, then replies with cards,
 * then the newest bot replies, until `limit` are chosen (newest first within each rule). Pure rules.
 */
export function topCards(messages: ChatRecord[], limit = MAX_CARDS): ChatRecord[] {
  const chosen = new Set<ChatRecord>(messages.filter(isOpenQuestion));
  const newestFirst = [...messages].reverse();
  for (const rule of [isFailure, hasCard, isBotReply]) {
    for (const record of newestFirst) {
      if (chosen.size >= limit) break;
      if (rule(record)) chosen.add(record);
    }
  }
  return messages.filter((record) => chosen.has(record));
}

export interface CatchUpSettings {
  catchUpEnabled: boolean;
  catchUpThreshold: number;
}

/** This plugin's settings (package.json `contributes.settings`); Settings → Chat & reports sets them. */
export const SETTING = {
  unread: "botling.catchup.unread",
  unreadThreshold: "botling.catchup.unreadThreshold",
} as const;

/**
 * The settings as catch-up uses them, from `api.settings.get`. Keys an earlier version kept (the summary model,
 * engine and prompt, the interval switch, the individual thresholds) are never read: they stay where they are.
 */
export function catchUpSettings(get: (key: string) => unknown): CatchUpSettings {
  const threshold = get(SETTING.unreadThreshold);
  return {
    catchUpEnabled: get(SETTING.unread) !== false,
    catchUpThreshold: clampedThreshold(typeof threshold === "number" ? threshold : DEFAULT_THRESHOLD),
  };
}

/** What the core knows of a chat for catch-up. */
export interface CatchUpChat {
  id: string;
  name: string;
  records: ChatRecord[];
  unread: number;
}

/** What the page draws: the folded lines and how many messages stayed in view. */
export interface CatchUpViewData {
  /** The range folded. */
  key: string;
  ids: string[];
  /** How many messages stayed in view. */
  important: number;
}

/** The fold as the chat page gets it (`chat.decorate`): its lines folded behind a header (web.ts draws it). */
export interface CatchUpDecoration {
  key: string;
  fold: string[];
  data: CatchUpViewData & { kind: "unread" };
}

interface Fold {
  key: string;
  folded: string[];
  kept: string[];
}

/** Every chat's fold (`Workspace.catchUps`). */
export class CatchUps {
  private folds = new Map<string, Fold>();

  constructor(private options: { settings: () => CatchUpSettings; changed: (chatId: string) => void }) {}

  /** You came back to `chat`: with more than the threshold of unread replies, all but the top few fold. */
  arrive(chat: CatchUpChat) {
    const settings = this.options.settings();
    if (!settings.catchUpEnabled) return;
    const unread = unreadMessages(chat.records, chat.unread);
    if (replyCount(unread) <= settings.catchUpThreshold) return;
    const kept = new Set(topCards(unread));
    const folded = unread.filter((record) => !kept.has(record));
    // Nothing worth folding (only lines that are not replies, or all of them are kept): no header.
    if (!replyCount(folded)) return;
    const key = `${folded[0]!.id}-${folded.at(-1)!.id}`;
    const current = this.folds.get(chat.id);
    const next = { key, folded: folded.map((record) => record.id), kept: [...kept].map((record) => record.id) };
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    this.folds.set(chat.id, next);
    this.options.changed(chat.id);
  }

  /** What the page draws for a chat, as the chat stands now: the lines folded then that are still there. */
  decorations(chat: CatchUpChat): CatchUpDecoration[] {
    const fold = this.folds.get(chat.id);
    if (!fold) return [];
    const present = new Set(chat.records.map((record) => record.id));
    const ids = fold.folded.filter((id) => present.has(id));
    if (!ids.length) return [];
    return [{ key: `unread:${fold.key}`, fold: ids, data: { kind: "unread", key: fold.key, ids, important: fold.kept.filter((id) => present.has(id)).length } }];
  }
}
