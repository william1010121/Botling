// spec/driver/worker-process-driver.ts on the real ClaudeWorkerAdapter (desktop/src/core/agent/claude-workers.ts).
// Translation only: every driver method makes the adapter's own call (start, steer, stop, as the worker core makes
// them) or plays what a `claude` process does (its items, its exit). What stands in for the outside world:
//   - a process: a fake ClaudeWorkerHead. Words sent to it are read while its input is open and lost once the app
//     closed it (`finish`); it stays alive after `finish` until the test exits it; reading a steer it says its turn
//     took the words (command_lifecycle "started"), so no settle wait is armed; its tree (children) may outlive its
//     leader, and `gone()` reports that live; `terminate` kills a live leader at once and its tree check (endTree)
//     answers when the test says so;
//   - its turns: a turn's result (a report with words of its own, "T<n>", or an error, or an API error that passes:
//     the app tries once more, BOTLING_API_RETRY_MS set to one wait during each call); a wake turn's start (an init
//     item) while a report waits for a Monitor; a Monitor's start (odd ones a Monitor tool call on a command: its
//     toolUse, then the background task; even ones a Monitor on a socket: a background task with `monitor`) and end;
//   - the core: a run handle per run that records the events the adapter emits (waitingOn, end) and whether the
//     core stopped it or the app's close cut it off (the core marks that run interrupted); a run's report words are
//     those of its end's finalText (with its report, or said with its error or its process's end);
//   - the clock: during each call the app's setTimeout/clearTimeout and Date.now are the session's, so the
//     keep-alive and a kept report's timers fire when the test says and background work turns 6 hours old when it
//     says. A Monitor's start is dated so that it runs past the cap and a minute a few ms later (the n-th Monitor n
//     ms after the clock of its start), so its expiry moves the clock by ms only and never ages other background work.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkerAdapter, type ClaudeWorkerHead } from "../src/core/agent/claude-workers";
import { BACKGROUND_WAIT_CAP_MS } from "../src/core/agent/background-cap";
import type { HeadConfig, HeadHandlers } from "../src/core/agent/head";
import type { RunHandle, WorkerEvent, WorkerLedgerRecord } from "../src/core/worker-core";
import type { WorkerProcessDriver, WorkerProcessSession } from "../../spec/driver/worker-process-driver";
import type { Hold, Outcome, Proc as ProcState, Run, View } from "../../spec/reference/worker-process";

const KEEP_MS = 600_000;
const SETTLE_MS = 1_500;
const SIX_HOURS = 6 * 3600_000;
/** A Monitor holds a report this long (claude-workers.ts MONITOR_HOLD_MS). */
const HOLD_MS = BACKGROUND_WAIT_CAP_MS + 60_000;
/** The grace a kept report waits for a Monitor's wake turn (claude-workers.ts monitorWakeGraceMs). */
/** The one wait before an API retry (BOTLING_API_RETRY_MS during the session's calls: one try). */
const RETRY_MS = 7_777;
const graceMs = () => { const ms = Number(process.env.BOTLING_MONITOR_GRACE_MS); return Number.isFinite(ms) && ms > 0 ? ms : 30_000; };
const WORD = /\bw\d+\b/g;
const TEXT = /\bT\d+\b/g;

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; done: boolean }
const deferred = <T>(): Deferred<T> => {
  const d = { done: false } as Deferred<T>;
  d.promise = new Promise<T>((resolve) => { d.resolve = (value) => { d.done = true; resolve(value); }; });
  return d;
};
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

interface FakeHead extends ClaudeWorkerHead {
  running: boolean;
  /** Its input is closed (`finish`). */
  finished: boolean;
  /** Its children outlive its leader. */
  treeAlive: boolean;
  /** Its tree check, from its exit until the test answers it. */
  check?: Deferred<{ killed: number[]; forced: boolean; alive?: boolean }>;
  read: string[];
  lost: string[];
  handlers: HeadHandlers;
  exit(tree: boolean): void;
}

interface Handle {
  run: number; words: string[]; events: WorkerEvent[]; stopped: boolean; threw: boolean;
  /** How many of its events came before its turns' last result (an API retry since then has used the try). */
  resultAt: number;
  /** The app's close cut it off (the core marks it interrupted). */
  interrupted: boolean;
  /** The words of its turns' good results. */
  results: string[];
}
/** What a process left running in the background: a command, or a Monitor. */
interface Task { id: string; monitor: boolean; since: number }

class Session implements WorkerProcessSession {
  private heads: FakeHead[] = [];
  private handles: Handle[] = [];
  private words = 0;
  private texts = 0;
  private tasks: Task[] = [];
  private taskCount = 0;
  private monitors = 0;
  /** A turn began (a wake turn, a Monitor tool call) since the last turn's result. */
  private turnSince = false;
  /** The cap timer of a kept report fired and the app armed the grace instead (a turn under way): it let the report go. */
  private capped = false;
  private wakes = 0;
  private closed = false;
  private clock = 1_800_000_000_000;
  private timers = new Map<number, { fn: () => void; ms: number }>();
  private nextTimer = 1;
  private adapter: ClaudeWorkerAdapter;
  private record: WorkerLedgerRecord;

  constructor() {
    const base: HeadConfig = { command: "claude", cwd: "/spec", sessionId: "coordinator", resume: true, allowedTools: [], model: "sonnet", effort: null };
    const home = mkdtempSync(join(tmpdir(), "spec-worker-process-"));
    this.adapter = new ClaudeWorkerAdapter(
      { base: () => base, cwd: () => home, subagentModel: () => "sonnet", keepAliveMs: KEEP_MS, settleMs: 1_500, home },
      (_config, handlers) => this.newHead(handlers),
    );
    this.record = {
      v: 3, id: "00000000-0000-4000-8000-000000000001", engine: "claude", adapter: "claude-process", name: "spec", instructions: "w0",
      type: null, ownerSessionId: "coordinator", run: 0, status: "running", report: { state: "none", attempts: 0 } as WorkerLedgerRecord["report"],
      conversationId: null, processes: [], createdAt: 0, runStartedAt: null, endedAt: null,
      engineData: { sessionId: "11111111-1111-4111-8111-111111111111", sessionStarted: true },
    };
  }

  private newHead(handlers: HeadHandlers): FakeHead {
    const session = this;
    const head: FakeHead = {
      pid: -1, running: false, finished: false, treeAlive: false, read: [], lost: [], handlers,
      start() { this.running = true; },
      send(text, uuid) {
        const words = text.match(WORD) ?? [];
        if (this.finished || !this.running) { this.lost.push(...words); return; }
        this.read.push(...words);
        // Its turn took the words: said as the CLI does (a steer read into the turn under way).
        handlers.onItem({ kind: "command", id: uuid, state: "started" });
      },
      answer() {},
      finish() { this.finished = true; },
      gone() { return !this.running && !this.treeAlive; },
      async terminate() {
        if (this.running) this.exit(session.pendingTree);
        return this.check ? this.check.promise : { killed: [], forced: false };
      },
      exit(tree) {
        if (!this.running) return;
        this.running = false;
        this.treeAlive = tree;
        this.check = deferred();
        handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false });
      },
    };
    this.heads.push(head);
    return head;
  }

  /** The children a kill's leader exit leaves (Stop's `tree`). */
  private pendingTree = false;

  /** Runs `call` and its microtasks with the session's clock and timers in place of the app's; `since`: what the
   * first clock reading during the call answers (a Monitor's start time). */
  private async within(call: () => unknown, since?: number) {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
    const retryMs = process.env.BOTLING_API_RETRY_MS;
    process.env.BOTLING_API_RETRY_MS = String(RETRY_MS);
    let first = since;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = this.nextTimer++;
      this.timers.set(id, { fn, ms: ms ?? 0 });
      return { id, unref() { return this; }, ref() { return this; }, hasRef: () => false, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: { id?: number }) => { if (handle?.id !== undefined) this.timers.delete(handle.id); }) as typeof clearTimeout;
    Date.now = () => { if (first === undefined) return this.clock; const t = first; first = undefined; return t; };
    try {
      try { const result = call(); if (result instanceof Promise) result.catch(() => undefined); } catch { /* a refusal: what it did is in the view */ }
      await flush();
      if (first !== undefined) throw new Error("the app did not read the clock for the Monitor's start");
    } finally {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      Date.now = real.now;
      if (retryMs === undefined) delete process.env.BOTLING_API_RETRY_MS; else process.env.BOTLING_API_RETRY_MS = retryMs;
    }
  }

  private latest() { return this.heads.at(-1); }
  private live() { const head = this.latest(); return head?.running ? head : undefined; }
  private current() { return this.handles.at(-1); }
  private handle(h: Handle): RunHandle {
    return { workerId: this.record.id, run: h.run, emit: (event) => { h.events.push(event); }, setEngineData: (patch) => { Object.assign(this.record.engineData, patch); } };
  }
  private word() { this.words += 1; return `w${this.words}`; }

  async start() {
    const words = this.word();
    this.record = { ...this.record, run: this.record.run + 1 };
    const h: Handle = { run: this.record.run, words: [words], events: [], stopped: false, threw: false, interrupted: false, results: [], resultAt: 0 };
    this.handles.push(h);
    this.capped = false;
    await this.within(() => {
      try { this.adapter.start(this.record, words, this.handle(h)); } catch (error) { h.threw = true; throw error; }
    });
  }
  async steer() {
    const words = this.word();
    this.current()!.words.push(words);
    await this.within(() => this.adapter.steer(this.record, words));
  }
  async result(ok: boolean) {
    const head = this.live()!;
    const text = `T${++this.texts}`;
    const h = this.current();
    if (ok && h && !this.ended(h)) h.results.push(text);
    if (h) h.resultAt = h.events.length;
    this.turnSince = false;
    await this.within(() => head.handlers.onItem((ok
      ? { kind: "result", ok: true, text, error: "", subtype: "success" }
      : { kind: "result", ok: false, text: "", error: "Spec turn failed.", subtype: "error_during_execution" }) as never));
  }
  async apiError() {
    const head = this.live()!;
    const h = this.current();
    if (h) h.resultAt = h.events.length;
    this.turnSince = false;
    await this.within(() => head.handlers.onItem({
      kind: "result", ok: false, how: "error", text: "", error: "API Error: 529 Overloaded", subtype: "success", apiPassing: true,
    } as never));
  }
  async retryFires() {
    const [id, timer] = [...this.timers].find(([, t]) => t.ms === RETRY_MS) ?? [];
    if (id === undefined) { await flush(); return; }
    this.timers.delete(id);
    await this.within(() => timer!.fn());
  }
  async wakeTurn() {
    const head = this.live()!;
    this.wakes += 1;
    this.turnSince = true;
    await this.within(() => head.handlers.onItem({ kind: "init", sessionId: String(this.record.engineData.sessionId) }));
  }
  async keepAliveFires() {
    const [id, timer] = [...this.timers].find(([, t]) => t.ms === KEEP_MS) ?? [];
    if (id === undefined) return;
    this.timers.delete(id);
    await this.within(() => timer!.fn());
  }
  async bgStart() {
    const id = `bg${++this.taskCount}`;
    this.tasks.push({ id, monitor: false, since: this.clock });
    await this.within(() => this.live()?.handlers.onItem({ kind: "backgroundStarted", id, description: `Spec command ${id}`, monitor: false }));
  }
  async bgEnd() { await this.end(this.tasks.filter((t) => !t.monitor && this.fresh(t)).at(-1)!); }
  async age() { this.clock += SIX_HOURS; await flush(); }
  async monStart() {
    const head = this.live()!;
    const n = ++this.monitors;
    const id = `mon${++this.taskCount}`;
    const since = this.clock - HOLD_MS + n;
    const tool = n % 2 === 1;
    this.tasks.push({ id, monitor: true, since });
    if (tool) {
      this.turnSince = true;
      await this.within(() => head.handlers.onItem({ kind: "toolUse", id, tool: "Monitor", title: "Monitor spec", detail: "", parent: null, input: {} }));
    }
    await this.within(() => head.handlers.onItem({ kind: "backgroundStarted", id, description: `Spec Monitor ${id}`, monitor: !tool }), since);
  }
  async monEnd() { await this.end(this.tasks.filter((t) => this.liveMonitor(t)).sort((a, b) => b.since - a.since)[0]!); }
  async oldEnd() { await this.end(this.tasks.find((t) => t.monitor && !this.liveMonitor(t) && this.fresh(t))!); }
  async monExpire() {
    const oldest = this.tasks.filter((t) => this.liveMonitor(t)).sort((a, b) => a.since - b.since)[0]!;
    this.clock = oldest.since + HOLD_MS;
    const cap = this.holdTimer()?.[2] === "cap";
    await this.fire("cap");
    const h = this.current();
    if (cap && h && !this.ended(h) && this.holdTimer()?.[2] === "grace") this.capped = true;
  }
  async graceFires() { await this.fire("grace"); }

  /** A background task ends. */
  private async end(task: Task) {
    this.tasks = this.tasks.filter((t) => t !== task);
    await this.within(() => this.live()?.handlers.onItem({ kind: "subagentEnded", id: task.id, status: "completed", summary: null }));
  }
  /** The timer of a report kept for a Monitor: on a Monitor's cap, or the grace for its wake turn. */
  private holdTimer(): [number, { fn: () => void; ms: number }, Exclude<Hold, "none">] | undefined {
    const found = [...this.timers].find(([, t]) => t.ms !== KEEP_MS && t.ms !== SETTLE_MS && t.ms !== RETRY_MS);
    return found && [found[0], found[1], found[1].ms === graceMs() ? "grace" : "cap"];
  }
  /** That timer fires, if it is the one armed. */
  private async fire(which: Exclude<Hold, "none">) {
    const timer = this.holdTimer();
    if (!timer || timer[2] !== which) { await flush(); return; }
    this.timers.delete(timer[0]);
    await this.within(() => timer[1].fn());
  }
  async procExit(tree: boolean) {
    const head = this.live()!;
    this.tasks = [];
    await this.within(() => head.exit(tree));
  }
  async treeChecked(ok: boolean) {
    const head = this.latest()!;
    if (ok) head.treeAlive = false;
    await this.within(() => head.check!.resolve({ killed: [], forced: false, ...(head.treeAlive ? { alive: true } : {}) }));
  }
  async olderChecked() {
    const head = this.heads.slice(0, -1).find((h) => h.check && !h.check.done)!;
    await this.within(() => head.check!.resolve({ killed: [], forced: false }));
  }
  async treeGone() { this.latest()!.treeAlive = false; await flush(); }
  async stop(tree: boolean) {
    const h = this.current();
    if (h && !this.ended(h)) h.stopped = true;
    if (this.live()) this.tasks = [];
    this.pendingTree = tree;
    await this.within(() => this.adapter.stop(this.record));
    this.pendingTree = false;
  }
  async appClose(tree: boolean) {
    const h = this.current();
    if (h && !this.ended(h)) h.interrupted = true;
    if (this.live()) this.tasks = [];
    this.closed = true;
    this.pendingTree = tree;
    await this.within(() => this.adapter.close());
    this.pendingTree = false;
  }

  private ended(h: Handle) { return h.stopped || h.threw || h.interrupted || h.events.some((e) => e.type === "end"); }
  private ends(h: Handle) { return h.events.filter((e): e is Extract<WorkerEvent, { type: "end" }> => e.type === "end"); }

  /** A background task started less than 6 hours ago (the test's world). */
  private fresh(t: Task) { return this.clock - t.since < SIX_HOURS; }
  /** A Monitor that still holds a report: started less than the cap and a minute ago. */
  private liveMonitor(t: Task) { return t.monitor && this.clock - t.since < HOLD_MS; }
  /** How a run ended, as the model names it. */
  private outcome(h: Handle): Outcome {
    if (h.threw) return "error";
    if (h.stopped) return "stopped";
    if (h.interrupted) return "interrupted";
    const how = this.ends(h)[0]!.end.how;
    return (how === "normal" ? "report" : how) as Outcome;
  }

  view(): View {
    const head = this.latest();
    const proc: ProcState = !head ? "none" : head.running ? (head.finished ? "closed" : "open") : head.check && !head.check.done ? "exited" : "none";
    const h = this.current();
    const ended = !h || this.ended(h);
    // A run whose words wait for a closing process (a report kept for a Monitor says "monitorRunning", an API retry
    // "apiRetry": still at work).
    const waits = h?.events.filter((e): e is Extract<WorkerEvent, { type: "waitingOn" }> => e.type === "waitingOn") ?? [];
    const on = waits.at(-1)?.on ?? null;
    const waiting = on && on.kind !== "monitorRunning" && on.kind !== "apiRetry" ? on : null;
    const run: Run = ended ? "idle" : waiting ? "held" : "working";
    const read = this.heads.flatMap((x) => x.read);
    const lost = this.heads.flatMap((x) => x.lost);
    let failed = 0;
    let stopped = 0;
    for (const x of this.handles) {
      const unread = x.words.filter((w) => !read.includes(w) && !lost.includes(w)).length;
      if (x.stopped || x.interrupted) stopped += unread;
      else if (x.threw || x.events.some((e) => e.type === "end" && e.end.how === "error")) failed += unread;
    }
    // Report words: what each run's report carried, and what its turns said that it did not.
    let told = 0;
    let dropped = 0;
    let reports = 0;
    for (const x of this.handles) {
      const carried = this.ends(x).flatMap((e) => e.end.finalText?.match(TEXT) ?? []);
      told += carried.length;
      if (this.ended(x)) dropped += x.results.filter((t) => !carried.includes(t)).length;
      reports += this.ends(x).length + (x.stopped ? 1 : 0) + (x.threw ? 1 : 0) + (x.interrupted ? 1 : 0);
    }
    const last = [...this.handles].reverse().find((x) => this.ended(x));
    const timer = this.holdTimer();
    const hold: Hold = timer ? timer[2] : "none";
    const tasks = head?.running ? this.tasks.filter((t) => this.fresh(t)) : [];
    return {
      proc, tree: !!head && !head.running && head.treeAlive, run, keep: [...this.timers.values()].some((t) => t.ms === KEEP_MS),
      bg: tasks.filter((t) => !t.monitor).length, mon: tasks.filter((t) => this.liveMonitor(t)).length,
      old: tasks.filter((t) => t.monitor && !this.liveMonitor(t)).length,
      checking: proc === "exited", older: this.heads.slice(0, -1).filter((x) => x.check && !x.check.done).length,
      sent: this.words, read: read.length, held: run === "held" ? waiting!.queued : 0, lost: lost.length, failed, stopped,
      hold, turn: hold !== "none" && this.turnSince, wakes: this.wakes, capped: !ended && this.capped,
      retry: !ended && [...this.timers.values()].some((t) => t.ms === RETRY_MS),
      tried: !ended && !!h && h.events.slice(h.resultAt).some((e) => e.type === "waitingOn" && e.on?.kind === "apiRetry"),
      kept: h && !ended ? h.results.length : 0, said: this.handles.reduce((n, x) => n + x.results.length, 0), told, dropped,
      runs: this.handles.length, reports, outcome: last ? this.outcome(last) : "none", closed: this.closed,
    };
  }

  async close() { await this.within(() => this.adapter.close()); }
}

export const workerProcessDriver: WorkerProcessDriver = {
  async open() { return new Session(); },
};
