// `botling run`'s loop (docs/headless-run.md): one task, no person present. It sends the task to a bot, answers
// what the chat would ask a person (a tool approval: allow once; a <choices> card: its recommended option), and
// settles once the bot, its workers and their background work have all been quiet for `settleMs`.
// It speaks the core's contract through a small transport, so tests drive it with a scripted core.
import type { BotView, MessageView } from "../contract";

export interface RunTransport {
  /** A command to the core; resolves with its result, rejects with its error. */
  call(cmd: Record<string, unknown>): Promise<any>;
  /** Every event the core emits (`{type, …}`), in order. */
  onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): void;
}

export interface RunLoopOptions {
  transport: RunTransport;
  botId: string;
  /** How long everything must stay quiet before the run counts as finished (a worker's report wakes the head again). */
  settleMs?: number;
  log?: (line: string) => void;
}

export type RunOutcome =
  | { status: "completed"; finalText: string; lastTurn: "done" | "stopped" | "failed" | null; error: string | null }
  | { status: "error"; finalText: string; lastTurn: "done" | "stopped" | "failed" | null; error: string };

export interface RunStats { turns: number; failedTurns: number; approvalsAnswered: number; choicesAnswered: number; workers: Set<string> }

type BackgroundState = Map<string, string>;

export class RunLoop {
  readonly stats: RunStats = { turns: 0, failedTurns: 0, approvalsAnswered: 0, choicesAnswered: 0, workers: new Set() };
  private bot: BotView | null = null;
  private started = false;
  private finalText = "";
  private lastTurn: RunOutcome["lastTurn"] = null;
  private lastError: string | null = null;
  private answered = new Set<string>();
  /** Background work by message: task id → status. */
  private background = new Map<string, BackgroundState>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finish!: (outcome: RunOutcome) => void;
  private ended = false;
  readonly done: Promise<RunOutcome>;
  private readonly settleMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: RunLoopOptions) {
    this.settleMs = options.settleMs ?? 15_000;
    this.log = options.log ?? (() => {});
    this.done = new Promise((resolve) => { this.finish = resolve; });
    options.transport.onEvent((event) => this.receive(event));
  }

  /** Sends the task as the user's message. */
  async start(text: string): Promise<void> {
    const sent = await this.options.transport.call({ type: "chat.send", botId: this.options.botId, text });
    if (sent?.turnId) this.started = true;
    this.check();
  }

  /** Ends the loop from outside (a timeout, the core going away). */
  fail(error: string): void {
    this.end({ status: "error", finalText: this.finalText, lastTurn: this.lastTurn, error });
  }

  /** Whether the bot or anything it started is still at work. */
  busy(): boolean {
    const bot = this.bot;
    if (!this.started) return true;
    if (bot) {
      if (bot.working || bot.subagents > 0 || bot.approvals > 0) return true;
      if (bot.phase === "starting" || bot.phase === "switching") return true;
      if (bot.subagentRows.some((row) => row.status === "running")) return true;
      if (bot.callIns?.length || bot.guest || bot.answeringIn) return true;
      if (bot.delegationRows?.some((row) => row.status === "running")) return true;
    }
    for (const tasks of this.background.values()) for (const status of tasks.values()) if (status === "running") return true;
    return false;
  }

  private receive(event: { type: string; [key: string]: unknown }): void {
    if (this.ended) return;
    const botId = this.options.botId;
    switch (event.type) {
      case "bot.updated": {
        const bot = event.bot as BotView;
        if (bot.id !== botId) return;
        this.bot = bot;
        if (bot.working) this.started = true;
        for (const row of bot.subagentRows) this.stats.workers.add(row.id);
        if (bot.problem) { this.end({ status: "error", finalText: this.finalText, lastTurn: this.lastTurn, error: `bot problem: ${bot.problem}` }); return; }
        break;
      }
      case "bot.removed":
        if (event.botId === botId) { this.fail("the bot was removed"); return; }
        break;
      case "turn.started":
        if (event.botId !== botId) return;
        this.started = true;
        this.stats.turns++;
        this.log(`turn ${this.stats.turns} started`);
        break;
      case "turn.finished": {
        if (event.botId !== botId) return;
        const status = event.status as "done" | "stopped" | "failed";
        this.lastTurn = status;
        if (typeof event.text === "string" && event.text.trim()) this.finalText = event.text;
        if (status === "failed") { this.stats.failedTurns++; this.lastError = typeof event.error === "string" ? event.error : "turn failed"; }
        else this.lastError = null;
        this.log(`turn finished: ${status}${status === "failed" ? ` (${this.lastError})` : ""}`);
        break;
      }
      case "message.added":
      case "message.updated": {
        if (event.botId !== botId) return;
        const message = event.message as MessageView;
        this.track(message);
        void this.answer(message);
        break;
      }
      default: return;
    }
    this.check();
  }

  private track(message: MessageView): void {
    if (!message.backgroundTasks?.length) { this.background.delete(message.id); return; }
    this.background.set(message.id, new Map(message.backgroundTasks.map((task) => [task.id, task.status])));
  }

  /** What a person would click: allow a tool once, take a card's recommended option. */
  private async answer(message: MessageView): Promise<void> {
    if (message.role !== "bot" || this.answered.has(message.id) || message.queued) return;
    if (message.chosen != null || (message.answer != null && message.answer !== "") || message.ignoredAt || message.picks?.length) return;
    const botId = this.options.botId;
    try {
      if (message.approval && message.choices?.length) {
        const index = pick(message.choices, (choice) => choice.action === "allowOnce") ?? pick(message.choices, (choice) => choice.action === "alwaysAllow") ?? 0;
        this.answered.add(message.id);
        this.stats.approvalsAnswered++;
        this.log(`approved ${message.approval.tool}`);
        await this.options.transport.call({ type: "chat.choose", botId, messageId: message.id, index });
      } else if (message.questions?.length) {
        this.answered.add(message.id);
        this.stats.choicesAnswered++;
        const picks = message.questions.map((question) => ({ options: [pick(question.options, (option) => option.recommended) ?? 0] }));
        this.log(`answered ${message.questions.length} question(s) with the recommended options`);
        await this.options.transport.call({ type: "chat.answer", botId, messageId: message.id, text: "", picks });
      } else if (message.choices?.length) {
        this.answered.add(message.id);
        this.stats.choicesAnswered++;
        const index = pick(message.choices, (choice) => choice.recommended) ?? 0;
        this.log(`chose "${message.choices[index]?.label ?? index}"`);
        await this.options.transport.call({ type: "chat.choose", botId, messageId: message.id, index });
      }
    } catch (error) {
      this.log(`could not answer ${message.id}: ${(error as Error).message}`);
    }
  }

  private check(): void {
    if (this.ended) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.busy()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.ended || this.busy()) return;
      if (this.lastTurn === "failed") this.end({ status: "error", finalText: this.finalText, lastTurn: this.lastTurn, error: this.lastError ?? "the last turn failed" });
      else this.end({ status: "completed", finalText: this.finalText, lastTurn: this.lastTurn, error: null });
    }, this.settleMs);
  }

  private end(outcome: RunOutcome): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.finish(outcome);
  }
}

function pick<T>(items: T[], test: (item: T) => boolean): number | null {
  const index = items.findIndex(test);
  return index >= 0 ? index : null;
}
