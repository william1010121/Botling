// Web Push triggers (protocol v1 §18.4, M4-24, Q-P1):
// - Push ONLY when a bot owned by this server needs the user (an approval or question card becomes open).
// - Call PushSender at most once per card-opening transition per unattached valid device; updates to an already-open
//   card, closed/answered/ignored/queued cards, turn endings, and non-card events never trigger a push.
// - Dispatches in TxScope.afterCommit so rolled-back transactions or cards closed in the same transaction never send
//   spurious notifications.
import type { Event as ContractEvent } from "../../contract";
import type { TxScope } from "../effects";
import { isOpenCard } from "../log";
import type { Db } from "../store";
import type { PushAlert, PushSender } from "./sender";

export interface PushTriggersOptions {
  scope: TxScope;
  sender: Pick<PushSender, "notify">;
  /** Optional DB reader to seed currently open cards at startup so existing cards do not re-trigger on update. */
  reader?: () => Db;
  /** Fallback bot display name lookup when `bot.updated` has not been seen yet. */
  botName?: (botId: string) => string | null | undefined;
  /** Devices currently attached with an open page on this server (excluded from push). */
  attachedDevices?: () => ReadonlySet<string> | readonly string[];
  log?: (line: string) => void;
}

function cardKey(botId: string, cardId: string): string {
  return `${botId}\0${cardId}`;
}

/** Device member IDs that currently have at least one open front-end session attached to this server. */
export function attachedDeviceIds(sessions: Iterable<{ isOpen: boolean; memberId: string | null }>): Set<string> {
  const attached = new Set<string>();
  for (const session of sessions) {
    if (session.isOpen && session.memberId) attached.add(session.memberId);
  }
  return attached;
}

export class PushTriggers {
  private readonly openCards = new Set<string>();
  private readonly botNames = new Map<string, string>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly options: PushTriggersOptions) {
    if (options.reader) this.seed(options.reader());
  }

  /** Seeds `openCards` from the `cards` read model (idempotent; call after startup recovery). */
  seed(db: Db): void {
    this.openCards.clear();
    for (const row of db.prepare("SELECT botId, cardId FROM cards WHERE state = 'open'").all()) {
      this.openCards.add(cardKey(String(row.botId), String(row.cardId)));
    }
  }

  /** EventTap `eventStored` hook: tracks open-card transitions inside `tx` and sends pushes after commit. */
  stored(_tx: Db, event: ContractEvent): void {
    if (this.closed) return;

    if (event.type === "bot.updated") {
      const prev = this.botNames.get(event.bot.id);
      this.botNames.set(event.bot.id, event.bot.name);
      this.options.scope.onRollback(() => {
        if (prev === undefined) this.botNames.delete(event.bot.id);
        else this.botNames.set(event.bot.id, prev);
      });
      return;
    }

    if (event.type === "bot.removed") {
      const prevName = this.botNames.get(event.botId);
      this.botNames.delete(event.botId);
      const prefix = `${event.botId}\0`;
      const removed: string[] = [];
      for (const key of this.openCards) {
        if (key.startsWith(prefix)) {
          this.openCards.delete(key);
          removed.push(key);
        }
      }
      this.options.scope.onRollback(() => {
        if (prevName !== undefined) this.botNames.set(event.botId, prevName);
        for (const key of removed) this.openCards.add(key);
      });
      return;
    }

    if (event.type === "message.removed") {
      const key = cardKey(event.botId, event.messageId);
      if (this.openCards.delete(key)) {
        this.options.scope.onRollback(() => { this.openCards.add(key); });
      }
      return;
    }

    if (event.type !== "message.added" && event.type !== "message.updated") return;

    const key = cardKey(event.botId, event.message.id);
    const wasOpen = this.openCards.has(key);
    const nowOpen = isOpenCard(event.message);
    if (wasOpen === nowOpen) return;

    if (!wasOpen && nowOpen) {
      this.openCards.add(key);
      this.options.scope.onRollback(() => { this.openCards.delete(key); });
      this.options.scope.afterCommit(() => {
        if (this.closed || !this.openCards.has(key)) return;
        const botName = this.botNames.get(event.botId) ?? this.options.botName?.(event.botId) ?? "Bot";
        const excludeDevices = this.options.attachedDevices?.();
        this.dispatch({ botId: event.botId, botName, ...(excludeDevices ? { excludeDevices } : {}) });
      });
      return;
    }

    this.openCards.delete(key);
    this.options.scope.onRollback(() => { this.openCards.add(key); });
  }

  /** Waits for all in-flight push notifications to settle (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  close(): void {
    this.closed = true;
  }

  private dispatch(alert: PushAlert): void {
    const task = Promise.resolve()
      .then(() => this.options.sender.notify(alert))
      .then(() => undefined)
      .catch((error) => {
        this.options.log?.(`push: trigger notify failed for ${alert.botId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }
}
