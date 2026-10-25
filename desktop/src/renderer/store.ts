// The workspace as the renderer knows it: every bot (for the left column) and the chat of the bot
// on screen, from a snapshot plus the events after it. Events carry the core's epoch and a
// gapless seq; a new epoch (the core restarted) or a gap means the view may be wrong, so the store
// takes a fresh snapshot instead of patching on guesses. Events that arrive while a snapshot is
// on its way are buffered and replayed if newer than it. Chat events for other bots are not
// kept (their chats are fetched when shown); `bot.updated` is kept for every bot.
import type { SpecStateView, TeamRunView, WebStateView, WaitingView, PendingFileView, PluginsView, SettingsView, BotView, CatchUpView, ComponentInfoView, PinChoiceView, PinView, Event, EventEnvelope, HeadsView, ImportView, MessageView, ResultOf, RunningView, StepView, SubagentView, TaskView } from "../contract";

/** A turn under way and its steps so far (with two heads, two can run at once). */
export interface RunState { turnId: string; messageId: string; live: StepView[] }

export interface ChatView {
  botId: string;
  messages: MessageView[];
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
  /** What waits on you across the bots, and managers' "In progress" (the right panel). */
  waiting: WaitingView;
  /** The web AIs: their sites, conversations and what their pages show. */
  web: WebStateView | null;
  /** The component spec open in the right panel (Phase 5a), if any. */
  spec?: SpecStateView | null;
  /** The temporary teams at work (the main bot's Now card). */
  teams: TeamRunView[];
}

type Snapshot = ResultOf<"chat.snapshot">;

export class WorkspaceStore {
  private view: WorkspaceView = { ready: false, bots: [], imported: null, chat: null, subagent: null, resyncs: 0, components: {}, board: false, plugins: null, settings: null, waiting: { items: [], doing: {} }, web: null, teams: [], spec: null };
  private epoch: string | null = null;
  private seq = 0;
  private syncing = false;
  private again = false;
  private wanted: string | undefined;
  private buffer: EventEnvelope[] = [];
  private listeners = new Set<() => void>();

  constructor(private fetchSnapshot: (botId?: string) => Promise<Snapshot>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getView = () => this.view;

  private set(view: WorkspaceView) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }

  /** Shows another bot's chat (fetched fresh). */
  select(botId: string) {
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
    try {
      const snapshot = await this.fetchSnapshot(this.wanted);
      this.epoch = snapshot.epoch;
      this.seq = snapshot.seq;
      const subagent = this.view.subagent && snapshot.chat?.botId === this.view.chat?.botId ? this.view.subagent : null;
      const chat = snapshot.chat ? { ...snapshot.chat, runs: (snapshot.chat.runs ?? []).map((run) => ({ turnId: run.turnId, messageId: run.messageId, live: run.live })) } : null;
      const board = this.view.board && chat?.botId === this.view.chat?.botId;
      this.set({ ready: true, bots: snapshot.bots, imported: snapshot.imported, chat, subagent, resyncs: this.view.resyncs + 1, components: snapshot.components ?? {}, board, plugins: snapshot.plugins ?? null, settings: snapshot.settings ?? this.view.settings, waiting: snapshot.waiting ?? this.view.waiting, web: snapshot.web ?? this.view.web, teams: snapshot.teams ?? this.view.teams, spec: snapshot.spec ?? null });
    } finally {
      this.syncing = false;
    }
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
  if (event.type === "settings.updated") return { ...view, settings: event.settings };
  if (event.type === "waiting.updated") return { ...view, waiting: event.waiting };
  if (event.type === "spec.updated") return { ...view, spec: event.spec };
  if (event.type === "web.updated") return { ...view, web: event.web };
  if (event.type === "teams.updated") return { ...view, teams: event.teams };
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
    case "subagent.updated":
      return view.subagent?.id === event.subagent.id ? { ...view, subagent: event.subagent } : view;
    case "message.added":
      if (chat.messages.some((message) => message.id === event.message.id)) return view;
      return withChat({ ...chat, messages: [...chat.messages, event.message] });
    case "message.updated":
      if (!chat.messages.some((message) => message.id === event.message.id)) return withChat({ ...chat, messages: [...chat.messages, event.message] });
      return withChat(update(event.message.id, () => event.message));
    case "turn.started": {
      const runs = [...(chat.runs ?? []).filter((run) => run.turnId !== event.turnId), { turnId: event.turnId, messageId: event.messageId, live: [] }];
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
