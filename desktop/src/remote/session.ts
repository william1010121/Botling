// The app's side of one remote worker session (spec/models/remoteworker/RemoteWorker.tla, the app's variables and
// actions under their names): its connections to the machine (`gen`, `conn`), the worker (`w`, `sweep`), the chat's
// last event (`got`) and the tool request cards. Transport-free: a SessionTransport opens connection g (an ssh
// process, a stream over the relay channel) and hands frames back; the machine's trust comes from the MachineStore.
//
// In the app the session drives itself (`auto`): it connects when the worker needs its machine (to start, to resume
// after a lost connection, to sweep up after a cancel while away), upgrades an older agent, reconnects with backoff.
// The spec adapter turns `auto` off and takes each step by hand.
import { randomUUID } from "node:crypto";
import type { StreamItem } from "../core/agent/stream";
import { AGENT_PROTOCOL, type DownFrame, type LogEntry, type RemoteExit, type RunSpec, type UpFrame } from "./protocol";

export type Conn = "down" | "hello" | "upgrade" | "attach" | "up";
export type WorkerState = "none" | "running" | "interrupted" | "cancelling" | "done" | "cancelled";
export type CardState = "none" | "open" | "sent" | "settled" | "closed";
type Permission = Extract<StreamItem, { kind: "permission" }>;
export interface Card { state: CardState; live: boolean; noted: boolean; tries: number; item: Permission }

/** One connection to the machine for this session. Link frames (rpc, blobs) are the transport's. */
export interface SessionLink {
  send(frame: DownFrame): void;
  close(): void;
  rpc(op: string, args: Record<string, unknown>): Promise<unknown>;
  sendBlob(data: Buffer): string;
  takeBlob(id: string): Promise<Buffer>;
}
export interface LinkHandlers {
  frame(frame: UpFrame): void;
  /** The connection ended (`error`: why, when it is worth saying). */
  closed(error?: string): void;
}
export interface SessionTransport {
  open(session: string, gen: number, handlers: LinkHandlers): SessionLink;
  /** Replaces the agent there with the app's version (ssh: uploads it; relay: the agent updates itself). */
  upgrade(): Promise<void>;
}

/** The machine as the session sees it (MachineStore). */
export interface MachineView { trusted(): boolean; epoch(): number; name(): string }

export interface SessionState { gen: number; got: number; sweep: boolean; started: boolean }

export interface SessionEvents {
  /** An item of the worker's stream, in order (cards included: a permission item opens or reopens one). */
  item(item: StreamItem): void;
  /** Claude's process on the machine ended (done) or the worker was cancelled. */
  exit(exit: RemoteExit): void;
  /** An app tool call claude made on the machine (app_notify_owner, the browser tools). */
  tool?(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** conn / w changed (the worker row shows it). */
  changed?(): void;
}

export interface RemoteSessionOptions {
  id: string;
  machine: MachineView;
  transport: SessionTransport;
  /** The app's version and (ssh) its agent bundle's SHA-256: an agent that differs is upgraded first. */
  version(): string;
  sha?(): string;
  state?: SessionState;
  save?(state: SessionState): void;
  events: SessionEvents;
  /** Before the first start on a connection: make the machine ready (git sync) and give the run's folder there. */
  prepare?(link: SessionLink): Promise<{ cwd: string }>;
  /** Drive itself (connect, upgrade, reconnect); off for the spec adapter. */
  auto?: boolean;
  waits?: number[];
  log?(line: string): void;
}

/** What a card says when the user's answer did not reach the claude that asked. */
export const NOTE_NOT_LIVE = "Your answer was not sent: Botling is not connected to this request on the machine right now. Answer again once the worker is back.";
export const NOTE_REFUSED = "Your answer did not reach the machine before the connection changed; nothing was run. Answer again.";
/** What the resumed claude is told after a lost connection. */
export const RESUME_WORDS = "(App: Botling lost its connection to this machine, so your process was stopped and started again on the same session. Continue the task where you left off; check what is already done before redoing anything.)";

const WAITS = [1_000, 2_000, 5_000, 10_000, 30_000];

export class RemoteSession {
  gen = 0;
  conn: Conn = "down";
  cepoch = 0;
  w: WorkerState = "none";
  sweep = false;
  got = 0;
  cards = new Map<string, Card>();
  /** The connection's link (null: down). */
  link: SessionLink | null = null;
  /** The session exists on the machine (a resume goes on with `--resume`). */
  started = false;
  /** The run to start once connected (the head's config and first words). */
  private spec: Omit<RunSpec, "cwd"> | null = null;
  private cwd: string | null = null;
  /** Words for the run under way that could not be sent (no connection): they go with the resume. */
  private pending: string[] = [];
  /** A new head on a session with history: the tail the replay brings is the last run's, not shown. */
  private quiet = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private preparing = false;
  private closed = false;
  lastError: string | null = null;

  constructor(readonly options: RemoteSessionOptions) {
    const s = options.state;
    if (s) { this.gen = s.gen; this.got = s.got; this.sweep = s.sweep; this.started = s.started; }
  }

  get id() { return this.options.id; }

  /** Whether the worker needs its machine (the model's `Needed`), or a start waits. */
  get needed(): boolean { return this.w === "interrupted" || this.sweep || (this.w === "none" && !!this.spec); }

  private save() { this.options.save?.({ gen: this.gen, got: this.got, sweep: this.sweep, started: this.started }); }
  private changed() { this.options.events.changed?.(); }

  // ---- The worker's lifecycle as the head drives it.

  /** A new run (a new head): start it once connected. On a session with history, attach first (take the lock). */
  begin(spec: Omit<RunSpec, "cwd">) {
    this.spec = spec;
    this.cards.clear();
    this.pending = [];
    if (this.gen > 0) { this.w = "interrupted"; this.quiet = true; this.quietResume = true; } else this.w = "none";
    this.kick();
  }

  /** Words into the run under way (a steer). Away: they wait and go with the resume. */
  send(text: string, uuid: string) {
    if (this.conn === "up" && this.w === "running" && this.link) this.link.send({ t: "send", s: this.id, g: this.gen, text, uuid });
    else this.pending.push(text);
  }

  /** Close claude's input: it finishes and exits (the head goes to sleep). Away: claude was stopped already. */
  finish() {
    if (this.conn === "up" && this.w === "running" && this.link) this.link.send({ t: "finish", s: this.id, g: this.gen });
    else if (this.w === "interrupted") { this.w = "done"; this.closeCards(); this.options.events.exit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
  }

  // ---- The model's app actions.

  /** Connect to a trusted machine (ssh to the host, or a stream over the relay channel). */
  connect(): boolean {
    if (!this.options.machine.trusted() || this.conn !== "down" || this.closed) return false;
    this.gen += 1;
    this.conn = "hello";
    this.cepoch = this.options.machine.epoch();
    this.save();
    const g = this.gen;
    const link = this.options.transport.open(this.id, g, {
      frame: (frame) => this.recv(g, frame),
      closed: (error) => this.dropped(g, error),
    });
    this.link = link;
    link.send({ t: "hello", s: this.id, g, p: AGENT_PROTOCOL });
    this.changed();
    return true;
  }

  /** The agent there is not the app's version: replace it; the connection ends and the app connects again. */
  async upgrade(): Promise<void> {
    if (this.conn !== "upgrade") return;
    const g = this.gen;
    try { await this.options.transport.upgrade(); this.lastError = null; } catch (error) { this.lastError = `Could not update botling-agent on ${this.options.machine.name()}: ${(error as Error).message}`; this.options.log?.(this.lastError); this.failures += 1; }
    if (this.gen !== g || this.conn !== "upgrade") return;
    this.conn = "down";
    const link = this.link;
    this.link = null;
    link?.close();
    this.changed();
    this.kick(this.lastError ? undefined : 0);
  }

  /** The user hands the machine the worker (after the machine is made ready for it). */
  start() {
    if (this.conn !== "up" || this.w !== "none" || !this.spec || !this.link) return;
    this.w = "running";
    this.link.send({ t: "start", s: this.id, g: this.gen, v: this.options.version(), run: { ...this.spec, cwd: this.cwd ?? "" } });
    this.started = true;
    this.save();
    this.changed();
  }

  /** The user answers card k: sent while the run that asked is the one the app is attached to, else refused at once. */
  answer(k: string, allow: boolean, input: Record<string, unknown>, message?: string): boolean {
    const card = this.cards.get(k);
    if (!card || card.state !== "open") return false;
    card.tries += 1;
    if (this.conn === "up" && this.w === "running" && card.live && this.link) {
      card.state = "sent";
      card.noted = false;
      this.link.send({ t: "answer", s: this.id, g: this.gen, k, allow, input, ...(message ? { message } : {}) });
    } else {
      card.noted = true;
      this.reopen(card, NOTE_NOT_LIVE);
    }
    return true;
  }

  /** The user cancels the worker: connected, the agent stops claude; away, cancelled here at once and swept later. */
  cancel() {
    if (this.w === "running") {
      this.w = "cancelling";
      this.link?.send({ t: "cancel", s: this.id, g: this.gen });
    } else if (this.w === "interrupted") {
      this.w = "cancelled";
      this.sweep = true;
      this.closeCards();
      this.unlive();
      this.save();
      this.options.events.exit({ code: null, signal: null, stderr: "", expected: true, silent: false });
      this.kick();
    } else return;
    this.changed();
  }

  /** The machine was revoked: its connection ends now (nothing more is taken from it). */
  revoked() { if (this.conn !== "down") this.cut(); }

  /** The connection ended (network, sleep, the relay, the ssh process). */
  private dropped(g: number, error?: string) {
    if (g !== this.gen || this.conn === "down") return;
    if (error) this.lastError = error;
    this.cut();
  }

  private cut() {
    const link = this.link;
    this.link = null;
    this.conn = "down";
    if (this.w === "running") this.w = "interrupted";
    else if (this.w === "cancelling") {
      this.w = "cancelled";
      this.sweep = true;
      this.closeCards();
      this.options.events.exit({ code: null, signal: null, stderr: "", expected: true, silent: false });
    }
    this.unlive();
    this.save();
    link?.close();
    this.changed();
    this.kick();
  }

  /** The app takes the next frame from the agent on connection g. */
  recv(g: number, m: UpFrame) {
    if (g !== this.gen || this.conn === "down") return;
    if (m.t === "hi" && this.conn === "hello") {
      const sha = this.options.sha?.() ?? "";
      if (m.v !== this.options.version() || (sha && m.sha !== sha)) {
        this.conn = "upgrade";
        this.changed();
        if (this.options.auto) void this.upgrade();
        return;
      }
      if (this.w === "interrupted" || this.sweep) {
        this.conn = "attach";
        this.link?.send({ t: "attach", s: this.id, g, from: this.got });
      } else {
        this.conn = "up";
        this.failures = 0;
        if (this.options.auto) void this.ready();
      }
      this.changed();
      return;
    }
    if (m.t === "ev") {
      if (m.n === this.got + 1) {
        this.got = m.n;
        if (this.quiet && this.conn === "attach") { this.save(); return; }
        this.show(m.e);
        this.save();
      } else if (m.n > this.got + 1) {
        // Never: the agent sends the log in order. Start again from what the chat shows.
        this.options.log?.(`session ${this.id}: event ${m.n} after ${this.got}; reconnecting`);
        this.cut();
      }
      return;
    }
    if (m.t === "attached" && this.conn === "attach") {
      this.conn = "up";
      this.sweep = false;
      this.quiet = false;
      this.failures = 0;
      for (const card of this.cards.values()) {
        if (card.state !== "sent") continue;
        card.state = "open";
        card.noted = true;
        this.reopen(card, NOTE_REFUSED);
      }
      this.save();
      if (this.retiring && !this.sweep) { this.close(); return; }
      if (this.w === "interrupted") {
        if (this.options.auto) void this.resume(g);
        else this.resumeNow(g);
      }
      this.changed();
      return;
    }
    if (m.t === "refused") {
      const card = this.cards.get(m.k);
      if (card?.state === "sent") { card.state = "open"; card.noted = true; this.reopen(card, NOTE_REFUSED); }
      return;
    }
    if (m.t === "tool") {
      const id = m.id;
      void Promise.resolve().then(() => this.options.events.tool?.(m.name, m.args) ?? Promise.reject(new Error(`Unknown app tool ${m.name}.`)))
        .then((result) => this.toolResult(g, id, true, result), (error: Error) => this.toolResult(g, id, false, undefined, error.message));
      return;
    }
  }

  /** Answers an app tool call claude made on the machine. */
  private toolResult(g: number, id: string, ok: boolean, result?: unknown, error?: string) {
    if (g === this.gen && this.conn === "up" && this.link) this.link.send({ t: "toolResult", s: this.id, g, id, ok, ...(ok ? { result } : { error }) });
  }

  /** After `attached`: the interrupted worker goes on (`start` with --resume), once the machine is ready. */
  private async resume(g: number) {
    if (this.options.prepare && this.link && this.cwd === null) {
      try { this.cwd = (await this.options.prepare(this.link)).cwd; } catch (error) { this.prepareFailed(error as Error); return; }
      if (g !== this.gen || this.conn !== "up") return;
    }
    this.resumeNow(g);
  }

  private resumeNow(g: number) {
    if (g !== this.gen || this.conn !== "up" || this.w !== "interrupted" || !this.link) return;
    const spec = this.spec;
    if (!spec) { this.w = "done"; this.options.events.exit({ code: null, signal: null, stderr: "", expected: true, silent: true }); return; }
    const words = [this.quietResume ? spec.words : RESUME_WORDS, ...this.pending.splice(0)].join("\n\n");
    this.quietResume = false;
    this.w = "running";
    this.link.send({ t: "start", s: this.id, g, v: this.options.version(), run: { ...spec, config: { ...spec.config, resume: this.started || spec.config.resume }, words, uuid: randomUUID(), cwd: this.cwd ?? "" } });
    this.started = true;
    this.save();
  }
  /** A new head on a session with history: its own words start the run (not the resume note). */
  private quietResume = false;

  /** Connected and the agent is ours: make the machine ready, then start a waiting run. */
  private async ready() {
    if (this.w !== "none" || !this.spec || this.preparing) return;
    const g = this.gen;
    if (this.options.prepare && this.link) {
      this.preparing = true;
      try { this.cwd = (await this.options.prepare(this.link)).cwd; } catch (error) { this.preparing = false; this.prepareFailed(error as Error); return; }
      this.preparing = false;
      if (g !== this.gen || this.conn !== "up") return;
    }
    this.start();
  }

  private prepareFailed(error: Error) {
    this.lastError = `Could not get ${this.options.machine.name()} ready: ${error.message}`;
    this.options.log?.(this.lastError);
    // A run that never started ends here (its head reports it); a resume tries again on the next connection.
    if (this.w === "none") {
      this.spec = null;
      this.w = "done";
      this.options.events.exit({ code: null, signal: null, stderr: this.lastError, expected: false, silent: true });
      this.link?.close();
      return;
    }
    this.link?.close();
  }

  /** The app shows event e (the next one in sequence). */
  private show(e: LogEntry) {
    switch (e.t) {
      case "ask": {
        const card = this.cards.get(e.k);
        if (!card) {
          this.cards.set(e.k, { state: "open", live: true, noted: false, tries: 0, item: e.item });
          this.options.events.item(e.item);
        } else {
          card.live = true;
          if (card.state === "none") { card.state = "open"; this.options.events.item(e.item); }
        }
        return;
      }
      case "ans": {
        const card = this.cards.get(e.k);
        if (card) { card.state = "settled"; card.live = false; }
        return;
      }
      case "done":
        if (this.w !== "cancelled") this.w = "done";
        this.closeCards();
        this.unlive();
        this.options.events.exit(e.exit);
        this.changed();
        return;
      case "cancelled": {
        const was = this.w;
        this.w = "cancelled";
        this.closeCards();
        this.unlive();
        if (was !== "cancelled") this.options.events.exit({ code: null, signal: null, stderr: "", expected: true, silent: false });
        this.changed();
        return;
      }
      case "out":
        if (e.item.kind === "init") this.started = true;
        this.options.events.item(e.item);
        return;
    }
  }

  private reopen(card: Card, note: string) {
    // After the core took the answer (it removed the card): the card comes back, saying what happened.
    const item: Permission = { ...card.item, summary: `${note}\n\n${card.item.summary}` };
    setTimeout(() => { if (card.state === "open" && !this.closed) this.options.events.item(item); }, 0);
  }

  private closeCards() {
    for (const [k, card] of this.cards) {
      if (card.state !== "open" && card.state !== "sent") continue;
      card.state = "closed";
      this.options.events.item({ kind: "permissionCancelled", requestId: k });
    }
  }
  private unlive() { for (const card of this.cards.values()) card.live = false; }

  // ---- Driving itself.

  /** Connect when needed (now, or after the backoff). */
  private kick(wait?: number) {
    if (!this.options.auto || this.closed || this.conn !== "down" || !this.needed) return;
    clearTimeout(this.timer);
    const waits = this.options.waits ?? WAITS;
    const ms = wait ?? (this.failures === 0 ? 0 : waits[Math.min(this.failures - 1, waits.length - 1)]!);
    this.failures += 1;
    this.timer = setTimeout(() => { this.timer = undefined; if (this.conn === "down" && this.needed) this.connect(); }, ms);
    this.timer.unref?.();
  }

  /** The machine was approved again (or the app came back): try now. */
  wake() { if (this.conn === "down") { this.failures = 0; this.kick(0); } }

  /** Its head is done with it: it closes now, or once a pending sweep is done. */
  retire() {
    this.retiring = true;
    if (!this.sweep) this.close();
  }
  private retiring = false;

  /** The app quits: the connection ends (the agent stops claude); nothing more happens here. */
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    const link = this.link;
    this.link = null;
    if (this.conn !== "down") { this.conn = "down"; if (this.w === "running") this.w = "interrupted"; }
    link?.close();
  }

}
