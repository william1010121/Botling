// M7-S65: `CoreCopies` cut out of `Core` (core/server.ts). The question cards copied between chats (`copies`: the main bot's <open-question>
// copies, a called-in bot's relayed cards), the server's own `serverAsk` cards, a peer's `new-bot` and `waiting.ignore`, and the answers
// that go back to a called-in bot. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line
// forwarders to `host` first, then the members as they were in `Core`, byte for byte (a member that `Core` or another collaborator calls
// lost its `private`).
import { oneLine, type Core } from "../server";
import { Bot, NO_LONGER_NEEDED } from "../bot";
import { type ChatRecord, isOpenQuestion } from "../store/records";
import { ContractError } from "../../contract";
import { type QuestionPick, answerMessage, savedQuestions, validPicks } from "../questions";
import { type RemoteMember } from "../conversations";
import { answerLabel } from "../attachments";
import { answeredNote, guestCardAnswerNote, pickedNote, relayedAnswerNote } from "../groups";
import { botName } from "../projects";

/** The longest `bots.create` job and `waiting.ignore` text the contract takes (`contract/index.ts`, counted in characters as zod does). */
const BOT_JOB_LIMIT = 4_000;
const WAITING_TEXT_LIMIT = 400;

export class CoreCopies {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private botRequested(...a: Parameters<Core["botRequested"]>) { return this.host.botRequested(...a); }
  private get bots() { return this.host.bots; }
  private get conversations() { return this.host.conversations; }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private machineNamed(...a: Parameters<Core["machineNamed"]>) { return this.host.machineNamed(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private noMainBotMessage(...a: Parameters<Core["noMainBotMessage"]>) { return this.host.noMainBotMessage(...a); }
  private get options() { return this.host.options; }
  private peerBots(...a: Parameters<Core["peerBots"]>) { return this.host.peerBots(...a); }
  private get profiles() { return this.host.profiles; }
  private refreshWaiting(...a: Parameters<Core["refreshWaiting"]>) { return this.host.refreshWaiting(...a); }
  private get removed() { return this.host.removed; }
  private tellMain(...a: Parameters<Core["tellMain"]>) { return this.host.tellMain(...a); }

  /** M5-06c: open `serverAsk` cards by the id of their chat line (the bot they are in, and how to end the wait). */
  serverAsks = new Map<string, { botId: string; close: (index: number | null) => void }>();
  /** <open-question> copies in the main bot's chat: the copy's id → the question it copies. */
  copies = new Map<string, { botId: string; questionId: string }>();

  /**
   * The main bot's <new-bot name="…" machine="…">job</new-bot> (M5-04d, D26, Q-C3): `bots.create` on that peer's server, this
   * server as origin (scope `manage`). The bot is made there, never here; the outcome comes back to the main bot as a note.
   */
  botRequestedOn(machineName: string, rawName: string, rawJob: string, sentOnce: Set<string>) {
    const machine = this.machineNamed(machineName);
    if (machine.kind === "here") { this.botRequested(rawName, rawJob, null); return; }
    if (machine.kind === "unknown") { this.tellMain((p) => `There is no machine named "${p(machine.name)}"; the bot was not made.`); return; }
    const name = botName(rawName);
    const job = rawJob.trim();
    if (!name || !job) return;
    const remoteCommand = this.options.remoteCommand!;
    let told = false;
    const tell = (why: string | null) => {
      if (told) return;
      told = true;
      this.tellMain((p) => (why === null ? `The bot "${p(name)}" was made on ${p(machine.name)}.` : `${p(machine.name)} did not make the bot "${p(name)}": ${p(oneLine(why))}.`));
    };
    if (machine.kind === "ambiguous") { tell("more than one machine has that name"); return; }
    if (job.length > BOT_JOB_LIMIT) { tell(`the job is longer than ${BOT_JOB_LIMIT} characters`); return; }
    const once = `${machine.id}\n${name.toLowerCase()}`;
    if (sentOnce.has(once)) return;
    sentOnce.add(once);
    let sent: ReturnType<typeof remoteCommand>;
    try { sent = remoteCommand(`srv:${machine.id}`, { type: "bots.create", name, job }); } catch (error) { tell((error as Error).message); return; }
    // The slot is committed first (a failure there is final), the owner's decision comes later; the main bot hears one of them.
    sent.committed.catch((error: unknown) => tell((error as Error).message));
    sent.outcome.then((outcome) => tell(outcome.ok ? null : outcome.why), (error: unknown) => tell((error as Error).message));
  }

  /** A bot of another machine of this cluster (`peerBots`) that is not one of this server's own (a local id always wins). */
  peerBotFor(botId: string): RemoteMember | null {
    if (botId === "main" || this.bots.has(botId) || this.profiles.some((profile) => profile.id === botId)) return null;
    return this.peerBots().find((peer) => peer.id === botId) ?? null;
  }

  /** Waiting items being set aside on a peer (committed or decided not yet): a second tap sends nothing (M5-04d). */
  private peerIgnoring = new Set<string>();

  /** `waiting.ignore` for a peer's bot, with this server as origin (scope `reply`); a failure is logged, never thrown. */
  ignoreWaitingOn(peer: RemoteMember, text: string) {
    const remoteCommand = this.options.remoteCommand;
    const who = `${peer.name} on ${peer.serverName}`;
    const key = `${peer.id}\n${text}`;
    if (!remoteCommand || this.peerIgnoring.has(key)) return;
    if (!text || text.length > WAITING_TEXT_LIMIT) { this.log(`ignoring a waiting item of ${who} failed: the text is empty or longer than ${WAITING_TEXT_LIMIT} characters`); return; }
    let sent: ReturnType<typeof remoteCommand>;
    try { sent = remoteCommand(`bot:${peer.id}`, { type: "waiting.ignore", botId: peer.id, text }); } catch (error) { this.log(`ignoring a waiting item of ${who} failed: ${oneLine((error as Error).message)}`); return; }
    this.peerIgnoring.add(key);
    let logged = false;
    const failed = (why: string) => { this.peerIgnoring.delete(key); if (!logged) { logged = true; this.log(`ignoring a waiting item of ${who} failed: ${oneLine(why)}`); } };
    sent.committed.catch((error: unknown) => failed((error as Error).message));
    sent.outcome.then((outcome) => { if (outcome.ok) this.peerIgnoring.delete(key); else failed(outcome.why); }, (error: unknown) => failed((error as Error).message));
  }

  /**
   * The main bot's <open-question from="name"/> (`showOpenQuestion`): the card a project or bot already
   * shows in its own chat shows here too, a copy kept in step with it; a pick or words on it go there.
   */
  showOpenQuestion(name: string) {
    const main = this.mainBot();
    if (!main) return;
    const wanted = name.replace(/^[\t ]+|[\t ]+$/g, "").toLowerCase();
    const profile = this.profiles.find((candidate) => candidate.role !== "main" && !candidate.parent && candidate.name.toLowerCase() === wanted);
    if (!profile) { main.queueNote(`(App: There is no project or bot called "${name}"; no card was shown.)`); return; }
    const question = this.bots.get(profile.id)?.guests.openQuestion();
    if (!question) {
      main.appNotice(`${profile.name} has no question waiting in its chat now.`, undefined, undefined, { sourceID: profile.id });
      main.queueNote(`(App: ${profile.name} has no open card, so none was shown. Do not ask its question again yourself; if it still needs the user, it asks in its own chat.)`);
      return;
    }
    const copy: string = main.appNotice(`${profile.name}: ${question.text}`, question.choices, (index) => this.pickOnCopy(copy, index), {
      onAnswer: (text, files) => this.answerOnCopy(copy, text, files), sourceID: profile.id, sourceMessageID: question.id, ...(question.questions ? { questions: question.questions } : {}),
    });
    this.copies.set(copy, { botId: profile.id, questionId: question.id });
    this.refreshWaiting();
  }

  /** Resolve copies to their original, then persist the informational disposition everywhere. */
  ignoreQuestion(botId: string, messageId: string): { accepted: boolean } {
    let chat = this.bot(botId), record = chat.line(messageId);
    const seen = new Set<string>();
    while (record?.sourceID && record.sourceMessageID) {
      const key = `${chat.id}:${record.id}`;
      if (seen.has(key) || !isOpenQuestion(record)) return { accepted: false };
      seen.add(key);
      const source = this.bots.get(record.sourceID);
      const original = source?.line(record.sourceMessageID);
      // The bot it copies was removed (a sub bot's card relayed into its parent's chat), or its line is gone: the copy
      // is ignored where it is, never left open with nothing to settle it (spec/models/callin/RelayedCard.tla).
      if (!source || !original) break;
      chat = source;
      record = original;
    }
    if (!record) return { accepted: false };
    const result = chat.ignoreQuestion(record.id);
    if (result.accepted) this.refreshWaiting();
    return result;
  }

  /** A pick on a copy goes to the question it copies; one settled or gone meanwhile closes the copy. */
  private pickOnCopy(copy: string, index: number) {
    const source = this.copies.get(copy);
    this.copies.delete(copy);
    if (!source) return;
    let accepted = false;
    try { accepted = this.bots.get(source.botId)?.choose(source.questionId, index).accepted ?? false; } catch { /* gone */ }
    if (!accepted) this.log(`a pick on a copy of ${source.botId}'s question found it settled`);
    this.refreshWaiting();
  }

  /** Words on a copy answer the question it copies; both show the answer. */
  private answerOnCopy(copy: string, text: string, files: string[]): boolean {
    const source = this.copies.get(copy);
    const bot = source ? this.bots.get(source.botId) : undefined;
    if (!source || !bot) { this.mainBot()?.settleAppQuestion(copy, { answer: "No longer needed" }); return false; }
    let accepted = false;
    // A question group answered on its copy: the original gets the same picks (its line shows them too).
    const copyLine = this.mainBot()?.line(copy);
    const picks = copyLine?.picks && bot.line(source.questionId)?.questions ? copyLine.picks : undefined;
    try { accepted = bot.answer(source.questionId, text, files, picks).accepted; } catch { /* gone */ }
    if (!accepted && copyLine) delete copyLine.picks;
    this.copies.delete(copy);
    this.mainBot()?.settleAppQuestion(copy, accepted ? { answer: answerLabel(text, files.length) } : { answer: "No longer needed" });
    this.refreshWaiting();
    return true;
  }

  /** A bot's question was settled in its own chat: so is its copy (`closeCopies`). */
  closeCopiesOf(botId: string, messageId: string) {
    const original = this.bots.get(botId)?.line(messageId);
    if (original?.ignoredAt) {
      const chats = [...this.bots.values()];
      for (const [copy, source] of this.copies) if (source.botId === botId && source.questionId === messageId) this.copies.delete(copy);
      for (const chat of chats) chat.guests.syncIgnoredCopies(botId, messageId, original.ignoredAt);
      return;
    }
    for (const [copy, source] of [...this.copies]) {
      if (source.botId !== botId || source.questionId !== messageId) continue;
      const line = this.bots.get(botId)?.line(messageId);
      if (line && line.chosen == null && line.answer == null) continue;
      this.copies.delete(copy);
      this.mainBot()?.settleAppQuestion(copy, line?.chosen != null ? { chosen: line.chosen } : { answer: line?.answer ?? "No longer needed" });
    }
  }

  /**
   * M5-06c (D74): a question card from this server itself (a fetch that asks, `server/fetch/approval.ts`) in `botId`'s
   * chat (the Maintainer's). It is a normal app question: the pick comes from any device through `chat.choose`, and the
   * answer is the choice's index. It is `null` whenever there is no pick: the card is ignored, closed after a restart
   * ("No longer needed"), the core shuts down, `cancelled` settles first (the ask it belongs to is over: the card is then
   * closed "No longer needed" so nobody answers a dead question), the bot is missing or there is nothing to choose.
   * A caller must treat anything but a valid index as "no".
   */
  serverAsk(botId: string, ask: { text: string; choices: string[] }, cancelled?: Promise<void>): Promise<number | null> {
    const bot = this.bots.get(botId);
    if (!bot || this.removed.has(botId) || !ask.choices.length) return Promise.resolve(null);
    return new Promise<number | null>((resolve) => {
      let id = "";
      let settled = false;
      const finish = (index: number | null) => {
        if (settled) return;
        settled = true;
        this.serverAsks.delete(id);
        resolve(index);
      };
      id = bot.appNotice(ask.text, ask.choices.map((label) => ({ label })), (index) => finish(Number.isInteger(index) && index >= 0 && index < ask.choices.length ? index : null));
      this.serverAsks.set(id, { botId, close: finish });
      void cancelled?.then(() => {
        if (settled) return;
        // Close the card first (a pick after this finds nothing open), then end the wait.
        try { bot.settleAppQuestion(id, {}); } catch (error) { this.log(`serverAsk: closing the card failed: ${(error as Error).message}`); }
        finish(null);
      });
    });
  }

  /** A `serverAsk` card that is no longer open and was not picked: ignored (the pick, if any, reaches its own callback). */
  serverAskClosed(messageId: string): void {
    const pending = this.serverAsks.get(messageId);
    if (!pending) return;
    const line = this.bots.get(pending.botId)?.line(messageId) ?? null;
    if (!line || (line.chosen == null && !isOpenQuestion(line))) pending.close(null);
  }

  /** Your pick on a called-in bot's line goes back to it (`answerCallIn`); null: not such a line. */
  calledInPick(botId: string, messageId: string, index: number): { accepted: boolean } | null {
    const chat = this.bot(botId);
    const record = chat.line(messageId);
    if (!record || !this.conversations.isCalledIn(record, chat.id)) return null;
    const label = record.choices?.[index]?.label;
    if (!isOpenQuestion(record) || label === undefined) return { accepted: false };
    const relayed = this.answerRelayedCopy(chat, record, label, { chosen: index });
    if (relayed) return relayed;
    return this.answerGuestLine(chat, record, pickedNote(label), label, { chosen: index });
  }

  /** Your words on a called-in bot's question go back to it. */
  calledInAnswer(botId: string, messageId: string, text: string, files: number): { accepted: boolean } | null {
    const chat = this.bot(botId);
    const record = chat.line(messageId);
    if (!record || !this.conversations.isCalledIn(record, chat.id) || !record.choices?.length) return null;
    const shown = answerLabel(text.trim(), files);
    if (!shown || !isOpenQuestion(record)) return { accepted: false };
    const relayed = this.answerRelayedCopy(chat, record, text.trim() || shown, { answer: shown });
    if (relayed) return relayed;
    return this.answerGuestLine(chat, record, answeredNote(shown), text.trim() || shown, { answer: shown });
  }

  /**
   * Your answer on a called-in bot's line in this chat (its guest line, `isCalledIn`) goes back to it, and counts once it
   * gets there (spec/models/callin/RelayedCard.tla): free, it answers here (a call-in, as when you named it); at work, the
   * answer goes into its own chat, read into its turn under way or waiting for it to end. Meanwhile the card shows the
   * answer "Queued"; if it never gets there (taken back, the bot stopped or removed), the card is open again and says so.
   */
  private answerGuestLine(chat: Bot, record: ChatRecord, note: string, words: string, outcome: { chosen?: number; answer?: string }): { accepted: boolean } {
    const guest = typeof record.sourceID === "string" ? this.bots.get(record.sourceID) : undefined;
    if (!guest || !this.conversations.callable(chat.id).some((member) => member.id === guest.id)) {
      chat.settleAppQuestion(record.id, { answer: NO_LONGER_NEEDED });
      return { accepted: false };
    }
    if (!chat.guests.holdCardAnswer(record.id, outcome, guest.profile.name)) return { accepted: false };
    const told = (delivered: boolean) => {
      chat.guests.releaseCardAnswer(record.id, delivered);
      // A relayed copy of the user's call-in (`callInBy`): the card it copies shows the answer too.
      if (delivered) this.settleRelayedOriginal(record, outcome);
    };
    const intoItsChat = () => {
      try { guest.send(words, { appNote: guestCardAnswerNote(chat.profile.name), onDelivery: told }); } catch { told(false); }
    };
    if (guest.takesGuest && !this.conversations.callIns(chat.id).length) {
      this.conversations.answerCallIn(chat, record, note, { began: () => told(true), busy: intoItsChat, failed: () => told(false) });
    } else intoItsChat();
    return { accepted: true };
  }

  /**
   * A called-in bot's question relayed into the chat of the bot that called it (`callInFollowUp`: the copy names it
   * with `sourceMessageID`) answered there: received where it was given. The answer is your message to this chat's own
   * bot (it asked on your behalf and carries the work on), and the card it copies shows the answer in the called-in
   * bot's chat; that bot is not woken, so two bots never act on one answer: the caller tells it with @ when needed.
   * null: not such a copy, or a copy of a call-in the user made (`callInBy`): this chat's bot did not ask, so the answer
   * goes to the called bot like its guest line's (answerGuestLine), and its own card shows it once it gets there.
   */
  private answerRelayedCopy(chat: Bot, copy: ChatRecord, words: string, outcome: { chosen?: number; answer?: string }): { accepted: boolean } | null {
    if (copy.role !== "bot" || typeof copy.sourceID !== "string" || typeof copy.sourceMessageID !== "string" || copy.callInBy === "user") return null;
    const name = this.bots.get(copy.sourceID)?.profile.name ?? "the bot you called in";
    chat.send(words, { replyTo: copy.id, appNote: relayedAnswerNote(name) });
    chat.settleAppQuestion(copy.id, outcome);
    this.settleRelayedOriginal(copy, outcome);
    return { accepted: true };
  }

  /**
   * A called-in bot's question relayed into another chat (`callInFollowUp`: the copy names it with `sourceMessageID`)
   * was answered on the copy: the answer went to that bot with the call-in, so its own card only shows it.
   */
  private settleRelayedOriginal(copy: ChatRecord, outcome: { chosen?: number; answer?: string }) {
    if (copy.role !== "bot" || typeof copy.sourceID !== "string" || typeof copy.sourceMessageID !== "string") return;
    const source = this.bots.get(copy.sourceID);
    const original = source?.line(copy.sourceMessageID);
    if (!source || !original || !isOpenQuestion(original)) return;
    if (copy.picks && original.questions) original.picks = copy.picks;
    source.settleAppQuestion(original.id, outcome);
  }

  /** A called-in bot answered in its own chat on a question relayed into other chats: every open copy shows the answer. */
  closeRelayedCopies(botId: string, messageId: string) {
    const original = this.bots.get(botId)?.line(messageId);
    if (!original || original.role !== "bot" || original.sourceMessageID || isOpenQuestion(original) || original.ignoredAt
      || !(original.choices?.length || original.questions?.length)) return;
    for (const chat of this.bots.values()) {
      if (chat.id === botId) continue;
      for (const copy of chat.lines()) {
        if (copy.role !== "bot" || copy.sourceID !== botId || copy.sourceMessageID !== messageId || !isOpenQuestion(copy)) continue;
        if (original.picks && copy.questions) copy.picks = original.picks;
        chat.settleAppQuestion(copy.id, original.chosen != null ? { chosen: original.chosen } : { answer: original.answer ?? NO_LONGER_NEEDED });
      }
    }
  }

  /** A called-in bot's question group answered together: its one answer message goes to that bot, as words would. */
  calledInGroupAnswer(botId: string, messageId: string, picks: QuestionPick[], files: number): { accepted: boolean } | null {
    const record = this.bot(botId).line(messageId);
    if (!record || !this.conversations.isCalledIn(record, botId)) return null;
    const questions = savedQuestions(record.questions);
    const clean = questions ? validPicks(questions, picks) : null;
    if (!questions || !clean) throw new ContractError("bad_request", "Those answers do not fit the questions.");
    if (!isOpenQuestion(record)) return { accepted: false };
    record.picks = clean;
    const result = this.calledInAnswer(botId, messageId, answerMessage(questions, clean), files);
    if (!result?.accepted && isOpenQuestion(record)) delete record.picks;
    return result;
  }

  bot(id: string): Bot {
    if (id === "main") {
      const main = this.mainBot();
      if (!main) throw new ContractError("not_found", this.noMainBotMessage());
      return main;
    }
    const bot = this.bots.get(id);
    if (!bot) throw new ContractError("not_found", "No such bot.");
    return bot;
  }
}
