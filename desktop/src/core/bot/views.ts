// BotViews (M7-S47): the bot's read-only views and view notifications (`view`, `snapshot`, `history`,
// `headsView`, `pluginChat`, `taskOutput`, `subagentView`, `tokenSpeed`, `noteRequest`, `updated`).
// Follows the bridge convention from M7-S41 (`core/bot/context.ts`).
import { join } from "node:path";
import { ContractError, type BotView, type ChatSnapshot, type Event, type HeadsView, type MessageView, type ResultOf, type RoutineView, type SubagentRowView } from "../../contract";
import { backgroundTaskOutput } from "../background-work";
import type { BackgroundTask } from "../background-tasks";
import type { Bot } from "../bot";
import type { BotContext } from "./context";
import { displayName, hasTwo, resolvePrimary, roundsText, type Engine } from "../heads";
import { MAX_PAGE_BYTES, PAGE_BYTES, pageBack, sliceViews } from "../history-page";
import type { BotStore } from "../store/bot-store";
import type { ChatRecord } from "../store/records";
import type { SubagentHistory } from "../store/subagent-store";
import type { SubagentBook, SubagentRecord } from "../subagents";
import { addSample, speedView, type RequestEvent, type SpeedTotals } from "../token-speed";
import type { BotOptions, Turn } from "./types";
import { clip, firstLine, iso, stepView, subagentView } from "./view-functions";

export class BotViews {
  /** Running sums of this head's own finished requests this session (never persisted; subagents keep theirs in their records). */
  mainSpeed: SpeedTotals | undefined;
  mainSpeedAt = 0;

  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get subagents(): SubagentBook { return this.ctx.subagents; }
  private get id() { return this.ctx.id; }
  private get profile() { return this.ctx.profile; }
  private get paths() { return this.ctx.paths; }
  private get owner(): Bot { return this.ctx.owner; }
  private get peers(): Bot[] { return this.ctx.peers; }
  private get members(): Bot[] { return this.ctx.members; }
  private get chat(): ChatRecord[] { return this.ctx.chat; }
  private get sharesChat(): boolean { return this.ctx.sharesChat; }
  private get records(): ChatRecord[] { return this.host.records; }
  private get problem() { return this.host.problem; }
  private get head() { return this.host.head; }
  private get switching() { return this.host.switching; }
  private get tidying() { return this.host.tidying; }
  private get turn() { return this.host.turn; }
  private get headsSettings() { return this.host.headsSettings; }
  private get conductor() { return this.host.conductor; }
  private get rounds() { return this.host.rounds; }
  private get unread() { return this.host.unread; }
  private get components() { return this.host.components; }
  private get routineStorePath() { return this.host.routineStorePath; }
  private log(line: string) { this.ctx.log(line); }
  private emit(event: Event) { this.ctx.emit(event); }
  private changed(record: ChatRecord) { this.host.changed(record); }
  private messageView(record: ChatRecord): MessageView { return this.host.messageView(record); }
  private subagentRows(): SubagentRowView[] { return this.host.subagentRows(); }
  private subagentChanged(subagent: SubagentRecord | undefined, progress = false, redrawLine = true) { this.host.subagentChanged(subagent, progress, redrawLine); }
  private appPrimary(): Engine | null { return this.host.appPrimary(); }

  // ---- Moved from `Bot` ----

  /** What you last said to it (or what was handed to it), for a component's arrival note. */
  get lastAsked(): string {
    const last = this.chat.findLast((record) => record.role === "user" || record.role === "relay");
    return last?.text ?? "";
  }

  /** A subagent of its is at work (Maintainer settles a request only once its editors are done). */
  get subagentsAtWork(): boolean {
    return this.members.some(bot => bot.subagents.running.length > 0);
  }

  /** Plugins' afterReply hooks may change the reply that just showed; `bots.onReply` listeners hear it. */
  afterReplyHooks(record: ChatRecord) {
    const filter = this.options.replyFilter?.();
    const shown = record.text;
    if (!filter) { this.options.replied?.(this.owner, record); return; }
    void filter(shown).then((changed) => {
      // A later edit (a card update, a pick) leaves it as it is.
      if (changed !== shown && record.text === shown) {
        record.text = changed;
        this.changed(record);
      }
      this.options.replied?.(this.owner, record);
    }, () => this.options.replied?.(this.owner, record));
  }

  /** Whether its head is running (plugins' `awake`). */
  get awake(): boolean {
    return this.members.some(bot => !!bot.head?.running);
  }

  get phase(): BotView["phase"] {
    if (this.switching) return "switching";
    if (this.tidying) return "tidying";
    return this.head?.running ? "awake" : "asleep";
  }

  /** A turn the user waits for is under way: its own, or its answer to a call-in in another chat. */
  get working(): boolean {
    return !!this.turn && (this.turn.origin !== "tidy" || !!this.turn.callIn);
  }

  view(): BotView {
    const phases = this.members.map(bot => bot.phase);
    const phase = phases.includes("switching") ? "switching" : phases.includes("tidying") ? "tidying" : phases.includes("awake") ? "awake" : "asleep";
    return {
      id: this.id,
      name: this.profile.name.slice(0, 200),
      role: this.profile.role,
      avatar: this.profile.avatar.slice(0, 40),
      folder: this.profile.folder.slice(0, 4_000),
      phase,
      working: this.members.some(bot => bot.working),
      connection: this.members.some(bot => bot.outage) ? "disconnected" : this.members.some(bot => bot.progress.retryingConnection) ? "retrying" : null,
      codexRetry: this.members.find(bot => bot.progress.codexRetry)?.progress.codexRetry ?? null,
      approvals: this.members.reduce((n, bot) => n + bot.approvals.size, 0),
      unread: this.unread,
      subagents: this.members.reduce((n, bot) => n + bot.subagents.running.length, 0),
      problem: (this.problem ?? this.profile.problem)?.slice(0, 2_000) ?? null,
      heads: this.headsSettings.engines,
      job: this.profile.job?.slice(0, 4_000) ?? null,
      ...(this.profile.parent ? { parent: this.profile.parent } : {}),
      subagentRows: this.subagentRows(),
      guest: this.options.guest?.() ?? null,
      callIns: this.options.callIns?.() ?? [],
      answeringIn: this.options.answeringIn?.() ?? null,
      components: this.components,
      lastActivity: this.records.length ? iso(this.records.at(-1)!.date) : null,
      tokenSpeed: this.tokenSpeed(),
    };
  }

  /** The head turn's token speed: the member whose head last finished a request. */
  tokenSpeed(): BotView["tokenSpeed"] {
    const latest = this.members.filter(bot => bot.views.mainSpeed).sort((a, b) => b.views.mainSpeedAt - a.views.mainSpeedAt)[0];
    const view = latest ? speedView(latest.views.mainSpeed) : null;
    return view && latest ? { ...view, engine: latest.engine } : null;
  }

  /** A finished model request of this head (scope null) or of one of its subagents. */
  noteRequest(event: RequestEvent) {
    if (event.scope === null) {
      const before = this.mainSpeed?.timed ?? 0;
      this.mainSpeed = addSample(this.mainSpeed, event.sample, event.estimated === true);
      if (this.mainSpeed.timed === before) return;
      this.mainSpeedAt = Date.now();
      this.updated();
      return;
    }
    const child = this.subagents.get(event.scope);
    if (child && this.subagents.speed(child.id, event)) this.subagentChanged(child, true);
  }

  /** Its row changed outside its own work (a guest answering in its chat): told again. */
  refresh() {
    this.updated();
  }

  /** The two-head parts of the chat: who new messages go to, the rounds line and the hand-offs. */
  headsView(): HeadsView | null {
    const heads = this.headsSettings;
    if (!hasTwo(heads)) return null;
    return {
      engines: heads.engines,
      answerWith: resolvePrimary(heads, this.appPrimary()),
      handoffsOn: heads.handoffs,
      rounds: this.rounds ? { kind: this.rounds.kind, round: this.rounds.round, limit: this.rounds.limit, text: roundsText(this.rounds) } : null,
      handoffs: this.conductor.records.slice(-12).map((record) => ({
        id: record.id, from: record.from, to: record.to, kind: record.kind, task: clip(firstLine(record.task), 400) ?? "",
        origin: clip(record.origin, 400), round: record.round, limit: record.limit, state: record.state,
        lines: record.lines.slice(-20).map((line) => ({ who: line.who, text: clip(line.text, 2_000) ?? "" })),
      })),
    };
  }

  /** Settings' Claude worker limit changed: the next worker starts under it (it is read each time); waiting ones may start now. */
  claudeWorkerLimitChanged(): void {
    for (const bot of this.members) bot.claudeWorkerHost?.slotsChanged();
  }

  /** The app's default primary changed: a bot that follows it tells the composer. */
  appPrimaryChanged(): void {
    if (!this.options.primary && !this.headsSettings.answerWith && hasTwo(this.headsSettings)) this.headsChanged();
  }

  headsChanged(): void {
    if (this.options.primary) return this.options.primary.headsChanged();
    this.options.emit({ type: "heads.updated", botId: this.id, heads: this.headsView() });
  }

  updated() {
    this.emit({ type: "bot.updated", bot: this.view() });
  }

  get shownTurn(): Turn | null {
    return this.turn && this.turn.origin !== "tidy" ? this.turn : null;
  }

  snapshot(): ChatSnapshot {
    const turns = this.members.map(bot => bot.shownTurn).filter((turn): turn is Turn => !!turn);
    const shown = turns[0];
    const owner = (turn: Turn) => this.members.find(bot => bot.shownTurn === turn)!;
    // Only the newest page of the chat: the renderer asks for older lines (`history`) when it needs them.
    const page = pageBack(this.records, this.records.length, (record) => this.messageView(record));
    return {
      botId: this.id,
      messages: page.views,
      ...(page.start > 0 ? { history: { hasMore: true, older: page.start } } : {}),
      running: shown ? { turnId: shown.id, messageId: shown.messageId } : null,
      live: shown ? shown.steps.slice(-500).map((step) => stepView(step, owner(shown).subagents)) : [],
      routines: this.chatRoutines(),
      runs: turns.map((turn) => ({ turnId: turn.id, messageId: turn.messageId, head: owner(turn).engine, live: turn.steps.slice(-500).map((step) => stepView(step, owner(turn).subagents)) })),
      heads: this.headsView(),
    };
  }

  /** Its routines for the chat's scheduled work (a partner's are its primary's); none while they cannot be read. */
  chatRoutines(): RoutineView[] {
    try { return this.owner.routinesView().routines; } catch { return []; }
  }

  /** A page of lines older than `before` (`chat.history`); with `until`, back to at least that line. */
  history(before: string, bytes?: number, until?: string): ResultOf<"chat.history"> {
    const end = this.records.findIndex((record) => record.id === before);
    if (end < 0) throw new ContractError("not_found", "That line is no longer in the chat.");
    const view = (record: ChatRecord) => this.messageView(record);
    let page = pageBack(this.records, end, view, Math.min(bytes ?? PAGE_BYTES, MAX_PAGE_BYTES));
    let found = false;
    if (until) {
      const at = this.records.findIndex((record) => record.id === until);
      found = at >= 0 && at < end;
      if (found && at < page.start) page = sliceViews(this.records, at, end, view);
    }
    return { messages: page.views, hasMore: page.start > 0, older: page.start, found };
  }

  /** What a plugin may read of this chat (`chat.messages`): its newest `limit` lines as kept. */
  pluginChat(limit: number) {
    return {
      botId: this.id, name: this.profile.name, unread: this.unread, messages: this.records.slice(-limit),
      // Task cards were removed in 2.5; kept empty for plugins that still read it.
      tasks: [],
    };
  }

  async taskOutput(messageId: string, taskId: string): Promise<ResultOf<"task.output">> {
    // One of its routines in the background-work row (`routineChips`): what it does, when, and where it is kept.
    if (taskId.startsWith("routine:")) {
      const routine = this.chatRoutines().find((candidate) => `routine:${candidate.id}` === taskId);
      if (!routine) return { text: "" };
      const where = routine.kind === "legacy" ? join(this.owner.profile.folder, this.owner.paths.routines) : this.routineStorePath;
      const zone = routine.timezone === "system_local" ? "" : ` (${routine.timezone})`;
      return { text: [`Botling routine · ${routine.schedule}${zone}`, routine.task, where ? `Kept in ${where}` : ""].filter(Boolean).join("\n") };
    }
    const record = this.records.find((message) => message.id === messageId);
    const task = Array.isArray(record?.backgroundTasks) ? (record.backgroundTasks as (BackgroundTask | null)[]).find((task) => task?.id === taskId) : undefined;
    if (!task) return { text: "" };
    const subagent = this.members.map(bot => bot.subagents.get(taskId)).find(Boolean);
    // The recent steps of an agent are read from its file (its memory tail is empty after a restart).
    const withSteps = subagent && !subagent.steps.length && subagent.stepCount ? { ...subagent, steps: this.members.find(bot => bot.subagents.get(taskId))?.subagentHistory(subagent).steps.slice(-4) ?? [] } : subagent;
    return { text: await backgroundTaskOutput(task, withSteps) };
  }

  /** `who`: the names the registry gives when another bot owns it (its owner, and this bot as its host). */
  subagentView(id: string, who?: { owner: string; host: string | null }): ResultOf<"subagent.view"> {
    const subagent = this.subagents.get(id);
    if (!subagent) {
      const peer = this.peers.find(bot => bot.subagents.get(id));
      if (peer) return peer.subagentView(id, who);
      throw new ContractError("not_found", "No such subagent.");
    }
    // Opened: its steps are read from its file now, not kept in memory.
    const view = subagentView(subagent, who?.owner ?? this.speaker, this.subagents, this.engine, this.subagentHistory(subagent));
    return { subagent: who?.host ? { ...view, host: who.host.slice(0, 200) } : view };
  }

  /** A chat line or relay already posted for this move key (notices are sent once per move). */
  hasMoveNotice(key: string): boolean {
    const records = this.owner.records;
    for (let i = records.length - 1, seen = 0; i >= 0 && seen < 2_000; i--, seen++) if (records[i]!.moveNotice === key) return true;
    return false;
  }

  subagentHistory(subagent: SubagentRecord): SubagentHistory {
    try { return this.store.readSubagentSteps(subagent.id); }
    catch (error) { this.log(`subagent ${subagent.id} steps cannot be read: ${String(error)}`); return { runs: [], steps: subagent.steps }; }
  }

  /** "garden · Codex" in a bot with two heads; else its name. */
  get speaker(): string {
    return this.sharesChat ? `${this.profile.name} · ${displayName(this.engine)}` : this.profile.name;
  }
}
