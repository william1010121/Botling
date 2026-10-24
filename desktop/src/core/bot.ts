// One bot in the core: its chat (kept in 1.x's chat.json format), its head (one long-lived
// claude process), the turn under way, the tool approvals it is waiting on, its task cards
// (tasks.json) and subagents (subagents.json).
//
// Rules, as in the Swift `Bot` (Bot.swift) unless said otherwise:
// - Waking: an asleep bot's head starts a NEW claude session, and its first message carries the
//   wake briefing (Prompts.swift's wake line: read memory.md), the chat's last lines and the
//   reactions intro before the user's words. The app starting counts as waking.
// - Sleeping: after `idleMs` with nothing under way (no turn, approval, waiting message or running
//   subagent) the bot tidies — the 1.x "tidy" turn, which updates memory.md and is never shown —
//   then its head's stdin is closed. Quitting the app tidies awake bots too (bounded by `quitTidyMs`).
// - One turn at a time. A message while a reply is written (1.x steering):
//   · the turn answers only the user, with no approval open and no subagent at work: what it said
//     so far stays as a bubble marked cut off, and the earlier message and the new one go to claude
//     as one ("I sent this in parts…"), then the turn is interrupted, so one reply answers both;
//   · otherwise (an approval is open, a subagent works, the turn is claude's own or the tidy) the
//     message waits and goes when the turn ends. (1.x hands it to claude at once, or pauses claude's
//     own work for it; 2.0 queues — simpler, and nothing is lost.)
// - Stop closes the turn's gate first (nothing it prints afterwards reaches anyone) and says so,
//   then asks claude to interrupt; a head that does not end the turn in time is ended with its
//   whole process tree.
// - An approval is a chat line with Allow once / Always allow / Don't allow. What a pick means
//   comes from the button's action, never its words. No answer in time counts as no. Approvals
//   left open by a restart or a dead head are closed ("No longer needed"), never answered later.
// - A head that crashes fails the turn it was on and is started again with `--resume` (a few
//   times, backing off) — 2.0's choice; 1.x lets it sleep and wakes a new session.
// - A reply's tags are acted on (reply.ts): <choices> become buttons whose pick goes back as the
//   user's answer, <task> lines move the task cards, <reaction> lines set the bot's reaction,
//   <no-reply/> leaves a turn claude started itself (a background subagent reporting) unshown.
//   Other requests (<team>, <component>, …) are taken out and a notice says 2.0 cannot do them yet.
// - A project bot shares its project's .bot/ with 1.x: while another Botling has the project
//   (store/lock.ts), the bot is read-only here.
import { randomUUID } from "node:crypto";
import {
  ContractError, type BotView, type CardView, type ChatSnapshot, type ChoiceView, type Event, type MessageView, type ResultOf,
  type StepView, type SubagentView, type TaskView,
} from "../contract";
import { ClaudeHead, type HeadConfig, type HeadExit } from "./agent/head";
import { ReplyText, type StreamItem } from "./agent/stream";
import {
  applyingReaction, archiveAll, archiveLine, characterCount, characterPrefix, compareReactions, reactionIntro, reactionUpdate, recentChat,
  REACTION_PALETTE, reportNote, seenReactions, type SeenReactions,
} from "./briefing";
import { extractCards, welcomeMessages } from "./cards";
import type { ProcessLedger } from "./process/ledger";
import { isPlainOK, PARTS_NOTE, profilePaths, withoutPartsNote, type BotPrompts } from "./prompts";
import { parseReply, saysNoReply, saysNothing, unsupportedRequest } from "./reply";
import { SubagentBook, readSubagent, SUBAGENT_TOOLS, toolCount, type SubagentRecord } from "./subagents";
import { readTaskCard, TaskBook, type TaskCard } from "./tasks";
import { BotStore, StoreError, type HeadState } from "./store/bot-store";
import type { ProjectLock } from "./store/lock";
import {
  HISTORY_LIMIT, isOpenQuestion, newId, swiftDateISO, toSwiftDate, type ChatRecord, type ChoiceRecord, type StepRecord,
} from "./store/records";
import type { BotProfile } from "./store/workspace";

export type Status = "done" | "stopped" | "failed";

export interface SessionStart {
  sessionId: string;
  resume: boolean;
  /** Appended to claude's system prompt (Prompts.swift's, ported in prompts.ts). */
  systemPrompt: string;
}

export interface BotOptions {
  profile: BotProfile;
  /** How to run this bot's head for a session. */
  headConfig: (profile: BotProfile, session: SessionStart) => HeadConfig;
  /** The instructions for this bot (settings may change between wakes). */
  prompts: () => BotPrompts;
  ledger: ProcessLedger;
  emit: (event: Event) => void;
  log: (line: string) => void;
  /** No answer in this time counts as "Don't allow" (1.x: 10 minutes). */
  approvalTimeoutMs: number;
  /** An idle head tidies and goes to sleep after this long. */
  idleMs: number;
  /** How long Stop waits for claude to end the turn before ending its process tree. */
  interruptGraceMs: number;
  /** The most a tidy turn may take before the head is put to sleep anyway. */
  tidyTimeoutMs?: number;
  /** On quit, how long an awake bot may tidy (0: not at all). */
  quitTidyMs?: number;
  /** Give a new, empty chat the welcome lines (the main bot of a fresh install). */
  welcome?: boolean;
  /** A project bot's hold on its project folder (null: it needs none). */
  lock?: ProjectLock | null;
}

type Origin = "user" | "app" | "background" | "tidy";

interface Turn {
  id: string;
  /** The reply's chat line id. */
  messageId: string;
  /** The user's line this turn answers (null for the app's own and claude's own turns). */
  userId: string | null;
  origin: Origin;
  /** What goes to claude before the briefing and reactions are added (the user's lines, or the app's note). */
  words: string;
  reply: ReplyText;
  steps: StepRecord[];
  /** The reply's chat line, once it has something to show. */
  record: ChatRecord | null;
  /** The gate: false once the turn ended or was stopped; nothing reaches anyone after. */
  open: boolean;
  /** Delivered to a head (false while it waits its turn). */
  sent: boolean;
  head: ClaudeHead | null;
  /** Sent again once already (its resume failed, or a merge's interrupt hit it). */
  retried: boolean;
  /** It joined an earlier message the user sent in parts (the interrupt for that one may land on it). */
  merged: boolean;
  /** Swift date it was sent. */
  started: number;
  usedTools: boolean;
  claimed: boolean;
  /** Subagents that ended while it ran (a silent turn has to report them). */
  ended: string[];
  done: Promise<Status>;
  resolve: (status: Status) => void;
  /** For the tidy turn: its reply. */
  onReply?: (text: string) => void;
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
const NEW_SESSION_DIVIDER = "Couldn't go on in the same session → new session";

export class Bot {
  readonly store: BotStore;
  readonly tasks: TaskBook;
  readonly subagents: SubagentBook;
  private records: ChatRecord[] = [];
  /** Set when its chat file could not be read: nothing is written over it then. */
  private problem: string | null = null;
  private readOnly = false;
  /** Set while another Botling has this bot's project: nothing is sent. */
  private lockProblem: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private head: ClaudeHead | null = null;
  /** Tidying memory.md before it sleeps. */
  private tidying = false;
  private turn: Turn | null = null;
  /** Messages that wait for the turn under way (or the tidy) to end. */
  private queue: Turn[] = [];
  private finished = new Map<string, Status>();
  private approvals = new Map<string, Approval>();
  private draining: { head: ClaudeHead; resolve: () => void; promise: Promise<void> } | null = null;
  /** Results still to come from turns cut off (to take in what the user added, or a tidy that ran late): they belong to nobody. */
  private ignoreResults = 0;
  /** One of those ended on its own before the interrupt reached it: the interrupt may stop the merged turn instead. */
  private mergeRaced = false;
  private session: HeadState;
  /** The next head is a new session: its first message carries the wake briefing. */
  private briefing = true;
  private crashes = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private alwaysAllowed: string[];
  private unread: number;
  private shuttingDown = false;
  /** What this head's session has been told of the chat's reactions (null: tell it from scratch). */
  private reactionsSeen: SeenReactions | null = null;
  /** Finished subagents a silent turn has already been asked to report, once. */
  private reportAsked = new Set<string>();
  /** Subagents that ended between turns: the next turn claude starts itself reports them. */
  private pendingEnded: string[] = [];
  /** Heads being ended (a Stop it did not listen to, quitting): nothing they print counts any more. */
  private ending = new WeakSet<ClaudeHead>();

  constructor(private options: BotOptions) {
    this.store = new BotStore(options.profile.storeDir);
    // A new session at every start: the app starting is a wake (1.x).
    this.session = { sessionId: randomUUID(), started: false };
    this.alwaysAllowed = this.store.loadAlwaysAllowed();
    this.unread = this.store.loadUnread();
    this.tasks = new TaskBook(this.readList("tasks.json", readTaskCard));
    this.subagents = new SubagentBook(this.readList("subagents.json", readSubagent));
    this.load();
    // Subagents that were running when the app went away went with their process.
    if (this.subagents.stopRunning()) this.saveSubagents();
    if (!this.problem) archiveAll(this.paths.archive, this.records);
    this.checkLock();
  }

  get id() {
    return this.options.profile.id;
  }
  get profile() {
    return this.options.profile;
  }
  private get paths() {
    return profilePaths(this.profile);
  }

  private log(line: string) {
    this.options.log(`[${this.profile.name}] ${line}`);
  }

  private emit(event: Event) {
    this.options.emit(event);
  }

  private readList<T>(name: "tasks.json" | "subagents.json", read: (value: unknown) => T | null): T[] {
    try {
      return this.store.loadList(name).map(read).filter((value): value is T => value !== null);
    } catch (error) {
      this.log(`${name} cannot be read (${(error as Error).message}); it is left as it is`);
      return [];
    }
  }

  // ------------------------------------------------------------------------------------------
  // The project lock

  /** Takes the project (or says who has it). True when this bot may work. */
  private checkLock(): boolean {
    const lock = this.options.lock;
    if (!lock) return true;
    const result = lock.acquire();
    const problem = result.held ? null
      : `${result.by[0]!.toUpperCase()}${result.by.slice(1)}. To keep its notes (.bot/memory.md) safe, this bot is read-only here until that one closes it.`;
    if (problem !== this.lockProblem) {
      this.lockProblem = problem;
      this.log(problem ?? "has its project again");
      this.updated();
    }
    return result.held;
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

  private messageView(record: ChatRecord): MessageView {
    return messageView(record, this.approvals.get(record.id), this.subagents);
  }

  /** A new line; `archive: false` for a reply still being written (it is archived when it ends). */
  private add(record: ChatRecord, { archive = true } = {}) {
    this.records.push(record);
    this.persist();
    if (archive) archiveLine(this.paths.archive, record);
    this.emit({ type: "message.added", botId: this.id, message: this.messageView(record) });
  }

  private changed(record: ChatRecord) {
    this.persist();
    this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
  }

  private remove(record: ChatRecord) {
    const at = this.records.indexOf(record);
    if (at < 0) return;
    this.records.splice(at, 1);
    this.persist();
    this.emit({ type: "message.removed", botId: this.id, messageId: record.id });
  }

  private notice(text: string) {
    this.add({ id: newId(), role: "notice", text, date: toSwiftDate() });
  }

  private saveTasks() {
    if (!this.readOnly) this.store.saveList("tasks.json", this.tasks.tasks);
    this.emit({ type: "tasks.updated", botId: this.id, tasks: this.taskViews() });
  }

  private saveSubagents() {
    if (!this.readOnly) this.store.saveList("subagents.json", this.subagents.list);
  }

  // ------------------------------------------------------------------------------------------
  // Views

  private get phase(): BotView["phase"] {
    if (this.tidying) return "tidying";
    return this.head?.running ? "awake" : "asleep";
  }

  view(): BotView {
    return {
      id: this.id,
      name: this.profile.name.slice(0, 200),
      role: this.profile.role,
      avatar: this.profile.avatar.slice(0, 40),
      folder: this.profile.folder.slice(0, 4_000),
      phase: this.phase,
      working: !!this.turn && this.turn.origin !== "tidy",
      approvals: this.approvals.size,
      unread: this.unread,
      subagents: this.subagents.running.length,
      problem: (this.problem ?? this.profile.problem ?? this.lockProblem)?.slice(0, 2_000) ?? null,
    };
  }

  private updated() {
    this.emit({ type: "bot.updated", bot: this.view() });
  }

  taskViews(): TaskView[] {
    const running = new Set(this.subagents.running.map((subagent) => subagent.id));
    return this.tasks.tasks.slice(-100).map((card) => taskView(card, running));
  }

  private get shownTurn(): Turn | null {
    return this.turn && this.turn.origin !== "tidy" ? this.turn : null;
  }

  snapshot(): ChatSnapshot {
    if (this.options.lock && this.lockProblem) this.checkLock();
    const shown = this.shownTurn;
    return {
      botId: this.id,
      messages: this.records.map((record) => this.messageView(record)),
      running: shown ? { turnId: shown.id, messageId: shown.messageId } : null,
      live: shown ? shown.steps.slice(-500).map((step) => stepView(step, this.subagents)) : [],
      tasks: this.taskViews(),
    };
  }

  get messageCount() {
    return this.records.length;
  }

  subagentView(id: string): ResultOf<"subagent.view"> {
    const subagent = this.subagents.get(id);
    if (!subagent) throw new ContractError("not_found", "No such subagent.");
    return { subagent: subagentView(subagent, this.profile.name, this.subagents) };
  }

  // ------------------------------------------------------------------------------------------
  // Sending, and the turn

  private refuseIfClosed() {
    if (this.problem) throw new ContractError("conflict", this.problem);
    if (this.profile.problem) throw new ContractError("conflict", this.profile.problem);
    if (this.shuttingDown) throw new ContractError("core_unavailable", "The core is shutting down.");
    if (!this.checkLock()) throw new ContractError("conflict", this.lockProblem ?? "Another Botling has this project.");
  }

  /** A message from the user; `replyTo`: a line of the chat it answers (a pick on a question, say). */
  send(text: string, { replyTo }: { replyTo?: string } = {}): ResultOf<"chat.send"> {
    this.refuseIfClosed();
    const words = text.trim();
    if (!words) throw new ContractError("bad_request", "Nothing to send.");
    const user: ChatRecord = { id: newId(), role: "user", text: words, date: toSwiftDate() };
    const quoted = replyTo ? this.records.find((record) => record.id === replyTo) : undefined;
    if (quoted) {
      user.replyTo = quoted.id;
      user.replyPreview = preview(quoted);
    }
    this.add(user);
    // A card for it at once; the turn names it.
    this.tasks.begin(user.id, words, "claude", user.date, quoted?.id);
    this.saveTasks();
    const lines: string[] = [];
    if (quoted) {
      const whose = quoted.role === "user" ? "what I said earlier" : quoted.role === "notice" ? "the app's message" : "what you said earlier";
      lines.push(`(Replying to ${whose}: "${preview(quoted)}")`);
    }
    lines.push(words);
    const turn = this.newTurn("user", lines.join("\n\n"), user.id);
    this.route(turn);
    return { messageId: turn.messageId, turnId: turn.id };
  }

  private newTurn(origin: Origin, words: string, userId: string | null): Turn {
    let resolve!: Turn["resolve"];
    const done = new Promise<Status>((r) => (resolve = r));
    return {
      id: `t-${randomUUID()}`, messageId: newId(), userId, origin, words, reply: new ReplyText(), steps: [], record: null,
      open: true, sent: false, head: null, retried: false, merged: false, started: toSwiftDate(), usedTools: false, claimed: false,
      ended: [], done, resolve,
    };
  }

  /** Where a new turn goes: now, joined with the one under way, or after it. */
  private route(turn: Turn) {
    const current = this.turn;
    if (!current && !this.tidying) return this.begin(turn);
    if (current && this.canMerge(current, turn)) return this.merge(current, turn);
    this.queue.push(turn);
    this.log("a message waits for the turn under way");
  }

  /** `Bot.merging`: the turn under way only answers the user, and stopping it loses nothing. */
  private canMerge(current: Turn, next: Turn): boolean {
    return next.origin === "user" && current.origin === "user" && current.open && current.sent && !!current.head?.running
      && current.head === this.head && !this.approvals.size && !this.subagents.running.length && !this.queue.length && !this.draining;
  }

  /**
   * The user added to what they said before it answered: what the turn said so far stays as a
   * bubble cut off before the new line, and both messages go to claude as one; the interrupt then
   * ends the turn that was under way, and claude answers the whole.
   */
  private merge(current: Turn, next: Turn) {
    const head = current.head!;
    next.words = PARTS_NOTE + withoutPartsNote(current.words) + "\n\n" + next.words;
    next.merged = true;
    if (current.userId && next.userId) {
      this.tasks.join(current.userId, next.userId);
      this.saveTasks();
    }
    this.cutOff(current);
    this.ignoreResults += 1;
    // The message goes first; the interrupt stops the turn for it (as 1.x does).
    this.begin(next, head);
    head.interrupt();
    this.log("you added to your message: the turn under way was cut off to answer both");
  }

  /** Ends a turn before it answered: its words and steps so far stay, marked cut off (or go, when there are none). */
  private cutOff(turn: Turn) {
    turn.open = false;
    if (this.turn === turn) this.turn = null;
    const text = parseReply(turn.reply.text).body;
    let record = turn.record;
    if (record && !text && !turn.steps.length) {
      this.remove(record);
      record = null;
    } else if (record || turn.steps.length) {
      const fresh = !record;
      record ??= { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, engine: "claude" };
      turn.record = record;
      record.text = text;
      record.state = "stopped";
      record.interrupted = true;
      if (turn.steps.length) record.steps = turn.steps;
      if (fresh) this.add(record);
      else { this.changed(record); archiveLine(this.paths.archive, record); }
    }
    this.emit({ type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status: "stopped", text });
    this.finished.set(turn.id, "stopped");
    turn.resolve("stopped");
  }

  /** Makes `turn` the one under way and sends it (waking the bot if it sleeps). */
  private begin(turn: Turn, head?: ClaudeHead) {
    this.turn = turn;
    this.clearIdle();
    if (turn.origin !== "tidy") {
      this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId });
      this.updated();
    }
    void this.deliver(turn, head);
  }

  /** Writes the turn's message to a head (starting one, in a new session, if the bot is asleep). */
  private async deliver(turn: Turn, given?: ClaudeHead) {
    // A stopped turn's head may still be ending it: its result line must not land in this turn.
    while (this.draining) await this.draining.promise;
    if (this.turn !== turn || !turn.open) return;
    const waking = !given && !this.head?.running;
    let head: ClaudeHead;
    try {
      head = given ?? this.ensureHead();
    } catch (error) {
      this.finishTurn(turn, "failed", `Could not start the agent: ${(error as Error).message}`);
      return;
    }
    turn.head = head;
    turn.sent = true;
    turn.started = toSwiftDate();
    const brief = waking && this.briefing;
    if (brief) this.briefing = false;
    head.send(this.compose(turn, brief), turn.userId ?? turn.messageId);
  }

  /**
   * What claude reads (`Bot.wake` / `Bot.deliver`): a new session's first message has the wake
   * line, the chat's last lines and the reactions intro before the words; later messages have
   * their reactions update after them.
   */
  private compose(turn: Turn, brief: boolean): string {
    if (turn.origin === "tidy" || turn.origin === "app") return turn.words;
    const parts: string[] = [];
    if (brief) {
      parts.push(this.options.prompts().wake, recentChat(this.records, { archive: this.paths.archive, leavingOut: turn.userId }));
      parts.push(reactionIntro(this.records, turn.userId), turn.words);
    } else {
      parts.push(turn.words, this.reactionsSeen ? reactionUpdate(this.records, this.reactionsSeen, turn.userId) : reactionIntro(this.records, turn.userId));
    }
    this.reactionsSeen = seenReactions(this.records);
    return parts.filter(Boolean).join("\n\n");
  }

  private ensureHead(): ClaudeHead {
    if (this.head?.running) return this.head;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const resume = this.session.started && !this.briefing;
    const config = this.options.headConfig(this.profile, { sessionId: this.session.sessionId, resume, systemPrompt: this.options.prompts().system });
    const head: ClaudeHead = new ClaudeHead(config, {
      onItem: (item) => this.onItem(head, item),
      onExit: (exit) => this.onExit(head, exit),
    });
    head.start();
    this.head = head;
    if (head.pid > 0) this.options.ledger.record(head.pid);
    this.log(`head started pid ${head.pid} session ${this.session.sessionId}${resume ? " (resumed)" : " (new)"}`);
    this.store.saveHead(this.session);
    this.updated();
    return head;
  }

  /** A new session for the next wake (after a sleep, or a resume claude no longer had). */
  private newSession() {
    this.session = { sessionId: randomUUID(), started: false };
    this.briefing = true;
    this.reactionsSeen = null;
  }

  /** The turn's reply line, put in the chat once it has something to show. */
  private place(turn: Turn): ChatRecord {
    if (turn.record) return turn.record;
    const record: ChatRecord = { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, state: "streaming", engine: "claude" };
    turn.record = record;
    this.add(record, { archive: false });
    return record;
  }

  /** Claude started a turn of its own (a background subagent told it something). */
  private backgroundTurn(head: ClaudeHead): Turn {
    const turn = this.newTurn("background", "", null);
    turn.head = head;
    turn.sent = true;
    this.turn = turn;
    this.clearIdle();
    this.emit({ type: "turn.started", botId: this.id, turnId: turn.id, messageId: turn.messageId });
    this.updated();
    return turn;
  }

  private onItem(head: ClaudeHead, item: StreamItem) {
    if (head !== this.head || this.ending.has(head)) return;
    if (item.kind === "init") {
      let save = false;
      if (!this.session.started) { this.session.started = true; save = true; }
      if (item.sessionId && item.sessionId !== this.session.sessionId && /^[0-9a-f-]{36}$/i.test(item.sessionId)) { this.session.sessionId = item.sessionId; save = true; }
      if (save) this.store.saveHead(this.session);
      return;
    }
    if (item.kind === "controlResponse") return;
    if (item.kind === "permissionCancelled") {
      for (const [id, approval] of this.approvals) if (approval.requestId === item.requestId) this.settle(id, NO_LONGER_NEEDED, false);
      return;
    }
    // Subagents are followed whoever's turn it is; their own lines stop here.
    if (this.onSubagentItem(item)) return;
    // The tail of a turn that was cut off: it belongs to nobody.
    if (this.ignoreResults > 0) {
      if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: the user added to their message.");
      if (item.kind === "result") {
        this.ignoreResults -= 1;
        if (item.ok) this.mergeRaced = true;
      }
      return;
    }
    let turn = this.turn;
    if (!turn || !turn.open || turn.head !== head) {
      // The tail of a stopped turn: only its end matters, to know the head is free again.
      if (this.draining?.head === head) {
        if (item.kind === "result") this.draining.resolve();
        if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: the user stopped this turn.");
        return;
      }
      if (turn) return; // A turn of ours waits to be sent: nothing of claude's can be for it yet.
      // Nothing of ours under way: claude started a turn itself.
      if (item.kind === "result" && !item.text) return;
      if (item.kind === "textBlock") return;
      turn = this.backgroundTurn(head);
    }
    if (item.kind === "permission") return this.ask(head, item, turn);
    switch (item.kind) {
      case "toolUse": {
        const isSubagent = SUBAGENT_TOOLS.has(item.tool);
        turn.steps.push({ id: item.id, kind: isSubagent ? "subagent" : "tool", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
        this.noteWork(turn, true);
        if (isSubagent) this.linkSubagent(turn, item.id);
        this.emitSteps(turn);
        return;
      }
      case "toolResult": {
        const step = turn.steps.find((candidate) => candidate.id === item.id);
        if (!step) return;
        // A subagent's step is done when the subagent is, not when its call returns.
        if (step.kind !== "subagent" || this.subagents.get(item.id)?.status !== "running") step.done = true;
        step.failed = item.failed;
        if (item.output) step.output = item.output;
        this.emitSteps(turn);
        return;
      }
      case "result":
        if (item.ok) turn.reply.add(item);
        // The interrupt meant for the turn that was cut off stopped this one instead: send it again, once.
        if (!item.ok && turn.merged && this.mergeRaced && !turn.retried && !turn.reply.text && head.running) {
          this.mergeRaced = false;
          turn.retried = true;
          head.send(this.compose(turn, false), turn.userId ?? turn.messageId);
          return;
        }
        this.mergeRaced = false;
        this.finishTurn(turn, item.ok ? "done" : "failed", item.ok ? undefined : item.error);
        return;
      default: {
        const piece = turn.reply.add(item);
        if (!piece) return;
        this.noteWork(turn, false);
        // claude's own turns show only once they end (or never); the tidy never.
        if (turn.origin === "background" || turn.origin === "tidy") return;
        this.showSoFar(turn);
      }
    }
  }

  /** The reply so far, without the app's tags (a tag still being written is held back). */
  private showSoFar(turn: Turn) {
    const shown = streamingText(turn.reply.text);
    if (!shown && !turn.record) return;
    const record = this.place(turn);
    const before = record.text;
    if (shown === before) return;
    record.text = shown;
    this.persist(true);
    if (shown.startsWith(before)) {
      this.emit({ type: "turn.delta", botId: this.id, turnId: turn.id, messageId: turn.messageId, text: shown.slice(before.length) });
    } else {
      this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    }
  }

  /** The turn's first words or tool claim its task card; a tool makes it real work. */
  private noteWork(turn: Turn, tool: boolean) {
    if (turn.origin !== "user" || !turn.userId) return;
    let changed = false;
    if (!turn.claimed) {
      turn.claimed = true;
      changed = this.tasks.claim(turn.userId, "claude", toSwiftDate()) || changed;
    }
    if (tool && !turn.usedTools) {
      turn.usedTools = true;
      const text = this.records.find((record) => record.id === turn.userId)?.text ?? "";
      this.tasks.working(turn.userId, text, "claude", toSwiftDate());
      changed = true;
    }
    if (changed) this.saveTasks();
  }

  private linkSubagent(turn: Turn, subagentId: string) {
    const base = this.tasks.base({ head: "claude", userMessage: turn.origin === "user" ? turn.userId : null, reporting: turn.ended });
    if (!base) return;
    this.tasks.link(subagentId, base.id);
    this.saveTasks();
  }

  /** Subagent bookkeeping (subagents.json). True when the item was the subagent's own (not the turn's). */
  private onSubagentItem(item: StreamItem): boolean {
    switch (item.kind) {
      case "toolUse":
        if (this.subagents.toolUse(item)) this.subagentChanged(this.subagents.get(item.parent ?? item.id));
        return item.parent !== null;
      case "toolResult": {
        const wasRunning = this.subagents.get(item.id)?.status === "running";
        if (this.subagents.toolResult(item)) this.subagentChanged(this.subagents.get(item.parent ?? item.id));
        if (wasRunning && this.subagents.get(item.id)?.status !== "running") this.subagentEnded(item.id);
        return item.parent !== null;
      }
      case "subagentText":
        if (this.subagents.text(item.parent, item.text)) this.subagentChanged(this.subagents.get(item.parent));
        return true;
      case "subagentStarted":
        if (this.subagents.started(item)) this.subagentChanged(this.subagents.get(item.id));
        return true;
      case "subagentEnded": {
        const ended = this.subagents.ended(item);
        if (ended) {
          this.subagentEnded(ended.id);
          this.subagentChanged(ended);
        }
        return true;
      }
      case "subagentWaiting":
        return true;
      default:
        return false;
    }
  }

  /** It changed: saved, its view sent, and the step that sent it (status, count) drawn again. */
  private subagentChanged(subagent: SubagentRecord | undefined) {
    if (!subagent) return;
    this.saveSubagents();
    this.emit({ type: "subagent.updated", botId: this.id, subagent: subagentView(subagent, this.profile.name, this.subagents) });
    const top = subagent.parentID ? this.subagents.get(subagent.parentID) ?? subagent : subagent;
    if (this.turn?.steps.some((step) => step.id === top.id)) this.emitSteps(this.turn);
    for (let i = this.records.length - 1, seen = 0; i >= 0 && seen < 80; i--, seen++) {
      const record = this.records[i]!;
      if (record !== this.turn?.record && record.steps?.some((step) => step.id === top.id)) {
        this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
        break;
      }
    }
  }

  /** A subagent ended: the step that sent it is done, and a silent turn will have to say what came of it. */
  private subagentEnded(id: string) {
    const subagent = this.subagents.get(id);
    if (!subagent) return;
    const mark = (steps: StepRecord[] | undefined) => {
      const step = steps?.findLast((candidate) => candidate.id === id);
      if (!step) return false;
      step.done = true;
      step.failed = subagent.status === "failed";
      return true;
    };
    if (!mark(this.turn?.steps)) {
      for (let i = this.records.length - 1; i >= Math.max(0, this.records.length - 80); i--) {
        if (mark(this.records[i]!.steps)) { this.persist(true); break; }
      }
    }
    if (this.turn && this.turn.origin !== "tidy") this.turn.ended.push(id);
    else this.pendingEnded.push(id);
    this.saveTasks(); // A card's "at work" may have changed.
    if (!this.turn && !this.queue.length && !this.tidying) this.scheduleIdle();
  }

  private emitSteps(turn: Turn) {
    if (turn.origin === "tidy" || turn !== this.turn) return;
    this.emit({ type: "turn.steps", botId: this.id, turnId: turn.id, messageId: turn.messageId, steps: turn.steps.slice(-500).map((step) => stepView(step, this.subagents)) });
  }

  private finishTurn(turn: Turn, status: Status, error?: string) {
    if (!turn.open) return;
    turn.open = false;
    if (this.turn === turn) this.turn = null;
    if (turn.origin === "tidy") {
      turn.onReply?.(status === "done" ? turn.reply.text : "");
      this.finished.set(turn.id, status);
      turn.resolve(status);
      for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, true);
      return; // sleep() goes on from here.
    }
    const raw = turn.reply.text;
    const parsed = parseReply(raw);
    const ended = turn.origin === "background" ? [...this.pendingEnded.splice(0), ...turn.ended] : turn.ended;
    if (status === "done") this.applyReactions(parsed.reactions);
    // Nothing for the user (`Bot.show`'s silent cases): a reply that only reacts; a turn claude
    // started itself that says <no-reply/> or nothing; the app's own note answered with <no-reply/>.
    const nothing = saysNothing(raw);
    const silent = status === "done" && (
      (nothing && parsed.reactions.length > 0)
      || (turn.origin === "background" && (saysNoReply(raw) || nothing))
      || (turn.origin === "app" && nothing && saysNoReply(raw)));
    if (silent) {
      if (turn.record) this.remove(turn.record);
      this.emit({ type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: "" });
      this.finished.set(turn.id, status);
      turn.resolve(status);
      this.afterTurn();
      // A finished subagent's result always reaches the user: ask once, then say it ourselves.
      if (turn.origin !== "user" && ended.length) this.reportFinished(ended);
      else this.next();
      return;
    }
    const fresh = !turn.record;
    const record: ChatRecord = turn.record ?? { id: turn.messageId, role: "bot", text: "", date: toSwiftDate(), turnID: turn.id, engine: "claude" };
    turn.record = record;
    let text = parsed.body;
    let cards: CardView[] | null = null;
    if (status === "done") {
      const extracted = extractCards(text);
      if (extracted) { text = extracted.text; cards = extracted.cards; record.cards = cards; }
      if (parsed.choices) record.choices = parsed.choices.map((choice) => ({ label: choice.label, ...(choice.detail ? { detail: choice.detail } : {}), recommended: choice.recommended }));
      if (parsed.displays.length) record.displays = parsed.displays;
    }
    if (status === "failed" && !text && error) text = error;
    record.text = text;
    record.state = status;
    record.session = this.session.sessionId.toUpperCase();
    if (turn.steps.length) record.steps = turn.steps;
    if (status !== "done") record.interrupted = true;
    if (error) record.error = error.slice(0, 2_000);
    if (fresh) this.add(record);
    else {
      this.persist();
      archiveLine(this.paths.archive, record);
    }
    this.emit({
      type: "turn.finished", botId: this.id, turnId: turn.id, messageId: turn.messageId, status, text: record.text,
      ...(error ? { error: error.slice(0, 2_000) } : {}), ...(cards ? { cards: cards.map(cardView) } : {}),
    });
    this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
    this.finished.set(turn.id, status);
    turn.resolve(status);
    if (status === "done") {
      this.crashes = 0;
      this.unread += 1;
      this.store.saveSetting("unread", this.unread);
      // The task cards it belongs to, from its <task> lines.
      this.tasks.replied(record.id, {
        head: "claude",
        userMessage: turn.origin === "user" ? turn.userId : null,
        userText: turn.userId ? this.records.find((candidate) => candidate.id === turn.userId)?.text ?? null : null,
        started: turn.started,
        usedTools: turn.usedTools,
        reporting: ended,
        asks: !!record.choices?.length,
        runningSubagents: new Set(this.subagents.running.map((subagent) => subagent.id)),
      }, parsed.tasks, toSwiftDate());
      this.saveTasks();
      if (parsed.requests.length) {
        const what = [...new Set(parsed.requests.map(unsupportedRequest))];
        this.notice(`Botling 2.0 cannot do this yet, so nothing happened: ${what.join("; ")}.`);
      }
      // What it said covers the subagents that ended so far.
      this.pendingEnded = [];
    }
    this.afterTurn();
    this.next();
  }

  /** claude waits on nothing once its turn ended: no approval stays open. */
  private afterTurn() {
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, true);
    this.updated();
  }

  /** The next waiting message, if any; else the idle clock starts. */
  private next(): void {
    if (this.turn || this.tidying) return;
    const waiting = this.queue.shift();
    if (waiting) {
      if (!waiting.open) return this.next();
      this.begin(waiting);
      return;
    }
    this.scheduleIdle();
  }

  /** `Bot.reportFinishedSubagents`: the bot answered a finished subagent's news with nothing. */
  private reportFinished(ids: string[]) {
    const finished = [...new Set(ids)].map((id) => this.subagents.get(id)).filter((subagent): subagent is SubagentRecord => !!subagent && subagent.status !== "running");
    const ask = finished.filter((subagent) => !this.reportAsked.has(subagent.id));
    if (ask.length && this.head?.running && !this.queue.length) {
      for (const subagent of ask) this.reportAsked.add(subagent.id);
      const turn = this.newTurn("app", reportNote(ask), null);
      turn.ended = ask.map((subagent) => subagent.id);
      this.begin(turn, this.head);
      return;
    }
    if (finished.length) {
      this.notice(finished.map((subagent) => {
        const report = (subagent.result ?? "").split("\n").find((line) => line.trim()) ?? "";
        const line = `Subagent “${subagent.description}” finished.`;
        return report ? `${line} Its report: ${report}` : line;
      }).join("\n"));
      this.unread += 1;
      this.store.saveSetting("unread", this.unread);
      this.updated();
    }
    this.next();
  }

  /** `quitting`: no polite interrupt first (the app is going), the tree is ended at once. */
  async stop(turnId: string, { quitting = false } = {}): Promise<ResultOf<"turn.stop">> {
    const turn = this.turn;
    if (!turn || turn.id !== turnId || turn.origin === "tidy") {
      // A message still waiting its turn: taken back (it never reached claude).
      const waiting = this.queue.find((candidate) => candidate.id === turnId);
      if (waiting) {
        this.queue.splice(this.queue.indexOf(waiting), 1);
        waiting.open = false;
        this.emit({ type: "turn.finished", botId: this.id, turnId, messageId: waiting.messageId, status: "stopped", text: "" });
        this.finished.set(turnId, "stopped");
        waiting.resolve("stopped");
        return { stopped: true, killed: [], forced: false };
      }
      return { stopped: false, killed: [], forced: false };
    }
    // Order matters: the turn is closed (and says so) before claude hears of it.
    turn.open = false;
    this.turn = null;
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
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, true);
    this.updated();
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
    if (this.draining === draining) this.draining = null;
    resolve();
    if (ended) {
      this.log(`turn ${turnId} stopped; claude ended it`);
      this.next();
      return { stopped: true, killed: [], forced: false };
    }
    // It did not answer: end its whole tree. The next message starts the head again (--resume).
    this.ending.add(head);
    const result = await head.terminate(1_500);
    this.log(`turn ${turnId} stopped; claude did not end it in time, so its tree was ended: ${result.killed.join(",")} forced=${result.forced}`);
    this.next();
    return { stopped: true, killed: result.killed, forced: result.forced };
  }

  async await(turnId: string, signal: AbortSignal): Promise<ResultOf<"turn.await">> {
    const done = this.finished.get(turnId);
    if (done) return { status: done };
    const turn = this.turn?.id === turnId ? this.turn : this.queue.find((candidate) => candidate.id === turnId);
    if (!turn) throw new ContractError("not_found", "No such turn.");
    const status = await Promise.race([
      turn.done,
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
    this.ignoreResults = 0;
    this.mergeRaced = false;
    for (const [id, approval] of [...this.approvals]) if (approval.head === head) this.settle(id, NO_LONGER_NEEDED, false);
    // Its subagents run inside its process: they went with it.
    if (this.subagents.stopRunning()) { this.saveSubagents(); this.saveTasks(); }
    const why = `${exit.signal ?? exit.code}`;
    const turn = this.turn;
    if (turn?.open && turn.head === head) {
      // A resume of a session claude no longer has: start a new session and send the message again, once.
      if (exit.silent && this.session.started && !turn.retried && !exit.expected && turn.origin !== "tidy" && turn.origin !== "background") {
        this.log(`resuming session ${this.session.sessionId} failed (${why}: ${exit.stderr.slice(0, 200)}); starting a new session`);
        this.newSession();
        this.store.saveHead(this.session);
        this.add({ id: newId(), role: "divider", text: NEW_SESSION_DIVIDER, date: toSwiftDate() });
        turn.retried = true;
        turn.head = null;
        turn.sent = false;
        void this.deliver(turn);
        return;
      }
      this.finishTurn(turn, "failed", `The agent exited (${why}) without finishing. ${exit.stderr.slice(-1_000)}`.trim());
    }
    this.log(`head exited (${why})${exit.expected ? "" : " unexpectedly"}`);
    if (exit.expected) {
      // It went to sleep: the next wake is a new session, briefed from memory.md and the chat.
      this.newSession();
    } else if (!this.shuttingDown) {
      this.crashes += 1;
      if (this.crashes <= MAX_RESTARTS) {
        const delay = 1_000 * 2 ** (this.crashes - 1);
        this.log(`starting it again in ${delay} ms`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.head && !this.shuttingDown && !this.problem && !this.profile.problem && !this.lockProblem) {
            try { this.ensureHead(); this.scheduleIdle(); } catch (error) { this.log(`restart failed: ${(error as Error).message}`); }
          }
        }, delay);
      } else {
        this.log(`it crashed ${this.crashes} times in a row; it starts again with the next message`);
      }
    }
    this.updated();
  }

  // ------------------------------------------------------------------------------------------
  // Sleeping

  private scheduleIdle() {
    this.clearIdle();
    if (!this.head?.running || this.turn || this.queue.length || this.approvals.size || this.tidying || this.shuttingDown) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.sleep();
    }, this.options.idleMs);
  }

  private clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** `Bot.sleep(tidy: true)`: memory.md is tidied, then the head ends. Nothing under way is cut off. */
  async sleep({ tidyMs = this.options.tidyTimeoutMs ?? 5 * 60_000 } = {}): Promise<void> {
    const head = this.head;
    if (!head?.running || this.turn || this.queue.length || this.approvals.size || this.tidying) return;
    // A subagent at work (in the background) would end with the process: wait for it.
    if (this.subagents.running.length && !this.shuttingDown) { this.scheduleIdle(); return; }
    this.clearIdle();
    this.tidying = true;
    this.updated();
    this.log("idle: tidying its notes, then going to sleep");
    if (tidyMs > 0) {
      const reply = await this.internal(this.options.prompts().tidy, tidyMs);
      if (reply !== null && !isPlainOK(reply)) this.log(`its tidy reply was not a plain OK: ${reply.slice(0, 200)}`);
    }
    if (this.head === head && head.running) {
      head.finish();
      const exited = await Promise.race([head.exited.then(() => true), sleep(5_000).then(() => false)]);
      if (!exited) await head.terminate(1_000);
    }
    this.tidying = false;
    this.updated();
    // What the user said meanwhile wakes it again, in a new session.
    if (!this.shuttingDown) this.next();
  }

  /** An app turn nobody sees (the tidy): its reply, or null when it did not end in time. */
  private internal(text: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const turn = this.newTurn("tidy", text, null);
      let settled = false;
      const settle = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        this.log("the tidy did not end in time");
        if (turn.open) {
          turn.open = false;
          if (this.turn === turn) this.turn = null;
          turn.resolve("stopped");
          // Its result, if it comes, belongs to nobody.
          if (turn.sent && turn.head?.running) { this.ignoreResults += 1; turn.head.interrupt(); }
        }
        settle(null);
      }, timeoutMs);
      turn.onReply = (reply) => settle(reply);
      void turn.done.then(() => settle(""));
      this.begin(turn, this.head ?? undefined);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Approvals

  private ask(head: ClaudeHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn) {
    if (item.tool !== "Monitored command" && this.alwaysAllowed.includes(item.tool)) {
      head.answer(item.requestId, true, item.input);
      return;
    }
    // Tidying: nobody is reading this turn, and it only touches memory.md.
    if (turn.origin === "tidy") {
      head.answer(item.requestId, false, item.input, "Not now: this turn only updates your memory file.");
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

  /** A button on a question: an approval's action, or a bot's own question answered with the pick's label (`Bot.choose`). */
  choose(messageId: string, index: number, notes?: string): ResultOf<"chat.choose"> {
    const record = this.records.find((candidate) => candidate.id === messageId);
    if (!record?.choices?.length) throw new ContractError("not_found", "No such question.");
    const choice = record.choices[index];
    if (!choice) throw new ContractError("bad_request", "No such button.");
    if (!isOpenQuestion(record)) return { accepted: false };
    if (!record.permissionTool) {
      // A bot's own question: the pick goes to it as your next message, as a reply to the question.
      this.refuseIfClosed();
      record.chosen = index;
      const extra = notes?.trim();
      if (extra) record.answer = extra;
      this.changed(record);
      this.send(choice.label + (extra ? `\n\n${extra}` : ""), { replyTo: messageId });
      return { accepted: true };
    }
    const approval = this.approvals.get(messageId);
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

  /** `Bot.answer`: the user answered a question in their own words instead of a button. */
  answer(messageId: string, text: string): ResultOf<"chat.answer"> {
    const words = text.trim();
    const record = this.records.find((candidate) => candidate.id === messageId);
    if (!record?.choices?.length) throw new ContractError("not_found", "No such question.");
    if (!words || !isOpenQuestion(record)) return { accepted: false };
    if (record.permissionTool) {
      // Words instead of a button: not allowed, and claude hears why.
      const approval = this.approvals.get(messageId);
      if (!approval) { record.answer = NO_LONGER_NEEDED; this.changed(record); return { accepted: false }; }
      clearTimeout(approval.timer);
      this.approvals.delete(messageId);
      record.answer = words;
      this.changed(record);
      approval.head.answer(approval.requestId, false, approval.input, `The user did not allow it and said: ${words}`);
      this.updated();
      return { accepted: true };
    }
    this.refuseIfClosed();
    record.answer = words;
    this.changed(record);
    this.send(words, { replyTo: messageId });
    return { accepted: true };
  }

  /** The user's own reaction on a line (`Bot.setReaction`, actor "user"). */
  react(messageId: string, emoji: string, present: boolean): ResultOf<"chat.react"> {
    if (!REACTION_PALETTE.includes(emoji)) throw new ContractError("bad_request", "Not one of the reactions.");
    if (this.readOnly) throw new ContractError("conflict", this.problem ?? "Read-only.");
    return { changed: this.setReaction(messageId, emoji, present, "user") };
  }

  private setReaction(messageId: string, emoji: string, present: boolean, actor: string): boolean {
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

  private applyReactions(actions: { messageId: string; emoji: string; present: boolean }[]) {
    for (const action of actions) {
      try {
        this.setReaction(action.messageId, action.emoji, action.present, "head:claude");
        // Its own reaction is not news to this head's session.
        if (this.reactionsSeen) this.reactionsSeen = applyingReaction(this.reactionsSeen, action.messageId, action.emoji, action.present, "head:claude");
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
    this.notice(`A card says: ${value}`);
    return { accepted: true };
  }

  /** Ends the turn and the head (with its tree) and writes everything out; for quitting. An idle awake bot tidies first (1.x). */
  async shutdown() {
    const tidyMs = this.options.quitTidyMs ?? 15_000;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.clearIdle();
    this.shuttingDown = true;
    // Messages still waiting never reached claude.
    for (const waiting of this.queue.splice(0)) { waiting.open = false; waiting.resolve("stopped"); }
    // A running turn's tree is ended at once (what it said so far stays); such a head does not tidy.
    const working = this.shownTurn;
    if (working) await this.stop(working.id, { quitting: true }).catch(() => {});
    for (const id of [...this.approvals.keys()]) this.settle(id, NO_LONGER_NEEDED, false);
    if (!working && this.head?.running && !this.turn && !this.tidying && tidyMs > 0) await this.sleep({ tidyMs });
    if (this.head?.running) {
      const last = this.head;
      // A polite end first (claude writes its session); then the tree.
      last.finish();
      const ended = await Promise.race([last.exited.then(() => true), sleep(1_000).then(() => false)]);
      if (!ended) await last.terminate(1_000);
    }
    this.options.lock?.release();
    this.persist();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `Bot.preview(of:)`: a line's first line, ≤ 60 characters (what a reply to it quotes). */
export function preview(record: ChatRecord): string {
  const line = record.text.split(/[\n\r\u2028\u2029]+/).find((part) => part.length > 0) ?? decodeURIComponent(record.attachments?.[0]?.url.split("/").pop() ?? "");
  return characterCount(line) > 60 ? `${characterPrefix(line, 60)}…` : line;
}

/** Tags held back while still being written, and those that end with their opening `>` (attributes only). */
const BLOCK_TAGS = ["choices", "show", "team", "component", "new-bot", "new-project", "plugin", "install-build", "install", "need-folder",
  "give-component", "take-component", "suggest-component", "component-spec", "component-declined", "open-question", "no-reply",
  "task", "reaction", "decision-ref", "app-screenshot", "end", "block"];
const ATTRIBUTE_TAGS = new Set(["task", "reaction", "decision-ref", "open-question", "app-screenshot"]);

/**
 * The reply so far as the chat shows it while it streams: the app's complete tags taken out, and
 * a tag still being written held back (from its `<` on), so no raw tag flashes in the bubble.
 */
export function streamingText(raw: string): string {
  let cut = -1;
  for (const name of BLOCK_TAGS) {
    const opener = new RegExp(`<${name}(?=[\\s/>]|$)`, "g");
    let open = -1;
    for (const match of raw.matchAll(opener)) open = match.index!;
    if (open < 0) continue;
    const rest = raw.slice(open);
    const closed = rest.includes(`</${name}>`) || /^<[^>]*\/>/.test(rest) || (ATTRIBUTE_TAGS.has(name) && /^<[^>]*>/.test(rest));
    if (!closed && (cut < 0 || open < cut)) cut = open;
  }
  // A `<` at the very end may be the start of a tag.
  const tail = /<[a-z/-]*$/i.exec(raw);
  if (tail && (cut < 0 || tail.index < cut)) cut = tail.index;
  return parseReply(cut >= 0 ? raw.slice(0, cut) : raw).body;
}

/** The question, with what would run shown as code so nothing in it renders as a link or formatting (`Bot.permissionText`). */
export function permissionText(tool: string, summary: string): string {
  const longest = Math.max(0, ...(summary.match(/~+/g) ?? []).map((run) => run.length));
  const fence = "~".repeat(Math.max(3, longest + 1));
  return `Wants to use \`${tool.replaceAll("`", "'")}\`:\n\n${fence}\n${summary}\n${fence}`;
}

const clip = (text: string | undefined | null, limit: number) => (text == null ? null : text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** A step as the contract shows it; a subagent's with its status and tool count (`ChatPayload.stepView`). */
export function stepView(step: StepRecord, subagents?: SubagentBook): StepView {
  const kind = (["tool", "text", "subagent", "message"] as const).includes(step.kind) ? step.kind : "tool";
  const subagent = kind === "subagent" ? subagents?.get(String(step.id)) : undefined;
  const view: StepView = {
    id: String(step.id).slice(0, 200),
    kind,
    tool: clip(step.tool, 200),
    title: clip(subagent?.description || String(step.title ?? ""), 2_000) ?? "",
    detail: clip(step.detail, 10_000),
    output: clip(step.output, 10_000),
    failed: step.failed === true,
    done: step.done === true,
  };
  if (kind === "subagent") {
    view.status = subagent?.status ?? (step.done ? (step.failed ? "failed" : "completed") : "running");
    view.count = subagent ? toolCount(subagent) : null;
    if (subagent && subagent.status !== "running") view.done = true;
  }
  return view;
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

const iso = (swift: number | undefined) => (typeof swift === "number" && Number.isFinite(swift) ? swiftDateISO(swift) : new Date(0).toISOString());

export function taskView(card: TaskCard, running: Set<string>): TaskView {
  return {
    id: card.id.slice(0, 64),
    name: clip(card.name, 400) ?? "",
    state: card.state,
    owner: card.owner ?? null,
    now: clip(card.now, 2_000),
    next: clip(card.next, 2_000),
    blocked: clip(card.blocked, 2_000),
    messageIds: card.messageIDs.filter((id) => /^[A-Za-z0-9_.:-]{1,64}$/.test(id)).slice(-1_000),
    updatedAt: iso(card.updatedAt),
    atWork: (card.subagentIDs ?? []).some((id) => running.has(id)),
  };
}

/** `ChatPayload.make(subagent:)`'s data: its task, steps, words and report. */
export function subagentView(subagent: SubagentRecord, owner: string, book: SubagentBook): SubagentView {
  return {
    id: subagent.id.slice(0, 200),
    title: clip(subagent.description || "Subagent", 400) ?? "Subagent",
    owner: owner.slice(0, 200),
    status: subagent.status,
    type: clip(subagent.type, 200),
    model: clip(subagent.model, 200),
    prompt: clip(subagent.prompt, 20_000) ?? "",
    steps: subagent.steps.slice(-500).map((step) => stepView(step, book)),
    result: clip(subagent.result, 20_000),
    startedAt: iso(subagent.startedAt),
    endedAt: subagent.endedAt != null ? iso(subagent.endedAt) : null,
  };
}

/** A chat line as the contract shows it (what 1.x's ChatPayload.Message is built from). */
export function messageView(record: ChatRecord, approval?: { expires: number }, subagents?: SubagentBook): MessageView {
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
  if (record.steps?.length) view.steps = record.steps.slice(-500).map((step) => stepView(step, subagents));
  if (record.interrupted) view.interrupted = true;
  if (record.attachments?.length) {
    view.attachments = record.attachments.slice(0, 50).filter((file) => typeof file?.url === "string").map((file) => ({
      name: decodeURIComponent(file.url.split("/").pop() ?? "file").slice(0, 400),
      kind: file.kind === "image" || file.kind === "video" ? file.kind : "file",
      url: file.url.slice(0, 4_000),
    }));
  }
  if (typeof record.replyTo === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(record.replyTo)) view.replyTo = record.replyTo;
  if (typeof record.replyPreview === "string") view.replyPreview = record.replyPreview.slice(0, 2_000);
  if (Array.isArray(record.reactions) && record.reactions.length) {
    view.reactions = record.reactions.slice(0, 60).filter((r) => typeof r?.emoji === "string" && typeof r?.actor === "string")
      .map((r) => ({ emoji: r.emoji.slice(0, 16), actor: r.actor.slice(0, 200) }));
  }
  return view;
}
