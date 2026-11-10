// Bots answering in chats that are not their own (1.x's CallIn.swift, BotMentions.swift and the
// running half of GroupChat.swift): the turns, one at a time per chat, each from the guest's own
// session; its line in the chat under its own name; your pick or words on its line go back to it.
// The strings are groups.ts's (checked against the Swift app's).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot, GuestAnswer } from "./bot";
import { writeFileAtomic } from "./durable/atomic";
import {
  BOT_MENTIONS_PER_USER_LINE, GROUP_TIMING, botAnswerNote, botFollowUpNote, botFollowUpMissedNote, botUnansweredNote, botCallInPrompt, botCallInWorkNote, callInWorkNote, botMentionCandidates, callInNote, callInPrompt, firstLineOf, heardSinceLastTurn,
  isPass, mentionBody, mentioned, quoteName, transcriptBefore, type Member,
} from "./groups";
import { parseReply, type BotRequest } from "./reply";
import { specTrace } from "./spec-trace";
import { newId, toSwiftDate, type ChatRecord } from "./store/records";

/** A delivered bot @ (`BotMentionRecord`), kept so the same reply is not delivered again. */
export interface BotMentionRecord { message: string; sender: string; recipient: string; body: string; date: string }

/**
 * bot-mentions.json (`BotMentionLog`): the bot @s delivered, newest last, at most 500; written before the
 * call-in starts, so a crash can lose a delivery but never repeat one. An unreadable file is never
 * overwritten: nothing is delivered until it reads again. Dates are ISO 8601, as 1.x writes this file.
 */
export class BotMentionLog {
  static readonly kept = 500;
  records: BotMentionRecord[] = [];
  private unreadable = false;

  constructor(readonly file: string) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    try {
      const value = JSON.parse(text);
      if (!Array.isArray(value)) throw new Error("not a list");
      this.records = value.filter((entry): entry is BotMentionRecord => !!entry && typeof entry.message === "string" && typeof entry.sender === "string" && typeof entry.recipient === "string" && typeof entry.body === "string" && typeof entry.date === "string");
    } catch {
      this.unreadable = true;
    }
  }

  add(record: BotMentionRecord) {
    if (this.unreadable) throw new Error("bot-mentions.json could not be read");
    const next = [...this.records, record].slice(-BotMentionLog.kept);
    writeFileAtomic(this.file, JSON.stringify(next.map((entry) => ({ ...entry, date: entry.date.replace(/\.\d{3}Z$/, "Z") }))));
    this.records = next;
  }
}

export interface ConversationsDeps {
  dataDir: string;
  /** Everyone who can answer outside their own chat, in turn order: the main bot, projects and bots, Maintainer (`everyMember`). */
  members: () => Member[];
  /** Sub bots, each under its project bot: callable with @ in that bot's chat only (null: none). */
  subBots?: () => (Member & { parent: string })[];
  bot: (id: string) => Bot | null;
  mainBotId: string;
  /** A guest's line was posted: plugins' bots.onReply hear it as that bot's reply. */
  replied?: (bot: Bot, line: ChatRecord) => void;
  /** Plugins' afterReply hooks for a bot's reply (null: none). */
  replyFilter: (bot: Bot) => ((text: string) => Promise<string>) | null;
  /** Acts on the tags in a guest's reply, as from its own chat. */
  handle: (bot: Bot, requests: BotRequest[]) => void;
  /** After the main bot's turn: what it wrote into inboxes goes out (`deliverInboxes`). */
  afterMainTurn: () => void;
  /** A bot's row changed with the call-ins: who answers or waits in its chat, or whether it answers in another. */
  speaking: (botId: string) => void;
  refreshWaiting: () => void;
  /** What a bot is told of components your words name with / (`components.mentionNote(for:)`). */
  mentionNote?: (text: string) => string | null;
  log: (line: string) => void;
  timing?: typeof GROUP_TIMING;
}

/** A bot @ (`BotMention`): the reply that did it, whom it named, the words for it. */
interface BotMention { message: string; recipient: string; body: string; depth?: number }

/** A call-in not answered yet: whom, since when (ms), the words a bot's @ gave it, and whether its turn has come. */
interface PendingCallIn { member: Member; since: number; body: string | null; state: "queued" | "answering" }

/** `HH:mm` in local time, as the chat shows it. */
const clock = (ms: number) => { const date = new Date(ms); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };

/** How many bot-to-bot hops one user line may start: the asker's follow-up reply may still @ once more, no further. */
const MAX_FOLLOW_DEPTH = 2;

export class Conversations {
  readonly mentionLog: BotMentionLog;
  /** Who answers in a chat right now (`callInSpeakers`, `groupSpeakers`), by the chat's id. */
  readonly speakers = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();
  /** Call-ins started and not answered yet, by the chat's id, in turn order. */
  private pending = new Map<string, PendingCallIn[]>();

  constructor(private readonly deps: ConversationsDeps) {
    this.mentionLog = new BotMentionLog(join(deps.dataDir, "bot-mentions.json"));
  }

  /** How long a guest waits for a busy bot and may take (`groupTiming`). */
  get groupTiming() { return this.deps.timing ?? GROUP_TIMING; }
  private get timing() { return this.groupTiming; }

  /** Everyone who can answer outside their own chat, in turn order (`everyMember`). */
  members(): Member[] { return this.deps.members(); }

  /** Components `text` names with / (`components.mentionNote(for:)`). */
  mentionNote = (text: string): string | null => this.deps.mentionNote?.(text) ?? null;

  /** Who a member id is (`speakerName(for:)`). */
  speakerName = (id: string): string | null => [...this.deps.members(), ...(this.deps.subBots?.() ?? [])].find((member) => member.id === id)?.name ?? null;

  /** The call-ins in `chatId` not answered yet: who, and whether answering or waiting their turn. */
  callIns(chatId: string): { id: string; state: "queued" | "answering" }[] {
    return (this.pending.get(chatId) ?? []).map((entry) => ({ id: entry.member.id, state: entry.state }));
  }

  /** The chat `botId` is answering a call-in in now (null: none). */
  answeringIn(botId: string): string | null {
    for (const [chatId, entries] of this.pending) if (entries.some((entry) => entry.state === "answering" && entry.member.id === botId)) return chatId;
    return null;
  }

  /** For the chat's own bot, with its next turn: its @s still being answered or waiting (status only). */
  callInStatus(chatId: string): string | null {
    const lines = (this.pending.get(chatId) ?? []).filter((entry) => entry.body !== null).map((entry) => entry.state === "answering"
      ? `(App: ${quoteName(entry.member.name)} is still answering your @ from ${clock(entry.since)}.)`
      : `(App: ${quoteName(entry.member.name)} is queued to answer your @ from ${clock(entry.since)}, after another call-in.)`);
    // The @s that failed since its last turn: told once, so it can say so to the user.
    lines.push(...(this.failures.get(chatId) ?? []));
    this.failures.delete(chatId);
    return lines.length ? lines.join("\n") : null;
  }

  /** Per chat, what its own bot is told with its next turn about @s that were not delivered or not answered. */
  private failures = new Map<string, string[]>();

  /** An @ of `chat`'s own bot failed: the chat gets the notice (`words`), and the bot itself is told too, so it can tell the user. */
  private failed(chat: Bot, words: string) {
    chat.appNotice(words);
    const lines = this.failures.get(chat.id) ?? [];
    this.failures.set(chat.id, [...lines.slice(-4), `(App: Your @ was not delivered or not answered. ${words} Tell the user so; do not ask the same bot again unless the user says so.)`]);
  }

  /** A spec trace line (spec/models/callin) in `chatId`, with what its pending list shows then. */
  private trace(action: string, chatId: string, state: Record<string, unknown>) {
    specTrace("callin", action, { chat: chatId, ...state, pending: this.callIns(chatId) });
  }

  private settle(chatId: string, entry: PendingCallIn) {
    const entries = this.pending.get(chatId) ?? [];
    if (!entries.includes(entry)) return;
    const left = entries.filter((other) => other !== entry);
    if (left.length) this.pending.set(chatId, left); else this.pending.delete(chatId);
    this.deps.speaking(chatId);
  }

  /** `chatId`'s own sub bots. */
  private subBotsOf(chatId: string): Member[] {
    return (this.deps.subBots?.() ?? []).filter((sub) => sub.parent === chatId).map(({ id, name }) => ({ id, name }));
  }

  /**
   * The names a bot's @ can be written with, for `chatId`'s chat: every project bot by its name, every sub bot by
   * its full path ("Parent/Sub"), and by its name alone the chat's own sub bots (and, to say they are out of
   * reach, other bots' sub bots).
   */
  private mentionAliases(chatId: string): { member: Member; name: string; full: boolean; own: boolean; path: string }[] {
    const tops = this.deps.members();
    const own = this.subBotsOf(chatId);
    const aliases: { member: Member; name: string; full: boolean; own: boolean; path: string }[] = tops.map((member) => ({ member, name: member.name, full: true, own: true, path: member.name }));
    for (const sub of this.deps.subBots?.() ?? []) {
      const parent = tops.find((member) => member.id === sub.parent);
      const member = { id: sub.id, name: sub.name };
      const isOwn = own.some((candidate) => candidate.id === sub.id);
      const path = parent ? `${parent.name}/${sub.name}` : sub.name;
      if (parent) aliases.push({ member, name: path, full: true, own: isOwn, path });
      aliases.push({ member, name: sub.name, full: false, own: isOwn, path });
    }
    return aliases;
  }

  /**
   * Which bot a line starting with @ names in `chatId`'s chat: a full name ("Parent/Sub" or a project bot's name)
   * names that one bot; a sub bot's name alone names it while exactly one bot here has that name. Longer names win.
   */
  private resolveMention(candidate: string, chatId: string):
    | { kind: "bot" | "elsewhere"; member: Member; written: string }
    | { kind: "ambiguous"; note: string }
    | { kind: "unknown" } {
    const aliases = this.mentionAliases(chatId).map((alias, index) => ({ ...alias, id: String(index) }));
    const first = mentioned(candidate, aliases)[0];
    if (!first || !candidate.toLowerCase().startsWith("@" + first.name.toLowerCase())) return { kind: "unknown" };
    const key = first.name.toLowerCase();
    const same = aliases.filter((alias) => alias.name.toLowerCase() === key);
    // The bots it can mean here: those with that full name, and the chat's own sub bots by their name alone.
    const reachable = same.filter((alias) => alias.full || alias.own);
    const pick = reachable.length ? reachable : same;
    const distinct = [...new Map(pick.map((alias) => [alias.member.id, alias])).values()];
    if (distinct.length > 1) {
      const paths = [...new Set(distinct.map((alias) => alias.path))];
      const shown = paths.map((path) => `@${path}`).join(", ");
      const note = paths.length < distinct.length
        ? `Not sent with @: ${distinct.length} bots are named "${first.name}" (${shown}) and @ cannot tell them apart; rename one.`
        : `Not sent with @: ${distinct.length} bots are named "${first.name}" (${shown}); write the full name, @Parent/${first.name} (e.g. ${`@${paths.find((path) => path.includes("/")) ?? paths[0]}`}).`;
      return { kind: "ambiguous", note };
    }
    const one = distinct[0]!;
    return { kind: reachable.length ? "bot" : "elsewhere", member: one.member, written: first.name };
  }

  /** The bots that can be called into `chat` with @: everyone but its own bot, and its own sub bots (`callable(into:)`). */
  callable(chatId: string): Member[] {
    const members = this.deps.members();
    if (members.some((member) => member.id === chatId)) return [...members.filter((member) => member.id !== chatId), ...this.subBotsOf(chatId)];
    // A sub bot may call the project bots in (its parent too), never another bot's sub bots.
    return (this.deps.subBots?.() ?? []).some((sub) => sub.id === chatId) ? members : [];
  }

  /** The names the @ menu offers (the main bot and Maintainer), then every other bot (`callInView`). */
  mentionNames(chatId: string, offered: string[]): { names: string[]; allNames: string[] } {
    const callable = this.callable(chatId);
    const first = callable.filter((member) => offered.includes(member.id));
    const rest = callable.filter((member) => !offered.includes(member.id));
    return { names: first.map((member) => member.name), allNames: [...first, ...rest].map((member) => member.name) };
  }

  /** The bots your words call into `chat` (`calledIn`). */
  calledIn(text: string, chatId: string): Member[] {
    const callable = this.callable(chatId);
    if (!callable.length) return [];
    // A sub bot may also be named by its full path, @Parent/Sub.
    const paths = this.mentionAliases(chatId).filter((alias) => alias.full && callable.some((member) => member.id === alias.member.id))
      .map((alias, index) => ({ id: `path:${index}`, name: alias.name, member: alias.member }));
    const named = mentioned(text, [...callable.map((member) => ({ ...member, member })), ...paths]).map((entry) => entry.member);
    return [...new Map(named.map((member) => [member.id, member])).values()];
  }

  /** What goes to the chat's own bot, unseen, with your line: what guests said since, who else answers. */
  notes(chat: Bot, called: Member[], words = ""): string | null {
    const notes = [heardSinceLastTurn(chat.lines(), this.speakerName), callInNote(called), this.mentionNote(words)].filter((note): note is string => !!note);
    return notes.length ? notes.join("\n") : null;
  }

  /** A guest's line in a bot's own chat (`isCalledIn`). */
  isCalledIn(record: ChatRecord, chatId: string): boolean {
    return record.role === "bot" && typeof record.sourceID === "string" && this.deps.members().some((member) => member.id === chatId);
  }

  /** Your pick or words on a called-in bot's line go back to it (`answerCallIn`); false if it is gone. */
  answerCallIn(chat: Bot, record: ChatRecord, text: string): boolean {
    const member = this.callable(chat.id).find((candidate) => candidate.id === record.sourceID);
    if (!member) return false;
    this.startCallIn(chat, [member], null, text);
    return true;
  }

  /**
   * A reply of `chat`'s own bot (`receiveBotMention`): a line that starts with @ and another bot's name
   * calls that bot in with it — one bot per reply, once (bot-mentions.json), at most 3 per message of yours.
   */
  receiveBotMention(record: ChatRecord, chat: Bot) {
    if (record.role !== "bot" || typeof record.sourceID === "string") return;
    // The reply to a woken follow-up (the callee's answer handed back): its @ wakes others only below MAX_FOLLOW_DEPTH.
    const wake = this.followUps.get(chat.id);
    if (wake) this.followUps.delete(chat.id);
    const depth = wake && wake.until > Date.now() ? wake.depth : 0;
    const route = (to: string | null, body: string | null, outcome: string) => {
      if (this.deps.members().some((member) => member.id === chat.id)) this.trace("BotReply", chat.id, { to, body, msg: record.id, depth, outcome });
    };
    if (!record.text.includes("@")) { route(null, null, "none"); return; }
    const isSub = (this.deps.subBots?.() ?? []).some((sub) => sub.id === chat.id);
    if (!isSub && !this.deps.members().some((member) => member.id === chat.id)) return;
    const callable = this.callable(chat.id);
    const addressed: { member: Member; body: string }[] = [];
    const unreachable: { id: string; name: string }[] = [];
    const unknown: string[] = [];
    const ambiguous: string[] = [];
    for (const candidate of botMentionCandidates(record.text)) {
      const found = this.resolveMention(candidate, chat.id);
      if (found.kind === "unknown") { const word = /^@([^\s,，:：、]+)/u.exec(candidate)?.[1]; if (word) unknown.push(word); continue; }
      if (found.kind === "ambiguous") { ambiguous.push(found.note); continue; }
      if (found.member.id === chat.id) continue;
      if (found.kind === "elsewhere" || !callable.some((member) => member.id === found.member.id)) { unreachable.push({ id: found.member.id, name: found.written }); continue; }
      addressed.push({ member: found.member, body: mentionBody(candidate, found.written) });
    }
    if (unreachable.length) {
      const names = [...new Set(unreachable.map((entry) => entry.name))];
      this.failed(chat, `Not sent to ${names.join(", ")} with @: ${names.length === 1 ? "it is" : "they are"} not a bot this chat can call in (another bot's sub bot answers only in that bot's chat).`);
    }
    if (unknown.length) {
      const names = [...new Set(unknown)].map((name) => `@${name}`);
      this.failed(chat, `Not sent to ${names.join(", ")}: no bot with that name (a sub bot that was closed is gone; the bots this chat can call in are listed in the @ menu).`);
    }
    // A name more than one bot has: nothing in this reply is sent, and the bot is told the full names to write.
    if (ambiguous.length) {
      for (const note of new Set(ambiguous)) this.failed(chat, note);
      route(null, null, "many");
      return;
    }
    const recipients = [...new Set(addressed.map((entry) => entry.member.id))];
    if (!recipients.length) { route(unreachable[0]?.id ?? null, null, unreachable.length ? "unreachable" : "none"); return; }
    if (recipients.length !== 1) {
      this.failed(chat, "Not sent with @: this reply names more than one bot at the start of a line. Name one bot per reply.");
      route(null, null, "many");
      return;
    }
    const recipient = addressed[0]!.member;
    const body = addressed.map((entry) => entry.body).filter(Boolean).join("\n");
    const log = this.mentionLog;
    // The same reply heard again: no new @.
    if (log.records.some((entry) => entry.message === record.id)) { route(recipient.id, body, "seen"); return; }
    if (depth >= MAX_FOLLOW_DEPTH) {
      this.failed(chat, `Not sent to ${recipient.name} with @: bots have already called each other in ${MAX_FOLLOW_DEPTH} times in a row from one message of yours.`);
      route(recipient.id, body, "dropped");
      return;
    }
    // Since the user's last line: the same words again are a retry, and only so many calls.
    const lastUser = chat.lines().findLast((line) => line.role === "user");
    const since = lastUser ? new Date(Date.UTC(2001, 0, 1) + lastUser.date * 1000).getTime() : 0;
    const recent = log.records.filter((entry) => entry.sender === chat.id && Date.parse(entry.date) > since);
    if (recent.some((entry) => entry.recipient === recipient.id && entry.body === body)) {
      // Still to be answered: that answer covers this one too.
      if (!(this.pending.get(chat.id) ?? []).some((entry) => entry.member.id === recipient.id && entry.body === body)) {
        this.failed(chat, `Not sent to ${recipient.name} with @: it was already asked the same since your last message.`);
        route(recipient.id, body, "dropped");
      } else route(recipient.id, body, "merged");
      return;
    }
    if (recent.length >= BOT_MENTIONS_PER_USER_LINE) {
      this.failed(chat, `Not sent to ${recipient.name} with @: a bot can call others in at most ${BOT_MENTIONS_PER_USER_LINE} times per message of yours.`);
      route(recipient.id, body, "dropped");
      return;
    }
    try {
      log.add({ message: record.id, sender: chat.id, recipient: recipient.id, body, date: new Date().toISOString() });
    } catch (error) {
      this.failed(chat, `Not sent to ${recipient.name} with @: could not keep a record of it (${(error as Error).message}).`);
      route(recipient.id, body, "dropped");
      return;
    }
    this.startCallIn(chat, [recipient], record.id, null, { message: record.id, recipient: recipient.id, body, depth: depth + 1 });
    route(recipient.id, body, "queued");
  }

  /** Chats whose bot was just handed a callee's answer: the next reply there is that follow-up (depth, expiry). */
  private followUps = new Map<string, { depth: number; until: number }>();

  /** Queues the called bots' turns after any still running for this chat, so they never talk over each other (`startCallIn`). */
  startCallIn(chat: Bot, members: Member[], newest: string | null, ask: string | null, caller?: BotMention) {
    const entries: PendingCallIn[] = members.map((member) => ({ member, since: Date.now(), body: caller?.body ?? null, state: "queued" }));
    this.pending.set(chat.id, [...(this.pending.get(chat.id) ?? []), ...entries]);
    this.deps.speaking(chat.id);
    this.enqueue(chat.id, async () => {
      try { await this.runCallIn(chat, entries, newest, ask, caller); } finally { for (const entry of entries) this.settle(chat.id, entry); }
    });
  }

  /** Runs `work` after what is queued for `key` (a chat). */
  enqueue(key: string, work: () => Promise<void>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch((error) => this.deps.log(`conversation ${key}: ${(error as Error).message}`));
    this.queues.set(key, next);
    void next.then(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  }

  private async runCallIn(chat: Bot, entries: PendingCallIn[], newest: string | null, ask: string | null, caller?: BotMention) {
    const before = transcriptBefore(newest, chat.lines());
    const unheard: string[] = [];
    const host = this.speakerName(chat.id) ?? chat.profile.name;
    for (const entry of entries) {
      const member = entry.member;
      const bot = this.deps.bot(member.id);
      // Not answered (`why`): a bot that asked is handed a turn saying so, like an answer; otherwise told with the notice below.
      const notHeard = (action: "Start" | "GiveUp" | "NoAnswer", why: string) => {
        if (!this.wakeUnheard(chat, member.name, why, caller)) unheard.push(`${member.name} (${why})`);
        this.trace(action, chat.id, { to: member.id, outcome: "unheard", followUp: this.followUps.get(chat.id)?.depth ?? 0 });
      };
      if (!bot) { this.settle(chat.id, entry); notHeard("Start", "it is not running"); continue; }
      if (!this.callable(chat.id).some((candidate) => candidate.id === member.id)) { this.settle(chat.id, entry); notHeard("Start", "it can no longer be called into this chat"); continue; }
      entry.state = "answering";
      this.trace("Start", chat.id, { to: member.id, outcome: "answering" });
      const prompt = caller
        ? botCallInPrompt({ member, host, chat: chat.lines(), transcript: before, body: caller.body, speakerName: this.speakerName }) + "\n" + botCallInWorkNote()
        : callInPrompt({ member, host, chat: chat.lines(), transcript: before, newest, ask, speakerName: this.speakerName, mentionNote: this.mentionNote }) + "\n" + callInWorkNote();
      this.speak(chat.id, member.id, member.id);
      const askedAt = toSwiftDate();
      const asked = ask ?? (caller ? `@${member.name} ${caller.body}` : (newest ? chat.lines().find((line) => line.id === newest)?.text : undefined) ?? "");
      let answer: GuestAnswer;
      try {
        answer = await bot.groupTurn(prompt, this.timing.busyNamed, this.timing.answerNamed, { callIn: chat.id, ...(caller ? { asked: caller.body } : {}) });
      } catch (error) {
        answer = { kind: "failed", why: (error as Error).message || "Its turn could not start." };
      } finally {
        // Answered or not, it is no longer pending (before the answer is handed back, which takes a turn).
        this.settle(chat.id, entry);
        this.speak(chat.id, null, member.id);
      }
      if (member.id === this.deps.mainBotId) this.deps.afterMainTurn();
      if (answer.kind === "busy") notHeard("GiveUp", "busy");
      else if (answer.kind === "failed") notHeard("NoAnswer", firstLineOf(answer.why));
      else {
        // You named it, so its tags act as they would in its own chat. Called in by a bot, its answer
        // is only a line: no tags act, nothing in it is dispatched.
        let said = "";
        const posted = await this.postGuestReply(answer, member, bot, chat, { passes: false, tagsAct: !caller }, (line) => {
          said = line.text;
          bot.keepCallIn(`Called into ${host}'s chat with @: ${asked}`, askedAt, line);
        });
        // A bot asked and nothing was posted: not an answer; it is told so like any @ not answered, never left waiting.
        if (caller && !posted) { notHeard("NoAnswer", "it answered nothing"); this.deps.refreshWaiting(); continue; }
        // A bot asked: wake it with the answer, once, so it is not left unaware of it.
        if (caller && posted && (caller.depth ?? 1) < MAX_FOLLOW_DEPTH) {
          this.followUps.set(chat.id, { depth: caller.depth ?? 1, until: Date.now() + 30 * 60_000 });
          chat.appMessage(botAnswerNote({ callee: member.name, question: caller.body, answer: said.trim() ? said : "(no words: only what its line in the chat shows)" }));
        }
        this.trace("Answer", chat.id, { to: member.id, outcome: "answered", posted: !!posted, followUp: this.followUps.get(chat.id)?.depth ?? 0 });
      }
      this.deps.refreshWaiting();
    }
    if (unheard.length) { const words = `Did not answer this time: ${unheard.join(", ")}.`; if (caller) this.failed(chat, words); else chat.appNotice(words); }
  }

  /**
   * A bot's @ (`caller`) to `name` was not answered (`why`; spec/models/callin: GiveUp, NoAnswer, Start): below the
   * depth limit the bot that asked is handed a turn saying so, as it would be handed the answer, and the chat shows the
   * notice. False when it was not (a user's @, the depth limit, or the bot cannot take a turn): the caller tells it then.
   */
  private wakeUnheard(chat: Bot, name: string, why: string, caller?: BotMention): boolean {
    if (!caller || (caller.depth ?? 1) >= MAX_FOLLOW_DEPTH) return false;
    const before = this.followUps.get(chat.id);
    this.followUps.set(chat.id, { depth: caller.depth ?? 1, until: Date.now() + 30 * 60_000 });
    if (!chat.appMessage(botUnansweredNote({ callee: name, question: caller.body, why }))) {
      if (before) this.followUps.set(chat.id, before); else this.followUps.delete(chat.id);
      return false;
    }
    chat.appNotice(`Did not answer this time: ${name} (${why}).`);
    return true;
  }

  /**
   * `callee`'s reply in its own chat on the news of a worker it started when called into `callerId`'s chat
   * (`callInFollowUp`): posted there as its line, and a bot that called it in is woken with it like its answer.
   * Only when it was a bot's @ (`asked` set): a call-in you made shows its news in its own chat, where you go.
   */
  callInFollowUp(callerId: string, callee: Bot, asked: string, record: ChatRecord) {
    const chat = this.deps.bot(callerId);
    if (!chat || chat === callee || !asked || !(record.text.trim() || record.choices?.length)) return;
    const member = { id: callee.id, name: this.speakerName(callee.id) ?? callee.profile.name };
    const line: ChatRecord = { id: newId(), role: "bot", text: record.text, date: toSwiftDate(), sourceID: member.id };
    if (record.engine) line.engine = record.engine;
    if (record.choices) line.choices = record.choices;
    if (record.questions) line.questions = record.questions;
    if (record.displays) line.displays = record.displays;
    // A question: the copy names its original, so an answer on either one shows on both (Core.closeRelayedCopies).
    if (record.choices?.length || record.questions?.length) line.sourceMessageID = record.id;
    chat.post(line);
    this.followUps.set(chat.id, { depth: 1, until: Date.now() + 30 * 60_000 });
    chat.appMessage(botFollowUpNote({ callee: member.name, question: asked, news: record.text, choices: record.choices?.map((choice) => choice.label)
      ?? record.questions?.map((question) => `${question.question}: ${question.options.map((option) => option.label).join(" / ")}`) }));
  }

  /**
   * `callee`'s turn on the report of a worker it started for `callerId`'s bot's @ ended without a reply (`why`):
   * the chat says so and its bot is woken with it, so it never waits on news that is not coming.
   */
  callInFollowUpMissed(callerId: string, callee: Bot, asked: string, why: string) {
    const chat = this.deps.bot(callerId);
    if (!chat || chat === callee || !asked) return;
    const name = this.speakerName(callee.id) ?? callee.profile.name;
    chat.appNotice(`${name}'s worker for your @ ended, but ${name} sent no answer on it (${why}).`);
    this.followUps.set(chat.id, { depth: 1, until: Date.now() + 30 * 60_000 });
    chat.appMessage(botFollowUpMissedNote({ callee: name, question: asked, why }));
  }

  /** Who answers in `chatId` now (null: nobody); `guest`, the bot that starts or stops answering there, is drawn again too. */
  speak(chatId: string, memberId: string | null, guest?: string) {
    if (memberId) this.speakers.set(chatId, memberId);
    else this.speakers.delete(chatId);
    this.deps.speaking(chatId);
    if (guest) this.deps.speaking(guest);
  }

  /**
   * A guest's reply (`postGuestReply`): filtered by plugins, parsed, posted as its line with its steps,
   * its tags handled when `policy` lets them act. The posted line's id; null when nothing was posted.
   */
  async postGuestReply(answer: Extract<GuestAnswer, { kind: "reply" }>, member: Member, bot: Bot, chat: Bot, policy: { passes: boolean; tagsAct: boolean }, keep?: (line: ChatRecord) => void): Promise<string | null> {
    let text = answer.text;
    const filter = this.deps.replyFilter(bot);
    if (filter) { try { text = await filter(text); } catch { /* as it was */ } }
    if (policy.passes && isPass(text)) return null;
    const parsed = parseReply(text);
    chat.guestReactions(parsed.reactions, `guest:${member.id}:${answer.engine}`);
    const line: ChatRecord = { id: newId(), role: "bot", text: parsed.body, date: toSwiftDate(), sourceID: member.id, engine: answer.engine };
    if (parsed.choices) line.choices = parsed.choices.map((choice) => ({ label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}), recommended: choice.recommended }));
    if (parsed.questions) line.questions = parsed.questions;
    if (parsed.displays.length) line.displays = parsed.displays as unknown as ChatRecord["displays"];
    if (answer.steps.length) line.steps = answer.steps;
    keep?.(line);
    let posted: string | null = null;
    if (line.text || line.choices || line.displays) {
      chat.post(line);
      posted = line.id;
      // Plugins listening with bots.onReply hear it as the guest's reply (`bot.replyObserver`).
      this.deps.replied?.(bot, line);
    }
    if (parsed.requests.length && policy.tagsAct) this.deps.handle(bot, parsed.requests);
    return posted;
  }
}
