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
// - Two servers and more (M3 step 11, v1 §10.1, §11.6, §13.1, §13.3): the bots of the other servers come from the
//   link's copies of their `srv:` tables (summary rows → `BotView`s in the list, `bot.updated` / `bot.removed` as rows
//   change); a chat of a peer's bot is a bot stream like any other (the attached server passes it through). The notice
//   line then also says "<machine> offline · as of <time>" over a peer's bot while that machine is stale (its chat is
//   the attached server's cache), with how many messages are held at the attached server, "waiting for <machine>".
//   A message whose outcome a restore of its owner took away shows "delivered, then lost when <machine> was restored".
//
// Pure TypeScript over two ports (the link, and the renderer's event sink): no Electron, no Node built-ins.
import {
  type BotView, type Command, type Event, type MessageView, type PluginsView as PluginsViewT, type ResultOf, type WireError,
} from "../contract";
import { z } from "zod";
import {
  slotKey,
  type Entry, type MessageOf, type StreamId, type Target, type Via,
} from "../protocol";
import { PluginName } from "../protocol/content-url";
import { PluginRow, type SummaryRow } from "../protocol/table-rows";
import type { ConnModel, FeLinkEvent, OutboxItem, ServerView } from "../fe-link";
import type { RequestVia } from "../renderer/client";
import { chatLinkPlugin, linkMenuKey, withOwnerLinkMenus } from "./peer-link-menu";
import {
  botIdOf, botOfStream, botViewOfSummary, CARD_COMMANDS, emptyChat, pendingLineId, READ_COMMANDS, streamOf,
  type AdapterAnswer, type BotModel, type ChatSnapshot, type RendererAdapterOptions, type Snapshot,
} from "./adapter-types";
import { AdapterEntries } from "./adapter-entries";
import { BundleRefusedError } from "../renderer/shell/row-loader";
import { panelByRef, rowWeb, specsByRef } from "./web-by-ref";
import { peerActionRefusal } from "./peer-actions";

// The names that used to be defined here, still exported from this path.
export { NOTICE_ID, botViewOfSummary, noticeText, pendingLine, pendingLineId, peerNoticeText, READ_COMMANDS } from "./adapter-types";
export type { AdapterAnswer, LinkPort, RendererAdapterOptions } from "./adapter-types";

export const RequestViaSchema = z.strictObject({ plugin: PluginName });

export class RendererAdapter {
  private readonly entries: AdapterEntries;
  private readonly models = new Map<string, BotModel>();
  /** The server's last chat part per bot (decorations, plugin data, heads… that the log does not carry in M1). */
  private readonly chatBase = new Map<string, ChatSnapshot>();
  private shown: string | null = null;
  private wasAttached = false;
  private everAttached = false;
  /** A snapshot was answered, so the renderer holds an epoch to keep in step with. */
  private served = false;
  private readonly attachWaiters = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  /**
   * The last `plugins.web` answer (every web part's source, ~2 MB with the built-in plugins). The 2.x window asks for it
   * again each time its chat frame re-binds (at every app render, every 30 s at least), and the specs only change with
   * the library: kept until a `plugins.updated` event, a plugins command, or a new epoch (M1 demo bug 1).
   */
  private pluginsWeb: Promise<unknown> | null = null;
  /** M7-09b: the row key (code hash and bundle reference) each plugin's web part was last answered from, to tell a row that moved. */
  private readonly webKeys = new Map<string, string>();
  /** M5-09: the `chat/link` entries the window was last given (`linkMenuKey`), to tell when the shown chat's list changed. */
  private linkMenus: string | null = null;
  /** M5-09: a peer bot's link button already on its way, by bot, line, link and command: a second press joins it (L-007). */
  private readonly linkRuns = new Map<string, Promise<AdapterAnswer>>();

  constructor(private readonly options: RendererAdapterOptions) {
    this.entries = new AdapterEntries(options, {
      models: this.models, chatBase: this.chatBase, shown: () => this.shown,
      peerOf: (botId) => this.peerOf(botId), serverView: (id) => this.serverView(id),
      shownPlugins: (plugins) => this.shownPlugins(plugins), clearPluginsWeb: () => { this.pluginsWeb = null; },
    });
  }

  // The state the entries half owns, read here.
  private get epoch() { return this.entries.epoch; }
  private get seq() { return this.entries.seq; }
  private get base() { return this.entries.base; }
  private set base(value: AdapterEntries["base"]) { this.entries.base = value; }
  private get waiting() { return this.entries.waiting; }
  private get early() { return this.entries.early; }
  private get notice() { return this.entries.notice; }
  private get noticeTimer() { return this.entries.noticeTimer; }

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

  async request(cmd: Command, via?: RequestVia): Promise<AdapterAnswer> {
    try {
      // M7-12b: what needs this desktop's own machine is refused here for a peer's bot, with the reason; the rest goes to
      // its owner. First, so a plugin's attributed request (`via`) is refused the same way.
      const peerOwner = botIdOf(cmd) ? this.peerOf(botIdOf(cmd)!) : null;
      if (peerOwner) {
        const why = peerActionRefusal(cmd, this.serverView(peerOwner)?.name ?? "that machine");
        if (why) return { ok: false, error: { code: "forbidden", message: `not sent: ${why}` } };
      }
      let validVia: RequestVia | undefined;
      if (via !== undefined) {
        const parsed = RequestViaSchema.safeParse(via);
        if (!parsed.success) return { ok: false, error: { code: "bad_request", message: "Malformed request attribution (via)." } };
        validVia = parsed.data;
        if (cmd.type === "chat.snapshot" || cmd.type === "chat.history" || READ_COMMANDS.has(cmd.type)) {
          return { ok: false, error: { code: "forbidden", message: "not sent: read commands cannot carry plugin attribution" } };
        }
        return await this.command(cmd, validVia);
      }
      if (cmd.type === "chat.snapshot") return { ok: true, result: await this.snapshot(cmd.botId) };
      if (cmd.type === "chat.history") return { ok: true, result: await this.history(cmd) };
      if (cmd.type === "chat.shown" && cmd.botId) { this.show(cmd.botId); this.refreshLinkMenus(); }
      // A peer's bot: the window hints go nowhere (the attached server's core does not have the bot; M3 step 11).
      if ((cmd.type === "chat.shown" || cmd.type === "chat.read") && cmd.botId && this.peerOf(cmd.botId)) return { ok: true, result: {} };
      // F1 (M6-06): plugin secrets never enter the durable outbox (fe-link.sqlite); send as a non-persisted req.
      if (cmd.type === "plugins.secret") return await this.read(cmd);
      if (READ_COMMANDS.has(cmd.type)) return await this.read(cmd);
      if (cmd.type === "plugins.linkCommand") return await this.linkCommand(cmd);
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
    if (cmd.type === "plugins.web") return { ok: true, result: await this.pluginsWebAnswer() };
    const result = await this.options.link.request(cmd);
    if (cmd.type === "plugins.panel") {
      try {
        return { ok: true, result: await panelByRef(result, this.bySource(), cmd.name, this.webKeys) };
      } catch (error) {
        // Bytes that are not the row's web part: refused, never the server's source in their place (M7-09b-F).
        if (error instanceof BundleRefusedError) return { ok: false, error: { code: "forbidden", message: "not served: the web part of this plugin is not the one its row names" } };
        throw error;
      }
    }
    if (cmd.type === "plugins.list") return { ok: true, result: this.shownPlugins(result as PluginsViewT) };
    return { ok: true, result };
  }

  // -------------------------------------------------------------------------------------------
  // A peer bot's link buttons (M5-09)

  /** The server whose plugins decide what the shown chat's link buttons may be: the owner of a peer's bot, else null (the attached one's). */
  private linkOwner(): string | null {
    return this.shown ? this.peerOf(this.shown) : null;
  }

  /**
   * The plugin view the window gets while a peer's bot is shown: its `chat/link` entries only for plugins that machine has. What the
   * window is given is noted, so a later change of the shown chat or of that machine's plugins sends the list again (`refreshLinkMenus`).
   */
  private shownPlugins(plugins: PluginsViewT): PluginsViewT {
    const owner = this.linkOwner();
    const view = owner ? withOwnerLinkMenus(plugins, this.options.link.table?.(owner)?.rows) : plugins;
    this.linkMenus = linkMenuKey(view);
    return view;
  }

  /** The shown chat or its owner's plugin rows changed: when that changes the offered link buttons, tell the window with a `plugins.updated`. */
  private refreshLinkMenus(): void {
    const full = this.base?.plugins;
    if (!this.served || !full || this.linkMenus === null) return;
    const owner = this.linkOwner();
    const view = owner ? withOwnerLinkMenus(full, this.options.link.table?.(owner)?.rows) : full;
    if (linkMenuKey(view) !== this.linkMenus) this.emitEvent({ type: "plugins.updated", plugins: full });
  }

  /**
   * `plugins.linkCommand` from the window. For the attached server's own bot it goes as it always did (the window needs no `via`). For
   * a peer's bot it runs on that machine as the plugin that contributes the button, so it goes with that plugin's `via`, stamped from
   * the owner's row (never the attached server's); a button no entry offers is refused here.
   */
  private async linkCommand(cmd: Extract<Command, { type: "plugins.linkCommand" }>): Promise<AdapterAnswer> {
    if (!this.peerOf(cmd.botId)) return await this.command(cmd);
    const plugin = chatLinkPlugin(this.base?.plugins, cmd.id);
    if (!plugin) return { ok: false, error: { code: "forbidden", message: "not sent: that link button is not offered" } };
    const key = JSON.stringify([cmd.botId, cmd.messageId, cmd.url, cmd.id]);
    const running = this.linkRuns.get(key);
    if (running) return await running;
    // The owner's row, for this shell button only: no plugin code of this machine runs, the owner's own code does. A frame's
    // command stays on the attached server's row (the code the frame runs), so the owner checks that hash (C7: "differs on").
    const run = this.command(cmd, { plugin }, this.peerOf(cmd.botId)).finally(() => { this.linkRuns.delete(key); });
    this.linkRuns.set(key, run);
    return await run;
  }

  private pluginsWebAnswer(): Promise<unknown> {
    if (this.pluginsWeb) return this.pluginsWeb;
    const asked = this.options.link.request({ type: "plugins.web" }).then((answer) => specsByRef(answer, this.bySource(), this.webKeys));
    this.pluginsWeb = asked;
    // A failed answer is not kept: the next ask goes to the server again.
    asked.catch(() => { if (this.pluginsWeb === asked) this.pluginsWeb = null; });
    return asked;
  }

  /** M7-09b: where a plugin's web part is read from by its row (the attached server's own rows, the adapter's bundle fetcher). */
  private bySource() {
    const server = this.options.link.server;
    const rows = () => (server && this.options.link.server === server ? this.options.link.table?.(server)?.rows : undefined);
    return { fetch: this.options.bundles, rows, log: (line: string) => this.audit(line) };
  }

  /**
   * M7-09b: the attached server's own `plugin:` rows changed. The kept `plugins.web` answer is dropped, and when a plugin whose web part
   * the window was given from its row now has another bundle (or none), the window is told with a `plugins.updated` so its frames ask again.
   */
  private onOwnPlugins(table: { changed: string[]; removed: string[] }): void {
    const keys = [...table.changed, ...table.removed].filter((key) => key.startsWith("plugin:"));
    if (!keys.length) return;
    this.pluginsWeb = null;
    const server = this.options.link.server;
    const rows = server ? this.options.link.table?.(server)?.rows : undefined;
    let moved = false;
    for (const key of keys) {
      const name = key.slice("plugin:".length);
      const served = this.webKeys.get(name);
      if (served === undefined) continue;
      const now = rowWeb(rows, name)?.key ?? null;
      if (now === served) continue;
      moved = true;
      if (now === null) this.webKeys.delete(name); else this.webKeys.set(name, now);
    }
    const full = this.base?.plugins;
    if (moved && this.served && full) this.emitEvent({ type: "plugins.updated", plugins: full });
  }

  /** `serverId`: whose `plugin:` row stamps the hash: the attached server's, or a peer bot's owner for its link button (M5-09). */
  private resolveVia(via: RequestVia, serverId: string | null = this.options.link.server): Via | null {
    const table = serverId ? this.options.link.table?.(serverId) ?? null : null;
    const rawRow = table?.rows.get(`plugin:${via.plugin}`);
    const parsedRow = rawRow ? PluginRow.safeParse(rawRow) : null;
    if (!parsedRow?.success) return null;
    return { plugin: via.plugin, codeHash: parsedRow.data.codeHash };
  }

  /**
   * `viaServer`: whose `plugin:` row stamps `via`. The attached server's by default: a frame runs that machine's code, so its
   * hash goes even to a peer's bot, whose owner refuses another version (C7). Only `linkCommand` passes a peer (M5-09).
   */
  private async command(cmd: Command, via?: RequestVia, viaServer: string | null = this.options.link.server): Promise<AdapterAnswer> {
    const botId = botIdOf(cmd);
    const missing = (): AdapterAnswer => ({ ok: false, error: { code: "forbidden", message: `not sent: the plugin is not installed on ${viaServer === this.options.link.server ? "this" : "that"} machine` } });
    if (via && !this.resolveVia(via, viaServer)) return missing();
    if (cmd.type.startsWith("plugins.")) this.pluginsWeb = null;
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
    // Authority at use (L-008): re-read the plugin row after any await so hot swaps or uninstalls never stamp a stale hash.
    let resolvedVia: Via | undefined;
    if (via) {
      const fresh = this.resolveVia(via, viaServer);
      if (!fresh) return missing();
      resolvedVia = fresh;
    }
    const basis = botId && CARD_COMMANDS.has(cmd.type) ? link.cursor(target) : null;
    const basisArg = basis ? { logId: basis.logId, seq: basis.seq } : undefined;
    const item = resolvedVia
      ? await link.submit(target, cmd, basisArg, resolvedVia)
      : await link.submit(target, cmd, basisArg);
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
        // A peer's bot is not in the attached server's core: its chat comes from its bot stream only (M3 step 11).
        const peer = botId ? this.peerOf(botId) : null;
        const answer = await this.options.link.request({ type: "chat.snapshot", ...(botId && !peer ? { botId } : {}) }) as Snapshot;
        const { epoch: _epoch, seq: _seq, chat, ...rest } = answer;
        this.base = { ...rest, bots: this.withPeerBots(rest.bots) };
        if (chat && !peer) this.chatBase.set(chat.botId, chat);
        if (!peer) botId = chat?.botId ?? botId;
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
    const answer = { ...this.base!, epoch: this.epoch, seq: this.seq, chat };
    if (answer.plugins) answer.plugins = this.shownPlugins(answer.plugins);
    return answer;
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
      case "pending": this.reconcile(); this.renderNotice(); return;
      case "outcome": this.onOutcome(event.item); return;
      case "reset": case "dropped": {
        // A snap follows; the model it replaces is gone now.
        const model = this.models.get(botOfStream(event.type === "reset" ? event.reset.stream : event.stream) ?? "");
        if (model) model.live = null;
        return;
      }
      case "error": this.audit(`link: ${String((event.error as Error)?.message ?? event.error)}`); return;
      case "servers": this.onServers(event.table); return;
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
    } else this.pluginsWeb = null;
    this.wasAttached = attached;
    this.renderNotice();
  }

  // -------------------------------------------------------------------------------------------
  // Other servers (M3 step 11)

  /** The server that owns a bot when it is not the attached one; null for the attached server's own bots. */
  private peerOf(botId: string): string | null {
    const owner = this.options.link.ownerOf?.(streamOf(botId)) ?? null;
    return owner && owner !== this.options.link.server ? owner : null;
  }

  private serverView(id: string | null): ServerView | null {
    if (!id) return null;
    return this.options.link.servers?.().find((server) => server.id === id) ?? null;
  }

  /** The peers' bots (from their summary rows) after the attached server's own, each once. */
  private peerBots(): BotView[] {
    const link = this.options.link;
    if (!link.servers || !link.table) return [];
    const found: BotView[] = [];
    for (const server of link.servers()) {
      if (server.self) continue;
      const table = link.table(server.id);
      if (!table) continue;
      for (const [key, body] of table.rows) if (key.startsWith("bot:")) found.push(botViewOfSummary(key.slice(4), body as SummaryRow));
    }
    return found;
  }

  private withPeerBots(own: BotView[]): BotView[] {
    const ids = new Set(own.map((bot) => bot.id));
    return [...own, ...this.peerBots().filter((bot) => !ids.has(bot.id))];
  }

  /** A peer's table changed: its bots in the list follow; the notice may change with a server's state. */
  private onServers(table?: { stream: string; changed: string[]; removed: string[] }): void {
    const server = this.options.link.server;
    if (table && this.base) {
      const rows = this.options.link.table?.(table.stream.slice(4))?.rows;
      const own = new Set((this.base.bots ?? []).map((bot) => bot.id));
      for (const key of table.changed) {
        if (!key.startsWith("bot:") || !rows?.has(key)) continue;
        const bot = botViewOfSummary(key.slice(4), rows.get(key) as SummaryRow);
        const held = this.base.bots.find((known) => known.id === bot.id);
        if (held && JSON.stringify(held) === JSON.stringify(bot)) continue;
        if (!held || this.peerOf(bot.id)) this.emitEvent({ type: "bot.updated", bot });
        own.add(bot.id);
      }
      for (const key of table.removed) {
        if (!key.startsWith("bot:")) continue;
        const botId = key.slice(4);
        if (this.base.bots.some((bot) => bot.id === botId) && !this.peerOf(botId)) this.emitEvent({ type: "bot.removed", botId });
      }
    }
    if (table && server && table.stream === `srv:${server}`) this.onOwnPlugins(table);
    // M5-09: a peer's plugin rows decide which link buttons its bots' chats offer.
    if (table && [...table.changed, ...table.removed].some((key) => key.startsWith("plugin:"))) this.refreshLinkMenus();
    this.renderNotice();
  }

  // -------------------------------------------------------------------------------------------
  // The entries half (M7-S95): one-line delegates to AdapterEntries

  private onSnap(snap: MessageOf<"snap">): void { this.entries.onSnap(snap); }
  private onEntries(stream: StreamId, entries: Entry[]): void { this.entries.onEntries(stream, entries); }
  private onLive(stream: StreamId, view: { turnId: string; seg: number; text: string } | null): void { this.entries.onLive(stream, view); }
  private reconcile(): void { this.entries.reconcile(); }
  private onOutcome(item: OutboxItem): void { this.entries.onOutcome(item); }
  private renderNotice(): void { this.entries.renderNotice(); }
  private removeNotice(): void { this.entries.removeNotice(); }
  private bumpEpoch(): void { this.entries.bumpEpoch(); }
  private emitEvent(event: Event, model?: BotModel): void { this.entries.emitEvent(event, model); }
  private audit(text: string): void { this.entries.audit(text); }
}
