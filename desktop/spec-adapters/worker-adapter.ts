// spec/driver/worker-driver.ts on the real WorkerCore (desktop/src/core/worker-core). Translation only: every driver
// method makes the core's own call, and every view is read from the core's ledger record and the real chip
// projection. What stands in for the outside world is kept as plain as the driver allows:
//   - the engine (a WorkerAdapter): its start, stop and recovery answer when the test says so; a run's output is a
//     recorded claude stream-json fixture, translated by the app's own parseLine and ClaudeStreamEvents; its process
//     lives until the run ends, a stop confirms it gone, or it exits on its own;
//   - the coordinator port: "busy" unless the test hands a report over (deliver);
//   - the coordinator bot: a report it takes (or a report turn it begins) and a note it is handed open a turn, whose
//     route back to the asking bot is the app's CallInWorkBook (desktop/src/core/call-in-work.ts) as bot.ts asks it
//     (relayIfCallInWork); the turn's end is told back as the book decides (relayFollowUp);
//   - a steer: the engine keeps it and answers when the test says so; a missed one follows the WorkerAdapter contract
//     the Codex adapter keeps (eae248aa): only the run that sent it, if not stopped or cancelled, acts on it, and once
//     that run ended its words go back through the core (sendToWorker, as codex.ts `followUp`);
//   - a crash: the old core is dropped (its ledger writes no longer land) and a new one loads the same ledger; the
//     coordinator's turns under way are gone, its call-in work book loads again from the same settings.
import { ClaudeStreamEvents } from "../src/core/agent/claude-worker-events";
import { CallInWorkBook, type CallInRelay, type CallInWork } from "../src/core/call-in-work";
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
  /** Steers not answered yet: the run that sent them, the words, and whether that run was stopped or cancelled since. */
  steers = new Map<string, { run: number; words: string; cancelled: boolean; life: number }>();
  /** Which app life (core) is running: a crash starts the next. */
  life = 0;

  start(record: Readonly<WorkerLedgerRecord>, _words: string, handle: RunHandle) {
    this.procs.set(record.id, [...(this.procs.get(record.id) ?? []), { handle, alive: true, life: this.life }]);
    const started = deferred<void>();
    this.starts.set(record.id, started);
    return started.promise;
  }
  steer(record: Readonly<WorkerLedgerRecord>, words: string) {
    this.steers.set(record.id, { run: record.run, words, cancelled: false, life: this.life });
    return true;
  }
  stop(record: Readonly<WorkerLedgerRecord>) {
    const steer = this.steers.get(record.id);
    if (steer) steer.cancelled = true;
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
  /** The latest run started in this app life. */
  latest(id: string) { return (this.procs.get(id) ?? []).filter((p) => p.life === this.life).at(-1)?.handle.run ?? 0; }
}

/** One turn of the coordinator's on a worker's news, with its route back to the asking bot (bot.ts `Turn.relayTo`). */
interface NewsTurn { id: string; relay: CallInRelay }

/** The coordinator bot's side: the turns it takes on its workers' news, and what goes back to an asking bot. */
class SpecCoordinator {
  settings: { callInWork?: unknown } = {};
  clock = 1_800_000_000_000;
  book = this.newBook();
  turns: NewsTurn[] = [];
  handed = new Map<string, number>();
  posted = new Map<string, number>();
  noted = new Map<string, { n: number; to: "coord" | "other" }>();

  newBook() {
    return new CallInWorkBook({ load: () => structuredClone(this.settings.callInWork), save: (work: Record<string, CallInWork>) => { this.settings.callInWork = structuredClone(work); } }, () => this.clock);
  }
  /** A turn on `id`'s news begins (bot.ts relayIfCallInWork): kept only when it goes back to an asking bot. */
  take(id: string, news: CallInRelay["news"]) {
    const relay = this.book.relay(id, news);
    if (!relay) return;
    this.turns.push({ id, relay });
    this.handed.set(id, (this.handed.get(id) ?? 0) + 1);
  }
  note(id: string, to: "coord" | "other") {
    this.noted.set(id, { n: (this.noted.get(id)?.n ?? 0) + 1, to });
    if (to === "coord") this.take(id, "note");
  }
  /** Turns under way on `id`'s `kind` of news whose route back has not run out, oldest first. */
  live(id: string, kind: CallInRelay["news"]) { return this.turns.filter((turn) => turn.id === id && turn.relay.news === kind && turn.relay.until > this.clock); }
  /** The oldest such turn on `id`'s `kind` of news ends (bot.ts relayFollowUp). */
  end(id: string, kind: CallInRelay["news"], said: boolean) {
    const i = this.turns.indexOf(this.live(id, kind)[0]!);
    if (i < 0) return;
    const [turn] = this.turns.splice(i, 1);
    const told = this.book.followUp(turn!.relay, said ? { status: "done", visible: true } : { status: "failed", visible: false, error: "It could not answer." });
    if (told) this.posted.set(id, (this.posted.get(id) ?? 0) + 1);
  }

}

class SpecPort implements CoordinatorPort {
  answers = new Map<string, "taken" | "queued">();
  shows = new Map<string, number>();
  constructor(readonly ack: Ack, private coordinator: SpecCoordinator) {}
  deliver(report: WorkerReport): "taken" | "queued" | "busy" {
    const how = this.answers.get(report.id) ?? "busy";
    if (how === "taken") { this.show(report.id, report.run); this.coordinator.take(report.id, "report"); }
    return how;
  }
  show(id: string, run: number) { this.shows.set(`${id}:${run}`, (this.shows.get(`${id}:${run}`) ?? 0) + 1); }
}

class Session implements WorkerSession {
  private engine = new SpecEngine();
  private ids: string[] = [];
  private nextId = "";
  private saved: WorkerLedgerRecord[] = [];
  private coordinator = new SpecCoordinator();
  private port: SpecPort;
  private core: WorkerCore;
  /** Workers whose route was linked, oldest link first. */
  private linked: string[] = [];

  constructor(ack: Ack, private streams: WorkerStreams) {
    this.port = new SpecPort(ack, this.coordinator);
    this.core = this.newCore();
  }

  private newCore(): WorkerCore {
    const life = this.engine.life;
    const store: WorkerStore = {
      load: () => structuredClone(this.saved),
      save: (records) => { if (life === this.engine.life) this.saved = structuredClone([...records]); },
    };
    return new WorkerCore({
      store, port: this.port, adapters: [this.engine], ownerSessionId: () => "spec-coordinator",
      // A note of a worker another bot owns goes out as an item the app routes to that owner.
      sink: { item: (item) => { if (life === this.engine.life && item.kind === "workerNote") this.coordinator.note(item.id, "other"); } },
      note: (note) => { if (life === this.engine.life) this.coordinator.note(note.id, "coord"); return true; },
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
    // A report turn begun is the coordinator's turn on that report (bot.ts backgroundTurn).
    await this.settle(() => { if (this.core.beginReport(id, run)) { this.port.show(id, run); this.coordinator.take(id, "report"); } });
  }
  async finishReport(w: number, completed: boolean) { const { id, run } = this.record(w); await this.settle(() => this.core.finishReport(id, run, completed)); }
  async retryUncertain(w: number) { const { id, run } = this.record(w); await this.settle(() => this.core.retryUncertain(id, run)); }
  async checkpoint(w: number) {
    const { id, run } = this.record(w);
    await this.settle(() => this.core.checkpoint({ task_id: id, run, outcome: "complete", evidence: "The spec test read the report." }));
  }
  async setOwner(w: number) { await this.settle(() => this.core.setWorkerOwner(this.id(w), { botId: "spec-other-bot", name: "Other", agentId: "spec-agent" })); }
  async steerBack(w: number, missed: boolean) {
    const id = this.id(w);
    const steer = this.engine.steers.get(id);
    this.engine.steers.delete(id);
    if (!steer || !missed || steer.cancelled || steer.life !== this.engine.life || steer.run !== this.engine.latest(id)) { await flush(); return; }
    // Its run still at work takes the words with its next turn; a run that ended starts the next (codex.ts followUp).
    if (this.record(w).status === "running") { await flush(); return; }
    await this.settle(() => this.core.sendToWorker(id, steer.words));
  }
  async note(w: number) { await this.settle(() => this.core.notifyOwner(this.id(w), { kind: "report", message: "Half of it is done." })); }
  async link(w: number) {
    const id = this.id(w);
    // A little later than now, but before any live route runs out (routes run out in the order they were linked).
    const routes = Object.values((this.coordinator.settings.callInWork ?? {}) as Record<string, CallInWork>).filter((route) => route.until > this.coordinator.clock);
    const gap = Math.min(2_000, ...routes.map((route) => route.until - this.coordinator.clock));
    this.coordinator.clock += gap / 2;
    this.coordinator.book.link(id, "spec-asking-bot", "please deploy it");
    this.linked = [...this.linked.filter((other) => other !== id), id];
    await flush();
  }
  async expire(w: number) {
    const until = (this.coordinator.settings.callInWork as Record<string, CallInWork> | undefined)?.[this.id(w)]?.until;
    if (until !== undefined) this.coordinator.clock = Math.max(this.coordinator.clock, until);
    await flush();
  }
  async turnEnd(w: number, kind: "report" | "note", said: boolean) { this.coordinator.end(this.id(w), kind, said); await flush(); }
  async crash() {
    this.engine.life += 1;
    this.engine.starts.clear();
    this.engine.stops.clear();
    this.engine.recovers.clear();
    this.engine.steers.clear();
    // The coordinator's port lives on (what it was shown stays counted); its turns under way are gone, its settings kept.
    this.coordinator.turns = [];
    this.coordinator.book = this.coordinator.newBook();
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
      steer: this.steerView(id), nsent: this.coordinator.noted.get(id)?.n ?? 0, noted: this.coordinator.noted.get(id)?.to ?? "none",
      link: !this.linked.includes(id) ? "none" : this.coordinator.book.relay(id, "report") ? "live" : "expired",
      relays: this.coordinator.live(id, "report").length, nturns: this.coordinator.live(id, "note").length,
      handed: this.coordinator.handed.get(id) ?? 0, posted: this.coordinator.posted.get(id) ?? 0,
    };
  }

  /** The run whose steer is still awaited and may act on it: not stopped or cancelled since, in this app life. */
  private steerView(id: string) {
    const steer = this.engine.steers.get(id);
    return steer && !steer.cancelled && steer.life === this.engine.life ? steer.run : 0;
  }

  async close() { await this.core.close(); }
}

export const workerDriver: WorkerSpecDriver = {
  async open({ ack, streams }) { return new Session(ack, streams); },
};
