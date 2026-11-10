// spec/driver/worker-process-driver.ts on the real ClaudeWorkerAdapter (desktop/src/core/agent/claude-workers.ts).
// Translation only: every driver method makes the adapter's own call (start, steer, stop, as the worker core makes
// them) or plays what a `claude` process does (its items, its exit). What stands in for the outside world:
//   - a process: a fake ClaudeWorkerHead. Words sent to it are read while its input is open and lost once the app
//     closed it (`finish`); it stays alive after `finish` until the test exits it; reading a steer it says its turn
//     took the words (command_lifecycle "started"), so no settle wait is armed; its tree (children) may outlive its
//     leader, and `gone()` reports that live; `terminate` kills a live leader at once and its tree check (endTree)
//     answers when the test says so;
//   - the core: a run handle per run that records the events the adapter emits (waitingOn, end);
//   - the clock: during each call the app's setTimeout/clearTimeout and Date.now are the session's, so the
//     keep-alive fires when the test says and background work turns 6 hours old when it says.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWorkerAdapter, type ClaudeWorkerHead } from "../src/core/agent/claude-workers";
import type { HeadConfig, HeadHandlers } from "../src/core/agent/head";
import type { RunHandle, WorkerEvent, WorkerLedgerRecord } from "../src/core/worker-core";
import type { WorkerProcessDriver, WorkerProcessSession } from "../../spec/driver/worker-process-driver";
import type { Proc as ProcState, Run, View } from "../../spec/reference/worker-process";

const KEEP_MS = 600_000;
const SIX_HOURS = 6 * 3600_000;
const WORD = /\bw\d+\b/g;

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

interface Handle { run: number; words: string[]; events: WorkerEvent[]; stopped: boolean; threw: boolean }

class Session implements WorkerProcessSession {
  private heads: FakeHead[] = [];
  private handles: Handle[] = [];
  private words = 0;
  private bgIds: string[] = [];
  private bgSince = new Map<string, number>();
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

  /** Runs `call` and its microtasks with the session's clock and timers in place of the app's. */
  private async within(call: () => unknown) {
    const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = this.nextTimer++;
      this.timers.set(id, { fn, ms: ms ?? 0 });
      return { id, unref() { return this; }, ref() { return this; }, hasRef: () => false, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: { id?: number }) => { if (handle?.id !== undefined) this.timers.delete(handle.id); }) as typeof clearTimeout;
    Date.now = () => this.clock;
    try {
      try { const result = call(); if (result instanceof Promise) result.catch(() => undefined); } catch { /* a refusal: what it did is in the view */ }
      await flush();
    } finally {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      Date.now = real.now;
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
    const h: Handle = { run: this.record.run, words: [words], events: [], stopped: false, threw: false };
    this.handles.push(h);
    await this.within(() => {
      try { this.adapter.start(this.record, words, this.handle(h)); } catch (error) { h.threw = true; throw error; }
    });
  }
  async steer() {
    const words = this.word();
    this.current()!.words.push(words);
    await this.within(() => this.adapter.steer(this.record, words));
  }
  async result() { await this.within(() => this.live()?.handlers.onItem({ kind: "result", ok: true, text: "Done.", error: "", subtype: "success" } as never)); }
  async keepAliveFires() {
    const [id, timer] = [...this.timers].find(([, t]) => t.ms === KEEP_MS) ?? [];
    if (id === undefined) return;
    this.timers.delete(id);
    await this.within(() => timer!.fn());
  }
  async bgStart() {
    const id = `bg${this.bgSince.size + 1}`;
    this.bgIds.push(id);
    this.bgSince.set(id, this.clock);
    await this.within(() => this.live()?.handlers.onItem({ kind: "backgroundStarted", id, description: `Spec command ${id}`, monitor: false }));
  }
  async bgEnd() {
    const id = this.fresh().at(-1)!;
    this.bgIds = this.bgIds.filter((other) => other !== id);
    await this.within(() => this.live()?.handlers.onItem({ kind: "subagentEnded", id, status: "completed", summary: null }));
  }
  async age() { this.clock += SIX_HOURS; await flush(); }
  async procExit(tree: boolean) {
    const head = this.live()!;
    this.bgIds = [];
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
    if (this.live()) this.bgIds = [];
    this.pendingTree = tree;
    await this.within(() => this.adapter.stop(this.record));
    this.pendingTree = false;
  }

  private ended(h: Handle) { return h.stopped || h.threw || h.events.some((e) => e.type === "end"); }

  /** Background tasks running that started less than 6 hours ago (the test's world). */
  private fresh() { return this.bgIds.filter((id) => this.clock - this.bgSince.get(id)! < SIX_HOURS); }

  view(): View {
    const head = this.latest();
    const proc: ProcState = !head ? "none" : head.running ? (head.finished ? "closed" : "open") : head.check && !head.check.done ? "exited" : "none";
    const h = this.current();
    const ended = !h || this.ended(h);
    const waiting = h?.events.filter((e): e is Extract<WorkerEvent, { type: "waitingOn" }> => e.type === "waitingOn").at(-1)?.on ?? null;
    const run: Run = ended ? "idle" : waiting ? "held" : "working";
    const read = this.heads.flatMap((x) => x.read);
    const lost = this.heads.flatMap((x) => x.lost);
    let failed = 0;
    let stopped = 0;
    for (const x of this.handles) {
      const unread = x.words.filter((w) => !read.includes(w) && !lost.includes(w)).length;
      if (x.stopped) stopped += unread;
      else if (x.threw || x.events.some((e) => e.type === "end" && e.end.how === "error")) failed += unread;
    }
    return {
      proc, tree: !!head && !head.running && head.treeAlive, run, keep: [...this.timers.values()].some((t) => t.ms === KEEP_MS),
      bg: head?.running ? this.fresh().length : 0,
      checking: proc === "exited", older: this.heads.slice(0, -1).filter((x) => x.check && !x.check.done).length,
      sent: this.words, read: read.length, held: run === "held" ? waiting!.queued : 0, lost: lost.length, failed, stopped,
    };
  }

  async close() { await this.within(() => this.adapter.close()); }
}

export const workerProcessDriver: WorkerProcessDriver = {
  async open() { return new Session(); },
};
