// BotTasks (M7-S45): session schedules, background tasks, and own-work running checks.
import { ownProcessWorker } from "../agent/workers";
import { backgroundTask, endBackgroundTask, endTask, hasBackgroundWorkRunning, stopBackgroundTasks, type BackgroundKind, type BackgroundTask } from "../background-tasks";
import type { Bot } from "../bot";
import { matchesCancellation, settleSchedules, scheduleDue, type ScheduleCall, type ScheduleCancellation } from "../session-schedules";
import type { ChatRecord } from "../store/records";
import type { SubagentRecord } from "../subagents";
import { BotContext } from "./context";
import type { Turn } from "./types";

export class BotTasks {
  constructor(private readonly host: Bot, private readonly ctx: BotContext = new BotContext(host)) {}

  // ---- Bridge: shared names from `BotContext`, Bot-owned names from `Bot` ----
  private get subagents() { return this.ctx.subagents; }
  private get engine() { return this.ctx.engine; }
  private get records() { return this.host.records; }
  private get turn() { return this.host.turn; }
  private get session() { return this.host.session; }
  private get ownRecords() { return this.host.ownRecords; }
  private get managedPending() { return this.host.managedPending; }
  private get outage() { return this.host.outage; }
  private get steered() { return this.host.steered; }
  private changed(record: ChatRecord) { this.host.changed(record); }
  private checkSettingsHold() { this.host.checkSettingsHold(); }

  /** Session schedule calls waiting for their structured results, and the next due clock. */
  scheduleCalls = new Map<string, ScheduleCall>();
  private scheduleDueAt: number | null = null;

  refreshScheduleDue() {
    const due = [...this.records.flatMap((record) => Array.isArray(record.backgroundTasks) ? record.backgroundTasks as BackgroundTask[] : []), ...(this.turn?.tasks ?? [])]
      .flatMap((task) => { const time = scheduleDue(task); return time === null ? [] : [time]; });
    this.scheduleDueAt = due.length ? Math.min(...due) : null;
  }

  settleSessionSchedules() {
    const now = Date.now();
    if (this.scheduleDueAt === null || now < this.scheduleDueAt) return;
    if (this.turn?.tasks) settleSchedules(this.turn.tasks, now);
    for (const record of this.records) {
      if (Array.isArray(record.backgroundTasks) && settleSchedules(record.backgroundTasks as BackgroundTask[], now)) this.changed(record);
    }
    this.refreshScheduleDue();
  }

  /** Background work the bot itself started in the turn under way (not one of its subagents'), once (`addTask`). */
  addBackgroundTask(id: string, kind: BackgroundKind, title: string) {
    const turn = this.turn;
    const step = turn?.open ? turn.steps.findLast((candidate) => candidate.id === id) : undefined;
    if (!turn || !step || turn.tasks?.some((task) => task.id === id)) return;
    const task = backgroundTask(id, kind, title || this.subagents.get(id)?.description || step.title, step.detail);
    if (kind === "monitor") {
      task.title = `Coordinator monitor: ${task.title}`;
      task.detail = `Owner session: ${this.session.sessionId.toLowerCase()}\n${task.detail ?? ""}`;
      // Claude reports the watch lifecycle, but no independent callback acknowledgement.
      task.monitor = { ownerSession: this.session.sessionId.toLowerCase(), threadId: null, turnId: turn.id,
        execution: "running", callback: "unknown" };
    }
    (turn.tasks ??= []).push(task);
  }

  /** A wake-up or cron job was cancelled: out of the turn under way and of the replies that kept it. */
  cancelScheduled(cancellation: ScheduleCancellation, turn: Turn | null) {
    if (turn?.tasks) turn.tasks = turn.tasks.filter((task) => !matchesCancellation(task, cancellation));
    for (const record of this.records) {
      const tasks = record.backgroundTasks as BackgroundTask[] | undefined;
      if (!Array.isArray(tasks) || !tasks.some((task) => matchesCancellation(task, cancellation))) continue;
      const kept = tasks.filter((task) => !matchesCancellation(task, cancellation));
      if (kept.length) record.backgroundTasks = kept;
      else delete record.backgroundTasks;
      this.changed(record);
    }
  }

  /** A kept task by its call's id: in the turn under way, or in a reply. */
  findTask(id: string): BackgroundTask | undefined {
    return this.turn?.tasks?.find((task) => task.id === id)
      ?? this.records.flatMap((record) => Array.isArray(record.backgroundTasks) ? record.backgroundTasks as BackgroundTask[] : []).find((task) => task.id === id);
  }

  touchTask(id: string) {
    if (this.turn?.tasks?.some((task) => task.id === id)) return;
    const record = this.records.findLast((candidate) => Array.isArray(candidate.backgroundTasks) && (candidate.backgroundTasks as BackgroundTask[]).some((task) => task.id === id));
    if (record) this.changed(record);
  }

  /** Background work a subagent started (the row labels it with the subagent), once. */
  addSubagentTask(ownerId: string, id: string, kind: BackgroundKind, title: string, detail: string) {
    const owner = this.subagents.get(ownerId);
    const call = owner?.steps.findLast((step) => step.id === id);
    this.placeSubagentTask(ownerId, backgroundTask(id, kind, title || call?.title || detail, detail || call?.detail));
  }

  /** Keeps a task of a subagent: in the turn under way, else in the reply that has the subagent's step (or the head's latest). */
  placeSubagentTask(ownerId: string, task: BackgroundTask) {
    const owner = this.subagents.get(ownerId);
    if (!owner || owner.status !== "running" || this.findTask(task.id)) return;
    task.owner = { id: owner.id, label: owner.description || owner.name || owner.type || "Subagent" };
    const turn = this.turn;
    if (turn?.open && turn.origin !== "tidy") { (turn.tasks ??= []).push(task); this.refreshScheduleDue(); return; }
    const target = this.records.findLast((record) => record.steps?.some((step) => step.id === owner.id))
      ?? this.records.findLast((record) => record.role === "bot" && !record.permissionTool && (record.engine ?? "claude") === this.engine);
    if (!target) return;
    target.backgroundTasks = [...(Array.isArray(target.backgroundTasks) ? target.backgroundTasks as BackgroundTask[] : []), task];
    this.changed(target);
    this.refreshScheduleDue();
  }

  /** The subagent is over: its background work went with it, so the row must not keep it running. */
  endSubagentTasks(ownerId: string) {
    const summary = "Ended with its subagent.";
    for (const task of this.turn?.tasks ?? []) if (task.owner?.id === ownerId && task.status === "running") endTask(task, "killed", summary);
    for (const record of this.records) {
      const tasks = Array.isArray(record.backgroundTasks) ? record.backgroundTasks as BackgroundTask[] : [];
      let changed = false;
      for (const task of tasks) if (task.owner?.id === ownerId && task.status === "running") { endTask(task, "killed", summary); changed = true; }
      if (changed) this.changed(record);
    }
    this.refreshScheduleDue();
  }

  /** A background task reported back (`endBackgroundTask`): in the turn under way, or in the reply it belongs to. */
  endBackground(id: string, status: string, summary: string | null) {
    const pending = this.turn?.tasks?.find((task) => task.id === id && task.status === "running");
    if (pending) { endTask(pending, status, summary); return; }
    const record = endBackgroundTask(this.records, id, status, summary);
    if (record) this.changed(record);
    this.checkSettingsHold();
  }

  /** The turn's background work goes in its reply (`message.backgroundTasks = trace.takeTasks()`). */
  keepTasks(turn: Turn, record: ChatRecord | null) {
    const tasks = turn.tasks;
    if (!tasks?.length) return;
    turn.tasks = [];
    // A silent turn keeps them in this head's latest reply.
    const target = record ?? this.records.findLast((candidate) => candidate.role === "bot" && !candidate.permissionTool && (candidate.engine ?? "claude") === this.engine);
    if (!target) return;
    target.backgroundTasks = [...(Array.isArray(target.backgroundTasks) ? target.backgroundTasks as BackgroundTask[] : []), ...tasks];
    if (!record) this.changed(target);
  }

  /** Its process went away: whatever had not reported never will (`stopBackgroundTasks(as: .stopped)`). */
  stopTasks() {
    this.scheduleCalls.clear();
    this.scheduleDueAt = null;
    // Only this head's: a partner head's tasks run in its own process, which goes on.
    const changed = stopBackgroundTasks(this.ownRecords, "stopped");
    for (const record of changed) this.changed(record);
  }

  /** Background work still going that it started not too long ago (sleeping or a restart would end it). */
  get backgroundWorkRunning(): boolean {
    return hasBackgroundWorkRunning(this.ownRecords);
  }

  /**
   * Work in this head's own process that a restart would end: its subagents or workers (hosted ones count,
   * whoever they report to), background tasks it started, or its wait for the network. Never a partner head's.
   */
  get ownWorkRunning(): boolean {
    // Your lines steered into a turn that claude has not read yet count: it still owes them an answer.
    return this.inHeadSubagents.length > 0 || this.managedPending || this.backgroundWorkRunning || !!this.outage || this.steered.size > 0;
  }

  /** Its subagents at work inside its head's process (a Claude worker is a process of its own: a restart or sleep leaves it be). */
  get inHeadSubagents(): SubagentRecord[] {
    return this.subagents.running.filter((subagent) => !ownProcessWorker(subagent.type));
  }
}
