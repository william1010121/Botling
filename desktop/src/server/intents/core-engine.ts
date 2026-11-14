// The 2.x core behind the server's TurnEngine (botlingd builds the Core with `coreEngineOptions`; 2.x builds it as
// before). The core's emit carries both its events and its answers to `receive`: events go to the server's host (the
// event tap), answers settle the legacy commands this binding sent.
import { randomUUID } from "node:crypto";
import { ContractError, PROTOCOL_VERSION, type BotView, type Command, type Event as ContractEvent, type Outbound } from "../../contract";
import type { Core } from "../../core/server";
import type { DeferredTurn } from "../../core/bot";
import type { ApplyNowCommand, EngineHost, TurnEngine, TurnRunning, TurnStart, TurnStatus, UserLine } from "../effects";

/** What the binding uses of the core. */
export type CoreLike = Pick<Core, "serverSend" | "serverTurn" | "serverUserLine" | "applyNow" | "receive" | "hasBot" | "botIds" | "serverBotView" | "pendingFiles" | "checkRemoveBot" | "removeBot">;

interface Waiting { resolve(value: unknown): void; reject(error: unknown): void }

export class CoreEngine implements TurnEngine {
  private core: CoreLike | null = null;
  private host: EngineHost | null = null;
  private readonly waiting = new Map<string, Waiting>();
  /** The `done` of turns the server is starting now (seen by `deferTurn` as they are routed). */
  private readonly dones = new Map<string, Promise<TurnStatus>>();
  private readonly early: ContractEvent[] = [];

  /** The core's `emit` and `deferTurn` options (pass them to `new Core`, then `bind` the core). */
  coreOptions(): { emit: (message: Outbound) => void; deferTurn: (turn: DeferredTurn) => boolean } {
    return { emit: (message) => this.emitted(message), deferTurn: (turn) => this.deferred(turn) };
  }

  bind(core: CoreLike): void {
    this.core = core;
  }

  attach(host: EngineHost): void {
    this.host = host;
    for (const event of this.early.splice(0)) host.event(event);
  }

  bots(): string[] { return this.need().botIds(); }
  hasBot(botId: string): boolean { return this.need().hasBot(botId); }
  botView(botId: string): BotView | null { return this.core?.serverBotView(botId) ?? null; }
  pendingFiles(botId: string): number { return this.need().pendingFiles(botId); }
  checkRemove(botId: string): void { this.need().checkRemoveBot(botId); }
  applyNow(cmd: ApplyNowCommand): unknown { return this.need().applyNow(cmd); }
  userLine(botId: string, line: UserLine): void { this.need().serverUserLine(botId, line); }

  async startTurn(turn: TurnStart): Promise<TurnRunning> {
    const core = this.need();
    const ids = { turnId: turn.turnId, messageId: turn.replyId, ...(turn.userId ? { userId: turn.userId } : {}) };
    try {
      if (turn.send) {
        const sent = await core.serverSend(turn.botId, turn.send.text, { ...(turn.send.replyTo ? { replyTo: turn.send.replyTo } : {}), ...(turn.send.to ? { to: turn.send.to } : {}) }, ids);
        if (!sent.turnId) return { turnId: null };
        const done = sent.turnId === turn.turnId ? this.dones.get(turn.turnId) : undefined;
        return { turnId: sent.turnId, ...(done ? { done } : {}) };
      }
      const started = core.serverTurn(turn.botId, {
        ids, words: turn.words ?? "", userId: turn.userId, origin: turn.origin ?? (turn.userId ? "user" : "app"),
        ...(turn.engine ? { engine: turn.engine } : {}), ...(turn.routine ? { routine: true } : {}),
      });
      return { turnId: started.turnId, ...(started.turnId === turn.turnId ? { done: started.done } : {}) };
    } finally {
      this.dones.delete(turn.turnId);
    }
  }

  stopTurn(botId: string, turnId: string): void {
    void this.run({ type: "turn.stop", botId, turnId }).catch(() => undefined);
  }

  /** A kept turn the core never routed: nothing in the core holds it. */
  discardTurn(): void {}

  async removeBot(botId: string): Promise<void> {
    try {
      await this.need().removeBot(botId);
    } catch (error) {
      if (error instanceof ContractError && error.code === "not_found") return;
      throw error;
    }
  }

  run(cmd: Command): Promise<unknown> {
    const core = this.need();
    const id = `srv-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      core.receive({ v: PROTOCOL_VERSION, id, cmd });
    });
  }

  private need(): CoreLike {
    if (!this.core) throw new Error("CoreEngine: no core bound yet");
    return this.core;
  }

  private emitted(message: Outbound): void {
    if ("event" in message) {
      if (this.host) this.host.event(message.event);
      else this.early.push(message.event);
      return;
    }
    const waiting = this.waiting.get(message.id);
    if (!waiting) return;
    this.waiting.delete(message.id);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(new ContractError(message.error.code, message.error.message));
  }

  private deferred(turn: DeferredTurn): boolean {
    this.dones.set(turn.turnId, turn.done);
    if (!this.host) return false;
    const kept = this.host.deferTurn({
      botId: turn.botId, turnId: turn.turnId, replyId: turn.messageId, userId: turn.userId, words: turn.words, engine: turn.engine,
      origin: turn.origin === "user" ? "user" : "app", routine: turn.routine, done: turn.done,
      release: () => turn.release(),
    });
    if (kept) this.dones.delete(turn.turnId);
    return kept;
  }
}
