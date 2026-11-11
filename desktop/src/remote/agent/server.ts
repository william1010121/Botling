// `botling-agent`'s core: the machine's side of spec/models/remoteworker/RemoteWorker.tla. It keeps each worker
// session's state on the machine's disk (the event log, the newest connection seen, the tool requests, the session
// lock) and runs claude for it. Transport-free: a link (one ssh process's stdio, or one relay channel) hands it
// frames (`AgentLink.recv`) and says when it ended (`AgentLink.closed`, the model's Notice).
//
// With ssh every connection is a new agent process, so what must hold across connections is on disk:
//   <home>/sessions/<s>/log.jsonl    the event log (the model's `log`), one LogEntry per line, numbered from 1
//   <home>/sessions/<s>/state.json   {seen (aseen), runs, nextReq, startAt}
//   <home>/sessions/<s>/reqs.json    the tool requests (the model's `req`, `reqBy`)
//   <home>/sessions/<s>/lock.json    the session lock: the agent process that owns the session and its claude's pid
// An older agent process that still runs (its ssh connection not noticed yet) loses the lock to the newer one, which
// ends its claude first (never two claude processes on one session); from then on it logs and answers nothing.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HeadConfig, HeadHandlers } from "../../core/agent/head";
import type { StreamItem } from "../../core/agent/stream";
import { validSession, type DownFrame, type LogEntry, type RemoteExit, type RunSpec, type UpFrame, type BlobFrame, BLOB_CHUNK } from "../protocol";

/** What the agent needs of a claude process (ClaudeHead on the machine; a scripted one in tests). */
export interface AgentClaude {
  readonly pid: number;
  start(): void;
  send(text: string, uuid: string): void;
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): void;
  finish(): void;
  terminate(graceMs?: number): Promise<unknown>;
}
export type SpawnClaude = (config: HeadConfig, handlers: HeadHandlers, run: { session: string; run: number }) => AgentClaude;

export interface AgentOptions {
  /** ~/.botling-agent */
  home: string;
  version: string;
  /** The SHA-256 of the agent's own bundle (the ssh path uploads when it differs from the app's). */
  sha: string;
  spawn: SpawnClaude;
  /** The head config for this machine (command, environment, folder); default: `machineConfig`. */
  config?(spec: RunSpec): HeadConfig;
  /** Link-level requests (machine info, git sync, upgrade). */
  rpc?(op: string, args: Record<string, unknown>, link: AgentLink): Promise<unknown>;
  /** Ends a claude process tree another agent process left (the session lock); default: process groups. */
  killTree?(pid: number): Promise<void>;
  /** Whether a process lives (default: kill 0). */
  alive?(pid: number): boolean;
  log?(line: string): void;
  /** How long a claude app tool call waits for the app's answer. */
  toolTimeoutMs?: number;
  /** This agent process in the session lock (default its pid; tests run several in one process). */
  id?: number;
}

interface Req { status: "pending" | "applied" | "cancelled"; run: number; nativeId: string; tool: string; input: Record<string, unknown> }
interface SessionState { seen: number; runs: number; nextReq: number; startAt: number }
interface Lock { agent: number; claude: number | null; run: number | null }

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
function writeJson(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

/** A session's files. */
class SessionDisk {
  readonly dir: string;
  constructor(home: string, readonly id: string) {
    this.dir = join(home, "sessions", id);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  private file(name: string) { return join(this.dir, name); }
  state(): SessionState { return { seen: 0, runs: 0, nextReq: 1, startAt: 0, ...readJson<Partial<SessionState>>(this.file("state.json"), {}) }; }
  setState(patch: Partial<SessionState>) { writeJson(this.file("state.json"), { ...this.state(), ...patch }); }
  reqs(): Record<string, Req> { return readJson(this.file("reqs.json"), {}); }
  setReqs(reqs: Record<string, Req>) { writeJson(this.file("reqs.json"), reqs); }
  lock(): Lock | null { return readJson<Lock | null>(this.file("lock.json"), null); }
  setLock(lock: Lock) { writeJson(this.file("lock.json"), lock); }
  log(): LogEntry[] {
    if (!existsSync(this.file("log.jsonl"))) return [];
    const out: LogEntry[] = [];
    for (const line of readFileSync(this.file("log.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { break; } // a torn last line (a crash mid-write) ends the log
    }
    return out;
  }
  append(entry: LogEntry) { appendFileSync(this.file("log.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 }); }
}

interface Run { run: number; head: AgentClaude; stopped: boolean; exited: Promise<void>; exitedResolve(): void }

/** One worker session in this agent process. */
class Session {
  readonly disk: SessionDisk;
  /** The connection this process is on for the session (the model's `agen`; 0: none) and its link. */
  agen = 0;
  link: AgentLink | null = null;
  astream = false;
  /** The claude processes this agent process runs for the session (the model's `alive`, as far as it is ours). */
  alive = new Map<number, Run>();
  log: LogEntry[];
  /** Frames are taken one at a time (the model's AgentRecv is one step even where it waits on a process to end). */
  queue: Promise<void> = Promise.resolve();
  tools = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(home: string, readonly id: string) {
    this.disk = new SessionDisk(home, id);
    this.log = this.disk.log();
  }
}

export class AgentServer {
  private sessions = new Map<string, Session>();
  private get me() { return this.options.id ?? process.pid; }
  constructor(readonly options: AgentOptions) {
    mkdirSync(join(options.home, "sessions"), { recursive: true, mode: 0o700 });
  }

  /** A new link (an ssh process's stdio, a relay channel); `send` writes a frame to the app. */
  connect(send: (frame: UpFrame) => void): AgentLink { return new AgentLink(this, send); }

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) { session = new Session(this.options.home, id); this.sessions.set(id, session); }
    return session;
  }

  /** The claude runs of a session this process runs now (tests, the spec adapter). */
  alive(id: string): number[] { return [...(this.sessions.get(id)?.alive.keys() ?? [])].sort((a, b) => a - b); }
  /** The connection this process is on for the session (the model's `agen`; 0: none). */
  connection(id: string): number { return this.sessions.get(id)?.agen ?? 0; }
  /** The session's event log. */
  logOf(id: string): LogEntry[] { return this.sessions.get(id)?.log ?? new SessionDisk(this.options.home, id).log(); }

  /** A worker frame from `link`: queued behind the session's earlier frames. */
  take(link: AgentLink, frame: DownFrame & { s: string; g: number }): Promise<void> {
    const session = this.session(frame.s);
    const step = session.queue.then(() => this.step(session, link, frame)).catch((error) => this.options.log?.(`session ${frame.s}: ${(error as Error).message}`));
    session.queue = step;
    return step;
  }

  /** The link the session is on ended (the model's Notice): claude stops (phase 1). */
  notice(link: AgentLink): Promise<void> {
    const steps: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.link !== link || session.agen === 0) continue;
      const step = session.queue.then(async () => {
        if (session.link !== link) return;
        session.agen = 0; session.link = null; session.astream = false;
        this.failTools(session, "Botling's connection to this machine ended.");
        await this.stopAll(session);
      });
      session.queue = step;
      steps.push(step);
    }
    return Promise.all(steps).then(() => undefined);
  }

  private async step(session: Session, link: AgentLink, frame: DownFrame & { s: string; g: number }) {
    const { g } = frame;
    const on = g === session.agen && link === session.link;
    switch (frame.t) {
      case "hello": {
        const state = session.disk.state();
        if (g <= state.seen) return; // an older connection's hello: dropped
        session.disk.setState({ seen: g });
        session.agen = g; session.link = link; session.astream = false;
        session.log = session.disk.log(); // another agent process may have written since
        link.send({ t: "hi", s: session.id, g, v: this.options.version, sha: this.options.sha });
        return;
      }
      case "attach": {
        if (!on) return;
        await this.lock(session);
        session.astream = true;
        session.log = session.disk.log();
        const from = Math.max(0, Math.min(frame.from, session.log.length));
        for (let n = from + 1; n <= session.log.length; n++) link.send({ t: "ev", s: session.id, g, n, e: session.log[n - 1]! });
        link.send({ t: "attached", s: session.id, g });
        return;
      }
      case "start": {
        if (!on) return;
        const state = session.disk.state();
        const run = state.runs + 1;
        session.disk.setState({ runs: run, startAt: session.log.length });
        await this.lock(session);
        session.astream = true;
        if (frame.v !== this.options.version) {
          // Never claude under an agent of another version than the app that started it (the app upgrades first).
          this.append(session, { t: "done", exit: { code: null, signal: null, stderr: `botling-agent ${this.options.version} does not run work from Botling ${frame.v}.`, expected: false, silent: true } });
          return;
        }
        this.spawn(session, run, frame.run);
        return;
      }
      case "answer": {
        const reqs = session.disk.reqs();
        const req = reqs[frame.k];
        const current = on && session.disk.state().seen === g && this.owns(session);
        const run = req ? session.alive.get(req.run) : undefined;
        if (current && req?.status === "pending" && run && !run.stopped) {
          reqs[frame.k] = { ...req, status: "applied" };
          session.disk.setReqs(reqs);
          run.head.answer(req.nativeId, frame.allow, frame.input, frame.message);
          this.append(session, { t: "ans", k: frame.k, allow: frame.allow });
        } else {
          // Not from the connection it is on, or no running claude waits for it: refused, the app's card opens again.
          link.send({ t: "refused", s: session.id, g, k: frame.k });
        }
        return;
      }
      case "cancel": {
        if (!on) return;
        await this.stopAll(session);
        if (!this.ended(session)) this.append(session, { t: "cancelled" });
        return;
      }
      case "send": {
        if (!on) return;
        this.latest(session)?.head.send(frame.text, frame.uuid);
        return;
      }
      case "finish": {
        if (!on) return;
        this.latest(session)?.head.finish();
        return;
      }
      case "toolResult": {
        if (!on) return;
        const waiting = session.tools.get(frame.id);
        if (!waiting) return;
        session.tools.delete(frame.id);
        clearTimeout(waiting.timer);
        if (frame.ok) waiting.resolve(frame.result); else waiting.reject(new Error(frame.error || "The app tool failed."));
        return;
      }
      default:
        return;
    }
  }

  private latest(session: Session): Run | undefined {
    const runs = [...session.alive.values()].filter((r) => !r.stopped);
    return runs[runs.length - 1];
  }

  /** Whether this process holds the session's lock (another agent process may have taken it since). */
  private owns(session: Session): boolean {
    const lock = session.disk.lock();
    return !lock || lock.agent === this.me;
  }

  /** The run's claude ended or the session moved on: what started since the last start has ended. */
  private ended(session: Session): boolean {
    const { startAt } = session.disk.state();
    return session.log.slice(startAt).some((e) => e.t === "done" || e.t === "cancelled");
  }

  /**
   * The session lock: every claude running the session stops (ours, and one another agent process left) before this
   * process takes it (the model's `alive' = {}` on attach, and before a start).
   */
  private async lock(session: Session) {
    const held = session.disk.lock();
    session.disk.setLock({ agent: this.me, claude: null, run: null });
    await this.stopAll(session);
    if (held && held.agent !== this.me && held.claude && (this.options.alive ?? pidAlive)(held.claude)) {
      await (this.options.killTree ?? killTree)(held.claude);
    }
  }

  private async stopAll(session: Session) {
    const runs = [...session.alive.values()];
    for (const run of runs) run.stopped = true;
    await Promise.all(runs.map(async (run) => {
      try { await run.head.terminate(1_500); } catch { /* it is gone */ }
      session.alive.delete(run.run);
    }));
  }

  private spawn(session: Session, run: number, spec: RunSpec) {
    const config = (this.options.config ?? machineConfig)(spec);
    let exitedResolve!: () => void;
    const exited = new Promise<void>((resolve) => (exitedResolve = resolve));
    const entry = {} as Run;
    const head = this.options.spawn(config, {
      onItem: (item) => this.onItem(session, entry, item),
      onExit: (exit) => this.onExit(session, entry, exit),
      onAppTool: (name, args) => this.appTool(session, entry, name, args),
    }, { session: session.id, run });
    Object.assign(entry, { run, head, stopped: false, exited, exitedResolve } satisfies Run);
    session.alive.set(run, entry);
    head.start();
    if (head.pid > 0) session.disk.setLock({ agent: this.me, claude: head.pid, run });
    head.send(spec.words, spec.uuid);
  }

  private current(session: Session, run: Run) {
    return session.alive.get(run.run) === run && !run.stopped && this.owns(session);
  }

  private onItem(session: Session, run: Run, item: StreamItem) {
    if (!this.current(session, run)) return;
    if (item.kind === "permission") {
      const reqs = session.disk.reqs();
      // A resumed run asking what an ended run asked (claude gives it a new tool_use_id) is the same request.
      const again = Object.entries(reqs).find(([, r]) => r.status === "pending" && r.run !== run.run && !session.alive.has(r.run) && r.tool === item.tool && sameJson(r.input, item.input));
      let k: string;
      if (again) k = again[0];
      else {
        const state = session.disk.state();
        k = `q${state.nextReq}`;
        session.disk.setState({ nextReq: state.nextReq + 1 });
      }
      reqs[k] = { status: "pending", run: run.run, nativeId: item.requestId, tool: item.tool, input: item.input };
      session.disk.setReqs(reqs);
      this.append(session, { t: "ask", k, item: { ...item, requestId: k } });
      return;
    }
    if (item.kind === "permissionCancelled") {
      const reqs = session.disk.reqs();
      const found = Object.entries(reqs).find(([, r]) => r.run === run.run && r.nativeId === item.requestId && r.status === "pending");
      if (!found) return;
      reqs[found[0]] = { ...found[1], status: "cancelled" };
      session.disk.setReqs(reqs);
      this.append(session, { t: "out", item: { kind: "permissionCancelled", requestId: found[0] } });
      return;
    }
    this.append(session, { t: "out", item });
  }

  private onExit(session: Session, run: Run, exit: Parameters<HeadHandlers["onExit"]>[0]) {
    run.exitedResolve();
    const ours = this.current(session, run);
    if (session.alive.get(run.run) === run && !run.stopped) session.alive.delete(run.run);
    if (!ours) return;
    const done: RemoteExit = { code: exit.code, signal: exit.signal, stderr: exit.stderr.slice(-4_000), expected: exit.expected, silent: exit.silent };
    this.append(session, { t: "done", exit: done });
  }

  private appTool(session: Session, run: Run, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.current(session, run) || !session.link || !session.astream) return Promise.reject(new Error("Botling is not connected to this machine right now; say it in your final report instead."));
    const id = randomUUID();
    const link = session.link;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.tools.delete(id); reject(new Error("Botling did not answer the app tool in time.")); }, this.options.toolTimeoutMs ?? 10 * 60_000);
      timer.unref?.();
      session.tools.set(id, { resolve, reject, timer });
      link.send({ t: "tool", s: session.id, g: session.agen, id, name, args });
    });
  }

  private failTools(session: Session, reason: string) {
    for (const [id, waiting] of session.tools) { clearTimeout(waiting.timer); waiting.reject(new Error(reason)); session.tools.delete(id); }
  }

  /** An event into the session's log, and onto the connection it is on once that asked for the stream. */
  private append(session: Session, entry: LogEntry) {
    session.disk.append(entry);
    session.log.push(entry);
    if (session.agen !== 0 && session.astream && session.link) {
      session.link.send({ t: "ev", s: session.id, g: session.agen, n: session.log.length, e: entry });
    }
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((session) => this.stopAll(session)));
  }
}

/** One link to the app. Blob chunks it receives are kept until their rpc takes them. */
export class AgentLink {
  private blobs = new Map<string, { chunks: Buffer[]; done: boolean; waiters: ((data: Buffer) => void)[] }>();
  private ended = false;
  constructor(private server: AgentServer, private writer: (frame: UpFrame) => void) {}

  send(frame: UpFrame) { if (!this.ended) { try { this.writer(frame); } catch { /* the link is going */ } } }

  recv(frame: Record<string, unknown> & { t: string }): Promise<void> {
    if (frame.t === "blob") { this.blob(frame as unknown as BlobFrame); return Promise.resolve(); }
    if (frame.t === "rpc") return this.rpc(frame as unknown as Extract<DownFrame, { t: "rpc" }>);
    if (!validSession(frame.s) || !Number.isSafeInteger(frame.g) || (frame.g as number) < 1) return Promise.resolve();
    return this.server.take(this, frame as unknown as DownFrame & { s: string; g: number });
  }

  /** The link ended (stdin closed, the channel gone): the model's Notice for the sessions on it. */
  closed(): Promise<void> { this.ended = true; return this.server.notice(this); }
  get isClosed() { return this.ended; }

  private async rpc(frame: Extract<DownFrame, { t: "rpc" }>) {
    const rpc = this.server.options.rpc;
    try {
      if (!rpc) throw new Error(`Unknown request ${frame.op}.`);
      const result = await rpc(frame.op, frame.args ?? {}, this);
      this.send({ t: "rpcResult", id: frame.id, ok: true, result });
    } catch (error) {
      this.send({ t: "rpcResult", id: frame.id, ok: false, error: (error as Error).message });
    }
  }

  private blobEntry(id: string) {
    let entry = this.blobs.get(id);
    if (!entry) { entry = { chunks: [], done: false, waiters: [] }; this.blobs.set(id, entry); }
    return entry;
  }

  private blob(frame: BlobFrame) {
    if (typeof frame.id !== "string" || typeof frame.data !== "string") return;
    const entry = this.blobEntry(frame.id);
    entry.chunks.push(Buffer.from(frame.data, "base64"));
    if (frame.end) {
      entry.done = true;
      const data = Buffer.concat(entry.chunks);
      for (const waiter of entry.waiters.splice(0)) waiter(data);
    }
  }

  /** The blob the app sent under `id` (waits for its last chunk). */
  takeBlob(id: string, timeoutMs = 10 * 60_000): Promise<Buffer> {
    const entry = this.blobEntry(id);
    if (entry.done) { this.blobs.delete(id); return Promise.resolve(Buffer.concat(entry.chunks)); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The file did not arrive in time.")), timeoutMs);
      timer.unref?.();
      entry.waiters.push((data) => { clearTimeout(timer); this.blobs.delete(id); resolve(data); });
    });
  }

  /** Sends a file to the app in chunks; returns its id. */
  sendBlob(data: Buffer): string {
    const id = randomUUID();
    if (!data.length) { this.send({ t: "blob", id, seq: 0, data: "", end: true }); return id; }
    for (let at = 0, seq = 0; at < data.length; at += BLOB_CHUNK, seq++) {
      this.send({ t: "blob", id, seq, data: data.subarray(at, at + BLOB_CHUNK).toString("base64"), ...(at + BLOB_CHUNK >= data.length ? { end: true } : {}) });
    }
    return id;
  }
}

/**
 * The head's config made for this machine: claude from this machine's PATH (or BOTLING_AGENT_CLAUDE), this agent's
 * environment, the worker's folder here. What only made sense on the app's computer is dropped (its plugin and added
 * folders, the site tools folder); every tool request is asked (no auto mode, no bypass, no allow rules: the app's
 * checks look at its own paths, not this machine's).
 */
export function machineConfig(spec: RunSpec, claude: { command?: string; args?: string[] } = {}): HeadConfig {
  const c = spec.config;
  const command = process.env.BOTLING_AGENT_CLAUDE?.trim() || claude.command || "claude";
  const prefix = process.env.BOTLING_AGENT_CLAUDE_ARGS ? JSON.parse(process.env.BOTLING_AGENT_CLAUDE_ARGS) as string[] : claude.args;
  return {
    ...c,
    command,
    prefixArgs: prefix,
    cwd: spec.cwd,
    env: {},
    pluginDirs: [], addDirs: [], siteToolsGuard: null,
    autoMode: false, bypassPermissions: false, allowRules: [],
  };
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Ends a process group another agent process started (claude leads its own group): TERM, then KILL after 2 s. */
export async function killTree(pid: number): Promise<void> {
  const signal = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };
  signal("SIGTERM");
  for (let i = 0; i < 20 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (pidAlive(pid)) signal("SIGKILL");
  for (let i = 0; i < 20 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
}
