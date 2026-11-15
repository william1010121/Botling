// TurnControl (M7-S52): the turn under way and the line of messages behind it. Where a new turn goes (`route`: now, joined with
// the turn under way by steering or an Antigravity insert, paused for, or queued), how the turn after it is picked (`next`), the
// turn set aside while claude answered the other head first (`deferred`, `unbegun`), a stop and its drain (`stop`, `drained`),
// a wait for a turn's end (`await`), and the cards of finished subagents (`reportFinished`). It owns fifteen fields: `turn`,
// `queue`, `finished`, `draining`, `ignoreResults`, `paused`, `reportAsked`, `pendingEnded`, `ending`, `contextSent`, `steered`,
// `claudeMidTurn`, `inserting`, `deferred`, `unbegun`. It follows the bridge convention of `core/bot/context.ts`: the moved
// bodies are what they were in `Bot` and say `this.options`, `this.head`, `this.finishTurn(...)`; the BRIDGE BLOCK below is every
// name it borrows, one forwarder each: the shared names through the BotContext, `Bot`'s own through the host. `Bot` keeps a
// delegate for every name moved here that something outside this class reaches, and an accessor for every field.
// Not moved (still in `Bot`): `begin`, because a test patches `begin` on the instance and `routeTurn` must reach that patch;
// `redrawQueued` (the decisions card).
import { ContractError, type Event, type ResultOf } from "../../contract";
import { AgyAcpHead } from "../agent/agy-acp";
import { CodexHead } from "../agent/codex";
import type { CommandState } from "../agent/stream";
import type { Bot, Status } from "../bot";
import { archiveLine, reportNote } from "../briefing";
import { isActive, type Engine } from "../heads";
import { PAUSE_NOTE, RESUME_NOTE } from "../prompts";
import { parseReply } from "../reply";
import type { SubagentRecord } from "../subagents";
import type { ChatRecord } from "../store/records";
import type { BotContext } from "./context";
import type { AgentHead, BotOptions, Origin, PresetTurnIds, Turn } from "./types";
import { sleep, turnCommandId } from "./view-functions";

export class TurnControl {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get id() { return this.ctx.id; }
  private get engine(): Engine { return this.ctx.engine; }
  private get subagents() { return this.ctx.subagents; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get peers(): Bot[] { return this.ctx.peers; }
  private get paths() { return this.ctx.paths; }
  private get sharesChat(): boolean { return this.ctx.sharesChat; }
  private log(line: string) { this.ctx.log(line); }
  private emit(event: Event) { this.ctx.emit(event); }
  private requireEngineRoute(head: Engine, from?: Engine) { this.ctx.requireEngineRoute(head, from); }
  private get head() { return this.host.head; }
  private get records(): ChatRecord[] { return this.host.records; }
  private get approvals() { return this.host.approvals; }
  private get tidying() { return this.host.tidying; }
  private get switching() { return this.host.switching; }
  private get switchReady() { return this.host.switchReady; }
  private get swapHold() { return this.host.swapHold; }
  private get settingsHold() { return this.host.settingsHold; }
  private get folderPending() { return this.host.folderPending; }
  private get modelSettingsPending() { return this.host.modelSettingsPending; }
  private get managedPending() { return this.host.managedPending; }
  private get ownWorkRunning() { return this.host.ownWorkRunning; }
  private get claimHold() { return this.host.claimHold; }
  private set claimHold(hold) { this.host.claimHold = hold; }
  private newTurn(origin: Origin, words: string, userId: string | null, ids?: PresetTurnIds): Turn { return this.host.newTurn(origin, words, userId, ids); }
  private begin(turn: Turn, head?: AgentHead) { this.host.begin(turn, head); }
  private delivered(turn: Turn) { this.host.delivered(turn); }
  private redrawQueued(turn: Turn) { this.host.redrawQueued(turn); }
  private turnImages(turn: Turn): string[] { return this.host.turnImages(turn); }
  private compose(turn: Turn, brief: boolean): string { return this.host.compose(turn, brief); }
  private finishTurn(turn: Turn, status: Status, error?: string) { this.host.finishTurn(turn, status, error); }
  private handOver(): Promise<void> { return this.host.handOver(); }
  private canSwitchInPlace(head: AgentHead): boolean { return this.host.canSwitchInPlace(head); }
  private clearIdle() { this.host.clearIdle(); }
  private scheduleIdle() { this.host.scheduleIdle(); }
  private place(turn: Turn): ChatRecord { return this.host.place(turn); }
  private notice(text: string) { this.host.notice(text); }
  private bumpUnread() { this.host.bumpUnread(); }
  private markSeen(ids: string[], head: Engine) { this.host.markSeen(ids, head); }
  private persist(soon?: boolean) { this.host.persist(soon); }
  private messageView(record: ChatRecord) { return this.host.messageView(record); }
  private updated() { this.host.updated(); }
  private settleTurnApprovals() { this.host.settleTurnApprovals(); }
  private headStopped(head: Engine) { this.host.headStopped(head); }
  private checkSettingsHold() { this.host.checkSettingsHold(); }
  private holdForSettings(turn: Turn) { this.host.holdForSettings(turn); }
  private releaseSettingsHold(): boolean { return this.host.releaseSettingsHold(); }
  private waitsForRestart(turn: Turn): boolean { return this.host.waitsForRestart(turn); }

  // ---- Fields owned here (`Bot` reads and writes them through accessors) ----
  /** The turn under way. */
  turn: Turn | null = null;
  /** Messages that wait for the turn under way (or the tidy) to end. */
  queue: Turn[] = [];
  finished = new Map<string, Status>();
  draining: { head: AgentHead; resolve: () => void; promise: Promise<void> } | null = null;
  /** Results still to come from turns ended early (a tidy or a guest turn that ran late): they belong to nobody. */
  ignoreResults = 0;
  /** Work paused for the user's message (1.x's `pausedWork`): carried on once the user has been answered. */
  paused: { conducted: boolean; handoffId: string | null } | null = null;
  /** Finished subagents a silent turn has already been asked to report, once. */
  reportAsked = new Set<string>();
  /** Subagents that ended between turns: the next turn claude starts itself reports them. */
  pendingEnded: string[] = [];
  /** Heads being ended (a Stop it did not listen to, quitting): nothing they print counts any more. */
  ending = new WeakSet<AgentHead>();
  /** The other head's words written to claude mid-turn, by message uuid: one that gets a turn of its own is the app's. */
  contextSent = new Set<string>();
  /** Your lines written to claude while its turn ran, by message uuid: one claude begins a turn of its own for is answered there. */
  steered = new Map<string, Turn>();
  /**
   * claude has a turn under way: it said "started" for a line, or its turn said something, and no result came since.
   * A "started" for a line then means claude read it into that turn (3353d2d9), never a turn of its own.
   */
  claudeMidTurn = new WeakSet<AgentHead>();
  /** Your lines offered into an Antigravity turn (`offerInsert`), by id: in the queue ("Queued") until it reads them. */
  inserting = new Map<string, Turn>();
  /** Our turn that claude has not begun yet, set aside while it answers the other head's words first. */
  deferred: Turn | null = null;
  /**
   * The deferred turn back as the turn under way that claude has not begun yet (no "started", no output), and the clock
   * that ends it if claude never does: its words were taken into the turn that just ended, so nothing more comes for it.
   */
  unbegun: { turn: Turn; head: AgentHead; timer: ReturnType<typeof setTimeout> } | null = null;

  // ---- TurnBook transitions: the only places `turn` and `queue` are assigned (M7-S54) ----
  /** `turn` waits behind the turn under way (or the tidy): last in line. */
  enqueue(turn: Turn) { this.queue.push(turn); }
  /** A message that waits for this head's own work before a model/effort restart goes first in line (`holdForSettings`). */
  enqueueFirst(turn: Turn) { this.queue.unshift(turn); }
  /** The message first in line leaves it, if any. */
  dequeue(): Turn | undefined { return this.queue.shift(); }
  /** The message at `at` leaves the line (read into the turn under way, or taken back). */
  dequeueAt(at: number) { this.queue.splice(at, 1); }
  /** Every waiting message leaves the line (quitting): the caller ends them. */
  dequeueAll(): Turn[] { return this.queue.splice(0); }
  /** `turn`, under way and not begun by claude, is set aside while claude answers a line first (turn cleared first, as it always was). */
  setAside(turn: Turn) { this.close(); this.deferred = turn; }
  /** The turn set aside is no longer set aside (it is the turn under way again, or it ended); hands it back. */
  takeBack(): Turn | null { const turn = this.deferred; this.deferred = null; return turn; }
  /** Your line `next` was written to claude's stdin mid-turn (`id`, lower case): if claude begins a turn for it, it is answered there. */
  steerStarted(id: string, next: Turn) { this.steered.set(id, next); }
  /** Claude read the line `id` into a turn, or ended it: nothing more comes for it. */
  steerSettled(id: string) { this.steered.delete(id); }
  /** The other head's words `id` were written to claude mid-turn. */
  contextWritten(id: string) { this.contextSent.add(id); }
  /** Claude read, or began a turn for, the other head's words `id`: false if they were not written mid-turn. */
  contextSettled(id: string): boolean { return this.contextSent.delete(id); }
  /** The head's process is gone: what was written to it mid-turn will never be read. */
  forgetSent() { this.contextSent.clear(); this.steered.clear(); }
  /** Your line `next` was offered into an Antigravity turn under `id`. */
  insertOffered(id: string, next: Turn) { this.inserting.set(id, next); }
  /** `turn` is the turn under way (`Bot.begin`'s name is taken by the forwarder to it below). */
  start(turn: Turn) { this.turn = turn; }
  /** No turn is under way. */
  close() { this.turn = null; }

  // ---- Moved from `Bot` ----
  /** Where a new turn goes: now, joined with the one under way, or after it. The turn that carries it. */
  route(turn: Turn): Turn {
    if (this.options.deferTurn && !turn.released) {
      turn.released = true;
      const kept = this.options.deferTurn({
        botId: this.id, turnId: turn.id, messageId: turn.messageId, userId: turn.userId, origin: turn.origin, words: turn.words,
        engine: this.engine, routine: turn.routine === true, done: turn.done,
        release: () => ({ turnId: this.route(turn).id, done: turn.done }),
      });
      if (kept) return turn;
    }
    const routed = this.routeTurn(turn);
    if (routed === turn && this.queue.includes(turn)) this.redrawQueued(turn);
    return routed;
  }

  routeTurn(turn: Turn): Turn {
    this.requireEngineRoute(this.engine, this.owner.engine);
    const current = this.turn;
    // The core is being swapped (hot-swap.ts): nothing new begins; it waits and is handed over.
    if (this.swapHold) { this.enqueue(turn); return turn; }
    // A switch of engine waits for this message: the handoff first, then the message (`restartsBeforeMessage`).
    if (!current && this.switchReady) { this.enqueue(turn); void this.handOver(); return turn; }
    // A message already waits for this head's work before a model/effort restart: this one goes after it.
    if (this.settingsHold) { this.enqueue(turn); this.checkSettingsHold(); return turn; }
    if (!current && !this.tidying && !this.switching && this.waitsForRestart(turn) && this.head?.running && this.ownWorkRunning
      && (this.folderPending || (this.modelSettingsPending && !this.canSwitchInPlace(this.head)))) {
      this.holdForSettings(turn);
      return turn;
    }
    if (!current && !this.tidying && !this.switching) { this.begin(turn); return turn; }
    // A saved model/effort, or a new working folder, belongs to a new turn, never to steering the old process.
    // While it tidies before sleep nothing joins a turn of claude's own (a report): its process is about to end.
    if (current && (this.modelSettingsPending || this.folderPending || this.tidying)) { this.enqueue(turn); return turn; }
    if (current && this.canPause(current, turn)) return this.pause(current, turn);
    if (current && this.canSteer(current, turn) && this.steerInto(current, turn)) return current;
    if (current && this.offerInsert(current, turn)) {
      this.enqueue(turn);
      this.log("you wrote while Antigravity worked: your message goes into its turn with its next tool result (queued until then)");
      return turn;
    }
    this.enqueue(turn);
    this.log("a message waits for the turn under way");
    return turn;
  }

  /**
   * `Bot.pausing`: you wrote while it works on something you did not start (handed-over work, a
   * routine, a report, claude's own turn). Unless stopping it would lose work (an approval is open, a
   * subagent runs in the foreground), that work waits until you are answered. Codex pauses only
   * handed-over work (its other turns take your message in with `turn/steer`, as 1.x).
   */
  private canPause(current: Turn, next: Turn): boolean {
    if (next.origin !== "user" || current.origin === "user" || current.origin === "tidy" || this.paused) return false;
    if (!current.open || !current.sent || !current.head?.running || current.head !== this.head || this.queue.length || this.draining || this.ignoreResults) return false;
    if (this.approvals.size || this.subagents.running.some((subagent) => !subagent.background)) return false;
    return this.engine === "claude" || (current.conducted && this.head instanceof CodexHead);
  }

  /** Pauses `current` for your message `next` (1.x's `route` with `pausing`): see the header. */
  private pause(current: Turn, next: Turn): Turn {
    const paused = { conducted: current.conducted, handoffId: current.handoffId };
    next.words = `${PAUSE_NOTE}\n\n${next.words}`;
    // Your message joins the turn, which is yours from now on; the work it was on waits.
    current.conducted = false;
    current.handoffId = null;
    if (!this.steerInto(current, next)) {
      current.conducted = paused.conducted;
      current.handoffId = paused.handoffId;
      next.words = next.words.slice(PAUSE_NOTE.length + 2);
      this.enqueue(next);
      return next;
    }
    this.paused = paused;
    this.log("you wrote while it worked on something you did not start: that work is paused for your message");
    return current;
  }

  /** `Bot.resumePausedWork`: the user has been answered; the paused work goes on, on its own hand-off. */
  private resumePaused(): boolean {
    const paused = this.paused;
    if (!paused) return false;
    this.paused = null;
    if (!this.head?.running) return false;
    // A hand-off stopped (or settled) meanwhile has nothing left to carry on.
    if (paused.handoffId && !this.owner.conductor.records.some((record) => record.id === paused.handoffId && isActive(record))) return false;
    const turn = this.newTurn("app", RESUME_NOTE, null);
    turn.conducted = paused.conducted;
    turn.handoffId = paused.handoffId;
    this.log("carrying on with the work paused for your message");
    this.begin(turn);
    return true;
  }

  /**
   * 1.x's steering: a message from you while a head works joins the turn under way (Codex: `turn/steer`;
   * claude: on its stdin), unless that turn is handed-over work (paused for you: `canPause`) or the tidy.
   * claude takes it in the user's own turn whatever is open; in work the user did not start only with no approval open and no foreground subagent at work (else it waits).
   */
  private canSteer(current: Turn, next: Turn): boolean {
    if (next.origin !== "user" || current.origin === "tidy" || current.conducted || !current.open || !current.sent) return false;
    if (current.head !== this.head || !this.head?.running || this.draining || this.ignoreResults || this.ending.has(this.head)) return false;
    if (this.head instanceof AgyAcpHead) return false;
    if (this.head instanceof CodexHead) return true;
    // claude reads a line on its stdin at its next step, so an open approval (answered by its card, never by words) or a
    // foreground subagent does not stop the user's own turn from taking it. Work the user did not start keeps those
    // gates: there `canPause` refused for them, and joining it unpaused would turn it into the user's turn.
    if (this.queue.length) return false;
    return current.origin === "user" || (!this.approvals.size && !this.subagents.running.some((subagent) => !subagent.background));
  }

  /**
   * An Antigravity head cannot take words into a running prompt (ACP has no steer), but every tool it calls is the
   * app's: your line `next` is offered to the turn under way and rides on its next tool result (`AgyAcpHead.offerInsert`).
   * It stays in the queue, "Queued", until the head says it was read (`insertDelivered`); a turn that ends without
   * another tool call drops the offer and the queue sends it as the next turn. The same gates as claude's steering.
   */
  private offerInsert(current: Turn, next: Turn): boolean {
    const head = this.head;
    if (!(head instanceof AgyAcpHead) || typeof head.offerInsert !== "function") return false;
    if (next.origin !== "user" || current.origin === "tidy" || current.conducted || !current.open || !current.sent) return false;
    if (current.head !== head || !head.running || this.draining || this.ignoreResults || this.ending.has(head)) return false;
    // Behind a message that waits for the next turn it would jump the order.
    const offered = new Set(this.inserting.values());
    if (this.queue.some((turn) => !offered.has(turn))) return false;
    if (current.origin !== "user" && this.approvals.size) return false;
    if (this.turnImages(next).length) return false;
    const id = (next.userId ?? next.messageId).toLowerCase();
    if (!head.offerInsert(id, next.words)) return false;
    this.insertOffered(id, next);
    return true;
  }

  /** Antigravity read your line with a tool result of its turn: it joins that turn, as a steered line does. */
  insertDelivered(head: AgentHead, id: string) {
    const next = this.inserting.get(id);
    if (!next) return;
    this.inserting.delete(id);
    const current = this.turn;
    const at = this.queue.indexOf(next);
    if (at < 0 || !next.open || next.sent || !current?.open || current.head !== head) return;
    this.dequeueAt(at);
    next.head = head;
    next.sent = true;
    this.joinTurn(current, next);
    this.delivered(next);
    this.redrawQueued(next);
    this.log("Antigravity read your message with a tool result: it joined its turn");
  }

  /** A line offered into an Antigravity turn leaves the queue another way (taken back, sent as a turn): the offer goes. */
  private withdrawInsert(turn: Turn) {
    const id = (turn.userId ?? turn.messageId).toLowerCase();
    if (this.inserting.get(id) !== turn) return;
    this.inserting.delete(id);
    const head = this.head;
    if (head instanceof AgyAcpHead && typeof head.withdrawInsert === "function") head.withdrawInsert(id);
  }

  /** Steers `next` into `current`: the reply now answers your latest words, and shows after them. */
  private steerInto(current: Turn, next: Turn): boolean {
    const head = this.head;
    if (!head) return false;
    if (head instanceof CodexHead) {
      if (!head.steer(this.compose(next, false))) return false;
    } else {
      // claude reads it into the turn under way at once (priority "now"; a foreground subagent at work goes to the
      // background first, so it is not stopped); if that turn ends first, it begins a turn of its own for it (`steeredStarted`).
      const id = next.userId ?? next.messageId;
      next.head = head;
      next.sent = true;
      this.steerStarted(id.toLowerCase(), next);
      head.send(this.compose(next, false), id, this.turnImages(next), { now: true });
      current.steeredNow = true;
    }
    this.joinTurn(current, next);
    this.delivered(next);
    this.log(head instanceof CodexHead ? "you wrote while Codex worked: your message joined its turn (turn/steer)" : "you wrote while claude worked: your message went into its turn");
    return true;
  }

  /** `next`, already read into `current`: their cards join, the turn is yours, and the reply so far moves below your line. */
  private joinTurn(current: Turn, next: Turn) {
    current.origin = "user";
    current.userId = next.userId;
    current.words = next.words;
    current.about.push(...next.about);
    for (const id of next.peer) current.peer.add(id);
    this.markSeen([...next.about, ...(next.userId ? [next.userId] : [])], this.engine);
    // The reply so far moves below your new line, where its end will be.
    const record = current.record;
    if (record) {
      const at = this.records.indexOf(record);
      if (at >= 0) {
        this.records.splice(at, 1);
        this.emit({ type: "message.removed", botId: this.id, messageId: record.id });
        this.records.push(record);
        this.persist();
        this.emit({ type: "message.added", botId: this.id, message: this.messageView(record) });
      }
    }
    void current.done.then(next.resolve);
  }

  /**
   * claude begins a turn of its own for a line of yours it was sent mid-turn (the turn under way ended
   * before it read it in): that turn answers you. Our turn sent after it and not begun waits for it.
   */
  steeredStarted(head: AgentHead, next: Turn) {
    if (head !== this.head || this.ignoreResults || this.draining || this.ending.has(head)) return;
    const waiting = this.turn;
    // Read into the turn under way after all.
    if (waiting && (!waiting.open || waiting.head !== head || waiting.reply.text || waiting.steps.length || waiting.record || this.deferred)) return;
    if (waiting) this.setAside(waiting);
    const turn = this.newTurn("user", next.words, next.userId);
    turn.head = head;
    turn.sent = true;
    turn.about = [...next.about];
    this.start(turn);
    this.clearIdle();
    this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId, head: this.engine });
    this.updated();
    this.log("claude read your line after its turn ended: it answers it in a turn of its own");
  }

  /**
   * claude is done with a message the app sent it (`command_lifecycle`'s end). A message it took into the turn under way
   * ("absorbed_mid_turn") gets no "started" and no result of its own: only this, before that turn's result. A turn of ours
   * set aside for it (deferred) would otherwise wait for a turn that never comes, and everything after it with it.
   * A turn under way that it ends is left to the result that follows (that result is its answer).
   */
  commandEnded(head: AgentHead, id: string, state: CommandState) {
    // Words steered into a turn, or the other head's words: read in there, nothing more comes for them.
    this.steerSettled(id);
    this.contextSettled(id);
    // The turn set aside and back as the turn under way, not begun: its end after the result means claude took its words
    // into the turn that just ended (2026-11-09: it waited for a turn that never came, hours of "Thinking").
    const unbegun = this.unbegun;
    if (unbegun && unbegun.head === head && this.turn === unbegun.turn && turnCommandId(unbegun.turn) === id) {
      this.clearUnbegun();
      this.finishTurn(unbegun.turn, state === "completed" ? "done" : "stopped");
      this.log(`claude was done with a message set aside for its own turn (${state}) without beginning it: that turn ended`);
      return;
    }
    const deferred = this.deferred;
    if (!deferred || deferred.head !== head || turnCommandId(deferred) !== id) return;
    this.takeBack();
    // Stopped by you meanwhile: closed already, and claude has nothing of it left to interrupt.
    if (!deferred.open) return;
    const status: Status = state === "completed" ? "done" : "stopped";
    deferred.open = false;
    this.emit({ type: "turn.finished", botId: this.id, turnId: deferred.id, messageId: deferred.messageId, status, text: "" });
    this.finished.set(deferred.id, status);
    deferred.resolve(status);
    this.log(state === "completed" ? "claude took a message into the turn under way: it gets no turn of its own" : `claude dropped a message it had taken into a turn (${state})`);
    this.updated();
  }

  /**
   * `turn`, set aside while claude answered a line first, is the turn under way again: claude begins it now, as a rule at
   * once (it was sent already and waits in claude's queue). Should claude never begin it (its words went into the turn
   * that just ended, and its end was lost or never said), it ends after `deferredStartMs` and what waits behind it goes:
   * never a "Thinking" that lasts until the app is restarted.
   */
  private awaitBegin(turn: Turn, head: AgentHead) {
    this.clearUnbegun();
    const timer = setTimeout(() => {
      if (this.unbegun?.timer !== timer) return;
      this.unbegun = null;
      if (this.turn !== turn || !turn.open || turn.reply.text || turn.steps.length || turn.record) return;
      this.log(`claude did not begin a message set aside for its own turn within ${Math.round(this.deferredStartMs / 1000)} s: that turn ended, and what waits goes on`);
      this.finishTurn(turn, "stopped");
    }, this.deferredStartMs);
    timer.unref?.();
    this.unbegun = { turn, head, timer };
  }

  private get deferredStartMs(): number { return this.options.deferredStartMs ?? 90_000; }

  clearUnbegun() {
    if (!this.unbegun) return;
    clearTimeout(this.unbegun.timer);
    this.unbegun = null;
  }

  /** The next waiting message, if any; else the idle clock starts. */
  next(): void {
    // While a stopped turn drains nothing begins (not even the turn set aside): stop() goes on here once it ended.
    if (this.turn || this.tidying || this.switching || this.draining) return;
    const deferred = this.deferred;
    if (deferred) {
      // It was sent already: claude begins it now.
      this.takeBack();
      if (deferred.open && deferred.head === this.head && this.head?.running) { this.start(deferred); this.awaitBegin(deferred, this.head); return; }
      // Stopped meanwhile: what claude does with it belongs to nobody.
      if (!deferred.open && deferred.head === this.head && this.head?.running) { this.ignoreResults += 1; this.head.interrupt(); }
    }
    if (this.swapHold) return;
    if (this.resumePaused()) return;
    // Your message waits for this head's own work before a model/effort restart.
    if (this.settingsHold && !this.releaseSettingsHold()) return;
    if (this.queue.some((turn) => turn.open) && this.switchReady) { void this.handOver(); return; }
    const waiting = this.dequeue();
    if (waiting) {
      this.withdrawInsert(waiting);
      if (!waiting.open) return this.next();
      this.begin(waiting);
      return;
    }
    this.scheduleIdle();
  }

  /** `Bot.reportFinishedSubagents`: the bot answered a finished subagent's news with nothing. */
  reportFinished(ids: string[]) {
    // Codex: a worker's report turn is on its way (or under way); it says what came of it.
    if ((this.engine === "codex" || this.engine === "agy") && this.managedPending) return this.next();
    const moved = this.options.agents?.movedOut(this.engine);
    const finished = [...new Set(ids)].filter((id) => !moved?.has(id)).map((id) => this.subagents.get(id)).filter((subagent): subagent is SubagentRecord => !!subagent && subagent.status !== "running");
    const ask = finished.filter((subagent) => !this.reportAsked.has(subagent.id));
    if (ask.length && this.engine === "claude" && this.head?.running && !this.queue.length) {
      for (const subagent of ask) this.reportAsked.add(subagent.id);
      const turn = this.newTurn("app", reportNote(ask), null);
      turn.ended = ask.map((subagent) => subagent.id);
      this.begin(turn);
      return;
    }
    if (finished.length) {
      this.notice(finished.map((subagent) => {
        const report = (subagent.result ?? "").split("\n").find((line) => line.trim()) ?? "";
        const line = `Subagent “${subagent.description}” finished.`;
        return report ? `${line} Its report: ${report}` : line;
      }).join("\n"));
      this.bumpUnread();
    }
    this.next();
  }

  /** `quitting`: no polite interrupt first (the app is going), the tree is ended at once. */
  async stop(turnId: string, { quitting = false } = {}): Promise<ResultOf<"turn.stop">> {
    // Stopped by you: the judge does not continue it (1.x's explicit stop wins).
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.origin === "tidy") {
      // A message still waiting its turn: taken back (it never reached claude).
      const waiting = this.queue.find((candidate) => candidate.id === turnId);
      if (waiting) {
        this.dequeueAt(this.queue.indexOf(waiting));
        this.withdrawInsert(waiting);
        waiting.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: waiting.messageId, status: "stopped", text: "" });
        this.finished.set(turnId, "stopped");
        waiting.resolve("stopped");
        // The message that waited for a model/effort restart was taken back: its card goes too.
        this.checkSettingsHold();
        return { stopped: true, killed: [], forced: false };
      }
      // Sent, but set aside while claude answers the other head's words first.
      if (this.deferred?.id === turnId) {
        const deferred = this.deferred;
        deferred.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: deferred.messageId, status: "stopped", text: "" });
        this.finished.set(turnId, "stopped");
        deferred.resolve("stopped");
        return { stopped: true, killed: [], forced: false };
      }
      // The message held for the other head (a message to both): taken back too.
      const hold = this.claimHold;
      if (hold?.turn.id === turnId) {
        this.claimHold = null;
        clearTimeout(hold.timer);
        hold.turn.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: hold.turn.messageId, status: "stopped", text: "" });
        hold.turn.resolve("stopped");
        return { stopped: true, killed: [], forced: false };
      }
      // The other head's turn.
      const peer = this.peers.find(bot => bot.ownsTurn(turnId));
      if (peer) return peer.stop(turnId, { quitting });
      return { stopped: false, killed: [], forced: false };
    }
    // Stop stops the work paused for the user too.
    this.paused = null;
    // Order matters: the turn is closed (and says so) before claude hears of it.
    turn.open = false;
    this.close();
    const text = parseReply(turn.reply.text).body;
    let record = turn.record;
    if (record || turn.origin !== "background") {
      record ??= this.place(turn);
      record.text = text;
      record.state = "stopped";
      record.interrupted = true;
      if (turn.steps.length) record.steps = turn.steps;
      this.persist();
      archiveLine(this.paths.archive, record);
    }
    this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: turn.messageId, status: "stopped", text });
    if (record) this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    this.finished.set(turnId, "stopped");
    turn.resolve("stopped");
    this.settleTurnApprovals();
    this.updated();
    // A message this head led for both: the other head gets it now.
    if (this.sharesChat) this.headStopped(this.engine);
    const head = turn.head;
    if (!head || !head.running || !turn.sent) { this.next(); return { stopped: true, killed: [], forced: false }; }
    if (quitting) {
      this.ending.add(head);
      const result = await head.terminate(1_000);
      return { stopped: true, killed: result.killed, forced: result.forced };
    }
    // Ask claude to end the turn (the session goes on); wait for its result line.
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const draining = { head, resolve, promise };
    this.draining = draining;
    head.interrupt();
    const ended = await Promise.race([promise.then(() => true), sleep(this.options.interruptGraceMs).then(() => false)]);
    if (ended) {
      if (this.draining === draining) this.draining = null;
      this.log(`turn ${turnId} stopped; claude ended it`);
      this.next();
      return { stopped: true, killed: [], forced: false };
    }
    // It did not answer: end its whole tree. The next message starts the head again (--resume). What waits goes only
    // once the process is gone (onExit), never to the process being ended.
    this.ending.add(head);
    const result = await head.terminate(1_500);
    if (this.draining === draining) this.draining = null;
    resolve();
    this.log(`turn ${turnId} stopped; claude did not end it in time, so its tree was ended: ${result.killed.join(",")} forced=${result.forced}`);
    this.next();
    return { stopped: true, killed: result.killed, forced: result.forced };
  }

  /** A stopped turn has drained (claude ended it, or its process is gone): the turn that waited is sent now. */
  drained(head: AgentHead) {
    const draining = this.draining;
    if (draining?.head !== head) return;
    this.draining = null;
    draining.resolve();
  }

  async await(turnId: string, signal: AbortSignal): Promise<ResultOf<"turn.await">> {
    const done = this.members.map(bot => bot.finished.get(turnId)).find(Boolean);
    if (done) return { status: done };
    const turn = this.turn?.id === turnId ? this.turn : this.deferred?.id === turnId ? this.deferred : this.queue.find((candidate) => candidate.id === turnId)
      ?? (this.claimHold?.turn.id === turnId ? this.claimHold.turn : undefined);
    if (!turn) {
      const peer = this.peers.find(bot => bot.ownsTurn(turnId));
      if (peer) return peer.await(turnId, signal);
      throw new ContractError("not_found", "No such turn.");
    }
    const status = await Promise.race([
      turn.done,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ContractError("cancelled", "Stopped waiting.")))),
    ]);
    return { status };
  }
}
