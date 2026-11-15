// The engine as botlingd hands it to the intent runtime (M1 step 9): the 2.x core (CoreEngine) with two things added
// on its way to the event tap.
// - Every contract event also goes to the exports (BotExports.feed: a turn's end exports the bot's files at once).
// - At each step boundary of a running turn (a `turn.steps` with more steps than before: a tool call or card started),
//   a `message.updated` of the reply line with the text so far goes into the log first (step 11's need 5): the live
//   segment is closed at that boundary, so a window that attaches later sees the earlier segments' text in the line
//   itself, not only in the live checkpoint. The line is the one the core last told (its `message.added` /
//   `message.updated`); no line told yet: nothing is added.
import type { BotView, Command, Event as ContractEvent, MessageView } from "../contract";
import type { ApplyNowCommand, EngineHost, TurnEngine, TurnRunning, TurnStart, UserLine } from "./effects";
import type { LiveChannel } from "./live";

interface RunningLine {
  turnId: string;
  messageId: string;
  steps: number;
  line: MessageView | null;
}

export interface BotlingdEngineOptions {
  /** Each contract event, as it goes to the tap (BotExports.feed). */
  feed?: (event: ContractEvent) => void;
  /** The live channel the tap feeds (the text so far of a running turn). */
  live?: LiveChannel | null;
}

export class BotlingdEngine implements TurnEngine {
  private readonly running = new Map<string, RunningLine>();

  /**
   * M5-02b: a guest's turn for a call-in from another server. The wrapper must hand it on: without it `CallInGuest` found no
   * `callInTurn` on the engine botlingd gave it and answered every call-in "this machine cannot take call-ins" (found by
   * M5-03b's two-process test; the M5-02b tests drove `CoreEngine` and the fake engine directly). Present only when the
   * inner engine has it, as the guest's check (`!engine.callInTurn`) needs.
   */
  readonly callInTurn?: TurnEngine["callInTurn"];

  constructor(private readonly inner: TurnEngine, private readonly options: BotlingdEngineOptions = {}) {
    if (inner.callInTurn) this.callInTurn = (guestId, prompt, onBegin, callOptions) => inner.callInTurn!(guestId, prompt, onBegin, callOptions);
  }

  attach(host: EngineHost): void {
    this.inner.attach({
      deferTurn: (turn) => host.deferTurn(turn),
      event: (event) => {
        const extra = this.before(event);
        if (extra) host.event(extra);
        host.event(event);
        try { this.options.feed?.(event); } catch { /* an observer never stops an event */ }
      },
    });
  }

  bots(): string[] { return this.inner.bots(); }
  hasBot(botId: string): boolean { return this.inner.hasBot(botId); }
  botView(botId: string): BotView | null { return this.inner.botView?.(botId) ?? null; }
  pendingFiles(botId: string): number { return this.inner.pendingFiles(botId); }
  checkRemove(botId: string): void { this.inner.checkRemove(botId); }
  applyNow(cmd: ApplyNowCommand): unknown { return this.inner.applyNow(cmd); }
  userLine(botId: string, line: UserLine): void { this.inner.userLine?.(botId, line); }
  startTurn(turn: TurnStart): Promise<TurnRunning> { return this.inner.startTurn(turn); }
  stopTurn(botId: string, turnId: string): void { this.inner.stopTurn(botId, turnId); }
  discardTurn(botId: string, turnId: string): void { this.inner.discardTurn(botId, turnId); }
  removeBot(botId: string): Promise<void> { return this.inner.removeBot(botId); }
  run(cmd: Command): Promise<unknown> { return this.inner.run(cmd); }

  /** What goes into the log before `event` (a step boundary's line update), if anything. */
  private before(event: ContractEvent): ContractEvent | null {
    switch (event.type) {
      case "turn.started":
        this.running.set(event.botId, { turnId: event.turnId, messageId: event.messageId, steps: 0, line: null });
        return null;
      case "message.added":
      case "message.updated": {
        const known = this.running.get(event.botId);
        if (known && known.messageId === event.message.id) known.line = event.message;
        return null;
      }
      case "turn.steps": {
        const known = this.running.get(event.botId);
        if (!known || known.turnId !== event.turnId || event.steps.length <= known.steps) return null;
        known.steps = event.steps.length;
        if (!known.line) return null;
        const live = this.options.live?.running(event.botId);
        if (!live || live.turnId !== event.turnId || live.turnText === known.line.text) return null;
        known.line = { ...known.line, text: live.turnText };
        return { type: "message.updated", botId: event.botId, message: known.line } as ContractEvent;
      }
      case "turn.finished": {
        const known = this.running.get(event.botId);
        if (known && known.turnId === event.turnId) this.running.delete(event.botId);
        return null;
      }
      default:
        return null;
    }
  }
}
