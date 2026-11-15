// BotGuests (M7-S48): guest turns in other chats, app questions/notices, and copied question cards.
import { ContractError, type Event, type MessageView, type ResultOf } from "../../contract";
import { attachmentsFolder, keep } from "../attachments";
import type { Bot } from "../bot";
import type { CardPick, Engine } from "../heads";
import { savedQuestions } from "../questions";
import { isOpenQuestion, newId, toSwiftDate, type ChatRecord } from "../store/records";
import type { BotContext } from "./context";
import { NO_LONGER_NEEDED, type AgentHead, type BotOptions, type GuestAnswer, type Origin, type PresetTurnIds, type Turn } from "./types";
import { sleep } from "./view-functions";

export class BotGuests {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: shared names via `ctx`, Bot's own via `host` ----
  private get options(): BotOptions { return this.ctx.options; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get peers(): Bot[] { return this.ctx.peers; }
  private get id() { return this.ctx.id; }
  private get profile() { return this.ctx.profile; }
  private log(line: string) { this.ctx.log(line); }
  private emit(event: Event) { this.ctx.emit(event); }

  private get records() { return this.host.records; }
  private get problem() { return this.host.problem; }
  private get shuttingDown() { return this.host.shuttingDown; }
  private get tidying() { return this.host.tidying; }
  private get deferred() { return this.host.deferred; }
  private get queue() { return this.host.queue; }
  private get claimHold() { return this.host.claimHold; }
  private get session() { return this.host.session; }
  private get denialAsks() { return this.host.denialAsks; }
  private get approvals() { return this.host.approvals; }
  private get turn() { return this.host.turn; }
  private get turns() { return this.host.turns; }
  private get ignoreResults() { return this.host.ignoreResults; }
  private set ignoreResults(v: number) { this.host.ignoreResults = v; }

  private add(record: ChatRecord, options?: { archive?: boolean }) { return this.host.add(record, options); }
  private bumpUnread() { return this.host.bumpUnread(); }
  private newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn { return this.host.newTurn(origin, words, userId, ids); }
  private updated() { return this.host.updated(); }
  private begin(turn: Turn, head?: AgentHead) { return this.host.begin(turn, head); }
  private next() { return this.host.next(); }
  private refuseIfClosed() { return this.host.refuseIfClosed(); }
  private persist(soon?: boolean) { return this.host.persist(soon); }
  private messageView(record: ChatRecord): MessageView { return this.host.messageView(record); }
  private changed(record: ChatRecord) { return this.host.changed(record); }
  private rowsChanged(force?: boolean) { return this.host.rowsChanged(force); }

  // ---- Owned state ----
  cardPicks = new Map<string, CardPick[]>();
  appQuestions = new Map<string, (index: number) => void>();
  appAnswers = new Map<string, (text: string, files: string[]) => boolean>();
  guestTurn = false;

  // ---- Moved from `Bot` ----
  /**
   * A line from the app in this chat (`Workspace.tell`): a plugin's notice, Maintainer's news. With
   * `choices` and `onPick` it is the app's own question (installing a plugin): a pick goes to `onPick`,
   * never to the bot; after a restart nobody waits for it, so it is closed ("No longer needed").
   */
  appNotice(text: string, choices?: { label: string; recommended?: boolean; detail?: string }[], onPick?: (index: number) => void,
    more: { onAnswer?: (text: string, files: string[]) => boolean; sourceID?: string; sourceMessageID?: string; moveNotice?: string; questions?: ChatRecord["questions"] } = {}): string {
    if (this.options.primary) return this.options.primary.appNotice(text, choices, onPick, more);
    const record: ChatRecord = { id: newId(), role: "notice", text, date: toSwiftDate() };
    // An agent move's notice: keyed so a move's notices are posted once, even when they are sent again after a crash.
    if (more.moveNotice) record.moveNotice = more.moveNotice;
    if (choices?.length) record.choices = choices.map((choice) => ({ label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}), recommended: !!choice.recommended }));
    if (choices?.length && more.questions?.length) record.questions = more.questions;
    // 1.x's keys: the project or bot a line came from, and the question it is a copy of.
    if (more.sourceID) record.sourceID = more.sourceID;
    if (more.sourceMessageID) record.sourceMessageID = more.sourceMessageID;
    if (choices?.length && onPick) {
      record.appQuestion = true;
      this.appQuestions.set(record.id, onPick);
      if (more.onAnswer) this.appAnswers.set(record.id, more.onAnswer);
    }
    this.add(record);
    this.bumpUnread();
    return record.id;
  }

  /**
   * Says `text` (its turn in a chat it was called into) and returns the reply,
   * showing neither in this chat. Wakes it if asleep. While it is busy with its own chat it waits up to
   * `waitForMs`, then gives up (busy); once asked, it has `answerWithinMs` to reply.
   */
  async groupTurn(text: string, waitForMs: number, answerWithinMs: number, { callIn, asked, by, onBegin, signal }: { callIn?: string; asked?: string; by?: "user"; onBegin?: () => void; signal?: AbortSignal } = {}): Promise<GuestAnswer> {
    if (this.options.primary) return this.options.primary.groupTurn(text, waitForMs, answerWithinMs, { callIn, asked, by, onBegin, signal });
    const deadline = Date.now() + waitForMs;
    while (this.turn || this.queue.length || this.tidying || this.guestTurn || this.deferred || this.claimHold) {
      if (this.shuttingDown) return { kind: "failed", why: "It was removed." };
      // Botling 3 M5-02b: `signal` (a call-in the host gave up, D51) ends the wait and the turn; 2.x passes none.
      if (signal?.aborted) return { kind: "failed", why: "cancelled" };
      if (Date.now() >= deadline) return { kind: "busy" };
      await sleep(300);
    }
    if (this.shuttingDown) return { kind: "failed", why: "It was removed." };
    if (signal?.aborted) return { kind: "failed", why: "cancelled" };
    const problem = this.problem ?? this.profile.problem;
    if (problem) return { kind: "failed", why: problem };
    this.guestTurn = true;
    const engine = this.engine;
    try {
      return await new Promise<GuestAnswer>((resolve) => {
        const turn = this.newTurn("tidy", text, null);
        turn.guest = true;
        if (callIn) { turn.callIn = callIn; turn.callInAsked = asked ?? ""; if (by) turn.callInBy = by; }
        let settled = false;
        const settle = (answer: GuestAnswer) => { if (!settled) { settled = true; clearTimeout(timer); resolve(answer); } };
        const giveUp = (why: string) => {
          if (turn.open) {
            turn.open = false;
            if (this.turn === turn) this.turns.close();
            if (turn.callIn) this.updated();
            turn.resolve("stopped");
            // Its reply, when it comes, belongs to nobody now.
            if (turn.sent && turn.head?.running) { this.ignoreResults += 1; turn.head.interrupt(); }
          }
          settle({ kind: "failed", why });
        };
        const timer = setTimeout(() => giveUp("No answer in time."), answerWithinMs);
        const aborted = () => giveUp("cancelled");
        signal?.addEventListener("abort", aborted, { once: true });
        void turn.done.finally(() => signal?.removeEventListener("abort", aborted));
        // A failed or stopped turn hands "" here (finishTurn): not a reply; turn.done says what happened.
        turn.onReply = (reply) => { if (reply) settle({ kind: "reply", text: reply, steps: turn.steps.slice(-500), engine }); };
        void turn.done.then((status) => settle(status === "done" ? { kind: "reply", text: turn.reply.text, steps: turn.steps.slice(-500), engine } : { kind: "failed", why: status === "failed" ? "It could not answer." : "It was stopped." }));
        if (signal?.aborted) { giveUp("cancelled"); return; }
        onBegin?.();
        this.begin(turn);
      });
    } finally {
      this.guestTurn = false;
      if (!this.shuttingDown) this.next();
    }
  }

  /** Free to take a turn in another chat now (`groupTurn` would not wait): no turn under way or waiting, not tidying. */
  get takesGuest(): boolean {
    if (this.options.primary) return this.options.primary.takesGuest;
    return !this.shuttingDown && !(this.turn || this.queue.length || this.tidying || this.guestTurn || this.deferred || this.claimHold);
  }

  /** A line in this chat that is not part of its own conversation (a guest's line, a group's lines): `Bot.post`. */
  post(record: ChatRecord, { unread = true } = {}) {
    if (this.options.primary) { this.options.primary.post(record, { unread }); return; }
    this.add(record);
    if (unread) this.bumpUnread();
  }

  /**
   * A turn it took in another chat, called in there with @ (`keepCallIn`): kept in its own chat and
   * archive too, as what it was asked there and its reply. Not unread: you read it where you called it in.
   */
  keepCallIn(asked: string, at: number, line: ChatRecord) {
    if (this.options.primary) { this.options.primary.keepCallIn(asked, at, line); return; }
    this.add({ id: newId(), role: "notice", text: asked, date: at });
    const copy: ChatRecord = { id: newId(), role: "bot", text: line.text, date: toSwiftDate() };
    if (line.displays) copy.displays = line.displays;
    if (line.steps?.length) copy.steps = line.steps;
    if (line.engine) copy.engine = line.engine;
    copy.session = this.session.sessionId;
    if (!copy.text && !copy.displays) return;
    this.add(copy);
  }

  /** Files you sent with a line that is not a message to it, copied where they stay (1.x's `keep`). */
  keepFiles(files: string[]): { url: string; kind: string; path: string }[] {
    return files.flatMap((file) => keep(file, attachmentsFolder(this.profile)) ?? []).map((kept) => ({ url: kept.url, kind: kept.kind, path: kept.path }));
  }

  /** A guest's reactions on this chat's lines (`applyReactions(actor: "guest:…")`). */
  guestReactions(actions: { messageId: string; emoji: string; present: boolean }[], actor: string) {
    for (const action of actions) {
      try { this.owner.setReaction(action.messageId, action.emoji, action.present, actor); } catch { /* A line it named that is not here. */ }
    }
  }

  /** Its latest question still waiting for you (1.x's `openQuestion`), if any (not tool approvals). */
  openQuestion(): { id: string; text: string; choices: { label: string; detail?: string; recommended: boolean }[]; questions?: NonNullable<ChatRecord["questions"]> } | null {
    const owner = this.owner;
    // The bot's own (1.x: role .bot), not the app's cards in its chat.
    const record = owner.records.findLast((candidate) => candidate.role === "bot" && isOpenQuestion(candidate) && !candidate.permissionTool && typeof candidate.sourceID !== "string");
    const questions = savedQuestions(record?.questions);
    return record ? { id: record.id, text: record.text, choices: (record.choices ?? []).map((choice) => ({ label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}), recommended: !!choice.recommended })), ...(questions ? { questions } : {}) } : null;
  }

  /** Its chat's lines as they stand (read only). */
  lines(): readonly ChatRecord[] {
    return this.owner.records;
  }

  /** A line of its chat as it stands (a question's pick or answer), or null. */
  line(id: string): ChatRecord | null {
    return this.owner.records.find((candidate) => candidate.id === id) ?? null;
  }

  /** User dismissal, kept separate from chosen/answer. No callbacks, messages or task transitions. */
  ignoreQuestion(id: string, at = new Date().toISOString()): ResultOf<"chat.ignoreQuestion"> {
    if (this.options.primary) return this.options.primary.ignoreQuestion(id, at);
    this.refuseIfClosed();
    const view = this.records.find(record => record.id === id);
    if (!view || !isOpenQuestion(view)) return { accepted: false };
    const source = view.decisionID ? this.records.find(record => record.id === view.decisionID) : view;
    if (!source || !isOpenQuestion(source)) return { accepted: false };
    const records = source.decisionID ? this.records.filter(record => record.decisionID === source.decisionID) : [source];
    // Authorization cards retain their pending decision and their existing Review flow.
    if (records.some(record => record.permissionTool || this.denialAsks.has(record.id) || this.peers.some(peer => peer.denialAsks.has(record.id))
      || this.approvals.has(record.id) || this.peers.some(peer => peer.approvals.has(record.id)))) return { accepted: false };
    for (const record of records) {
      if (!isOpenQuestion(record)) continue;
      record.ignoredAt = at;
      this.appQuestions.delete(record.id);
      this.appAnswers.delete(record.id);
      this.cardPicks.delete(record.id);
    }
    this.persist();
    for (const peer of this.peers) peer.persist();
    for (const record of records) this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    this.log(`Question ${source.id} ignored by user at ${at}; no answer or authorization.`);
    this.updated();
    return { accepted: true };
  }

  /** The original was ignored: synchronize open or explicitly startup-invalidated copies only. */
  syncIgnoredCopies(sourceID: string, sourceMessageID: string, at: string): void {
    if (this.options.primary) { this.options.primary.syncIgnoredCopies(sourceID, sourceMessageID, at); return; }
    for (const record of this.records) {
      if ((record.role !== "notice" && record.role !== "bot") || record.sourceID !== sourceID || record.sourceMessageID !== sourceMessageID
        || record.chosen != null || record.answer != null || record.ignoredAt != null
        || !(isOpenQuestion(record) || record.questionInvalidatedAt != null)
        || record.permissionTool || this.approvals.has(record.id) || this.peers.some(peer => peer.approvals.has(record.id))
        || this.denialAsks.has(record.id) || this.peers.some(peer => peer.denialAsks.has(record.id))) continue;
      this.refuseIfClosed();
      record.ignoredAt = at;
      this.appQuestions.delete(record.id);
      this.appAnswers.delete(record.id);
      this.cardPicks.delete(record.id);
      this.changed(record);
      this.log(`Question copy ${record.id} inherited Ignore from ${sourceID}/${sourceMessageID} at ${at}; no answer or authorization.`);
    }
  }

  /** Closes one of the app's own questions in this chat without a pick going anywhere: shows `chosen` or `answer` (1.x's `markChosen` / `markAnswered`). */
  settleAppQuestion(id: string, outcome: { chosen?: number; answer?: string }): void {
    if (this.options.primary) { this.options.primary.settleAppQuestion(id, outcome); return; }
    const record = this.records.find((candidate) => candidate.id === id);
    this.appQuestions.delete(id);
    this.appAnswers.delete(id);
    if (!record || !isOpenQuestion(record)) return;
    if (outcome.chosen !== undefined && record.choices?.[outcome.chosen]) record.chosen = outcome.chosen;
    else record.answer = outcome.answer ?? NO_LONGER_NEEDED;
    this.changed(record);
  }

  /**
   * Your answer on a called-in bot's card in this chat (`outcome`) waits to reach that bot (`to`, its name): the card
   * shows it "Queued" and cannot be answered again until `releaseCardAnswer` says whether it got there.
   */
  holdCardAnswer(id: string, outcome: { chosen?: number; answer?: string }, to: string): boolean {
    if (this.options.primary) return this.options.primary.holdCardAnswer(id, outcome, to);
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record || !isOpenQuestion(record)) return false;
    record.pendingAnswer = { ...outcome, to };
    delete record.notDelivered;
    this.changed(record);
    return true;
  }

  /** The answer `holdCardAnswer` kept reached the bot (the card shows it answered), or never will (it is open again, with a note). */
  releaseCardAnswer(id: string, delivered: boolean): void {
    if (this.options.primary) { this.options.primary.releaseCardAnswer(id, delivered); return; }
    const record = this.records.find((candidate) => candidate.id === id);
    const pending = record?.pendingAnswer;
    if (!record || !pending) return;
    delete record.pendingAnswer;
    if (delivered) { this.settleAppQuestion(id, pending.chosen !== undefined ? { chosen: pending.chosen } : { answer: pending.answer ?? "" }); return; }
    record.notDelivered = pending.to;
    delete record.picks;
    this.changed(record);
  }

  /** The app's questions in this chat that are copies of `botId`'s questions (`sourceMessageID`), still open. */
  openCopies(botId?: string): ChatRecord[] {
    return this.records.filter((record) => record.role === "notice" && typeof record.sourceMessageID === "string" && isOpenQuestion(record) && (!botId || record.sourceID === botId));
  }

  /** Settles a subagent's row into the right panel's "Settled", or brings it back (`settleSubagent`). */
  settleSubagent(id: string, settled: boolean): ResultOf<"subagent.settle"> {
    if (this.options.primary) return this.options.primary.settleSubagent(id, settled);
    for (const bot of this.members) {
      if (!bot.subagents.get(id)) continue;
      const changed = bot.subagents.settle(id, settled);
      if (changed) { bot.saveSubagents(false, bot.subagents.get(id)); this.rowsChanged(true); }
      return { changed };
    }
    // An agent it owns that another bot hosts: its row here is the registry's.
    const moved = this.options.agents?.settle(this.id, id, settled) ?? null;
    if (moved) { if (moved.changed) this.rowsChanged(true); return moved; }
    throw new ContractError("not_found", "No such subagent.");
  }
}
