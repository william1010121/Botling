// One bot in the core: its chat (kept in 1.x's chat.json format), its head (one long-lived
// claude process, started when a message needs it and resumed after a crash or sleep), the turn
// under way, and the tool approvals it is waiting on.
//
// Rules, as in the Phase 0 core and the Swift `Bot`:
// - One turn at a time. A second message while one runs is refused (1.x steers instead: a gap).
// - Stop closes the turn's gate first (nothing it prints afterwards reaches anyone) and says so,
//   then asks claude to interrupt; a head that does not end the turn in time is ended with its
//   whole process tree, and the next message starts a new one with `--resume`.
// - An approval is a chat line with Allow once / Always allow / Don't allow. What a pick means
//   comes from the button's action, never its words. No answer in time counts as no. Approvals
//   left open by a restart or a dead head are closed ("No longer needed"), never answered later.
// - A head that crashes fails the turn it was on, and is started again (a few times, backing off).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ContractError, type BotView, type CardView, type ChatSnapshot, type ChoiceView, type Event, type MessageView, type ResultOf, type StepView } from "../contract";
import { ClaudeHead, type HeadConfig, type HeadExit } from "./agent/head";
import { ReplyText, type StreamItem } from "./agent/stream";
import { extractCards, welcomeMessages } from "./cards";
import type { ProcessLedger } from "./process/ledger";
import { BotStore, StoreError, type HeadState } from "./store/bot-store";
import { isOpenQuestion, newId, swiftDateISO, toSwiftDate, type ChatRecord, type ChoiceRecord, type StepRecord } from "./store/records";
import type { BotProfile } from "./store/workspace";

export type Status = "done" | "stopped" | "failed";

export interface BotOptions {
  profile: BotProfile;
  /** How to run this bot's head for a session. */
  headConfig: (profile: BotProfile, session: { sessionId: string; resume: boolean }) => HeadConfig;
  ledger: ProcessLedger;
  emit: (event: Event) => void;
  log: (line: string) => void;
  /** No answer in this time counts as "Don't allow" (1.x: 10 minutes). */
  approvalTimeoutMs: number;
  /** An idle head is put to sleep (stdin closed) after this long. */
  idleMs: number;
  /** How long Stop waits for claude to end the turn before ending its process tree. */
  interruptGraceMs: number;
  /** Give a new, empty chat the welcome lines (the main bot of a fresh install). */
  welcome?: boolean;
}

interface Turn {
  id: string;
  messageId: string;
  userId: string;
  text: string;
  reply: ReplyText;
  steps: StepRecord[];
  /** The reply's chat line, once it has something to show. */
  record: ChatRecord | null;
  /** The gate: false once the turn ended or was stopped; nothing reaches anyone after. */
  open: boolean;
  head: ClaudeHead | null;
  /** Sent again once already (its resume failed). */
  retried: boolean;
  done: Promise<Status>;
  resolve: (status: Status) => void;
}

interface Approval {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  head: ClaudeHead;
  timer: NodeJS.Timeout;
  expires: number;
}

const NO_LONGER_NEEDED = "No longer needed";
const NO_ANSWER = "No answer in time";
/** Tools whose "always" would be far broader than it sounds; they are asked every time (`Bot.neverAlways`). */
const NEVER_ALWAYS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Monitored command"]);
const MAX_RESTARTS = 3;

export class Bot {
  readonly store: BotStore;
  private records: ChatRecord[] = [];
  /** Set when its chat file could not be read: nothing is written over it then. */
  private problem: string | null = null;
  private readOnly = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private head: ClaudeHead | null = null;
  private turn: Turn | null = null;
  private finished = new Map<string, Status>();
  private approvals = new Map<string, Approval>();
  private draining: { head: ClaudeHead; resolve: () => void; promise: Promise<void> } | null = null;
  private session: HeadState;
  private crashes = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private alwaysAllowed: string[];
  private unread: number;
  private shuttingDown = false;

  constructor(private options: BotOptions) {
    this.store = new BotStore(options.profile.storeDir);
    this.session = this.store.loadHead() ?? { sessionId: randomUUID(), started: false };
    this.alwaysAllowed = this.store.loadAlwaysAllowed();
    this.unread = this.store.loadUnread();
    this.load();
  }

  get id() {
    return this.options.profile.id;
  }
  get profile() {
    return this.options.profile;
  }

  private log(line: string) {
    this.options.log(`[${this.profile.name}] ${line}`);
  }

  private emit(event: Event) {
    this.options.emit(event);
  }

  // ------------------------------------------------------------------------------------------
  // The chat file

  private load() {
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
    for (const record of records) {
      // A turn that was streaming when the core died is not resumed or re-sent: it is marked.
      if (record.state === "streaming") {
        record.state = "failed";
        record.interrupted = true;
        record.text += (record.text ? "\n\n" : "") + "(Interrupted: the core restarted during this reply. It was not sent again.)";
        changed = true;
      }
      // A tool question from before a restart has nobody waiting for it any more.
      if (record.permissionTool && isOpenQuestion(record)) {
        record.answer = NO_LONGER_NEEDED;
        changed = true;
      }
    }
    if (!records.length && this.options.welcome && !this.store.hasChat) {
      records = welcomeMessages();
      changed = true;
    }
    this.records = records;
    if (changed) this.persist();
  }

  private persist(soon = false) {
    if (this.readOnly) return;
    if (soon) {
      this.saveTimer ??= setTimeout(() => { this.saveTimer = null; this.persist(); }, 500);
      return;
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.store.saveMessages(this.records);
  }

  private add(record: ChatRecord) {
    this.records.push(record);
    this.persist();
    this.emit({ type: "message.added", botId: this.id, message: messageView(record, this.approvals.get(record.id)) });
  }

  private changed(record: ChatRecord) {
    this.persist();
    this.emit({ type: "message.updated", botId: this.id, message: messageView(record, this.approvals.get(record.id)) });
  }

  // ------------------------------------------------------------------------------------------
  // Views

  view(): BotView {
    return {
      id: this.id,
      name: this.profile.name.slice(0, 200),
      role: this.profile.role,
      avatar: this.profile.avatar.slice(0, 40),
      folder: this.profile.folder.slice(0, 4_000),
      phase: this.head?.running ? "awake" : "asleep",
      working: !!this.turn,
      approvals: this.approvals.size,
      unread: this.unread,
      problem: (this.problem ?? this.profile.problem)?.slice(0, 2_000) ?? null,
    };
  }

  private updated() {
    this.emit({ type: "bot.updated", bot: this.view() });
  }

  snapshot(): ChatSnapshot {
    return {
      botId: this.id,
      messages: this.records.map((record) => messageView(record, this.approvals.get(record.id))),
      running: this.turn ? { turnId: this.turn.id, messageId: this.turn.messageId } : null,
      live: this.turn ? this.turn.steps.slice(-500).map(stepView) : [],
    };
  }

  get messageCount() {
    return this.records.length;
  }

  // ------------------------------------------------------------------------------------------
  // Sending, and the turn

  send(text: string): ResultOf<"chat.send"> {
    if (this.problem) throw new ContractError("conflict", this.problem);
    if (this.profile.problem) throw new ContractError("conflict", this.profile.problem);
    if (this.shuttingDown) throw new ContractError("core_unavailable", "The core is shutting down.");
    if (this.turn) throw new ContractError("conflict", "A reply is still being written. Stop it or wait for it first.");
    const user: ChatRecord = { id: newId(), role: "user", text, date: toSwiftDate() };
    this.add(user);
    let resolve!: Turn["resolve"];
    const done = new Promise<Status>((r) => (resolve = r));
    const turn: Turn = {
      id: `t-${randomUUID()}`, messageId: newId(), userId: user.id, text, reply: new ReplyText(), steps: [], record: null,
      open: true, head: null, retried: false, done, resolve,
    };
    this.turn = turn;
    this.clearIdle();
    this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId });
    this.updated();
    void this.deliver(turn);
    return { messageId: turn.messageId, turnId: turn.id };
  }

  /** Writes the turn's message to a head (starting one if the bot is asleep). */
  private async deliver(turn: Turn) {
    // A stopped turn's head may still be ending it: its result line must not land in this turn.
    while (this.draining) await this.draining.promise;
    if (this.turn !== turn || !turn.open) return;
    let head: ClaudeHead;
    try {
      head = this.ensureHead();
    } catch (error) {
      this.finishTurn(turn, "failed", `Could not start the agent: ${(error as Error).message}`);
      return;
    }
    turn.head = head;
    head.send(turn.text, turn.userId);
  }

  private ensureHead(): ClaudeHead {
    if (this.head?.running) return this.head;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const config = this.options.headConfig(this.profile, { sessionId: this.session.sessionId, resume: this.session.started });
    const head: ClaudeHead = new ClaudeHead(config, {
      onItem: (item) => this.onItem(head, item),
      onExit: (exit) => this.onExit(head, exit),
    });
    head.start();
    this.head = head;
    if (head.pid > 0) this.options.ledger.record(head.pid);
    this.log(`head started pid ${head.pid} session ${this.session.sessionId}${this.session.started ? " (resumed)" : ""}`);
    this.store.saveHead(this.session);
    this.updated();
    return head;
  }

  /** The turn's reply line, put in the chat once it has something to show. */
  private place(turn: Turn): ChatRecord {
    if (turn.record) return turn.record;
    const record: ChatRecord = { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, state: "streaming", engine: "claude" };
    turn.record = record;
    this.add(record);
    return record;
  }

  private onItem(head: ClaudeHead, item: StreamItem) {
    if (head !== this.head) return;
    if (item.kind === "init") {
      let save = false;
      if (!this.session.started) { this.session.started = true; save = true; }
      if (item.sessionId && item.sessionId !== this.session.sessionId && /^[0-9a-f-]{36}$/i.test(item.sessionId)) { this.session.sessionId = item.sessionId; save = true; }
      if (save) this.store.saveHead(this.session);
      return;
    }
    if (item.kind === "permission") return this.ask(head, item);
    if (item.kind === "permissionCancelled") {
      for (const [id, approval] of this.approvals) if (approval.requestId === item.requestId) this.settle(id, NO_LONGER_NEEDED, false);
      return;
    }
    if (item.kind === "controlResponse") return;
    const turn = this.turn;
    if (!turn || !turn.open || turn.head !== head) {
      // The tail of a stopped turn: only its end matters, to know the head is free again.
      if (item.kind === "result" && this.draining?.head === head) this.draining.resolve();
      return;
    }
    switch (item.kind) {
      case "toolUse":
        if (item.parent) return; // A subagent's own calls: not this reply's steps (subagents are a gap).
        turn.steps.push({ id: item.id, kind: item.tool === "Agent" || item.tool === "Task" ? "subagent" : "tool", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
        this.emitSteps(turn);
        return;
      case "toolResult": {
        const step = turn.steps.find((candidate) => candidate.id === item.id);
        if (!step) return;
        step.done = true;
        step.failed = item.failed;
        if (item.output) step.output = item.output;
        this.emitSteps(turn);
        return;
      }
      case "result":
        if (item.ok) turn.reply.add(item);
        this.finishTurn(turn, item.ok ? "done" : "failed", item.ok ? undefined : item.error);
        return;
      default: {
        const piece = turn.reply.add(item);
        if (!piece) return;
        const record = this.place(turn);
        record.text = turn.reply.text;
        this.persist(true);
        this.emit({ type: "turn.delta", botId: this.id, turnId: turn.id, messageId: turn.messageId, text: piece });
      }
    }
  }

  private emitSteps(turn: Turn) {
    this.emit({ type: "turn.steps", botId: this.id, turnId: turn.id, messageId: turn.messageId, steps: turn.steps.slice(-500).map(stepView) });
  }

  private finishTurn(turn: Turn, status: Status, error?: string) {
    if (!turn.open) return;
    turn.open = false;
    if (this.turn === turn) this.turn = null;
    const record = this.place(turn);
    let text = turn.reply.text;
    const cards = status === "done" ? extractCards(text) : null;
    if (cards) { text = cards.text; record.cards = cards.cards; }
    if (status === "failed" && !text && error) text = error;
    record.text = text;
    record.state = status;
    record.session = this.session.sessionId.toUpperCase();
    if (turn.steps.length) record.steps = turn.steps;
    if (status !== "done") record.interrupted = true;
    if (error) record.error = error.slice(0, 2_000);
    this.persist();
    this.emit({
      type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: record.text,
      ...(error ? { error: error.slice(0, 2_000) } : {}), ...(record.cards ? { cards: record.cards.map(cardView) } : {}),
    });
    this.emit({ type: "message.updated", botId: this.id, message: messageView(record) });
    this.finished.set(turn.id, status);
    turn.resolve(status);
    if (status === "done") {
      this.crashes = 0;
      this.unread += 1;
      this.store.saveSetting("unread", this.unread);
    }
    // claude waits on nothing once its turn ended.
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, true);
    this.scheduleIdle();
    this.updated();
  }

  async stop(turnId: string): Promise<ResultOf<"turn.stop">> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId) return { stopped: false, killed: [], forced: false };
    // Order matters: the turn is closed (and says so) before claude hears of it.
    turn.open = false;
    this.turn = null;
    const record = this.place(turn);
    record.text = turn.reply.text;
    record.state = "stopped";
    record.interrupted = true;
    if (turn.steps.length) record.steps = turn.steps;
    this.persist();
    this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: turn.messageId, status: "stopped", text: record.text });
    this.emit({ type: "message.updated", botId: this.id, message: messageView(record) });
    this.finished.set(turnId, "stopped");
    turn.resolve("stopped");
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, true);
    this.updated();
    const head = turn.head;
    if (!head || !head.running) return { stopped: true, killed: [], forced: false };
    // Ask claude to end the turn (the session goes on); wait for its result line.
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    const draining = { head, resolve, promise };
    this.draining = draining;
    head.interrupt();
    const ended = await Promise.race([promise.then(() => true), sleep(this.options.interruptGraceMs).then(() => false)]);
    if (this.draining === draining) this.draining = null;
    resolve();
    if (ended) {
      this.log(`turn ${turnId} stopped; claude ended it`);
      this.scheduleIdle();
      return { stopped: true, killed: [], forced: false };
    }
    // It did not answer: end its whole tree. The next message starts a new head (--resume).
    const result = await head.terminate(1_500);
    this.log(`turn ${turnId} stopped; claude did not end it in time, so its tree was ended: ${result.killed.join(",")} forced=${result.forced}`);
    return { stopped: true, killed: result.killed, forced: result.forced };
  }

  async await(turnId: string, signal: AbortSignal): Promise<ResultOf<"turn.await">> {
    const done = this.finished.get(turnId);
    if (done) return { status: done };
    if (this.turn?.id !== turnId) throw new ContractError("not_found", "No such turn.");
    const status = await Promise.race([
      this.turn.done,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ContractError("cancelled", "Stopped waiting.")))),
    ]);
    return { status };
  }

  private onExit(head: ClaudeHead, exit: HeadExit) {
    if (head.pid > 0) this.options.ledger.forget(head.pid);
    if (this.draining?.head === head) this.draining.resolve();
    if (head !== this.head) return;
    this.head = null;
    this.clearIdle();
    for (const [id, approval] of [...this.approvals]) if (approval.head === head) this.settle(id, NO_LONGER_NEEDED, false);
    const why = `${exit.signal ?? exit.code}`;
    const turn = this.turn;
    if (turn?.open && turn.head === head) {
      // A resume of a session claude no longer has: start a new session and send the message again, once.
      if (exit.silent && this.session.started && !turn.retried && !exit.expected) {
        this.log(`resuming session ${this.session.sessionId} failed (${why}: ${exit.stderr.slice(0, 200)}); starting a new session`);
        this.session = { sessionId: randomUUID(), started: false };
        this.store.saveHead(this.session);
        turn.retried = true;
        turn.head = null;
        void this.deliver(turn);
        return;
      }
      this.finishTurn(turn, "failed", `The agent exited (${why}) without finishing. ${exit.stderr.slice(-1_000)}`.trim());
    }
    this.log(`head exited (${why})${exit.expected ? "" : " unexpectedly"}`);
    if (!exit.expected && !this.shuttingDown) {
      this.crashes += 1;
      if (this.crashes <= MAX_RESTARTS) {
        const delay = 1_000 * 2 ** (this.crashes - 1);
        this.log(`starting it again in ${delay} ms`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.head && !this.shuttingDown && !this.problem && !this.profile.problem) {
            try { this.ensureHead(); } catch (error) { this.log(`restart failed: ${(error as Error).message}`); }
          }
        }, delay);
      } else {
        this.log(`it crashed ${this.crashes} times in a row; it starts again with the next message`);
      }
    }
    this.updated();
  }

  private scheduleIdle() {
    this.clearIdle();
    if (!this.head?.running || this.turn || this.approvals.size) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.head?.running && !this.turn && !this.approvals.size) {
        this.log("idle: going to sleep");
        this.head.finish();
      }
    }, this.options.idleMs);
  }

  private clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  // ------------------------------------------------------------------------------------------
  // Approvals

  private ask(head: ClaudeHead, item: Extract<StreamItem, { kind: "permission" }>) {
    if (item.tool !== "Monitored command" && this.alwaysAllowed.includes(item.tool)) {
      head.answer(item.requestId, true, item.input);
      return;
    }
    const turn = this.turn;
    if (!turn?.open || turn.head !== head) {
      head.answer(item.requestId, false, item.input, "Not now: the user stopped this turn.");
      return;
    }
    const choices: ChoiceRecord[] = [{ label: "Allow once", recommended: true, action: "allowOnce" }];
    if (!NEVER_ALWAYS.has(item.tool)) choices.push({ label: `Always allow ${item.tool}`, detail: `For ${this.profile.name}, from now on`, recommended: false, action: "alwaysAllow" });
    choices.push({ label: "Don't allow", recommended: false, action: "deny" });
    const record: ChatRecord = { id: newId(), role: "bot", text: permissionText(item.tool, item.summary), date: toSwiftDate(), choices, permissionTool: item.tool };
    const expires = Date.now() + this.options.approvalTimeoutMs;
    const timer = setTimeout(() => this.expire(record.id), this.options.approvalTimeoutMs);
    this.approvals.set(record.id, { requestId: item.requestId, tool: item.tool, input: item.input, head, timer, expires });
    this.add(record);
    this.log(`asks to use ${item.tool}`);
    this.updated();
  }

  /** Nobody answered in time: it counts as not allowed. */
  private expire(id: string) {
    const approval = this.approvals.get(id);
    if (!approval) return;
    this.settle(id, NO_ANSWER, false);
    approval.head.answer(approval.requestId, false, approval.input, "The user did not answer in time; carry on without it, or ask again later.");
  }

  /** Closes an approval without the user's pick (`answer` says why); `deny` tells claude no. */
  private settle(id: string, answer: string, deny: boolean) {
    const approval = this.approvals.get(id);
    if (!approval) return;
    clearTimeout(approval.timer);
    this.approvals.delete(id);
    if (deny && approval.head.running) approval.head.answer(approval.requestId, false, approval.input, "No longer needed.");
    const record = this.records.find((candidate) => candidate.id === id);
    if (record && isOpenQuestion(record)) {
      record.answer = answer;
      this.changed(record);
    }
    this.updated();
  }

  choose(messageId: string, index: number): ResultOf<"chat.choose"> {
    const record = this.records.find((candidate) => candidate.id === messageId);
    if (!record?.choices?.length) throw new ContractError("not_found", "No such question.");
    const choice = record.choices[index];
    if (!choice) throw new ContractError("bad_request", "No such button.");
    if (!isOpenQuestion(record)) return { accepted: false };
    const approval = this.approvals.get(messageId);
    if (!record.permissionTool) {
      // A bot's own question: the pick goes to it as your next message.
      record.chosen = index;
      this.changed(record);
      if (!this.turn) this.send(choice.label);
      return { accepted: true };
    }
    if (!approval) {
      record.answer = NO_LONGER_NEEDED;
      this.changed(record);
      return { accepted: false };
    }
    // What a pick means comes from its action, never its words: anything not an allow refuses.
    const allow = choice.action === "allowOnce" || choice.action === "alwaysAllow";
    const always = choice.action === "alwaysAllow" && !NEVER_ALWAYS.has(approval.tool);
    clearTimeout(approval.timer);
    this.approvals.delete(messageId);
    record.chosen = index;
    this.changed(record);
    approval.head.answer(approval.requestId, allow, approval.input, allow ? undefined : "The user did not allow it.");
    this.log(`${approval.tool}: ${allow ? (always ? "always allowed" : "allowed once") : "not allowed"}`);
    if (always && !this.alwaysAllowed.includes(approval.tool)) {
      this.alwaysAllowed.push(approval.tool);
      this.store.saveSetting("alwaysAllowed", this.alwaysAllowed);
      // Other questions for the same tool are settled by "always".
      for (const [id, other] of [...this.approvals]) {
        if (other.tool !== approval.tool) continue;
        clearTimeout(other.timer);
        this.approvals.delete(id);
        const otherRecord = this.records.find((candidate) => candidate.id === id);
        if (otherRecord) { otherRecord.chosen = index; this.changed(otherRecord); }
        other.head.answer(other.requestId, true, other.input);
      }
    }
    this.updated();
    return { accepted: true };
  }

  read(): ResultOf<"chat.read"> {
    if (this.unread !== 0) {
      this.unread = 0;
      if (!this.readOnly) this.store.saveSetting("unread", 0);
      this.updated();
    }
    return { read: true };
  }

  // ------------------------------------------------------------------------------------------
  // Cards

  card(messageId: string, cardId: string) {
    const record = this.records.find((candidate) => candidate.id === messageId);
    const card = record?.cards?.find((candidate) => candidate.id === cardId);
    if (!card) throw new ContractError("not_found", "No such card.");
    return card;
  }

  cardSave(messageId: string, cardId: string, data: string): ResultOf<"card.save"> {
    const card = this.card(messageId, cardId);
    try {
      const value = JSON.parse(data);
      if (value === null || value === undefined) throw new Error("null");
    } catch {
      throw new ContractError("bad_request", "ccb.save takes JSON data that is not null.");
    }
    card.data = data;
    this.persist();
    this.emit({ type: "card.updated", botId: this.id, messageId, cardId, data });
    return { saved: true };
  }

  cardAction(messageId: string, cardId: string, name: string, value: string): ResultOf<"card.action"> {
    this.card(messageId, cardId);
    // Card actions are requests, not commands: the core decides what (if anything) they do. The
    // only one so far is "say", which shows the value as a notice; nothing runs a shell or opens files.
    if (name !== "say") throw new ContractError("forbidden", `Cards cannot ask for "${name}".`);
    this.emit({ type: "card.acted", botId: this.id, messageId, cardId, name, value });
    this.add({ id: newId(), role: "notice", text: `A card says: ${value}`, date: toSwiftDate() });
    return { accepted: true };
  }

  /** Ends the turn and the head (with its tree), and writes everything out; for quitting. */
  async shutdown() {
    this.shuttingDown = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.clearIdle();
    if (this.turn) await this.stop(this.turn.id).catch(() => {});
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, false);
    const head = this.head;
    if (head?.running) {
      // A polite end first (claude writes its session); then the tree.
      head.finish();
      const ended = await Promise.race([head.exited.then(() => true), sleep(1_500).then(() => false)]);
      if (!ended) await head.terminate(1_000);
    }
    this.persist();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The question, with what would run shown as code so nothing in it renders as a link or formatting (`Bot.permissionText`). */
export function permissionText(tool: string, summary: string): string {
  const longest = Math.max(0, ...(summary.match(/~+/g) ?? []).map((run) => run.length));
  const fence = "~".repeat(Math.max(3, longest + 1));
  return `Wants to use \`${tool.replaceAll("`", "'")}\`:\n\n${fence}\n${summary}\n${fence}`;
}

const clip = (text: string | undefined, limit: number) => (text === undefined ? null : text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export function stepView(step: StepRecord): StepView {
  return {
    id: String(step.id).slice(0, 200),
    kind: (["tool", "text", "subagent", "message"] as const).includes(step.kind) ? step.kind : "tool",
    tool: clip(step.tool, 200),
    title: clip(String(step.title ?? ""), 2_000) ?? "",
    detail: clip(step.detail, 10_000),
    output: clip(step.output, 10_000),
    failed: step.failed === true,
    done: step.done === true,
  };
}

function cardView(card: { id: string; html: string; data: string | null }): CardView {
  return { id: card.id, html: card.html, data: card.data };
}

function choiceView(choice: ChoiceRecord): ChoiceView {
  return {
    label: clip(String(choice.label ?? ""), 400) ?? "",
    detail: clip(choice.detail, 400),
    recommended: choice.recommended === true,
    action: choice.action === "allowOnce" || choice.action === "alwaysAllow" || choice.action === "deny" ? choice.action : null,
  };
}

/** A chat line as the contract shows it (what 1.x's ChatPayload.Message is built from). */
export function messageView(record: ChatRecord, approval?: { expires: number }): MessageView {
  const view: MessageView = { id: record.id, role: record.role, text: record.text.slice(0, 400_000), time: swiftDateISO(record.date) };
  if (record.turnID && /^[A-Za-z0-9_.:-]{1,64}$/.test(record.turnID)) view.turnId = record.turnID;
  if (record.state) view.state = record.state;
  if (record.cards?.length) view.cards = record.cards.slice(0, 20).map(cardView);
  if (record.choices?.length) {
    view.choices = record.choices.slice(0, 20).map(choiceView);
    view.chosen = typeof record.chosen === "number" && record.chosen >= 0 ? record.chosen : null;
    view.answer = typeof record.answer === "string" ? record.answer.slice(0, 4_000) : null;
  }
  if (record.permissionTool) view.approval = { tool: record.permissionTool.slice(0, 200), expires: approval ? new Date(approval.expires).toISOString() : null };
  if (record.steps?.length) view.steps = record.steps.slice(-500).map(stepView);
  if (record.interrupted) view.interrupted = true;
  if (record.attachments?.length) {
    view.attachments = record.attachments.slice(0, 50).filter((file) => typeof file?.url === "string").map((file) => ({
      name: decodeURIComponent(file.url.split("/").pop() ?? "file").slice(0, 400),
      kind: file.kind === "image" || file.kind === "video" ? file.kind : "file",
      url: file.url.slice(0, 4_000),
    }));
  }
  if (typeof record.replyPreview === "string") view.replyPreview = record.replyPreview.slice(0, 2_000);
  return view;
}

/** What a bot is told about itself (a small part of 1.x's Prompts.swift; the rest is a gap). */
export function systemPrompt(profile: BotProfile): string {
  const memory = join(profile.folder, profile.memoryPath);
  const who = profile.role === "main"
    ? "You are the user's main bot in Botling, a desktop chat app where each bot is a Claude Code session."
    : profile.role === "manager"
      ? `You are ${profile.name}, the bot that manages the project in ${profile.folder}, in Botling, a desktop chat app where each bot is a Claude Code session.`
      : `You are ${profile.name}, a bot in Botling (a desktop chat app where each bot is a Claude Code session). What you are for: ${profile.job ?? ""}`;
  return `${who}\nYour memory file is ${memory}: read it when you start, and keep what you need to remember there.\nReply in the language the user writes in.`;
}
