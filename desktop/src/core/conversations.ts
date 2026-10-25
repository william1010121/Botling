// Bots answering in chats that are not their own (1.x's CallIn.swift, BotMentions.swift and the
// running half of GroupChat.swift): the turns, one at a time per chat, each from the guest's own
// session; its line in the chat under its own name; your pick or words on its line go back to it.
// The strings are groups.ts's (checked against the Swift app's).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot, GuestAnswer } from "./bot";
import { writeFileAtomic } from "./durable/atomic";
import {
  BOT_MENTIONS_PER_USER_LINE, GROUP_TIMING, botCallInPrompt, botMentionCandidates, callInNote, callInPrompt, firstLineOf, heardSinceLastTurn,
  isPass, mentionBody, mentioned, transcriptBefore, type Member,
} from "./groups";
import { parseReply, type BotRequest } from "./reply";
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
  bot: (id: string) => Bot | null;
  mainBotId: string;
  /** Plugins' afterReply hooks for a bot's reply (null: none). */
  replyFilter: (bot: Bot) => ((text: string) => Promise<string>) | null;
  /** Acts on the tags in a guest's reply, as from its own chat. */
  handle: (bot: Bot, requests: BotRequest[]) => void;
  /** After the main bot's turn: what it wrote into inboxes goes out (`deliverInboxes`). */
  afterMainTurn: () => void;
  /** Who is answering in a chat changed (the typing bubble under its own name). */
  speaking: (chatId: string) => void;
  refreshWaiting: () => void;
  log: (line: string) => void;
  timing?: typeof GROUP_TIMING;
}

/** A bot @ (`BotMention`): the reply that did it, whom it named, the words for it. */
interface BotMention { message: string; recipient: string; body: string }

export class Conversations {
  readonly mentionLog: BotMentionLog;
  /** Who answers in a chat right now (`callInSpeakers`, `groupSpeakers`), by the chat's id. */
  readonly speakers = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly deps: ConversationsDeps) {
    this.mentionLog = new BotMentionLog(join(deps.dataDir, "bot-mentions.json"));
  }

  /** How long a guest waits for a busy bot and may take (`groupTiming`). */
  get groupTiming() { return this.deps.timing ?? GROUP_TIMING; }
  private get timing() { return this.groupTiming; }

  /** Everyone who can answer outside their own chat, in turn order (`everyMember`). */
  members(): Member[] { return this.deps.members(); }

  /** Who a member id is (`speakerName(for:)`). */
  speakerName = (id: string): string | null => this.deps.members().find((member) => member.id === id)?.name ?? null;

  /** The bots that can be called into `chat` with @: everyone but its own bot (`callable(into:)`). */
  callable(chatId: string): Member[] {
    const members = this.deps.members();
    return members.some((member) => member.id === chatId) ? members.filter((member) => member.id !== chatId) : [];
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
    return callable.length ? mentioned(text, callable) : [];
  }

  /** What goes to the chat's own bot, unseen, with your line: what guests said since, who else answers. */
  notes(chat: Bot, called: Member[]): string | null {
    const notes = [heardSinceLastTurn(chat.lines(), this.speakerName), callInNote(called)].filter((note): note is string => !!note);
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
    if (record.role !== "bot" || typeof record.sourceID === "string" || !record.text.includes("@")) return;
    const members = this.deps.members();
    if (!members.some((member) => member.id === chat.id)) return;
    const callable = this.callable(chat.id);
    const addressed: { member: Member; body: string }[] = [];
    let ambiguous = false;
    for (const candidate of botMentionCandidates(record.text)) {
      // Every bot, itself among them, so "@itself …" is not read as a shorter name.
      const named = mentioned(candidate, members);
      const first = named[0];
      if (!first || !candidate.toLowerCase().startsWith("@" + first.name.toLowerCase())) continue;
      if (named.filter((member) => member.name.toLowerCase() === first.name.toLowerCase()).length > 1) { ambiguous = true; continue; }
      if (!callable.some((member) => member.id === first.id)) continue;
      addressed.push({ member: first, body: mentionBody(candidate, first.name) });
    }
    const recipients = [...new Set(addressed.map((entry) => entry.member.id))];
    if (!recipients.length && !ambiguous) return;
    if (recipients.length !== 1 || ambiguous) {
      chat.appNotice("Not sent with @: this reply names more than one bot at the start of a line. Name one bot per reply.");
      return;
    }
    const recipient = addressed[0]!.member;
    const body = addressed.map((entry) => entry.body).filter(Boolean).join("\n");
    const log = this.mentionLog;
    if (log.records.some((entry) => entry.message === record.id)) return;
    // Since the user's last line: the same words again are a retry, and only so many calls.
    const lastUser = chat.lines().findLast((line) => line.role === "user");
    const since = lastUser ? new Date(Date.UTC(2001, 0, 1) + lastUser.date * 1000).getTime() : 0;
    const recent = log.records.filter((entry) => entry.sender === chat.id && Date.parse(entry.date) > since);
    if (recent.some((entry) => entry.recipient === recipient.id && entry.body === body)) return;
    if (recent.length >= BOT_MENTIONS_PER_USER_LINE) {
      chat.appNotice(`Not sent to ${recipient.name} with @: a bot can call others in at most ${BOT_MENTIONS_PER_USER_LINE} times per message of yours.`);
      return;
    }
    try {
      log.add({ message: record.id, sender: chat.id, recipient: recipient.id, body, date: new Date().toISOString() });
    } catch (error) {
      chat.appNotice(`Not sent to ${recipient.name} with @: could not keep a record of it (${(error as Error).message}).`);
      return;
    }
    this.startCallIn(chat, [recipient], record.id, null, { message: record.id, recipient: recipient.id, body });
  }

  /** Queues the called bots' turns after any still running for this chat, so they never talk over each other (`startCallIn`). */
  startCallIn(chat: Bot, members: Member[], newest: string | null, ask: string | null, caller?: BotMention) {
    this.enqueue(chat.id, () => this.runCallIn(chat, members, newest, ask, caller));
  }

  /** Runs `work` after what is queued for `key` (a chat). */
  enqueue(key: string, work: () => Promise<void>) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch((error) => this.deps.log(`conversation ${key}: ${(error as Error).message}`));
    this.queues.set(key, next);
    void next.then(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  }

  private async runCallIn(chat: Bot, members: Member[], newest: string | null, ask: string | null, caller?: BotMention) {
    const before = transcriptBefore(newest, chat.lines());
    const unheard: string[] = [];
    const host = this.speakerName(chat.id) ?? chat.profile.name;
    for (const member of members) {
      const bot = this.deps.bot(member.id);
      if (!bot || !this.callable(chat.id).some((candidate) => candidate.id === member.id)) continue;
      const prompt = caller
        ? botCallInPrompt({ member, host, chat: chat.lines(), transcript: before, body: caller.body, speakerName: this.speakerName })
        : callInPrompt({ member, host, chat: chat.lines(), transcript: before, newest, ask, speakerName: this.speakerName });
      this.speak(chat.id, member.id);
      const askedAt = toSwiftDate();
      const asked = ask ?? (caller ? `@${member.name} ${caller.body}` : (newest ? chat.lines().find((line) => line.id === newest)?.text : undefined) ?? "");
      let answer: GuestAnswer;
      try {
        answer = await bot.groupTurn(prompt, this.timing.busyNamed, this.timing.answerNamed);
      } finally {
        this.speak(chat.id, null);
      }
      if (member.id === this.deps.mainBotId) this.deps.afterMainTurn();
      if (answer.kind === "busy") unheard.push(`${member.name} (busy)`);
      else if (answer.kind === "failed") unheard.push(`${member.name} (${firstLineOf(answer.why)})`);
      else {
        // You named it, so its tags act as they would in its own chat. Called in by a bot, its answer
        // is only a line: no tags act, nothing in it is dispatched.
        await this.postGuestReply(answer, member, bot, chat, { passes: false, tagsAct: !caller }, (line) => {
          bot.keepCallIn(`Called into ${host}'s chat with @: ${asked}`, askedAt, line);
        });
      }
      this.deps.refreshWaiting();
    }
    if (unheard.length) chat.appNotice(`Did not answer this time: ${unheard.join(", ")}.`);
  }

  /** Who answers in `chatId` now (null: nobody). */
  speak(chatId: string, memberId: string | null) {
    if (memberId) this.speakers.set(chatId, memberId);
    else this.speakers.delete(chatId);
    this.deps.speaking(chatId);
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
    if (parsed.displays.length) line.displays = parsed.displays as unknown as ChatRecord["displays"];
    if (answer.steps.length) line.steps = answer.steps;
    keep?.(line);
    let posted: string | null = null;
    if (line.text || line.choices || line.displays) {
      chat.post(line);
      posted = line.id;
    }
    if (parsed.requests.length && policy.tagsAct) this.deps.handle(bot, parsed.requests);
    return posted;
  }
}
