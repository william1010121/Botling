// spec/driver/worker-driver.ts on the real WorkerCore (desktop/src/core/worker-core). Translation only: every driver
// method makes the core's own call, and every view is read from the core's ledger record and the real chip
// projection. What stands in for the outside world is kept as plain as the driver allows:
//   - the engine (a WorkerAdapter): its start, stop and recovery answer when the test says so; a run's output is a
//     recorded claude stream-json fixture, translated by the app's own parseLine and ClaudeStreamEvents; its process
//     lives until the run ends, a stop confirms it gone, or it exits on its own;
//   - the coordinator port: "busy" unless the test hands a report over (deliver);
//   - a crash: the old core is dropped (its ledger writes no longer land) and a new one loads the same ledger.
import { ClaudeStreamEvents } from "../src/core/agent/claude-worker-events";
import { parseLine } from "../src/core/agent/stream";
import {
  chipStatus, WorkerCore,
  type CoordinatorPort, type RecoverResult, type RunHandle, type WorkerAdapter, type WorkerLedgerRecord, type WorkerReport, type WorkerStore,
} from "../src/core/worker-core";
import type { WorkerSession, WorkerSpecDriver, WorkerStreams, WorkerView } from "../../spec/driver/worker-driver";
import type { Ack } from "../../spec/reference/worker";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => { resolve = r; }), resolve };
};
/** Lets every microtask chain the last call set off run to its end. */
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

interface Proc { handle: RunHandle; alive: boolean; life: number }

class SpecEngine implements WorkerAdapter {
  readonly kind = "claude-process" as const;
  readonly engine = "claude" as const;
  readonly steersRunning = true;
  procs = new Map<string, Proc[]>();
  starts = new Map<string, Deferred<void>>();
  stops = new Map<string, Deferred<{ cleaned: boolean }>>();
  recovers = new Map<string, Deferred<RecoverResult>>();
  /** Which app life (core) is running: a crash starts the next. */
  life = 0;

  start(record: Readonly<WorkerLedgerRecord>, _words: string, handle: RunHandle) {
    this.procs.set(record.id, [...(this.procs.get(record.id) ?? []), { handle, alive: true, life: this.life }]);
    const started = deferred<void>();
    this.starts.set(record.id, started);
    return started.promise;
  }
  steer() { return true; }
  stop(record: Readonly<WorkerLedgerRecord>) {
    const stopped = deferred<{ cleaned: boolean }>();
    this.stops.set(record.id, stopped);
    return stopped.promise;
  }
  answer() {}
  recover(record: Readonly<WorkerLedgerRecord>) {
    const checked = deferred<RecoverResult>();
    this.recovers.set(record.id, checked);
    return checked.promise;
  }
  async close() {}

  alive(id: string) { return (this.procs.get(id) ?? []).filter((p) => p.alive); }
}

class SpecPort implements CoordinatorPort {
  answers = new Map<string, "taken" | "queued">();
  shows = new Map<string, number>();
  constructor(readonly ack: Ack) {}
  deliver(report: WorkerReport): "taken" | "queued" | "busy" {
    const how = this.answers.get(report.id) ?? "busy";
    if (how === "taken") this.show(report.id, report.run);
    return how;
  }
  show(id: string, run: number) { this.shows.set(`${id}:${run}`, (this.shows.get(`${id}:${run}`) ?? 0) + 1); }
}

class Session implements WorkerSession {
  private engine = new SpecEngine();
  private ids: string[] = [];
  private nextId = "";
  private saved: WorkerLedgerRecord[] = [];
  private port: SpecPort;
  private core: WorkerCore;

  constructor(ack: Ack, private streams: WorkerStreams) {
    this.port = new SpecPort(ack);
    this.core = this.newCore();
  }

  private newCore(): WorkerCore {
    const life = this.engine.life;
    const store: WorkerStore = {
      load: () => structuredClone(this.saved),
      save: (records) => { if (life === this.engine.life) this.saved = structuredClone([...records]); },
    };
    return new WorkerCore({
      store, port: this.port, sink: { item: () => undefined }, adapters: [this.engine], ownerSessionId: () => "spec-coordinator",
      log: () => undefined, newId: () => this.nextId, processStartTime: () => "spec",
    });
  }

  private id(w: number) { return this.ids[w]!; }
  private record(w: number) { return this.core.get(this.id(w))!; }
  private async settle(call: () => unknown) {
    try { const result = call(); if (result instanceof Promise) result.catch(() => undefined); } catch { /* a refusal changes nothing */ }
    await flush();
  }

  async handoff(w: number) {
    this.nextId = `00000000-0000-4000-8000-${String(w + 1).padStart(12, "0")}`;
    this.ids[w] = this.nextId;
    await this.settle(() => this.core.handoff("claude-process", { instructions: `Spec task ${w + 1}.` }));
  }
  async startDone(w: number) {
    const started = this.engine.starts.get(this.id(w));
    this.engine.starts.delete(this.id(w));
    await this.settle(() => started?.resolve());
  }
  async send(w: number) { await this.settle(() => this.core.sendToWorker(this.id(w), "Continue, please.")); }
  async steer(w: number) { await this.settle(() => this.core.sendToWorker(this.id(w), "Also check the folder name.")); }
  async recoverDone(w: number) {
    const id = this.id(w);
    const checked = this.engine.recovers.get(id);
    this.engine.recovers.delete(id);
    const alive = this.engine.alive(id).length > 0;
    await this.settle(() => checked?.resolve(alive ? { state: "blocked", reason: "Its earlier process is still running." } : { state: "clean" }));
  }
  async stopWorker(w: number) { await this.settle(() => this.core.stopWorker(this.id(w))); }
  async cancel(w: number) { await this.settle(() => this.core.cancel(this.id(w))); }
  async stopDone(w: number, ok: boolean) {
    const id = this.id(w);
    const stopped = this.engine.stops.get(id);
    this.engine.stops.delete(id);
    if (ok) for (const p of this.engine.alive(id)) p.alive = false;
    await this.settle(() => stopped?.resolve({ cleaned: ok }));
  }
  async end(w: number, v: "done" | "failed") {
    const proc = this.engine.alive(this.id(w)).at(-1)!;
    const events = new ClaudeStreamEvents();
    for (const line of v === "done" ? this.streams.done : this.streams.failed) {
      for (const item of parseLine(line)) {
        if (item.kind === "init") proc.handle.emit({ type: "session", conversationId: item.sessionId });
        else if (item.kind === "result") {
          proc.handle.emit({ type: "end", end: { how: item.how ?? (item.ok ? "normal" : "error"), finalText: item.ok ? item.text : null, error: item.ok ? null : item.error || item.text || null, detail: item.subtype } });
        } else { const event = events.event(item); if (event) proc.handle.emit(event); }
      }
    }
    if (v === "failed") proc.handle.emit({ type: "end", end: { how: "exited", finalText: null, error: "The worker's process ended before its report.", detail: "signal SIGKILL" } });
    proc.alive = false;
    await flush();
  }
  async exit(w: number) {
    for (const p of this.engine.alive(this.id(w))) {
      p.alive = false;
      // Its exit reaches its own run's handle, if that core still lives; the core must drop it.
      if (p.life === this.engine.life) p.handle.emit({ type: "end", end: { how: "exited", finalText: null, error: "exited", detail: "exit 0" } });
    }
    await flush();
  }
  async deliver(w: number, how: "taken" | "queued") {
    this.port.answers.set(this.id(w), how);
    await this.settle(() => this.core.redeliver());
    this.port.answers.delete(this.id(w));
  }
  async beginReport(w: number) {
    const { id, run } = this.record(w);
    await this.settle(() => { if (this.core.beginReport(id, run)) this.port.show(id, run); });
  }
  async finishReport(w: number, completed: boolean) { const { id, run } = this.record(w); await this.settle(() => this.core.finishReport(id, run, completed)); }
  async retryUncertain(w: number) { const { id, run } = this.record(w); await this.settle(() => this.core.retryUncertain(id, run)); }
  async checkpoint(w: number) {
    const { id, run } = this.record(w);
    await this.settle(() => this.core.checkpoint({ task_id: id, run, outcome: "complete", evidence: "The spec test read the report." }));
  }
  async setOwner(w: number) { await this.settle(() => this.core.setWorkerOwner(this.id(w), { botId: "spec-other-bot", name: "Other", agentId: "spec-agent" })); }
  async crash() {
    this.engine.life += 1;
    this.engine.starts.clear();
    this.engine.stops.clear();
    this.engine.recovers.clear();
    // The coordinator's port lives on (what it was shown stays counted).
    this.core = this.newCore();
    await flush();
  }

  view(w: number): WorkerView | null {
    const id = this.ids[w];
    const r = id ? this.core.get(id) : undefined;
    if (!id || !r) return null;
    const ops = (this.core as unknown as { ops: Map<string, unknown> }).ops;
    const current = r.status === "running" ? this.engine.alive(id).find((p) => p.handle.run === r.run && p.life === this.engine.life) : undefined;
    return {
      status: r.status, run: r.run, report: r.report.state, attempts: r.report.attempts, cleanup: r.cleanup ?? "none",
      recovery: r.recovery === "required", owned: !!r.owner, chip: chipStatus(r), busy: ops.has(id),
      stale: this.engine.alive(id).some((p) => p !== current), shown: this.port.shows.get(`${id}:${r.run}`) ?? 0,
    };
  }

  async close() { await this.core.close(); }
}

export const workerDriver: WorkerSpecDriver = {
  async open({ ack, streams }) { return new Session(ack, streams); },
};
