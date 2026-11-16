// BotProgress (M7-S45): network outage, API retries, Codex retries, and quiet-run stall reminders.
import type { BotView } from "../../contract";
import type { CodexItem } from "../agent/codex";
import { ReplyText } from "../agent/stream";
import { API_RETRY_NOTE, apiRetryDelays, apiRetryText } from "../api-retry";
import type { Bot, Status } from "../bot";
import { WARM_WINDOW_MS, restoredText, resumeMode, resumeNote, type CutOff, type Outage } from "../network-resume";
import { fromSwiftDate as fromSwiftDateMs, newId, toSwiftDate } from "../store/records";
import type { BotContext } from "./context";
import type { Turn } from "./types";
import { subagentOf } from "./view-functions";

export class BotProgress {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: shared names from `BotContext`, Bot-owned names from `Bot` ----
  private get peers() { return this.ctx.peers; }
  private get subagents() { return this.ctx.subagents; }
  private get store() { return this.ctx.store; }
  private get engine() { return this.ctx.engine; }
  private get profile() { return this.ctx.profile; }
  private log(line: string) { this.ctx.log(line); }
  private get head() { return this.host.head; }
  private get session() { return this.host.session; }
  private sessionResumed(sessionId: string) { this.host.headRun.sessionResumed(sessionId); }
  private get turn() { return this.host.turn; }
  private get shuttingDown() { return this.host.shuttingDown; }
  private get problem() { return this.host.problem; }
  private get approvals() { return this.host.approvals; }
  private get tidying() { return this.host.tidying; }
  private clearIdle() { this.host.clearIdle(); }
  private updated() { this.host.updated(); }
  private checkSettingsHold() { this.host.checkSettingsHold(); }
  private add(...a: Parameters<Bot["add"]>) { return this.host.add(...a); }
  private deliverTo(...a: Parameters<Bot["deliverTo"]>) { return this.host.deliverTo(...a); }
  private withSavedMemory(prompt: string) { return this.host.withSavedMemory(prompt); }
  private finishTurn(turn: Turn, status: Status, error?: string) { this.host.finishTurn(turn, status, error); }
  private bumpUnread() { this.host.bumpUnread(); }

  /** Cut off by the network (1.x's `outage`): it waits for the network to come back (`networkRestored`) to carry on. */
  outage: Outage | null = null;
  retryingConnection = false;
  /** claude is retrying the API connection. */
  retryingStarted() { this.retryingConnection = true; }
  /** The head's process is gone: no retry of the connection is shown. */
  retryingEnded() { this.retryingConnection = false; }
  /** Turns tried again in a row after an API error that passes (api-retry.ts), and the wait before the next try. */
  apiRetries = 0;
  /** A turn's API errors are over (it was given up, or it went on): the count starts again. */
  apiRetriesReset() { this.apiRetries = 0; }
  private apiRetryTimer: NodeJS.Timeout | null = null;
  /** Its Codex head waits to try a refused request again (BotView.codexRetry): until its next item, or the turn's end. */
  codexRetry: NonNullable<BotView["codexRetry"]> | null = null;
  /** The head's process is gone: no Codex retry is waited for. */
  codexRetryEnded() { this.codexRetry = null; }
  /** When the turn under way last showed a step (1.x's `lastProgress`, ms), and each subagent's (`subagentProgress`). */
  private lastProgress: number | null = null;
  private subagentProgress = new Map<string, number>();
  /** Quiet spells already reminded of ("": its own turn; else a subagent's id), once each (`stallReminded`). */
  private stallReminded = new Set<string>();

  recordOutage({ turnFailed = false, subagents = [], lostSession = null }: { turnFailed?: boolean; subagents?: string[]; lostSession?: string | null }) {
    const record: Outage = this.outage ? { ...this.outage, subagents: [...this.outage.subagents] } : { since: Date.now(), turnFailed: false, subagents: [], lostSession: null };
    if (turnFailed) record.turnFailed = true;
    for (const id of subagents) if (!record.subagents.includes(id)) record.subagents.push(id);
    if (lostSession) record.lostSession = lostSession;
    this.outage = record;
    this.retryingConnection = false;
    this.clearIdle();
    this.updated();
  }

  /**
   * The network is back (`now`: when that was seen). Within the warm window of the failure it goes on in the
   * same session and continues its subagents; later, cut-off subagents start over as new ones in their
   * worktree with their prompt and one added line. (A partner head's outage is looked at too.)
   */
  networkRestored(now = Date.now()) {
    for (const peer of this.peers) peer.networkRestored(now);
    const outage = this.outage;
    if (!outage) return;
    this.outage = null;
    this.retryingConnection = false;
    queueMicrotask(() => this.checkSettingsHold());
    const elapsed = Math.max(0, now - outage.since);
    const warm = elapsed <= WARM_WINDOW_MS;
    const cut: CutOff[] = outage.subagents.flatMap((id) => {
      const subagent = this.subagents.get(id);
      return subagent ? [{ description: subagent.description, type: subagent.type ?? null, prompt: subagent.prompt, agentId: subagent.agentID ?? null }] : [];
    });
    const note = resumeNote(elapsed, outage.turnFailed || outage.lostSession !== null, cut);
    const mode = resumeMode(elapsed, cut.length);
    this.add({ id: newId(), role: "divider", text: restoredText(elapsed, mode), date: toSwiftDate() });
    this.updated();
    if (!this.head?.running && warm && outage.lostSession) {
      // The process went away with it: the same session again, while its cache is warm.
      this.sessionResumed(outage.lostSession);
      this.store.saveHead(this.session);
      this.deliverTo(this.engine, this.withSavedMemory(note), null, { origin: "app" });
      return;
    }
    this.deliverTo(this.engine, note, null, { origin: "app" });
  }

  /**
   * The turn ended on an API error that passes: it ends stopped with the line "API 暫時擋住，30 秒後重試（1/3）" (its steps
   * kept), and after the wait the same session is told to carry on (API_RETRY_NOTE) in a turn of the app's, which
   * takes over its call-in relay. Claude already did the turn's tools; it goes on from there and redoes none. False:
   * no try left (or a turn in another chat, which is not tried again here).
   */
  retryApiLater(turn: Turn): boolean {
    const delays = apiRetryDelays();
    const attempt = this.apiRetries + 1;
    if (attempt > delays.length || turn.guest || turn.callIn) return false;
    this.apiRetries = attempt;
    const delay = delays[attempt - 1]!;
    const relay = turn.relayTo;
    turn.relayTo = undefined;
    turn.reply = new ReplyText();
    turn.reply.add({ kind: "assistantText", text: apiRetryText(attempt, delays.length, delay) });
    this.log(`API error that passes; trying the turn again in ${Math.round(delay / 1000)} s (${attempt}/${delays.length})`);
    this.finishTurn(turn, "stopped");
    this.clearApiRetry();
    this.apiRetryTimer = setTimeout(() => {
      this.apiRetryTimer = null;
      if (this.shuttingDown || this.problem) return;
      try {
        const next = this.deliverTo(this.engine, API_RETRY_NOTE, null, { origin: "app" });
        if (relay) next.relayTo = relay;
      } catch (error) { this.log(`API retry not delivered: ${(error as Error).message}`); }
    }, delay);
    this.apiRetryTimer.unref?.();
    return true;
  }

  clearApiRetry() {
    if (this.apiRetryTimer) { clearTimeout(this.apiRetryTimer); this.apiRetryTimer = null; }
  }

  /** Something happened in the turn under way (or one starts). */
  noteCodexRetry(item: Extract<CodexItem, { kind: "apiRetry" }>) {
    const shown = this.codexRetry;
    // A late time for an attempt no longer shown (the turn moved on, or a newer attempt came) is dropped.
    if (item.retryAt !== null && (!shown || shown.attempt !== item.attempt || shown.retryAt !== null)) return;
    if (item.retryAt === null && !this.turn?.open) return;
    this.codexRetry = { attempt: item.attempt, max: item.max, reason: item.reason, retryAt: item.retryAt };
    this.updated();
  }

  clearCodexRetry() {
    if (!this.codexRetry) return;
    this.codexRetry = null;
    this.updated();
  }

  noteProgress() {
    this.lastProgress = Date.now();
    this.stallReminded.delete("");
  }

  noteProgressOf(item: CodexItem) {
    const id = subagentOf(item);
    if (id) { this.subagentProgress.set(id, Date.now()); this.stallReminded.delete(id); }
    this.noteProgress();
    if (this.retryingConnection) { this.retryingConnection = false; this.updated(); }
  }

  /**
   * Reminds you once per quiet spell when the turn under way, or a subagent at work, has shown no new step
   * for `intervalMs` (0 or less: never). Not while it waits for you (1.x: or for the network). Its lines: who is quiet.
   */
  checkStall(now: number, intervalMs: number): string[] {
    if (intervalMs <= 0 || !this.head?.running || this.approvals.size || this.outageBlocksStall()) return [];
    const minutes = Math.max(1, Math.round(intervalMs / 60_000));
    const lines: string[] = [];
    let quietForeground = false;
    for (const subagent of this.subagents.running) {
      if (this.stallReminded.has(subagent.id)) continue;
      const last = this.subagentProgress.get(subagent.id) ?? fromSwiftDateMs(subagent.startedAt);
      if (now - last < intervalMs) continue;
      this.stallReminded.add(subagent.id);
      if (!subagent.background) quietForeground = true;
      lines.push(`子代理「${subagent.description || "Subagent"}」已經 ${minutes} 分鐘沒有新的步驟了。`);
    }
    const working = !!this.turn?.open && !this.tidying;
    if (working && this.lastProgress !== null && now - this.lastProgress >= intervalMs && !this.stallReminded.has("")) {
      this.stallReminded.add("");
      // Waiting on a quiet subagent is that subagent's quiet spell, already said.
      if (!quietForeground) lines.unshift(`${this.profile.name} 已經 ${minutes} 分鐘沒有新的步驟了。`);
    }
    if (!lines.length) return [];
    this.add({ id: newId(), role: "notice", text: `${lines.join("\n")}\n可能卡住了：可以再等等，或傳訊息問它在做什麼。`, date: toSwiftDate() });
    this.bumpUnread();
    return lines;
  }

  /** Not while it waits for the network. */
  outageBlocksStall(): boolean {
    return this.outage !== null;
  }
}
