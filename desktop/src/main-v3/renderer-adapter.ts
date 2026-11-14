// Botling 3's window main: what the 2.x renderer is fed (protocol v1 §13, M1 brief §7 risk 6). The renderer stays as
// it is: it asks `chat.snapshot` / `chat.history`, sends contract commands, and applies contract events that carry an
// `epoch` and a gapless `seq` (a new epoch or a gap makes it take a fresh snapshot). This adapter sits between it and
// the front-end link (src/fe-link) and turns the server's streams into exactly that:
//
// - Entries of a bot's log stream → the contract events they are (an entry's kind is the event's type). New 3.x kinds
//   map to events the renderer knows: `turn.interrupted` → `turn.finished{stopped}` with the checkpoint text.
// - `live` frames (the running segment, §9.2) → `turn.delta` when the shown text grows by an append, otherwise one
//   `message.updated` with the whole text so far. Earlier segments of the turn are kept here (or, after a reconnect
//   mid-turn, taken from the reply line's committed text).
// - Snapshots: the server's `chat.snapshot` (a read on the session) gives the bots, settings, plugins…; the chat's lines
//   come from the bot stream's `snap` plus the entries after it, so what the renderer gets matches the events that
//   follow. The adapter keeps a mirror of each followed chat by running the renderer's own reducer (renderer/store.ts
//   `apply`) over every event it emits, so a snapshot is exactly what the renderer would hold at that seq.
// - History: `chat.history` → `history` pages of the bot stream (with `until`, pages are read back to that line).
// - Commands: reads go as `req` (no slot, §11.1); every other command is a slot in the durable outbox. `chat.send`
//   answers once the item is durable (the "waiting" state, §11.2) and shows a pending line in the chat at once; the
//   line is swapped for the real one when the entry carrying its slot arrives (§13.4: no duplicate, no flicker). Other
//   commands answer with their outcome. A pending line shows the "queued" badge only after ~150 ms without an outcome.
// - Connection states (§13.3): shown as one notice line at the end of the shown chat (the renderer has no other place
//   that can say "connecting…" without a renderer change). "connecting", "offline", "catching up" show after a short
//   delay (so a normal attach never flashes); "history restored" and "update required" show at once; "live" removes it.
// - A new epoch (then one harmless `core.swap{phase: null}` event, so the renderer notices it) whenever its view may be
//   wrong: a followed chat was replaced by a new `snap` (reset, hash mismatch, a fallback answer), or the link
//   re-attached after a loss (bots, settings and plugins may have changed meanwhile, as when the 2.x core restarted).
//
// Pure TypeScript over two ports (the link, and the renderer's event sink): no Electron, no Node built-ins.
import {
  EventEnvelope, MESSAGE_TEXT_LIMIT, PROTOCOL_VERSION,
  type Command, type CommandType, type Event, type EventEnvelope as EventEnvelopeT, type MessageView, type ResultOf, type WireError,
} from "../contract";
import {
  BotSnapView, ProtocolEntryEvent, slotKey,
  type ConnectionState, type Cursor, type Entry, type MessageOf, type Outcome, type Slot, type StreamId, type Target,
} from "../protocol";
import type { Clock, ConnModel, FeLinkEvent, OutboxItem, PendingView, StoredCursor } from "../fe-link";
import { apply, type ChatView, type WorkspaceView } from "../renderer/store";

/** What the adapter needs of the front-end link (src/fe-link FeLink has it all). */
export interface LinkPort {
  readonly status: ConnModel;
  /** The server's id from `welcome`. */
  readonly server: string | null;
  on(listener: (event: FeLinkEvent) => void): () => void;
  subscribe(stream: StreamId): void;
  unsubscribe(stream: StreamId): void;
  dropCache(stream: StreamId): Promise<void>;
  submit(target: Target, cmd: Command, basis?: Cursor): Promise<OutboxItem>;
  dismiss(slot: Slot): Promise<void>;
  dismissRestored(): void;
  pending(target?: Target): PendingView[];
  cursor(stream: StreamId): StoredCursor | null;
  request(cmd: Command): Promise<unknown>;
  history(stream: StreamId, before: string, bytes?: number): Promise<MessageOf<"history.page">>;
}

export type AdapterAnswer = { ok: true; result: unknown } | { ok: false; error: WireError };
type Snapshot = ResultOf<"chat.snapshot">;
type ChatSnapshot = NonNullable<Snapshot["chat"]>;

export interface RendererAdapterOptions {
  link: LinkPort;
  /** The renderer port: every event goes to every app window (main's `broadcast`). */
  emit: (envelope: EventEnvelopeT) => void;
  clock: Clock;
  /** A new epoch id (default: random). */
  newEpoch?: () => string;
  /** Bot streams followed at once (the shown one, recently shown ones, and any with pending lines). Default 8. */
  followLimit?: number;
  /** How long a snapshot waits for the bot stream's `snap` before it answers from the server's chat (default 3 s). */
  snapWaitMs?: number;
  /** Before the first attach, how long reads wait for it (default 15 s); later, reads fail at once while detached. */
  firstAttachWaitMs?: number;
  /** "connecting" / "offline" / "catching up" show only after this long (default 400 ms). */
  noticeDelayMs?: number;
  audit?: (text: string) => void;
}

/**
 * Commands that only read (requests on the session, §11.1): no slot, no outcome. `chat.read` and `chat.shown` are
 * idempotent window hints, sent as reads so opening a chat does not write a log entry each time. Anything not listed
 * is a slot (the safe default: a read sent as a slot still answers, from its `cmd.applied` result).
 */
export const READ_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  "chat.snapshot", "chat.history", "chat.read", "chat.shown", "task.output", "subagent.view", "turn.await", "routines.list",
  "results.list", "storage.list", "attachment.file", "link.authorize", "settings.get", "bot.settings", "engine.models", "codex.models",
  "usage.view", "doctor.view", "doctor.run", "mobile.view", "machines.view", "machines.hosts", "waiting.list", "plugins.list", "plugins.store",
  "plugins.web", "plugins.file", "plugins.linkTarget", "plugins.loaded", "plugins.failed", "plugins.notice", "card.image",
  "project.files", "project.preview", "worker.cwd", "agent.targets", "agy.runtime.check", "component.detail",
]);
/** Card answers carry the bot cursor the window showed as `basis` (§11.5). */
const CARD_COMMANDS: ReadonlySet<string> = new Set(["chat.choose", "chat.answer", "chat.ignoreQuestion", "component.approve"]);
const PROTOCOL_KINDS: ReadonlySet<string> = new Set(ProtocolEntryEvent.options.map((option) => option.shape.type.value));

/** The id of the connection-state notice line. */
export const NOTICE_ID = "fe-conn-notice";

const streamOf = (botId: string) => `bot:${botId}` as StreamId;
const botOfStream = (stream: string) => (stream.startsWith("bot:") ? stream.slice(4) : null);
const botIdOf = (cmd: Command): string | null => {
  const value = (cmd as { botId?: unknown }).botId;
  return typeof value === "string" ? value : null;
};

/** A short stable id for a pending line, from its slot (FNV-1a, 64 bits as two 32-bit halves). */
export function pendingLineId(slot: Slot): string {
  const text = slotKey(slot);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `fe-p-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

function randomEpoch(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `v3-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const hhmm = (ms: number | null) => {
  if (ms === null) return "";
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** The words of the notice line for a connection state; null: no notice ("live"). */
export function noticeText(status: ConnModel): string | null {
  switch (status.state) {
    case "live": return null;
    case "connecting": return "Connecting to the Botling server…";
    case "offline": return `Offline${status.asOf !== null ? ` · as of ${hhmm(status.asOf)}` : ""}. New messages wait here and go when the Botling server is back.`;
    case "catching up": return "Catching up…";
    case "history restored": return `This machine's history was restored from a backup${status.restoredAt !== null ? ` (noticed at ${hhmm(status.restoredAt)})` : ""}. Lines after the backup are gone.`;
    case "update required": return `This Botling window needs an update to use the server${status.minFeVersion ? ` (version ${status.minFeVersion} or later)` : ""}. What you write is kept until then.`;
    default: return `Botling server: ${status.state}.`;
  }
}

const IMMEDIATE_NOTICE: ReadonlySet<ConnectionState> = new Set(["history restored", "update required"]);

function wireError(outcome: Outcome): WireError {
  switch (outcome.kind) {
    case "refused": {
      const code = outcome.reason === "changed" || outcome.reason === "turn ended" ? "conflict" : outcome.reason === "invalid" ? "bad_request" : "forbidden";
      return { code, message: `Not sent: ${outcome.reason}${outcome.detail ? ` (${outcome.detail})` : ""}`.slice(0, 2_000) };
    }
    case "cancelled": return { code: "cancelled", message: "Not sent: cancelled." };
    case "skipped": return { code: "cancelled", message: "Not sent: skipped after a restore." };
    default: return { code: "internal", message: "No outcome." };
  }
}

interface LiveOverlay {
  turnId: string;
  seg: number;
  /** Text of the turn's earlier segments. */
  prefix: string;
  /** The current segment. */
  segText: string;
}

interface BotModel {
  botId: string;
  stream: StreamId;
  /** A `snap` was applied: `chat` mirrors the renderer's lines. */
  ready: boolean;
  chat: ChatView;
  /** Message ids the renderer may hold for this chat (lines, history pages, pending lines, notice). */
  known: Set<string>;
  /** Each line's text as the log has it (live text not included), for the live overlay. */
  committed: Map<string, string>;
  /** Running turns this stream told of: turnId → the reply line's id. */
  turns: Map<string, string>;
  live: LiveOverlay | null;
  /** A live view that came before its `turn.started`. */
  liveWaiting: { turnId: string; seg: number; text: string } | null;
  /** A snapshot answered without this stream's snap: the snap, when it comes, makes a new epoch. */
  servedFallback: boolean;
  waiters: Array<() => void>;
  shownAt: number;
}

interface PendingLine { botId: string; id: string; rendered: string }

export class RendererAdapter {
  private epoch: string;
  private seq = 0;
  private readonly newEpoch: () => string;
  private readonly models = new Map<string, BotModel>();
  /** The global parts of the last server snapshot, kept up to date by the events emitted since (the offline answer). */
  private base: Omit<Snapshot, "epoch" | "seq" | "chat"> | null = null;
  /** The server's last chat part per bot (decorations, plugin data, heads… that the log does not carry in M1). */
  private readonly chatBase = new Map<string, ChatSnapshot>();
  private shown: string | null = null;
  private wasAttached = false;
  private everAttached = false;
  /** A snapshot was answered, so the renderer holds an epoch to keep in step with. */
  private served = false;
  private readonly attachWaiters = new Set<() => void>();
  /** Renderer requests waiting for a slot's outcome, by slot key. */
  private readonly waiting = new Map<string, (answer: AdapterAnswer) => void>();
  /** Outcomes no request waited for (yet), by slot key; bounded. */
  private readonly early = new Map<string, OutboxItem>();
  /** Pending lines shown, by slot key; `swapped` once the entry with the slot replaced it. */
  private readonly lines = new Map<string, PendingLine>();
  private readonly swapped = new Set<string>();
  private notice: { botId: string; text: string } | null = null;
  private noticeTimer: unknown;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: RendererAdapterOptions) {
    this.newEpoch = options.newEpoch ?? randomEpoch;
    this.epoch = this.newEpoch();
  }

  /** Starts listening to the link (call before the link dials). */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.link.on((event) => this.onLink(event));
    this.onState(this.options.link.status);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.noticeTimer !== undefined) this.options.clock.clearTimeout(this.noticeTimer);
    for (const resolve of this.waiting.values()) resolve({ ok: false, error: { code: "core_unavailable", message: "The window is closing." } });
    this.waiting.clear();
  }

  /** For tests and diagnostics. */
  get currentEpoch(): string { return this.epoch; }
  get currentSeq(): number { return this.seq; }
  get shownBot(): string | null { return this.shown; }
  followed(): string[] { return [...this.models.keys()]; }

  // -------------------------------------------------------------------------------------------
  // Renderer requests

  async request(cmd: Command): Promise<AdapterAnswer> {
    try {
      if (cmd.type === "chat.snapshot") return { ok: true, result: await this.snapshot(cmd.botId) };
      if (cmd.type === "chat.history") return { ok: true, result: await this.history(cmd) };
      if (cmd.type === "chat.shown" && cmd.botId) this.show(cmd.botId);
      if (READ_COMMANDS.has(cmd.type)) return await this.read(cmd);
      return await this.command(cmd);
    } catch (error) {
      const wire = (error as { wire?: WireError }).wire;
      if (wire) return { ok: false, error: wire };
      return { ok: false, error: { code: "core_unavailable", message: String((error as Error)?.message ?? error).slice(0, 2_000) } };
    }
  }

  private attached(): boolean { return this.options.link.status.attached; }

  /** Resolves once attached (at once when attached); with `ms`, false when that passes first. */
  private whenAttached(ms?: number): Promise<boolean> {
    if (this.attached()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: unknown;
      const done = (value: boolean) => { this.attachWaiters.delete(wake); if (timer !== undefined) this.options.clock.clearTimeout(timer); resolve(value); };
      const wake = () => done(true);
      this.attachWaiters.add(wake);
      if (ms !== undefined) timer = this.options.clock.setTimeout(() => done(false), ms);
    });
  }

  private async read(cmd: Command): Promise<AdapterAnswer> {
    if (!this.attached()) {
      const wait = this.everAttached ? 0 : (this.options.firstAttachWaitMs ?? 15_000);
      if (!wait || !(await this.whenAttached(wait))) return { ok: false, error: { code: "core_unavailable", message: "The Botling server is not connected." } };
    }
    return { ok: true, result: await this.options.link.request(cmd) };
  }

  private async command(cmd: Command): Promise<AdapterAnswer> {
    const botId = botIdOf(cmd);
    let target: Target;
    if (botId) target = streamOf(botId);
    else {
      if (!this.options.link.server) await this.whenAttached();
      target = `srv:${this.options.link.server}` as Target;
    }
    const link = this.options.link;
    if (cmd.type === "chat.send" && botId) {
      // The user moved on: a "history restored" notice and the "not sent" lines of this chat have been seen.
      if (link.status.state === "history restored") link.dismissRestored();
      for (const item of link.pending(target)) if (item.state === "not sent" || item.lost) await link.dismiss(item.slot);
    }
    const basis = botId && CARD_COMMANDS.has(cmd.type) ? link.cursor(target) : null;
    const item = await link.submit(target, cmd, basis ? { logId: basis.logId, seq: basis.seq } : undefined);
    if (cmd.type === "chat.send" && botId) {
      this.reconcile();
      return { ok: true, result: { messageId: pendingLineId(item.slot), turnId: null } };
    }
    const key = slotKey(item.slot);
    return new Promise((resolve) => {
      this.waiting.set(key, resolve);
      // The outcome may already be in (a fast server answered before the submit's promise did).
      const early = this.early.get(key);
      if (early) { this.early.delete(key); this.onOutcome(early); }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Snapshots and history

  async snapshot(botId?: string): Promise<Snapshot> {
    let fresh = false;
    if (this.attached() || !this.base) {
      if (!this.attached()) await this.whenAttached();
      try {
        const answer = await this.options.link.request({ type: "chat.snapshot", ...(botId ? { botId } : {}) }) as Snapshot;
        const { epoch: _epoch, seq: _seq, chat, ...rest } = answer;
        this.base = rest;
        if (chat) this.chatBase.set(chat.botId, chat);
        botId = chat?.botId ?? botId;
        fresh = true;
      } catch (error) {
        if (!this.base) throw error;
      }
    }
    const chatId = botId ?? this.shown ?? this.chatBase.keys().next().value ?? null;
    if (chatId) {
      this.show(chatId);
      const model = this.models.get(chatId);
      if (model && !model.ready && this.attached()) {
        await new Promise<void>((resolve) => {
          const timer = this.options.clock.setTimeout(() => { model.waiters = model.waiters.filter((w) => w !== done); resolve(); }, this.options.snapWaitMs ?? 3_000);
          const done = () => { this.options.clock.clearTimeout(timer); resolve(); };
          model.waiters.push(done);
        });
      }
    }
    const chat = chatId ? this.chatOf(chatId, fresh) : null;
    this.served = true;
    return { ...this.base!, epoch: this.epoch, seq: this.seq, chat };
  }

  /** The chat part of a snapshot: the server's (or the last known) with the lines and runs this adapter mirrors. */
  private chatOf(botId: string, fresh: boolean): ChatSnapshot | null {
    const model = this.models.get(botId);
    const server = this.chatBase.get(botId) ?? null;
    if (!model?.ready) {
      if (!server) return null;
      if (model) model.servedFallback = true;
      return server;
    }
    const mirror = model.chat;
    const runs = fresh && server ? server.runs : (mirror.runs ?? []);
    return {
      ...(server ?? { heads: null }),
      botId,
      messages: mirror.messages,
      ...(mirror.history?.hasMore ? { history: mirror.history } : {}),
      running: fresh && server ? server.running : mirror.running,
      live: fresh && server ? server.live : mirror.live,
      runs,
      heads: server?.heads ?? mirror.heads ?? null,
    } as ChatSnapshot;
  }

  private async history(cmd: Extract<Command, { type: "chat.history" }>): Promise<ResultOf<"chat.history">> {
    if (!this.attached()) throw Object.assign(new Error("not attached"), { wire: { code: "core_unavailable", message: "The Botling server is not connected." } satisfies WireError });
    const stream = streamOf(cmd.botId);
    let before = cmd.before;
    let messages: MessageView[] = [];
    let hasMore = false;
    let older = 0;
    let found = false;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await this.options.link.history(stream, before, cmd.bytes);
      messages = [...page.messages, ...messages];
      hasMore = page.hasMore;
      older = page.older;
      if (cmd.until && page.messages.some((message) => message.id === cmd.until)) found = true;
      if (!cmd.until || found || !page.hasMore || !page.messages.length) break;
      before = page.messages[0].id;
    }
    const model = this.models.get(cmd.botId);
    if (model) for (const message of messages) { model.known.add(message.id); model.committed.set(message.id, message.text); }
    return { messages, hasMore, older, found };
  }

  // -------------------------------------------------------------------------------------------
  // Following bot streams

  /** The chat the renderer shows: followed, and the notice line moves there. */
  private show(botId: string): void {
    if (this.shown !== botId && this.notice) this.removeNotice();
    this.shown = botId;
    this.follow(botId);
    this.renderNotice();
  }

  private follow(botId: string): BotModel {
    let model = this.models.get(botId);
    if (model) { model.shownAt = this.options.clock.now(); return model; }
    model = {
      botId, stream: streamOf(botId), ready: false, chat: emptyChat(botId), known: new Set(), committed: new Map(), turns: new Map(),
      live: null, liveWaiting: null, servedFallback: false, waiters: [], shownAt: this.options.clock.now(),
    };
    this.models.set(botId, model);
    const stream = model.stream;
    // This adapter holds no cache of the stream yet: forget the stored cursor first, so the sub asks for a snap.
    void this.options.link.dropCache(stream).then(() => {
      if (this.models.get(botId) === model) this.options.link.subscribe(stream);
    }, (error) => this.audit(`follow ${stream}: ${String(error)}`));
    this.evict();
    return model;
  }

  private evict(): void {
    const limit = this.options.followLimit ?? 8;
    if (this.models.size <= limit) return;
    const busy = new Set(this.options.link.pending().map((p) => botOfStream(p.slot.target)));
    const candidates = [...this.models.values()].filter((m) => m.botId !== this.shown && !busy.has(m.botId)).sort((a, b) => a.shownAt - b.shownAt);
    for (const model of candidates) {
      if (this.models.size <= limit) break;
      this.models.delete(model.botId);
      this.options.link.unsubscribe(model.stream);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Link events

  private onLink(event: FeLinkEvent): void {
    switch (event.type) {
      case "state": this.onState(event.status); return;
      case "snap": this.onSnap(event.snap); return;
      case "entries": this.onEntries(event.stream, event.entries); return;
      case "live": if (!event.stale) this.onLive(event.stream, event.view); return;
      case "pending": this.reconcile(); return;
      case "outcome": this.onOutcome(event.item); return;
      case "reset": case "dropped": {
        // A snap follows; the model it replaces is gone now.
        const model = this.models.get(botOfStream(event.type === "reset" ? event.reset.stream : event.stream) ?? "");
        if (model) model.live = null;
        return;
      }
      case "error": this.audit(`link: ${String((event.error as Error)?.message ?? event.error)}`); return;
      default: return;
    }
  }

  private onState(status: ConnModel): void {
    const attached = status.attached;
    if (attached) {
      for (const wake of [...this.attachWaiters]) wake();
      // The renderer's view may be behind on what changed while detached: a new epoch makes it take a fresh snapshot.
      if (!this.wasAttached && this.everAttached && this.served) this.bumpEpoch();
      this.everAttached = true;
    }
    this.wasAttached = attached;
    this.renderNotice();
  }

  private onSnap(snap: MessageOf<"snap">): void {
    const botId = botOfStream(snap.stream);
    const model = botId ? this.models.get(botId) : undefined;
    if (!model) return;
    const parsed = BotSnapView.safeParse(snap.view);
    const view = parsed.success ? parsed.data : { bot: null, messages: [], history: { hasMore: false, older: 0 }, cards: [] };
    if (!parsed.success) this.audit(`snap of ${snap.stream}: not a bot view; shown empty`);
    const replaced = model.ready || model.servedFallback;
    model.ready = true;
    model.servedFallback = false;
    model.chat = { ...emptyChat(model.botId), messages: view.messages, ...(view.history.hasMore ? { history: view.history } : {}) };
    model.known = new Set(view.messages.map((message) => message.id));
    model.committed = new Map(view.messages.map((message) => [message.id, message.text]));
    model.turns = new Map();
    model.live = null;
    model.liveWaiting = null;
    // Pending lines of this chat are drawn again over the new lines.
    for (const [key, line] of this.lines) if (line.botId === model.botId) this.lines.delete(key);
    if (this.notice?.botId === model.botId) this.notice = null;
    for (const done of model.waiters.splice(0)) done();
    if (replaced) this.bumpEpoch();
    this.reconcile();
    this.renderNotice();
  }

  private onEntries(stream: StreamId, entries: Entry[]): void {
    const botId = botOfStream(stream);
    const model = botId ? this.models.get(botId) : undefined;
    for (const entry of entries) {
      if (PROTOCOL_KINDS.has(entry.kind)) { if (model) this.onProtocolEntry(model, entry); continue; }
      const event = { type: entry.kind, ...entry.body } as Event;
      if (!model) {
        // A server-wide stream (srv:): its contract events are the renderer's too (bots, settings, plugins…).
        if (!("botId" in event)) this.emitEvent(event);
        continue;
      }
      this.onContractEntry(model, event, entry);
    }
  }

  private onContractEntry(model: BotModel, event: Event, entry: Entry): void {
    switch (event.type) {
      case "message.added":
      case "message.updated": {
        const message = event.message;
        if (entry.slot) this.swapPending(model, entry.slot);
        model.committed.set(message.id, message.text);
        const live = this.overlayFor(model, message.id);
        const shown = live !== null && (message.state === undefined || message.state === "streaming") ? { ...message, text: live } : message;
        // The renderer ignores an `added` for a line it holds (a pending or live line drawn first): update it instead.
        if (event.type === "message.added" && !model.known.has(message.id)) this.emitEvent({ ...event, message: shown }, model);
        else this.emitEvent({ type: "message.updated", botId: model.botId, message: shown }, model);
        return;
      }
      case "message.removed":
        model.committed.delete(event.messageId);
        this.emitEvent(event, model);
        model.known.delete(event.messageId);
        return;
      case "turn.started": {
        model.turns.set(event.turnId, event.messageId);
        this.emitEvent(event, model);
        const waiting = model.liveWaiting;
        if (waiting && waiting.turnId === event.turnId) { model.liveWaiting = null; this.applyLive(model, waiting); }
        return;
      }
      case "turn.finished":
        model.turns.delete(event.turnId);
        if (model.live?.turnId === event.turnId) model.live = null;
        model.committed.set(event.messageId, event.text);
        this.ensureLine(model, event.messageId, event.turnId, event.text, event.status);
        this.emitEvent(event, model);
        return;
      default:
        this.emitEvent(event, model);
    }
  }

  private onProtocolEntry(model: BotModel, entry: Entry): void {
    const body = entry.body as Record<string, unknown>;
    if (entry.kind === "turn.interrupted") {
      const turnId = String(body.turnId);
      const text = typeof body.text === "string" ? body.text : "";
      const messageId = typeof body.messageId === "string" ? body.messageId : model.turns.get(turnId) ?? `fe-int-${turnId}`.slice(0, 64);
      model.turns.delete(turnId);
      if (model.live?.turnId === turnId) model.live = null;
      model.committed.set(messageId, text);
      // The renderer shows a stopped reply as interrupted: the checkpoint text with nothing re-run (§9.3, §12).
      this.ensureLine(model, messageId, turnId, text, "stopped");
      this.emitEvent({ type: "turn.finished", botId: model.botId, turnId, messageId, status: "stopped", text }, model);
      return;
    }
    if (entry.kind === "turn.cancelled") {
      const turnId = String(body.turnId);
      const messageId = model.turns.get(turnId);
      model.turns.delete(turnId);
      if (model.live?.turnId === turnId) model.live = null;
      if (messageId) this.emitEvent({ type: "turn.finished", botId: model.botId, turnId, messageId, status: "stopped", text: model.committed.get(messageId) ?? "" }, model);
    }
    // turn.queued, cmd.* (outcomes come through the outbox), content.* (step 13): nothing for the renderer.
  }

  /** Makes sure the renderer holds line `messageId` (a reply whose `message.added` it never got). */
  private ensureLine(model: BotModel, messageId: string, turnId: string, text: string, state: MessageView["state"]): void {
    if (model.known.has(messageId)) return;
    const message: MessageView = { id: messageId, role: "bot", text: text.slice(0, MESSAGE_TEXT_LIMIT * 4), time: new Date(this.options.clock.now()).toISOString(), turnId, ...(state ? { state } : {}), ...(state === "stopped" ? { interrupted: true } : {}) };
    this.emitEvent({ type: "message.updated", botId: model.botId, message }, model);
  }

  // -------------------------------------------------------------------------------------------
  // Live text

  private messageOfTurn(model: BotModel, turnId: string): string | null {
    return model.turns.get(turnId) ?? model.chat.runs?.find((run) => run.turnId === turnId)?.messageId
      ?? (model.chat.running?.turnId === turnId ? model.chat.running.messageId : null)
      ?? this.chatBase.get(model.botId)?.runs?.find((run) => run.turnId === turnId)?.messageId
      ?? null;
  }

  /** The whole text shown for line `messageId` while its turn's live overlay runs, else null. */
  private overlayFor(model: BotModel, messageId: string): string | null {
    const live = model.live;
    if (!live || this.messageOfTurn(model, live.turnId) !== messageId) return null;
    return live.prefix + live.segText;
  }

  private onLive(stream: StreamId, view: { turnId: string; seg: number; text: string } | null): void {
    const model = this.models.get(botOfStream(stream) ?? "");
    if (!model?.ready) return;
    if (!view) { model.live = null; model.liveWaiting = null; return; }
    if (!this.messageOfTurn(model, view.turnId)) { model.liveWaiting = { turnId: view.turnId, seg: view.seg, text: view.text }; return; }
    this.applyLive(model, view);
  }

  private applyLive(model: BotModel, view: { turnId: string; seg: number; text: string }): void {
    const messageId = this.messageOfTurn(model, view.turnId)!;
    let live = model.live;
    if (!live || live.turnId !== view.turnId) {
      // A first frame of this turn: earlier segments are what the log committed of the reply line.
      live = { turnId: view.turnId, seg: view.seg, prefix: view.seg === 0 ? "" : (model.committed.get(messageId) ?? ""), segText: "" };
    } else if (view.seg !== live.seg) {
      live.prefix = view.seg === live.seg + 1 ? live.prefix + live.segText : (model.committed.get(messageId) ?? live.prefix + live.segText);
      live.seg = view.seg;
      live.segText = "";
    }
    live.segText = view.text;
    model.live = live;
    const text = live.prefix + live.segText;
    const line = model.chat.messages.find((message) => message.id === messageId);
    if (line && model.known.has(messageId) && text.startsWith(line.text)) {
      if (text.length > line.text.length) this.emitEvent({ type: "turn.delta", botId: model.botId, turnId: view.turnId, messageId, text: text.slice(line.text.length) }, model);
      return;
    }
    const message: MessageView = line
      ? { ...line, text, state: "streaming" }
      : { id: messageId, role: "bot", text, time: new Date(this.options.clock.now()).toISOString(), turnId: view.turnId, state: "streaming" };
    this.emitEvent({ type: "message.updated", botId: model.botId, message }, model);
  }

  // -------------------------------------------------------------------------------------------
  // Pending lines and outcomes

  private swapPending(model: BotModel, slot: Slot): void {
    const key = slotKey(slot);
    if (this.swapped.has(key)) return;
    this.swapped.add(key);
    const line = this.lines.get(key);
    if (line) {
      this.lines.delete(key);
      this.emitEvent({ type: "message.removed", botId: model.botId, messageId: line.id }, model);
      model.known.delete(line.id);
    }
  }

  /** Draws the outbox's `chat.send` items of followed chats as lines, and takes away lines whose item is gone. */
  private reconcile(): void {
    const items = this.options.link.pending();
    const present = new Set<string>();
    for (const item of items) {
      if (item.cmd.type !== "chat.send") continue;
      const botId = item.cmd.botId;
      const model = this.models.get(botId);
      if (!model?.ready || this.swapped.has(item.key)) continue;
      present.add(item.key);
      const message = pendingLine(item);
      const rendered = JSON.stringify(message);
      const line = this.lines.get(item.key);
      if (line?.rendered === rendered) continue;
      this.lines.set(item.key, { botId, id: message.id, rendered });
      this.emitEvent({ type: line ? "message.updated" : "message.added", botId, message }, model);
    }
    for (const [key, line] of this.lines) {
      if (present.has(key)) continue;
      this.lines.delete(key);
      const model = this.models.get(line.botId);
      if (model) { this.emitEvent({ type: "message.removed", botId: line.botId, messageId: line.id }, model); model.known.delete(line.id); }
    }
    // Swapped keys can be forgotten once the outbox no longer holds them.
    const held = new Set(items.map((item) => item.key));
    for (const key of this.swapped) if (!held.has(key)) this.swapped.delete(key);
  }

  private onOutcome(item: OutboxItem): void {
    const keys = [slotKey(item.slot), ...(item.movedFrom ? [slotKey(item.movedFrom)] : [])];
    if (!item.outcome) return;
    if (!keys.some((key) => this.waiting.has(key))) {
      if (item.cmd.type === "chat.send") return;
      this.early.set(keys[0], item);
      while (this.early.size > 200) this.early.delete(this.early.keys().next().value!);
      return;
    }
    for (const key of keys) {
      const resolve = this.waiting.get(key);
      if (!resolve) continue;
      this.waiting.delete(key);
      const outcome = item.outcome!;
      resolve(outcome.kind === "applied" ? { ok: true, result: outcome.result ?? {} } : { ok: false, error: wireError(outcome) });
      // A "not sent" item answered to the window that asked needs no line or later dismissal.
      if (outcome.kind !== "applied") void this.options.link.dismiss(item.slot).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The connection notice

  private renderNotice(): void {
    const status = this.options.link.status;
    const text = noticeText(status);
    const botId = this.shown;
    const model = botId ? this.models.get(botId) : undefined;
    if (!text || !model?.ready) {
      if (this.noticeTimer !== undefined) { this.options.clock.clearTimeout(this.noticeTimer); this.noticeTimer = undefined; }
      if (!text) this.removeNotice();
      return;
    }
    if (this.notice && this.notice.botId === botId) {
      if (this.notice.text !== text) this.drawNotice(model, text);
      return;
    }
    if (IMMEDIATE_NOTICE.has(status.state)) { this.drawNotice(model, text); return; }
    if (this.noticeTimer !== undefined) return;
    this.noticeTimer = this.options.clock.setTimeout(() => {
      this.noticeTimer = undefined;
      const now = noticeText(this.options.link.status);
      const shown = this.shown ? this.models.get(this.shown) : undefined;
      if (now && shown?.ready) this.drawNotice(shown, now);
    }, this.options.noticeDelayMs ?? 400);
  }

  private drawNotice(model: BotModel, text: string): void {
    this.notice = { botId: model.botId, text };
    const message: MessageView = { id: NOTICE_ID, role: "notice", text, time: new Date(this.options.clock.now()).toISOString() };
    // `updated`, not `added`: it is not chat activity, so the bot does not move up the column.
    this.emitEvent({ type: "message.updated", botId: model.botId, message }, model);
  }

  private removeNotice(): void {
    const notice = this.notice;
    if (!notice) return;
    this.notice = null;
    const model = this.models.get(notice.botId);
    if (model) { this.emitEvent({ type: "message.removed", botId: notice.botId, messageId: NOTICE_ID }, model); model.known.delete(NOTICE_ID); }
  }

  // -------------------------------------------------------------------------------------------
  // Emitting

  private bumpEpoch(): void {
    this.epoch = this.newEpoch();
    this.seq = 0;
    // One event under the new epoch so the renderer notices at once; `core.swap{null}` changes nothing it shows.
    this.emitEvent({ type: "core.swap", phase: null });
  }

  /** Emits one contract event to the renderer and runs it through the mirror (the renderer's own reducer). */
  private emitEvent(event: Event, model?: BotModel): void {
    const envelope = { v: PROTOCOL_VERSION, epoch: this.epoch, seq: this.seq + 1, event };
    const checked = EventEnvelope.safeParse(envelope);
    if (!checked.success) { this.audit(`dropped an event the renderer would refuse: ${event.type}`); return; }
    this.seq += 1;
    this.mirror(event, model);
    this.options.emit(checked.data);
  }

  private mirror(event: Event, model?: BotModel): void {
    if (model) {
      if ((event.type === "message.added" || event.type === "message.updated")) model.known.add(event.message.id);
      const view = apply({ ...this.workspace(), chat: model.chat }, event);
      model.chat = view.chat ?? model.chat;
      this.keepBase(view);
    } else {
      this.keepBase(apply(this.workspace(), event));
    }
  }

  private workspace(): WorkspaceView {
    const base = this.base;
    return {
      ready: true, bots: base?.bots ?? [], imported: base?.imported ?? null, chat: null, subagent: null, resyncs: 0, components: base?.components ?? {},
      plugins: base?.plugins ?? null, settings: base?.settings ?? null, doctor: base?.doctor ?? null, waiting: base?.waiting ?? { items: [], doing: {} },
    };
  }

  private keepBase(view: WorkspaceView): void {
    if (!this.base) return;
    this.base = {
      ...this.base, bots: view.bots, components: view.components, ...(view.plugins ? { plugins: view.plugins } : {}),
      ...(view.settings ? { settings: view.settings } : {}), ...(view.doctor ? { doctor: view.doctor } : {}), waiting: view.waiting,
    };
  }

  private audit(text: string): void { this.options.audit?.(text); }
}

function emptyChat(botId: string): ChatView {
  return { botId, messages: [], running: null, live: [], runs: [] };
}

/** How an outbox `chat.send` item is drawn in place (§11.6, §13.4). */
export function pendingLine(item: PendingView): MessageView {
  const cmd = item.cmd as Extract<Command, { type: "chat.send" }>;
  const id = pendingLineId(item.slot);
  const time = new Date(item.createdAt).toISOString();
  if (item.lost) return { id, role: "error", text: `Delivered, then lost when this machine's history was restored: ${cmd.text}`, time };
  if (item.state === "not sent") return { id, role: "error", text: `Not sent (${item.reason ?? "refused"}): ${cmd.text}`, time };
  return {
    id, role: "user", text: cmd.text, time,
    ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}),
    // The "sending" marker only after ~150 ms with no outcome (the link says when), so a normal ack never flashes it.
    ...(item.sending && (item.state === "waiting" || item.state === "held") ? { queued: true } : {}),
  };
}
