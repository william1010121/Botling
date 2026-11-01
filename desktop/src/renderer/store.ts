// The workspace as the renderer knows it: every bot (for the left column) and the chat of the bot
// on screen, from a snapshot plus the events after it. Events carry the core's epoch and a
// gapless seq; a new epoch (the core restarted) or a gap means the view may be wrong, so the store
// takes a fresh snapshot instead of patching on guesses. Events that arrive while a snapshot is
// on its way are buffered and replayed if newer than it. Chat events for other bots are not
// kept (their chats are fetched when shown); `bot.updated` is kept for every bot.
import type { DoctorView, SpecStateView, WaitingView, PendingFileView, PluginsView, SettingsView, BotView, CatchUpView, ComponentInfoView, PinChoiceView, PinView, Event, EventEnvelope, HeadsView, ImportView, MessageView, ResultOf, RoutineView, RunningView, StepView, SubagentView, TaskView } from "../contract";

/** A turn under way and its steps so far (with two heads, two can run at once). */
export interface RunState { turnId: string; messageId: string; head?: "claude" | "codex" | "agy"; live: StepView[] }

export interface ChatView {
  botId: string;
  messages: MessageView[];
  /** Older lines wait in the core (`chat.history`); absent when `messages` is all of it. */
  history?: { hasMore: boolean; older: number };
  /** The turn the typing bubble shows (the first of `runs`). */
  running: RunningView | null;
  /** The running turn's steps so far. */
  live: StepView[];
  tasks: TaskView[];
  runs?: RunState[];
  /** A bot with two heads: who new messages go to, the rounds line, the hand-offs. */
  heads?: HeadsView | null;
  /** Unread lines folded with their summary, and the interval summaries. */
  catchUp?: CatchUpView | null;
  intervalSummaries?: CatchUpView[];
  /** Its pins, those floating, and what the pin picker offers. */
  pins?: PinView[];
  floating?: PinView[];
  pinChoices?: PinChoiceView[];
  /** Files waiting in the input box. */
  pendingFiles?: PendingFileView[];
  /** Its routines, shown with its scheduled work. */
  routines?: RoutineView[];
}

export interface WorkspaceView {
  ready: boolean;
  bots: BotView[];
  imported: ImportView | null;
  chat: ChatView | null;
  /** The subagent being watched in the chat's place (its own conversation), if any. */
  subagent: SubagentView | null;
  /** Times the store re-synced from a snapshot (for tests and diagnostics). */
  resyncs: number;
  /** The component library as the page draws it. */
  components: Record<string, ComponentInfoView>;
  /** The chat shows its Board instead of its messages. */
  board: boolean;
  /** The plugin library, once asked for (`plugins.list`) or changed (`plugins.updated`). */
  plugins: PluginsView | null;
  /** The app's settings (language, avatar size, look…). */
  settings: SettingsView | null;
  doctor?: DoctorView | null;
  /** What waits on you across the bots, and managers' "In progress" (the right panel). */
  waiting: WaitingView;
  /** The component spec open in the right panel (Phase 5a), if any. */
  spec?: SpecStateView | null;
  /** The core is being replaced by a newer build (a fresh snapshot from the new core clears it). */
  coreSwap?: "draining" | "updating" | null;
}

/** Only inputs used by the selected chat page; sidebar activity is deliberately excluded. */
export type ChatRenderView = Pick<WorkspaceView, "chat" | "subagent" | "board" | "settings" | "components" | "resyncs" | "bots"> & { libraryVersion: number };

// Worker progress changes the selected bot's sidebar row on every step. Compare only
// its chat inputs before invalidating the expensive history conversion. Keep unknown/new
// fields conservative; only these four known sidebar-only fields are excluded.
const chatBotKey = (bot: BotView): string => {
  const { subagentRows: _rows, unread: _unread, openTasks: _tasks, lastActivity: _activity, ...chat } = bot;
  return JSON.stringify(chat);
};

type Snapshot = ResultOf<"chat.snapshot">;

export class WorkspaceStore {
  private view: WorkspaceView = { ready: false, bots: [], imported: null, chat: null, subagent: null, resyncs: 0, components: {}, board: false, plugins: null, settings: null, waiting: { items: [], doing: {} }, spec: null };
  private epoch: string | null = null;
  private seq = 0;
  private syncing = false;
  private selectionGeneration = 0;
  private again = false;
  private wanted: string | undefined;
  private buffer: EventEnvelope[] = [];
  private listeners = new Set<() => void>();

  constructor(private fetchSnapshot: (botId?: string) => Promise<Snapshot>, private fetchHistory?: (botId: string, before: string, until?: string) => Promise<ResultOf<"chat.history">>) {}

  private loadingOlder = false;

  /**
   * Older lines of the shown chat (the snapshot holds only its newest page): the page before the first line held,
   * or, with `until`, back to at least that line. Does nothing when the chat has no more, or a page is on its way.
   */
  async loadOlder(until?: string): Promise<void> {
    const chat = this.view.chat;
    const before = chat?.messages[0]?.id;
    if (!chat?.history?.hasMore || !before || this.loadingOlder || !this.fetchHistory) return;
    const generation = this.selectionGeneration;
    this.loadingOlder = true;
    try {
      const page = await this.fetchHistory(chat.botId, before, until);
      const now = this.view.chat;
      // A resync, another chat or a newer first line meanwhile: this page no longer fits, drop it.
      if (generation !== this.selectionGeneration || !now || now.botId !== chat.botId || now.messages[0]?.id !== before) return;
      const have = new Set(now.messages.map((message) => message.id));
      const { history: _history, ...rest } = now;
      this.set({ ...this.view, chat: { ...rest, messages: [...page.messages.filter((message) => !have.has(message.id)), ...now.messages], ...(page.hasMore ? { history: { hasMore: true, older: page.older } } : {}) } });
    } catch {
      // The reader asks again by scrolling; a resync sets everything right.
    } finally {
      this.loadingOlder = false;
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getView = () => this.view;
  private libraryVersion = 0;
  private chatView: ChatRenderView | undefined;

  getChatView = (): ChatRenderView => {
    const view = this.view, previous = this.chatView;
    // Other bots still supply mention names and guest faces. Their working/unread/task counters
    // only affect the sidebar, and must not invalidate this chat's payload.
    const bots = previous && previous.bots.length === view.bots.length && previous.bots.every((old, index) => {
      const bot = view.bots[index];
      return old.id === bot.id && (bot.id === view.chat?.botId ? old === bot || chatBotKey(old) === chatBotKey(bot)
        : old.name === bot.name && old.avatar === bot.avatar && old.role === bot.role);
    }) ? previous.bots : view.bots;
    if (previous && previous.chat === view.chat && previous.subagent === view.subagent && previous.board === view.board
      && previous.settings === view.settings && previous.libraryVersion === this.libraryVersion
      && previous.resyncs === view.resyncs && previous.bots === bots) return previous;
    return this.chatView = { chat: view.chat, subagent: view.subagent, board: view.board, settings: view.settings,
      components: view.components, libraryVersion: this.libraryVersion, resyncs: view.resyncs, bots };
  };

  subscribeChat = (listener: () => void) => {
    let previous = this.getChatView();
    return this.subscribe(() => {
      const next = this.getChatView();
      if (next !== previous) { previous = next; listener(); }
    });
  };

  private set(view: WorkspaceView) {
    if (view === this.view) return;
    if (view.components !== this.view.components) {
      // Snapshots can contain a new object for the same library. Compare only on library events
      // or snapshots, never on streamed tokens; retain the object so templates can be cached.
      if (JSON.stringify(view.components) === JSON.stringify(this.view.components)) view = { ...view, components: this.view.components };
      else this.libraryVersion++;
    }
    this.view = view;
    for (const listener of this.listeners) listener();
  }

  /** Shows another bot's chat (fetched fresh). */
  select(botId: string) {
    // A navigation must not wait behind an older snapshot (which may never reply).
    // Its eventual response must not overwrite the newer chat or release its buffer.
    this.selectionGeneration++;
    this.syncing = false;
    this.again = false;
    this.buffer = [];
    this.wanted = botId;
    if (this.view.subagent) this.set({ ...this.view, subagent: null });
    return this.resync();
  }

  /** Shows the chat's Board instead of its messages, or the messages again. */
  showBoard(board: boolean) {
    this.set({ ...this.view, board });
  }

  /** Watches one of the shown bot's subagents (null: back to the chat). */
  watch(subagent: SubagentView | null) {
    this.set({ ...this.view, subagent });
  }

  get selected(): string | undefined {
    return this.wanted ?? this.view.chat?.botId;
  }

  async resync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    const generation = this.selectionGeneration;
    try {
      const snapshot = await this.fetchSnapshot(this.wanted);
      if (generation !== this.selectionGeneration) return;
      this.epoch = snapshot.epoch;
      this.seq = snapshot.seq;
      const subagent = this.view.subagent && snapshot.chat?.botId === this.view.chat?.botId ? this.view.subagent : null;
      const chat = snapshot.chat ? { ...snapshot.chat, runs: (snapshot.chat.runs ?? []).map((run) => ({ ...run })) } : null;
      const board = this.view.board && chat?.botId === this.view.chat?.botId;
      this.set({ ready: true, bots: snapshot.bots, imported: snapshot.imported, chat, subagent, resyncs: this.view.resyncs + 1, components: snapshot.components ?? {}, board, plugins: snapshot.plugins ?? null, settings: snapshot.settings ?? this.view.settings, doctor: snapshot.doctor ?? this.view.doctor, waiting: snapshot.waiting ?? this.view.waiting, spec: snapshot.spec ?? null, coreSwap: null });
    } catch (error) {
      // A failed obsolete request must not discard a later user's selection.
      if (generation !== this.selectionGeneration) return;
      throw error;
    } finally {
      if (generation === this.selectionGeneration) this.syncing = false;
    }
    if (generation !== this.selectionGeneration) return;
    const buffered = this.buffer;
    this.buffer = [];
    for (const envelope of buffered) this.receive(envelope);
    if (this.again) {
      this.again = false;
      await this.resync();
    }
  }

  receive(envelope: EventEnvelope) {
    if (this.syncing) {
      this.buffer.push(envelope);
      return;
    }
    if (envelope.epoch !== this.epoch || envelope.seq > this.seq + 1) {
      void this.resync();
      return;
    }
    if (envelope.seq <= this.seq) return; // Already in the snapshot.
    this.seq = envelope.seq;
    // A bot it has not seen (a project just added): the snapshot has it in its place in the list.
    const event = envelope.event;
    if (event.type === "bot.updated" && !this.view.bots.some((bot) => bot.id === event.bot.id)) {
      void this.resync();
      return;
    }
    // A bot taken out of the column: its chat, if shown, gives way to the main bot's.
    if (event.type === "bot.removed") {
      if (this.selected === event.botId) {
        this.wanted = undefined;
        this.set({ ...this.view, bots: this.view.bots.filter((bot) => bot.id !== event.botId), subagent: null });
        void this.resync();
        return;
      }
    }
    this.set(apply(this.view, event));
  }
}

export function apply(view: WorkspaceView, event: Event): WorkspaceView {
  if (event.type === "components.updated") return { ...view, components: event.components };
  if (event.type === "plugins.updated") return { ...view, plugins: event.plugins };
  if (event.type === "doctor.updated") return { ...view, doctor: event.doctor };
  if (event.type === "settings.updated") return { ...view, settings: event.settings };
  if (event.type === "waiting.updated") return { ...view, waiting: event.waiting };
  if (event.type === "spec.updated") return { ...view, spec: event.spec };
  if (event.type === "core.swap") return { ...view, coreSwap: event.phase };
  if (event.type === "bot.removed") return { ...view, bots: view.bots.filter((bot) => bot.id !== event.botId) };
  if (event.type === "bot.updated") {
    const bots = view.bots.some((bot) => bot.id === event.bot.id)
      ? view.bots.map((bot) => (bot.id === event.bot.id ? event.bot : bot))
      : [...view.bots, event.bot];
    return { ...view, bots };
  }
  // A new line moves its chat up the column (`lastActivity`).
  if (event.type === "message.added" && view.bots.some((bot) => bot.id === event.botId && bot.lastActivity !== event.message.time)) {
    view = { ...view, bots: view.bots.map((bot) => (bot.id === event.botId ? { ...bot, lastActivity: event.message.time } : bot)) };
  }
  const chat = view.chat;
  if (!chat || event.botId !== chat.botId) return view;
  const withChat = (next: ChatView): WorkspaceView => ({ ...view, chat: next });
  const update = (id: string, change: (message: MessageView) => MessageView): ChatView => ({
    ...chat,
    messages: chat.messages.map((message) => (message.id === id ? change(message) : message)),
  });
  switch (event.type) {
    case "message.removed":
      return withChat({ ...chat, messages: chat.messages.filter((message) => message.id !== event.messageId) });
    case "tasks.updated":
      return withChat({ ...chat, tasks: event.tasks });
    case "routines.updated":
      return withChat({ ...chat, routines: event.routines });
    case "subagent.updated":
      return view.subagent?.id === event.subagent.id ? { ...view, subagent: event.subagent } : view;
    case "message.added":
      if (chat.messages.some((message) => message.id === event.message.id)) return view;
      return withChat({ ...chat, messages: [...chat.messages, event.message] });
    case "message.updated":
      if (!chat.messages.some((message) => message.id === event.message.id)) {
        // A line from an older page that is not loaded: it shows when that page is loaded.
        if (chat.history?.hasMore && chat.messages.length && event.message.time < chat.messages[0]!.time) return view;
        return withChat({ ...chat, messages: [...chat.messages, event.message] });
      }
      return withChat(update(event.message.id, () => event.message));
    case "turn.started": {
      const runs = [...(chat.runs ?? []).filter((run) => run.turnId !== event.turnId), { turnId: event.turnId, messageId: event.messageId, head: event.head, live: [] }];
      return withChat({ ...chat, runs, ...(chat.running ? {} : { running: { turnId: event.turnId, messageId: event.messageId }, live: [] }) });
    }
    case "turn.delta":
      return withChat(update(event.messageId, (message) => ({ ...message, text: message.text + event.text })));
    case "turn.steps": {
      const runs = (chat.runs ?? []).map((run) => (run.turnId === event.turnId ? { ...run, live: event.steps } : run));
      if (chat.running?.turnId !== event.turnId) return withChat({ ...chat, runs });
      return withChat({ ...chat, runs, live: event.steps });
    }
    case "turn.finished": {
      const next = update(event.messageId, (message) => ({ ...message, text: event.text, state: event.status, ...(event.cards ? { cards: event.cards } : {}) }));
      const runs = (chat.runs ?? []).filter((run) => run.turnId !== event.turnId);
      if (chat.running?.turnId !== event.turnId) return withChat({ ...next, runs });
      // The other head's turn, if one runs, is the one shown now.
      const other = runs[0];
      return withChat({ ...next, runs, running: other ? { turnId: other.turnId, messageId: other.messageId } : null, live: other?.live ?? [] });
    }
    case "files.updated":
      return withChat({ ...chat, pendingFiles: event.files });
    case "heads.updated":
      return withChat({ ...chat, heads: event.heads });
    case "pins.updated":
      return withChat({ ...chat, pins: event.pins, floating: event.floating, pinChoices: event.pinChoices });
    case "catchup.updated":
      return withChat({ ...chat, catchUp: event.catchUp, intervalSummaries: event.intervalSummaries });
    case "card.updated":
      return withChat(update(event.messageId, (message) => ({
        ...message,
        cards: message.cards?.map((card) => (card.id === event.cardId ? { ...card, data: event.data === "null" ? null : event.data } : card)),
      })));
    case "card.acted":
      return view;
    default:
      return view;
  }
}
