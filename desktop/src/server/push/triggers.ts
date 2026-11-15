// Web Push triggers (protocol v1 §18.4, M4-24, Q-P1):
// - Push ONLY when a bot owned by this server needs the user (an approval or question card becomes open).
// - Call PushSender at most once per card-opening transition per unattached valid `read`-scoped device; updates to an
//   already-open card, closed/answered/ignored/queued cards, turn endings, and non-card events never trigger a push.
// - Coalesces repeated triggers for the same bot within `coalesceMs` (default 1 minute).
// - Handles `404`/`410` gone endpoints (remembers endpoint without logging it, never retries until device subscribes a
//   new endpoint), and retries `429`/`5xx`/network failures with per-origin `Retry-After` + bounded exponential backoff,
//   re-checking roster subscriptions, `read` scope, and attached sessions dynamically when a retry fires (L-008).
// - Dispatches in TxScope.afterCommit so rolled-back transactions or cards closed in the same transaction never send
//   spurious notifications.
import type { Event as ContractEvent } from "../../contract";
import type { TxScope } from "../effects";
import { isOpenCard } from "../log";
import type { Db } from "../store";
import type { PushAlert, PushRoster, PushSendReport, PushSender } from "./sender";

export const DEFAULT_PUSH_COALESCE_MS = 60_000;
export const DEFAULT_PUSH_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_PUSH_MAX_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_PUSH_MAX_RETRIES = 3;
const MAX_GONE_ENDPOINTS = 4096;
const MAX_PENDING_RETRIES = 256;

export interface PushTriggersOptions {
  scope: TxScope;
  sender: Pick<PushSender, "notify">;
  /** Roster subscription lookup; re-read dynamically on every send and scheduled retry (L-008). */
  roster?: PushRoster;
  /** Read-scope gate (M4-22 N2 / R3); defaults to true when omitted. */
  canPushDevice?: (device: string) => boolean;
  /** Optional DB reader to seed currently open cards at startup so existing cards do not re-trigger on update. */
  reader?: () => Db;
  /** Fallback bot display name lookup when `bot.updated` has not been seen yet. */
  botName?: (botId: string) => string | null | undefined;
  /** Devices currently attached with an open page on this server (excluded from push). */
  attachedDevices?: () => ReadonlySet<string> | readonly string[];
  /** Per-bot coalescing window in ms (`0` disables coalescing; default 60,000 ms). */
  coalesceMs?: number;
  /** Base exponential backoff delay in ms for retryable failures (default 2,000 ms). */
  backoffBaseMs?: number;
  /** Maximum backoff / Retry-After cap in ms (default 300,000 ms). */
  maxBackoffMs?: number;
  /** Maximum retry attempts after an initial failed attempt (default 3). */
  maxRetries?: number;
  now?: () => number;
  log?: (line: string) => void;
}

function cardKey(botId: string, cardId: string): string {
  return `${botId}\0${cardId}`;
}

function retryKey(botId: string, device: string): string {
  return `${botId}\0${device}`;
}

function toDeviceSet(list: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
  if (!list) return new Set();
  return list instanceof Set ? new Set(list) : new Set(list);
}

function safeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "<invalid-endpoint>";
  }
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
  private readonly lastBotPushAt = new Map<string, number>();
  private readonly goneEndpoints = new Set<string>();
  private readonly originBlockedUntil = new Map<string, number>();
  private readonly pendingRetries = new Map<string, { timer: NodeJS.Timeout; attempt: number }>();
  private readonly coalesceMs: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: PushTriggersOptions) {
    this.coalesceMs = options.coalesceMs ?? DEFAULT_PUSH_COALESCE_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_PUSH_BACKOFF_BASE_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_PUSH_MAX_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_PUSH_MAX_RETRIES;
    this.now = options.now ?? Date.now;
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
      this.options.scope.afterCommit(() => {
        this.lastBotPushAt.delete(event.botId);
        this.cancelBotRetries(event.botId);
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
        this.triggerBot(event.botId);
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
    for (const entry of this.pendingRetries.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingRetries.clear();
  }

  private botHasOpenCard(botId: string): boolean {
    const prefix = `${botId}\0`;
    for (const key of this.openCards) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  private triggerBot(botId: string): void {
    const now = this.now();
    const lastAt = this.lastBotPushAt.get(botId);
    if (this.coalesceMs > 0 && lastAt !== undefined && now - lastAt < this.coalesceMs) {
      return;
    }

    const botName = this.currentBotName(botId);
    const attached = toDeviceSet(this.options.attachedDevices?.());

    if (this.options.roster) {
      const immediate: string[] = [];
      const deferred: Array<{ device: string; delayMs: number }> = [];
      const endpoints = new Map<string, string>();

      for (const { device, subscription } of this.options.roster.pushSubscriptions()) {
        if (attached.has(device)) continue;
        if (this.options.canPushDevice && !this.options.canPushDevice(device)) continue;
        if (this.goneEndpoints.has(subscription.endpoint)) continue;
        endpoints.set(device, subscription.endpoint);

        const origin = safeOrigin(subscription.endpoint);
        const blockedUntil = this.originBlockedUntil.get(origin) ?? 0;
        if (blockedUntil > now + 5) {
          deferred.push({ device, delayMs: Math.min(this.maxBackoffMs, blockedUntil - now) });
        } else {
          immediate.push(device);
        }
      }

      if (!immediate.length && !deferred.length) return;
      this.lastBotPushAt.set(botId, now);

      for (const item of deferred) {
        this.scheduleRetry(botId, item.device, 0, item.delayMs);
      }
      if (immediate.length) {
        this.dispatch({ botId, botName, devices: immediate }, 0, endpoints);
      }
      return;
    }

    this.lastBotPushAt.set(botId, now);
    this.dispatch({ botId, botName, ...(attached.size ? { excludeDevices: attached } : {}) }, 0, new Map());
  }

  private currentBotName(botId: string): string {
    return this.botNames.get(botId) ?? this.options.botName?.(botId) ?? "Bot";
  }

  private dispatch(alert: PushAlert, attempt: number, endpoints: Map<string, string>): void {
    const task = Promise.resolve()
      .then(() => this.options.sender.notify(alert))
      .then((report) => {
        if (report) this.handleReport(alert.botId, report, attempt, endpoints);
      })
      .catch((error) => {
        this.options.log?.(`push: trigger notify failed for ${alert.botId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  private handleReport(botId: string, report: PushSendReport, attempt: number, endpoints: Map<string, string>): void {
    if (this.closed) return;
    const now = this.now();
    for (const result of report.results) {
      const endpoint = endpoints.get(result.device);
      const origin = endpoint ? safeOrigin(endpoint) : result.device;

      if (result.ok) {
        this.cancelRetry(botId, result.device);
        continue;
      }

      if (result.gone) {
        if (endpoint) this.markGone(endpoint);
        this.cancelRetry(botId, result.device);
        continue;
      }

      if (!result.retryable) continue;

      if (attempt >= this.maxRetries) {
        this.options.log?.(`push: giving up retry for ${result.device} (${origin}) after ${attempt} attempt(s) (${result.reason})`);
        continue;
      }

      const nextAttempt = attempt + 1;
      const expDelay = Math.min(this.maxBackoffMs, this.backoffBaseMs * 2 ** (nextAttempt - 1));
      const retryAfterDelay = result.retryAfterMs !== undefined
        ? Math.min(this.maxBackoffMs, Math.max(0, result.retryAfterMs))
        : 0;
      const delayMs = Math.min(this.maxBackoffMs, Math.max(expDelay, retryAfterDelay));

      const blockedUntil = now + delayMs;
      const prevBlocked = this.originBlockedUntil.get(origin) ?? 0;
      if (blockedUntil > prevBlocked) this.originBlockedUntil.set(origin, blockedUntil);

      this.scheduleRetry(botId, result.device, nextAttempt, delayMs);
    }
  }

  private scheduleRetry(botId: string, device: string, attempt: number, delayMs: number): void {
    if (this.closed) return;
    const key = retryKey(botId, device);
    const existing = this.pendingRetries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingRetries.delete(key);
    } else if (this.pendingRetries.size >= MAX_PENDING_RETRIES) {
      return;
    }

    const boundedDelay = Math.max(1, Math.min(this.maxBackoffMs, delayMs));
    const timer = setTimeout(() => {
      this.pendingRetries.delete(key);
      this.runRetry(botId, device, attempt);
    }, boundedDelay);
    timer.unref?.();
    this.pendingRetries.set(key, { timer, attempt });
  }

  private runRetry(botId: string, device: string, attempt: number): void {
    if (this.closed || !this.botHasOpenCard(botId)) return;

    const attached = toDeviceSet(this.options.attachedDevices?.());
    if (attached.has(device)) return;
    if (this.options.canPushDevice && !this.options.canPushDevice(device)) return;

    const endpoints = new Map<string, string>();
    if (this.options.roster) {
      // Re-read valid unrevoked subscriptions dynamically (L-008): revoked/unsubscribed devices are dropped here.
      const sub = this.options.roster.pushSubscriptions().find((entry) => entry.device === device);
      if (!sub) return;
      if (this.goneEndpoints.has(sub.subscription.endpoint)) return;
      endpoints.set(device, sub.subscription.endpoint);

      const origin = safeOrigin(sub.subscription.endpoint);
      const now = this.now();
      const blockedUntil = this.originBlockedUntil.get(origin) ?? 0;
      if (blockedUntil > now + 5) {
        if (attempt >= this.maxRetries) return;
        this.scheduleRetry(botId, device, attempt + 1, blockedUntil - now);
        return;
      }
    }

    this.dispatch({ botId, botName: this.currentBotName(botId), devices: [device] }, attempt, endpoints);
  }

  private cancelRetry(botId: string, device: string): void {
    const key = retryKey(botId, device);
    const existing = this.pendingRetries.get(key);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.pendingRetries.delete(key);
  }

  private cancelBotRetries(botId: string): void {
    const prefix = `${botId}\0`;
    for (const [key, entry] of this.pendingRetries) {
      if (key.startsWith(prefix)) {
        clearTimeout(entry.timer);
        this.pendingRetries.delete(key);
      }
    }
  }

  private markGone(endpoint: string): void {
    if (this.goneEndpoints.has(endpoint)) return;
    if (this.goneEndpoints.size >= MAX_GONE_ENDPOINTS) {
      const oldest = this.goneEndpoints.values().next().value;
      if (oldest !== undefined) this.goneEndpoints.delete(oldest);
    }
    this.goneEndpoints.add(endpoint);
  }
}
