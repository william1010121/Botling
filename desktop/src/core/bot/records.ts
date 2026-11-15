// BotRecords (M7-S46): the bot's chat log, component specs, persistence, unread count, and reactions.
import { attachmentList, attachmentsFolder, keep } from "../attachments";
import { applyingReaction, archiveLine, compareReactions, REACTION_PALETTE, type SeenReactions } from "../briefing";
import { dropLineMedia } from "../chat-media";
import { parseFeedback } from "../feedback";
import { PAGE_COMPONENT } from "../page-preview";
import { RELAY_PREFIX, SUB_BOT_RELAY_PREFIX } from "../prompts";
import { sameJSON } from "../same-json";
import { StoreError, type BotStore } from "../store/bot-store";
import { HISTORY_LIMIT, isOpenQuestion, newId, toSwiftDate, type ChatRecord } from "../store/records";
import { interruptedNote, markCutOffTasksTold, stopBackgroundTasks } from "../background-tasks";
import { ContractError, type Event, type MessageView, type ResultOf } from "../../contract";
import type { Bot } from "../bot";
import type { Engine } from "../heads";
import type { BotContext } from "./context";
import { NO_LONGER_NEEDED, type BotOptions, type PresetTurnIds, type StoredSpec, type Turn } from "./types";
import { messageView, union } from "./view-functions";

export class BotRecords {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: shared context (`ctx`) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get sharesChat(): boolean { return this.ctx.sharesChat; }
  private get id(): string { return this.ctx.id; }
  private get profile() { return this.ctx.profile; }
  private get paths() { return this.ctx.paths; }
  private log(line: string) { this.ctx.log(line); }
  private emit(event: Event) { this.host.emit(event); }

  // ---- Bridge: names on `Bot` (`host`) ----
  private get shuttingDown(): boolean { return this.host.shuttingDown; }
  private get lineMediaStore(): string { return this.host.lineMediaStore; }
  private updated() { this.host.updated(); }
  private refuseIfClosed() { this.host.refuseIfClosed(); }
  private deliverTo(head: Engine, words: string, userId: string | null, extra?: Partial<Pick<Turn, "conducted" | "handoffId" | "about" | "origin" | "delivery" | "routine" | "released">> & { ids?: PresetTurnIds }): Turn { return this.host.deliverTo(head, words, userId, extra); }

  // ---- Moved from `Bot` ----
  /** Components being made from its replies (specs.json, 1.x's format; the primary's): the component studio's records, kept as they are. */
  specList: StoredSpec[] = [];
  records: ChatRecord[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  /** The subagent rows as the windows last saw them (a change sends bot.updated). */
  lastRows = "";
  unread = 0;
  /** Why the chat file could not be read (the bot is then left as it is), and whether the bot may write. Read through `Bot`. */
  problem: string | null = null;
  readOnly = false;
  /** What this head's session has been told of the chat's reactions (null: tell it from scratch). */
  reactionsSeen: SeenReactions | null = null;
  /** The session has been told of these reactions (`seen`). */
  seeReactions(seen: SeenReactions | null) { this.reactionsSeen = seen; }
  /** What the head has been told of the reactions is forgotten (it is a new head). */
  forgetReactions() { this.reactionsSeen = null; }

  /** What the partner's chat did, in this chat (`mirror`): its lines are this chat's lines too. */
  /** Called by BotContext.emit (M7-S41). */
  fromPartner(partner: Bot, event: Event) {
    switch (event.type) {
      case "bot.updated":
        return this.updated();
      case "message.added":
      case "message.updated": {
        let record = this.records.find((candidate) => candidate.id === event.message.id);
        if (!record) {
          // A change to a line this chat no longer holds (an old one past its window, while the partner's own file
          // still has it, e.g. an old worker's step re-drawn when its head starts) is no new line: only an added one
          // joins the chat. Pushing it here put weeks-old replies after your newest line, where catch-up read them as new.
          if (event.type !== "message.added") return;
          const theirs = partner.records.find((candidate) => candidate.id === event.message.id);
          if (!theirs) return;
          record = theirs;
          record.seenBy = union(record.seenBy, record.engine ? [record.engine] : undefined);
          this.records.push(record);
          this.persist();
          return this.options.emit({ type: "message.added", botId: this.id, message: this.messageView(record) });
        }
        this.persist(true);
        return this.options.emit({ type: event.type, botId: this.id, message: this.messageView(record) });
      }
      case "message.removed": {
        const at = this.records.findIndex((candidate) => candidate.id === event.messageId);
        if (at >= 0) { this.records.splice(at, 1); this.persist(); }
        return this.options.emit({ ...event, botId: this.id });
      }
      case "subagent.updated":
        return this.options.emit({ ...event, botId: this.id });
      default:
        return this.options.emit({ ...event, botId: this.id } as Event);
    }
  }

  readList<T>(name: "subagents.json" | "specs.json", read: (value: unknown) => T | null): T[] {
    try {
      return this.store.loadList(name).map(read).filter((value): value is T => value !== null);
    } catch (error) {
      this.log(`${name} cannot be read (${(error as Error).message}); it is left as it is`);
      return [];
    }
  }

  // ------------------------------------------------------------------------------------------
  // The chat file

  load() {
    let records: ChatRecord[];
    try {
      const loaded = this.store.loadMessages();
      records = loaded.records;
      if (loaded.dropped) this.log(`${loaded.dropped} chat line(s) in chat.json are not readable and are left out`);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      this.problem = `Its chat file cannot be read, so it is left as it is: ${error.message}`;
      this.readOnly = true;
      this.log(this.problem);
      this.records = [];
      return;
    }
    let changed = false;
    // Background work that ran when the app went away went with it (`stopBackgroundTasks(as: .interrupted)`).
    if (stopBackgroundTasks(records, "interrupted").length) changed = true;
    for (const record of records) {
      // An answer that waited to reach a called-in bot when the core stopped never got there: its card is open again.
      if (record.pendingAnswer) {
        record.notDelivered = record.pendingAnswer.to;
        delete record.pendingAnswer;
        delete record.picks;
        changed = true;
      }
      // A turn that was streaming when the core died is not resumed or re-sent: it is marked.
      if (record.state === "streaming") {
        record.state = "failed";
        record.interrupted = true;
        record.text += (record.text ? "\n\n" : "") + "(Interrupted: the core restarted during this reply. It was not sent again.)";
        changed = true;
      }
      // A tool question (or the app's own question) from before a restart has nobody waiting for it any more.
      if ((record.permissionTool || record.appQuestion) && isOpenQuestion(record)) {
        // A copied question can later inherit its source's Ignore. Keep this system transition
        // separate from answer: user words (even "No longer needed") must never be reclassified.
        if (!record.permissionTool && record.appQuestion && record.sourceID && record.sourceMessageID) record.questionInvalidatedAt = new Date().toISOString();
        else record.answer = NO_LONGER_NEEDED;
        changed = true;
      }
    }
    this.records = records;
    if (changed) this.persist();
  }

  persist(soon = false) {
    if (this.readOnly) return;
    if (soon) {
      this.saveTimer ??= setTimeout(() => { this.saveTimer = null; this.persist(); }, 500);
      return;
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.store.saveMessages(this.records);
  }

  messageView(record: ChatRecord): MessageView {
    const lookup = { get: (id: string) => this.members.map(bot => bot.subagents.get(id)).find(Boolean) };
    const view = messageView(record, this.members.map(bot => bot.approvals.get(record.id)).find(Boolean), lookup, this.owner.displayViews(record));
    // Your line a head could not take into its turn under way waits in a queue: it says so until it is sent.
    if (record.role === "user" && this.members.some(bot => bot.waitsFor(record.id))) view.queued = true;
    // A card's answer that waits to reach the bot that asked: shown as given, "Queued" (`holdCardAnswer`).
    if (record.pendingAnswer) {
      if (record.pendingAnswer.chosen !== undefined) view.chosen = record.pendingAnswer.chosen;
      else view.answer = (record.pendingAnswer.answer ?? "").slice(0, 4_000);
      view.queued = true;
    }
    if (record.notDelivered && isOpenQuestion(record)) view.notDelivered = record.notDelivered;
    // The result pages it links to, as preview cards, when the library has the card (Phase 5c).
    const previews = this.owner.previews(record);
    if (previews) view.previews = previews.map((data) => ({ name: PAGE_COMPONENT, data }));
    // The component it already is (Phase 5a), from the component studio's seam; the studio draws the specs made from it itself (chat.decorate).
    const extras = this.owner.options.lineExtras?.(this.owner, record);
    if (extras?.component) view.component = extras.component;
    // A "not right" report shows short (1.x's `FeedbackNote`, read back from the text for older ones).
    if (record.role === "relay") {
      const note = record.feedback && typeof record.feedback === "object" ? record.feedback as { about?: unknown; words?: unknown } : null;
      const feedback = note && typeof note.about === "string" && typeof note.words === "string" ? { about: note.about, words: note.words } : parseFeedback(record.text);
      if (feedback) view.feedback = { about: feedback.about.slice(0, 400), words: feedback.words.slice(0, 20_000) };
    }
    return view;
  }

  /** The specs made from its replies. */
  get specs(): readonly StoredSpec[] {
    return this.owner.specList;
  }

  /** Changes its specs and saves them, if anything changed (`editSpecs`); the lines they belong to are drawn again. */
  editSpecs(change: (specs: StoredSpec[]) => void): boolean {
    const owner = this.owner;
    const edited = structuredClone(owner.specList);
    change(edited);
    if (sameJSON(edited, owner.specList)) return false;
    const touched = new Set([...owner.specList, ...edited].flatMap((spec) => (spec.messageID ? [spec.messageID] : [])));
    owner.specList = edited;
    if (!owner.readOnly) owner.store.saveList("specs.json", edited);
    for (const id of touched) owner.refreshLine(id);
    return true;
  }

  /** A line is drawn again (its chips changed). */
  refreshLine(messageId: string) {
    const owner = this.owner;
    const record = owner.records.find((candidate) => candidate.id === messageId);
    if (record) owner.emit({ type: "message.updated", botId: owner.id, message: owner.messageView(record) });
  }

  /** A new line; `archive: false` for a reply still being written (it is archived when it ends). */
  add(record: ChatRecord, { archive = true } = {}) {
    this.records.push(record);
    this.persist();
    if (archive) archiveLine(this.paths.archive, record);
    this.emit({ type: "message.added", botId: this.id, message: this.messageView(record) });
  }

  changed(record: ChatRecord) {
    this.persist();
    this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
  }

  remove(record: ChatRecord) {
    const at = this.records.indexOf(record);
    if (at < 0) return;
    this.records.splice(at, 1);
    this.persist();
    dropLineMedia(this.lineMediaStore, record.id);
    this.emit({ type: "message.removed", botId: this.id, messageId: record.id });
  }

  notice(text: string) {
    this.add({ id: newId(), role: "notice", text, date: toSwiftDate() });
  }

  /**
   * Work handed over by the app (`Bot.relay`): a "Handed to you" line, and the words to the head with
   * 1.x's relay prefix, as a message the reply answers.
   */
  relay(text: string, { files = [], feedback }: { files?: string[]; feedback?: { about: string; words: string } } = {}): ResultOf<"chat.send"> {
    if (this.options.primary) return this.options.primary.relay(text, { files, ...(feedback ? { feedback } : {}) });
    this.refuseIfClosed();
    const words = text.trim();
    if (!words) throw new ContractError("bad_request", "Nothing to send.");
    // Its files are kept in the bot's own attachments folder (pictures go to the head as pictures).
    const kept = files.flatMap((file) => keep(file, attachmentsFolder(this.profile)) ?? []);
    const line: ChatRecord = { id: newId(), role: "relay", text: words, date: toSwiftDate() };
    if (kept.length) line.attachments = kept.map((file) => ({ url: file.url, kind: file.kind }));
    // A "not right" report shows short in the chat (1.x's `FeedbackNote`).
    if (feedback) line.feedback = feedback;
    this.add(line);
    const turn = this.deliverTo(this.engine, (this.profile.parent ? SUB_BOT_RELAY_PREFIX : RELAY_PREFIX) + words + (kept.length ? `\n\n${attachmentList(kept.map((file) => file.path))}` : ""), line.id);
    return { messageId: turn.messageId, turnId: turn.id };
  }

  /** Something only the app says (no line in the chat): wakes it like a message (`Bot.appMessage`). */
  /** Its turn's id (null: not delivered: it cannot run now). */
  appMessage(text: string): string | null {
    if (this.options.primary) return this.options.primary.appMessage(text);
    const words = text.trim();
    if (!words || this.problem || this.profile.problem || this.shuttingDown) return null;
    return this.deliverTo(this.engine, words, null, { origin: "app" }).id;
  }

  /** Marks the chat read when you are looking at it (`markRead`). */
  markRead() {
    void this.read();
  }

  get messageCount() {
    return this.records.length;
  }

  /** Where you read it up to (`chatRead`): how many lines were unread, and its newest line. */
  readMark(): { unread: number; through: string | null } {
    return { unread: this.unread, through: this.records.at(-1)?.id ?? null };
  }

  /** These lines reached `head` (they are in its context): the chat marks them (`markSeen`). */
  markSeen(ids: string[], head: Engine) {
    const owner = this.owner;
    if (!owner.partner || !ids.length) return;
    let changed = false;
    for (const id of new Set(ids)) {
      const record = owner.records.findLast((candidate) => candidate.id === id);
      if (!record || record.seenBy?.includes(head)) continue;
      record.seenBy = union(record.seenBy, [head]);
      changed = true;
      owner.emit({ type: "message.updated", botId: owner.id, message: owner.messageView(record) });
    }
    if (changed) owner.persist(true);
  }

  bumpUnread() {
    const owner = this.owner;
    owner.unread += 1;
    owner.store.saveSetting("unread", owner.unread);
    owner.updated();
  }

  /**
   * The chat lines whose background tasks are this head's. A shared chat holds the partner head's replies
   * too (their tasks, e.g. an Antigravity worker, run in the partner's process): they are left out.
   */
  get ownRecords(): ChatRecord[] {
    if (!this.sharesChat) return this.records;
    return this.records.filter((record) => (record.engine ?? "claude") === this.engine);
  }

  /** The interrupted-work note for a wake, once: those tasks count as told from now on (`takeInterruptedNote`). */
  takeInterruptedNote(): string {
    const note = interruptedNote(this.records);
    if (!note) return "";
    for (const record of markCutOffTasksTold(this.records)) this.changed(record);
    return note;
  }

  /** The user's own reaction on a line (`Bot.setReaction`, actor "user"). */
  react(messageId: string, emoji: string, present: boolean): ResultOf<"chat.react"> {
    if (!REACTION_PALETTE.includes(emoji)) throw new ContractError("bad_request", "Not one of the reactions.");
    if (this.readOnly) throw new ContractError("conflict", this.problem ?? "Read-only.");
    return { changed: this.setReaction(messageId, emoji, present, "user") };
  }

  setReaction(messageId: string, emoji: string, present: boolean, actor: string): boolean {
    const record = this.records.slice(-HISTORY_LIMIT).find((candidate) => candidate.id === messageId && candidate.role !== "divider");
    if (!record) throw new ContractError("not_found", "No such line.");
    const before = JSON.stringify(record.reactions ?? []);
    const reactions = (record.reactions ?? []).filter((r) => !(r.emoji === emoji && r.actor === actor));
    if (present) reactions.push({ emoji, actor });
    reactions.sort(compareReactions);
    if (JSON.stringify(reactions) === before) return false;
    record.reactions = reactions;
    this.changed(record);
    return true;
  }

  applyReactions(actions: { messageId: string; emoji: string; present: boolean }[]) {
    const actor = `head:${this.engine}`;
    for (const action of actions) {
      try {
        this.owner.setReaction(action.messageId, action.emoji, action.present, actor);
        // Its own reaction is not news to this head's session.
        if (this.reactionsSeen) this.reactionsSeen = applyingReaction(this.reactionsSeen, action.messageId, action.emoji, action.present, actor);
      } catch { /* A line it named that is not in the chat. */ }
    }
  }

  read(): ResultOf<"chat.read"> {
    if (this.unread !== 0) {
      this.unread = 0;
      if (!this.readOnly) this.store.saveSetting("unread", 0);
      this.updated();
    }
    return { read: true };
  }
}
