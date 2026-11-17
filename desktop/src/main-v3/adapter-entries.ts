// The entry-folding half of `RendererAdapter` (M7-S95: moved out of renderer-adapter.ts, bodies unchanged): what the
// link's snaps, entries, live frames and outcomes make of the renderer's events, the pending lines, the connection
// notice, and the epoch / seq the events leave under. It owns the mirror of the shown chats' state (`base`, the
// epoch and seq, the notice, the pending lines, the slot waiters); what it borrows from the adapter is the bridge block.
import {
  EventEnvelope, MESSAGE_TEXT_LIMIT, PROTOCOL_VERSION,
  type Event, type MessageView, type PluginsView as PluginsViewT,
} from "../contract";
import {
  BotSnapView, interruptedLine, KeptResultMarker, slotKey,
  type Entry, type MessageOf, type Slot, type StreamId,
} from "../protocol";
import type { OutboxItem, ServerView } from "../fe-link";
import { apply, type WorkspaceView } from "../renderer/store";
import {
  botOfStream, emptyChat, IMMEDIATE_NOTICE, NOTICE_ID, noticeText, pendingLine, peerNoticeText, PROTOCOL_KINDS, randomEpoch, sizeText, streamOf, wireError,
  type AdapterAnswer, type BotModel, type ChatSnapshot, type PendingLine, type RendererAdapterOptions, type Snapshot,
} from "./adapter-types";

/** What the entries half borrows from the adapter (the bridge block below forwards to it, one line per name). */
export interface EntriesHost {
  readonly models: Map<string, BotModel>;
  readonly chatBase: Map<string, ChatSnapshot>;
  shown(): string | null;
  peerOf(botId: string): string | null;
  serverView(id: string | null): ServerView | null;
  shownPlugins(plugins: PluginsViewT): PluginsViewT;
  clearPluginsWeb(): void;
}

export class AdapterEntries {
  epoch: string;
  seq = 0;
  private readonly newEpoch: () => string;
  /** The global parts of the last server snapshot, kept up to date by the events emitted since (the offline answer). */
  base: Omit<Snapshot, "epoch" | "seq" | "chat"> | null = null;
  /** Renderer requests waiting for a slot's outcome, by slot key. */
  readonly waiting = new Map<string, (answer: AdapterAnswer) => void>();
  /** Outcomes no request waited for (yet), by slot key; bounded. */
  readonly early = new Map<string, OutboxItem>();
  /** Pending lines shown, by slot key; `swapped` once the entry with the slot replaced it. */
  private readonly lines = new Map<string, PendingLine>();
  private readonly swapped = new Set<string>();
  notice: { botId: string; text: string } | null = null;
  noticeTimer: unknown;

  constructor(private readonly options: RendererAdapterOptions, private readonly host: EntriesHost) {
    this.newEpoch = options.newEpoch ?? randomEpoch;
    this.epoch = this.newEpoch();
  }

  // The bridge: what the moved bodies borrow from the adapter, one forwarder per name.
  private get models() { return this.host.models; }
  private get chatBase() { return this.host.chatBase; }
  private get shown() { return this.host.shown(); }
  private peerOf(botId: string) { return this.host.peerOf(botId); }
  private serverView(id: string | null) { return this.host.serverView(id); }
  private shownPlugins(plugins: PluginsViewT) { return this.host.shownPlugins(plugins); }
  /** Sets another owner's field (the adapter's `pluginsWeb`); to be replaced by a named transition. */
  private set pluginsWeb(_value: null) { this.host.clearPluginsWeb(); }

  onSnap(snap: MessageOf<"snap">): void {
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

  onEntries(stream: StreamId, entries: Entry[]): void {
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
        // A line the renderer already holds exactly so (a checkpoint of text the live frames showed, an entry seen again)
        // is not sent again: the chat page would draw its row anew, and a video in it would start over (M1 demo bug 1).
        if (model.known.has(message.id) && sameLine(model.chat.messages.find((held) => held.id === message.id), shown)) return;
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
        // A reply with nothing to show (the core kept it out: only <no-reply/> or reactions, or cut off before it said
        // anything): the log holds no line for it, so neither does the renderer, as in 2.x. A line only the live frames
        // drew goes; none is made. A failed turn that says something (an error message or text) or that the log holds a
        // line for still gets its line (the server ends a turn the core never did so). A failed turn with none of the three
        // is one the server absorbed into a failed main turn (worker.ts turnEnded): no bubble, as the read model draws none.
        // Blank text counts as none, as the core's own rule does (hasVisibleContent: a stop's raw body may be "\n").
        if (!event.text.trim() && (event.status !== "failed" || !event.error) && !model.committed.has(event.messageId)) {
          if (model.known.has(event.messageId)) {
            this.emitEvent({ type: "message.removed", botId: model.botId, messageId: event.messageId }, model);
            model.known.delete(event.messageId);
          }
          this.emitEvent(event, model);
          return;
        }
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
      // Shown as 2.x shows a reply its core died during (protocol/interrupted.ts): the checkpoint text and the note,
      // "failed", nothing re-run (§9.3, §12). The server's read model makes the same line, so a later snap matches.
      const held = model.known.has(messageId) ? model.chat.messages.find((message) => message.id === messageId) : undefined;
      const line = interruptedLine(held, { turnId, text }, { id: messageId, time: new Date(this.options.clock.now()).toISOString() });
      model.committed.set(messageId, line.text);
      this.emitEvent({ type: "turn.finished", botId: model.botId, turnId, messageId, status: "failed", text: line.text }, model);
      this.emitEvent({ type: "message.updated", botId: model.botId, message: line }, model);
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

  onLive(stream: StreamId, view: { turnId: string; seg: number; text: string } | null): void {
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
  reconcile(): void {
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

  onOutcome(item: OutboxItem): void {
    const keys = [slotKey(item.slot), ...(item.movedFrom ? [slotKey(item.movedFrom)] : [])];
    if (!item.outcome) return;
    if (!keys.some((key) => this.waiting.has(key))) {
      if (item.cmd.type === "chat.send") return;
      this.early.set(keys[0], item);
      while (this.early.size > 200) this.early.delete(this.early.keys().next().value!);
      return;
    }
    const outcome = item.outcome;
    const resolvers: Array<(answer: AdapterAnswer) => void> = [];
    for (const key of keys) {
      const resolve = this.waiting.get(key);
      if (!resolve) continue;
      this.waiting.delete(key);
      resolvers.push(resolve);
    }
    if (outcome.kind !== "applied") {
      for (const resolve of resolvers) resolve({ ok: false, error: wireError(outcome, item.unsendable) });
      // A "not sent" item answered to the window that asked needs no line or later dismissal.
      void this.options.link.dismiss(item.slot).catch(() => undefined);
      return;
    }
    void this.appliedAnswer(item, outcome.result).then((answer) => { for (const resolve of resolvers) resolve(answer); });
  }

  /**
   * What an applied slot answers: its result, or (N2) the result the owner kept because it did not fit the slot's
   * `cmd.applied` entry, fetched with a `slot.result` req. The command ran either way, so an error here says so and
   * never reads as "not sent".
   */
  private async appliedAnswer(item: OutboxItem, result: unknown): Promise<AdapterAnswer> {
    const marker = KeptResultMarker.safeParse(result);
    if (!marker.success) return { ok: true, result: result ?? {} };
    const { bytes, kept } = marker.data.resultKept;
    const ran = `${item.cmd.type} ran, but its result (${sizeText(bytes)})`;
    if (!kept) return { ok: false, error: { code: "internal", message: `${ran} is too large to send back; the server did not keep it.` } };
    try {
      return { ok: true, result: await this.options.link.request({ type: "slot.result", slot: item.slot }) };
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      return { ok: false, error: { code: "internal", message: `${ran} could not be fetched: ${text}`.slice(0, 2_000) } };
    }
  }

  // -------------------------------------------------------------------------------------------
  // The connection notice

  /** The notice line's words: the connection state's, else a peer's bot whose machine is not live. */
  private noticeNow(): string | null {
    const link = this.options.link;
    const own = noticeText(link.status);
    if (own) return own;
    const botId = this.shown;
    if (!botId || !link.servers) return null;
    const owner = this.peerOf(botId);
    if (!owner) return null;
    return peerNoticeText(this.serverView(owner), this.serverView(link.server), link.pending(), link.staleSince?.(streamOf(botId)) ?? null);
  }

  renderNotice(): void {
    const status = this.options.link.status;
    const text = this.noticeNow();
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
      const now = this.noticeNow();
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

  removeNotice(): void {
    const notice = this.notice;
    if (!notice) return;
    this.notice = null;
    const model = this.models.get(notice.botId);
    if (model) { this.emitEvent({ type: "message.removed", botId: notice.botId, messageId: NOTICE_ID }, model); model.known.delete(NOTICE_ID); }
  }

  // -------------------------------------------------------------------------------------------
  // Emitting

  bumpEpoch(): void {
    this.epoch = this.newEpoch();
    this.seq = 0;
    this.pluginsWeb = null;
    // One event under the new epoch so the renderer notices at once; `core.swap{null}` changes nothing it shows.
    this.emitEvent({ type: "core.swap", phase: null });
  }

  /** Emits one contract event to the renderer and runs it through the mirror (the renderer's own reducer). */
  emitEvent(event: Event, model?: BotModel): void {
    const envelope = { v: PROTOCOL_VERSION, epoch: this.epoch, seq: this.seq + 1, event };
    const checked = EventEnvelope.safeParse(envelope);
    if (!checked.success) { this.audit(`dropped an event the renderer would refuse: ${event.type}`); return; }
    this.seq += 1;
    if (event.type === "plugins.updated") this.pluginsWeb = null;
    this.mirror(event, model);
    // The window's copy of the plugin view hides link buttons the shown peer's machine cannot run (the mirror keeps the whole view).
    if (event.type === "plugins.updated") {
      const shown = this.shownPlugins(event.plugins);
      this.options.emit(shown === event.plugins ? checked.data : { ...checked.data, event: { ...event, plugins: shown } });
      return;
    }
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

  audit(text: string): void { this.options.audit?.(text); }
}

/** The renderer's reducer stores an updated line as it comes, so the same JSON is the same row. */
function sameLine(held: MessageView | undefined, next: MessageView): boolean {
  return !!held && JSON.stringify(held) === JSON.stringify(next);
}
