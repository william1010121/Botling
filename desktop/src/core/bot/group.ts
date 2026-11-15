// BotGroup (M7-S50): multi-head coordination, routing between peers, conductor rounds/handoffs,
// claim holds, and user message entry (`send`, `presetUserLine`, `startPresetTurn`).
// Follows the M7-S41 bridge convention.
import { randomUUID } from "node:crypto";
import { ContractError, type ResultOf } from "../../contract";
import { AgyAcpHead } from "../agent/agy-acp";
import { CodexHead } from "../agent/codex";
import { ReplyText } from "../agent/stream";
import { attachmentList, attachmentsFolder, keep } from "../attachments";
import { archiveLine } from "../briefing";
import { Bot, type Status } from "../bot";
import {
  Conductor, displayName, fitted, hasTwo, isActive, otherHead, resolvePrimary,
  type AnswerTarget, type ConductorAction, type Engine, type Handoff, type Heads, type RoundsProgress,
} from "../heads";
import { isOpenQuestion, newId, toSwiftDate, type ChatRecord } from "../store/records";
import type { BotContext } from "./context";
import type { BotOptions, Origin, PresetTurnIds, Turn } from "./types";
import { preview, union } from "./view-functions";

export class BotGroup {
  /** App-owned peers keyed by engine (on the conversation owner only). */
  partners = new Map<Engine, Bot>();
  conductor: Conductor;
  /** A message to both, kept from the head that does not lead until the lead says what it takes on. */
  claimHold: { id: string; lead: Engine; held: Engine; turn: Turn; timer: NodeJS.Timeout } | null = null;
  lastLead: Engine | null = null;
  /** The questions handed over with each hand-off (`handoffDecisions`). */
  handoffDecisions = new Map<string, Set<string>>();
  rounds: RoundsProgress | null = null;

  constructor(private readonly host: Bot, private readonly ctx: BotContext) {
    this.conductor = new Conductor(host.headsSettings);
  }

  // ---- Bridge: shared context (ctx) and host Bot members (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get partner(): Bot | null { return this.ctx.partner; }
  private get peers(): Bot[] { return this.ctx.peers; }
  private get heads(): Heads { return this.ctx.heads; }
  private allowsEngineRoute(head: Engine, from?: Engine): boolean { return this.ctx.allowsEngineRoute(head, from); }
  private requireEngineRoute(head: Engine, from?: Engine): void { return this.ctx.requireEngineRoute(head, from); }
  private botFor(head: Engine): Bot | null { return this.ctx.botFor(head); }
  private get profile() { return this.ctx.profile; }
  private get paths() { return this.ctx.paths; }
  private log(line: string) { this.ctx.log(line); }
  private get records() { return this.host.records; }
  private get headsSettings() { return this.host.headsSettings; }
  private get head() { return this.host.head; }
  private get turn() { return this.host.turn; }
  private get draining() { return this.host.draining; }
  private get ignoreResults() { return this.host.ignoreResults; }
  private get ending() { return this.host.ending; }
  private get turns() { return this.host.turns; }
  private get cardPicks() { return this.host.cardPicks; }
  private refuseIfClosed() { return this.host.refuseIfClosed(); }
  private add(record: ChatRecord, opts?: { archive?: boolean }) { return this.host.add(record, opts); }
  private changed(record: ChatRecord) { return this.host.changed(record); }
  private notice(text: string) { return this.host.notice(text); }
  private componentNotes(user: ChatRecord) { return this.host.componentNotes(user); }
  private route(turn: Turn) { return this.host.route(turn); }
  private clearApiRetry() { return this.host.clearApiRetry(); }
  private finishTurn(turn: Turn, status: Status, error?: string) { return this.host.finishTurn(turn, status, error); }
  private markSeen(ids: string[], head: Engine) { return this.host.markSeen(ids, head); }
  private identifyDecision(id: string) { return this.host.identifyDecision(id); }
  private decisionContext(ids: Set<string>) { return this.host.decisionContext(ids); }
  private bumpUnread() { return this.host.bumpUnread(); }
  private headsChanged() { return this.host.headsChanged(); }
  private forgetReturnRoutes(handoffId?: string) { return this.host.forgetReturnRoutes(handoffId); }

  // ---- Moved from `Bot` ----
  /**
   * The other head (1.x's `makePartner`): for a bot with two heads, or made when a bot with one first hands
   * work to the other CLI (`onDemand`, a head it was handed to).
   */
  makePartner(onDemand?: Engine, restore = false): Bot | null {
    if (this.options.primary) return null;
    const other = onDemand ?? this.partner?.engine ?? otherHead(this.engine, this.heads);
    // Restore selected peer stores without launching providers or requiring installed runtimes.
    if (!restore || !this.headsSettings.engines.includes(other)) this.requireEngineRoute(other);
    if (this.partners.has(other)) return this.partners.get(other)!;
    if (other === this.engine) return null;
    if (onDemand ? onDemand !== other : !this.headsSettings.engines.includes(other)) return null;
    const partner = new Bot({ ...this.options, primary: this.host, engine: other });
    this.partners.set(other, partner);
    // The shared chat holds the partner's lines too: the same records, so a change shows in both.
    const mine = new Map(this.records.map((record, index) => [record.id, index]));
    for (const record of partner.records) {
      const at = mine.get(record.id);
      if (at !== undefined) {
        // Which heads saw it, and its reactions, are kept here.
        const kept = this.records[at]!;
        if (kept.seenBy) record.seenBy = union(kept.seenBy, record.seenBy);
        if (kept.reactions) record.reactions = kept.reactions;
        if (kept.ignoredAt) record.ignoredAt = kept.ignoredAt;
        if (kept.questionInvalidatedAt) record.questionInvalidatedAt = kept.questionInvalidatedAt;
        if (kept.decisionID && !isOpenQuestion(kept)) { record.decisionID = kept.decisionID; record.choices = kept.choices; record.chosen = kept.chosen; record.answer = kept.answer; if (kept.questions) record.questions = kept.questions; if (kept.picks) record.picks = kept.picks; }
        this.records[at] = record;
      }
    }
    return partner;
  }

  /**
   * A message from the user; `replyTo`: a line of the chat it answers (a pick on a question, say).
   * `to`: with two heads, both (the usual) or one by name; `appNote` goes ahead of the words without
   * showing; `decisionOwner`: a shared decision's answer, for the head that asked it only; `via`: a
   * plugin sent it (its title, shown on the line).
   */
  send(text: string, { replyTo, to, appNote, decisionOwner, files, originals, via, onDelivery, ids }: { replyTo?: string; to?: AnswerTarget; appNote?: string; decisionOwner?: Engine; files?: string[]; originals?: string[]; via?: string; onDelivery?: (delivered: boolean) => void; ids?: PresetTurnIds } = {}): ResultOf<"chat.send"> {
    if (this.options.primary) return this.options.primary.send(text, { replyTo, to, appNote, decisionOwner, files, ...(originals ? { originals } : {}), via, onDelivery, ...(ids ? { ids } : {}) });
    this.refuseIfClosed();
    const words = text.trim();
    if (!words && !files?.length) throw new ContractError("bad_request", "Nothing to send.");
    // `originals`: the files among them the user picked or dropped from disk, attached where they are
    // (unless in a temporary place); the rest are copied into the bot's own attachments folder (`keep`).
    const own = new Set(originals ?? []);
    const kept = (files ?? []).flatMap((file) => keep(file, attachmentsFolder(this.profile), new Date(), { original: own.has(file) }) ?? []);
    if (!words && !kept.length) throw new ContractError("bad_request", "The files could not be read.");
    const two = hasTwo(this.headsSettings);
    const { record: made, target, quoted } = this.userRecord(ids?.userId ?? newId(), words, toSwiftDate(), { replyTo, to: decisionOwner ?? to, via });
    if (kept.length) made.attachments = kept.map((file) => ({ url: file.url, kind: file.kind }));
    // Botling 3's server put the line in the chat already, with its intent (`presetUserLine`): it is that line, brought
    // up to date (a plugin's words, the files that went with it), never a second one. 2.x never passes such an id.
    const preset = ids?.userId ? this.records.find((record) => record.id === ids.userId && record.role === "user") : undefined;
    const user = preset ?? made;
    if (preset) this.updateUserLine(preset, made);
    else this.add(user);
    const lines: string[] = [];
    if (appNote) lines.push(appNote);
    // What its components kept since your last message, and cards it drew empty (`componentStateNote`, `emptyShowNote`).
    for (const note of this.componentNotes(user)) lines.push(note);
    if (quoted) {
      const whose = quoted.role === "user" ? "what I said earlier" : quoted.role === "notice" ? "the app's message"
        : typeof quoted.sourceID === "string" ? "another bot's line in this chat" : "what you said earlier";
      lines.push(`(Replying to ${whose}: "${preview(quoted)}")`);
    }
    if (words) lines.push(words);
    if (kept.length) lines.push(attachmentList(kept.map((file) => file.path)));
    const message = lines.join("\n\n");
    if (!two) {
      const turn = this.route(this.watchDelivery(this.host.newTurn("user", message, user.id, ids), onDelivery));
      return { messageId: turn.messageId, turnId: turn.id };
    }
    this.conduct(this.conductor.userMessage(words));
    if (decisionOwner) {
      // A shared decision has one owner: no copy goes to the other head as context.
      const turn = this.deliverTo(decisionOwner, message, user.id, { delivery: onDelivery, ids });
      return { messageId: turn.messageId, turnId: turn.id };
    }
    const turn = this.deliverTo(target, message, user.id, { delivery: onDelivery, ids });
    return { messageId: turn.messageId, turnId: turn.id };
  }

  /** Your line as `send` makes it (who it goes to with two heads, the line it answers); `to`: the head asked for. */
  userRecord(id: string, words: string, date: number, { replyTo, to, via }: { replyTo?: string; to?: AnswerTarget; via?: string }): { record: ChatRecord; target: Engine; quoted: ChatRecord | undefined } {
    const heads = this.headsSettings;
    const target = fitted(heads, to ?? resolvePrimary(heads, this.appPrimary()), this.appPrimary());
    const record: ChatRecord = { id, role: "user", text: words, date };
    if (hasTwo(heads)) record.to = target;
    if (via) record.via = via;
    const quoted = replyTo ? this.records.find((candidate) => candidate.id === replyTo) : undefined;
    if (quoted) {
      record.replyTo = quoted.id;
      record.replyPreview = preview(quoted);
    }
    return { record, target, quoted };
  }

  /** `line` (already in the chat) takes what `made` says of it now, keeping its id and date; drawn again if it changed. */
  updateUserLine(line: ChatRecord, made: ChatRecord) {
    const before = JSON.stringify(line);
    for (const key of ["text", "to", "via", "attachments", "replyTo", "replyPreview"] as const) {
      if (made[key] === undefined) delete line[key];
      else (line as Record<string, unknown>)[key] = made[key];
    }
    if (JSON.stringify(line) !== before) this.changed(line);
  }

  /**
   * Botling 3's server: the user's line of a `chat.send` whose intent it is committing now (or committed before a
   * crash), put in the chat at once as 2.x's `send` does, so chat.json, the history and commands that name the line
   * (a reaction) see it while its turn waits. The turn's `send` later finds it by id and does not add it again. A line
   * already in the chat is left as it is. False: it was there.
   */
  presetUserLine(line: { id: string; text: string; date: number; replyTo?: string; to?: AnswerTarget }): boolean {
    if (this.options.primary) return this.options.primary.presetUserLine(line);
    if (this.records.some((record) => record.id === line.id)) return false;
    this.refuseIfClosed();
    this.add(this.userRecord(line.id, line.text.trim(), line.date, { ...(line.replyTo ? { replyTo: line.replyTo } : {}), ...(line.to ? { to: line.to } : {}) }).record);
    return true;
  }

  /** A turn for `head` (this bot's or its partner's), routed there now. */
  deliverTo(head: Engine, words: string, userId: string | null, extra: Partial<Pick<Turn, "conducted" | "handoffId" | "about" | "origin" | "delivery" | "routine" | "released">> & { ids?: PresetTurnIds } = {}): Turn {
    // Work for a head the bot does not have (a hand-off from a bot with one head): made when first needed (1.x's `bot(for:)`).
    this.requireEngineRoute(head);
    const bot = this.botFor(head) ?? this.owner.makePartner(head);
    if (!bot) throw new ContractError("conflict", "Requested engine could not be created; nothing was rerouted.");
    const turn = bot.newTurn(extra.origin ?? (userId ? "user" : "app"), words, userId, extra.ids);
    if (extra.routine) turn.routine = true;
    if (extra.released) turn.released = true;
    if (extra.conducted) turn.conducted = true;
    if (extra.handoffId) turn.handoffId = extra.handoffId;
    if (extra.about) turn.about = extra.about;
    return bot.route(bot.watchDelivery(turn, extra.delivery));
  }

  /** `turn` tells `delivery` once whether it reached the head: it begins or is read into the turn under way
   * (`delivered`), or it ends without either (taken back, dropped at a stop or shutdown). */
  watchDelivery(turn: Turn, delivery?: (delivered: boolean) => void): Turn {
    if (!delivery) return turn;
    turn.delivery = delivery;
    void turn.done.then(() => { const tell = turn.delivery; turn.delivery = undefined; tell?.(false); });
    return turn;
  }

  /** `turn` reached the head: its `delivery` is told so (once). */
  delivered(turn: Turn) {
    const tell = turn.delivery;
    turn.delivery = undefined;
    tell?.(true);
  }

  /**
   * Botling 3's server: a turn whose intent the server committed before a restart (a routine's run, an answer's
   * message), made again with the ids it recorded and routed now, past `deferTurn`.
   */
  startPresetTurn(spec: { ids: PresetTurnIds; words: string; userId: string | null; origin: "user" | "app"; engine?: Engine; routine?: boolean }): { turnId: string; done: Promise<Status> } {
    if (this.options.primary) return this.options.primary.startPresetTurn(spec);
    this.refuseIfClosed();
    const turn = this.deliverTo(spec.engine ?? this.engine, spec.words, spec.userId, { origin: spec.origin, ids: spec.ids, released: true, ...(spec.routine ? { routine: true } : {}) });
    return { turnId: turn.id, done: turn.done };
  }

  newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn {
    // Your message (or the app's) goes on with the session: the try waiting after an API error is not needed.
    if (origin === "user" || origin === "app") this.clearApiRetry();
    let resolve!: Turn["resolve"];
    const done = new Promise<Status>((r) => (resolve = r));
    const turn: Turn = {
      id: ids?.turnId ?? `t-${randomUUID()}`, messageId: ids?.messageId ?? newId(), userId, origin, words, reply: new ReplyText(), steps: [], record: null,
      open: true, sent: false, head: null, retried: false, started: toSwiftDate(),
      ended: [], conducted: false, handoffId: null, about: [], peer: new Set(), told: 0, done, resolve,
    };
    return turn;
  }

  // ------------------------------------------------------------------------------------------
  // Two heads: who reads a message to both first

  /** A head not at work, taking turns when both are free (`claimLead`). Null when both are at work. */
  claimLead(heads: Engine[]): Engine | null {
    const free = heads.filter((head) => !this.botFor(head)?.working);
    if (free.length <= 1) return free[0] ?? null;
    return free.find((head) => head !== this.lastLead) ?? free[0]!;
  }

  /** Keeps the message from `held` until the lead says what it takes on (or ends its turn, or the wait passes). */
  holdForClaim(words: string, userId: string, held: Engine, lead: Engine): Turn {
    const turn = this.botFor(held)!.newTurn("user", words, userId);
    const id = randomUUID();
    const timer = setTimeout(() => { if (this.claimHold?.id === id) this.releaseClaim(); }, this.options.claimWaitMs ?? 20_000);
    this.claimHold = { id, lead, held, turn, timer };
    this.lastLead = lead;
    this.log(`${displayName(lead)} reads it first; ${displayName(held)} waits for what it takes on`);
    return turn;
  }

  /** Sends the held message on, with what the lead said about it (none: it said nothing yet). */
  releaseClaim(words?: string, about: string[] = []) {
    const hold = this.claimHold;
    if (!hold) return;
    this.claimHold = null;
    clearTimeout(hold.timer);
    if (words) {
      hold.turn.words = `${words}\n\n${hold.turn.words}`;
      hold.turn.about.push(...about);
    }
    if (!this.allowsEngineRoute(hold.held, hold.lead)) {
      this.finishTurn(hold.turn, "failed", "Antigravity cross-engine held turn blocked; nothing was routed.");
      return;
    }
    this.log(`${displayName(hold.held)} gets the message${words ? " with what the other head said" : ""}`);
    this.botFor(hold.held)?.route(hold.turn);
  }

  /** A head's turn ended without words for the other (silent, failed, stopped): a message it led goes on now. */
  headStopped(head: Engine) {
    const owner = this.owner;
    if (owner.claimHold?.lead === head) owner.releaseClaim();
  }

  /**
   * Something for `head` about the chat (what the other head said): it joins Codex's turn under way
   * (`turn/steer`), else it goes with the head's next message. An asleep head reads the chat when it
   * wakes. (1.x also steers claude mid-turn; 2.0 keeps it for claude's next message.)
   */
  tell(head: Engine, note: string, about: string[]) {
    if (!this.allowsEngineRoute(head)) return;
    const target = this.botFor(head);
    if (!target || !target.head?.running) return;
    if (target.hearNow(note, about)) return;
    target.pendingNote = [target.pendingNote, note].filter(Boolean).join("\n\n");
    target.pendingAbout.push(...about);
  }

  /**
   * The other head's words for this head's turn under way, at once (1.x's `Outgoing(contextOnly:)`):
   * Codex takes them into the turn (`turn/steer`); claude gets them as a message on its stdin, which
   * it reads into the turn under way (or, if that turn ends first, answers in a turn of its own,
   * which counts as the app's: `<no-reply/>` shows nothing). False: no turn of ours to join.
   */
  hearNow(note: string, about: string[]): boolean {
    if (!this.allowsEngineRoute(this.engine, this.owner.engine)) return false;
    const turn = this.turn;
    const head = this.head;
    if (!turn?.open || !turn.sent || turn.origin === "tidy" || !head?.running || turn.head !== head || this.draining || this.ignoreResults > 0 || this.ending.has(head)) return false;
    if (head instanceof AgyAcpHead) return false;
    if (head instanceof CodexHead) {
      if (!head.steer(note)) return false;
    } else {
      const id = randomUUID();
      this.turns.contextWritten(id);
      head.send(note, id);
    }
    for (const id of about) turn.peer.add(id);
    this.markSeen(about, this.engine);
    return true;
  }

  /** What it said between its tool calls, while the other head may work too (`headWords`). */
  headWords(words: string) {
    // Only explicit, correlated handoffs deliver peer input. Streaming commentary from an
    // independent task must not become a new provider request or steer another task.
  }

  /** A head showed a reply: the other head hears it, and the conductor carries any hand-off (`headReplied`). */
  headReplied(record: ChatRecord, head: Engine, handoff: Handoff | null, handed: boolean, handoffId: string | null) {
    if (!this.allowsEngineRoute(head) || (handoff && !this.allowsEngineRoute(handoff.to, head))) {
      this.notice("Requested collaboration route is unavailable; nothing was routed.");
      return;
    }
    const actions = this.conductor.replied(head, record.text, handoff, handed, handoffId);
    const decisions = new Set(handoffId ? this.handoffDecisions.get(handoffId) ?? [] : []);
    // An OPEN question gets an identity when it is actually handed over.
    if (isOpenQuestion(record) && !record.permissionTool && actions.some((a) => a.type === "ask" && a.handoffId && a.head !== head)) {
      this.identifyDecision(record.id);
      decisions.add(record.decisionID ?? record.id);
    }
    // An earlier question named on the hand-off (decision=…): an explicit reference, never a guess.
    if (handoff?.decisionId) {
      const source = this.records.find((candidate) => candidate.id === handoff.decisionId && candidate.role === "bot" && !candidate.permissionTool);
      if (source && (isOpenQuestion(source) || source.decisionID === handoff.decisionId)) {
        if (isOpenQuestion(source)) this.identifyDecision(source.id);
        if (source.decisionID) decisions.add(source.decisionID);
      }
    }
    for (const action of actions) if (action.type === "ask" && action.handoffId && action.head !== head) this.handoffDecisions.set(action.handoffId, decisions);
    this.conduct(actions);
  }

  /** Does what the conductor says: work for a head, lines and cards in the chat, the rounds line. */
  conduct(actions: ConductorAction[]): void {
    if (this.options.primary) return this.options.primary.conduct(actions);
    for (const action of actions) {
      switch (action.type) {
        case "ask":
          if (!this.allowsEngineRoute(action.head, this.conductor.records.find(record => record.id === action.handoffId)?.from ?? this.engine)) {
            if (action.handoffId) {
              for (const stopped of this.conductor.stop(action.handoffId)) if (stopped.type === "progress") this.rounds = stopped.progress;
            }
            this.notice("Requested collaboration route is unavailable; nothing was routed.");
            break;
          }
          this.deliverTo(action.head, action.text + this.decisionContext(action.handoffId ? this.handoffDecisions.get(action.handoffId) ?? new Set() : new Set()), null,
            { origin: "app", conducted: !!action.handoffId, handoffId: action.handoffId });
          break;
        case "line": {
          // The chat shows a hand-off's first line; the archive keeps all of it, for whoever reads the discussion later.
          const record: ChatRecord = { id: newId(), role: "divider", text: action.text, date: toSwiftDate() };
          this.add(record, { archive: !action.archive });
          if (action.archive) archiveLine(this.paths.archive, { ...record, text: action.archive });
          break;
        }
        case "card": {
          const record: ChatRecord = { id: newId(), role: "notice", text: action.text, date: toSwiftDate(), choices: action.choices.map((choice, index) => ({ label: choice.label, recommended: index === 0 })) };
          this.cardPicks.set(record.id, action.choices.map((choice) => choice.pick));
          this.add(record);
          this.bumpUnread();
          break;
        }
        case "progress":
          this.rounds = action.progress;
          break;
      }
    }
    const kept = new Set(this.conductor.records.map((record) => record.id));
    for (const id of [...this.handoffDecisions.keys()]) if (!kept.has(id)) this.handoffDecisions.delete(id);
    this.headsChanged();
  }

  /** "Stop now" on the rounds line: no more hand-offs for this message. */
  stopRounds(): ResultOf<"rounds.stop"> {
    this.forgetReturnRoutes();
    for (const peer of this.peers) peer.forgetReturnRoutes();
    const actions = this.conductor.stopAll();
    this.conduct(actions);
    return { stopped: actions.length > 0 };
  }

  /** Stops exactly one hand-off's chain (and the work it is under way with). */
  stopHandoff(id: string): ResultOf<"handoff.stop"> {
    const record = this.conductor.records.find((candidate) => candidate.id === id && isActive(candidate));
    if (!record) return { stopped: false };
    const chain = this.conductor.records.filter((candidate) => candidate.chainId === record.chainId && isActive(candidate)).map((candidate) => candidate.id);
    this.conduct(this.conductor.stop(id));
    for (const bot of this.members) {
      if (!bot) continue;
      for (const stopped of chain) bot.forgetReturnRoutes(stopped);
      for (const waiting of bot.queue.filter((turn) => turn.handoffId && chain.includes(turn.handoffId))) void bot.stop(waiting.id);
      if (bot.turn?.handoffId && chain.includes(bot.turn.handoffId)) void bot.stop(bot.turn.id);
    }
    return { stopped: true };
  }

  /** Who new messages go to (the composer's primary engine), saved in bot.json. */
  setAnswerWith(to: AnswerTarget): ResultOf<"heads.answerWith"> {
    const owner = this.owner;
    owner.headsSettings.answerWith = fitted(owner.headsSettings, to, owner.appPrimary());
    owner.saveHeads();
    owner.headsChanged();
    return { answerWith: owner.headsSettings.answerWith ?? resolvePrimary(owner.headsSettings, owner.appPrimary()) };
  }

  /** The app's default primary engine (Settings → Engines and models); null: none chosen. */
  appPrimary(): Engine | null {
    return (this.owner.options.launch?.().defaultPrimaryEngine ?? null) as Engine | null;
  }
}
