// The workspace as the renderer knows it: every bot (for the left column) and the chat of the bot
// on screen, from a snapshot plus the events after it. Events carry the core's epoch and a
// gapless seq; a new epoch (the core restarted) or a gap means the view may be wrong, so the store
// takes a fresh snapshot instead of patching on guesses. Events that arrive while a snapshot is
// on its way are buffered and replayed if newer than it. Chat events for other bots are not
// kept (their chats are fetched when shown); `bot.updated` is kept for every bot.
import type { BotView, Event, EventEnvelope, ImportView, MessageView, ResultOf, RunningView, StepView } from "../contract";

export interface ChatView {
  botId: string;
  messages: MessageView[];
  running: RunningView | null;
  /** The running turn's steps so far. */
  live: StepView[];
}

export interface WorkspaceView {
  ready: boolean;
  bots: BotView[];
  imported: ImportView | null;
  chat: ChatView | null;
  /** Times the store re-synced from a snapshot (for tests and diagnostics). */
  resyncs: number;
}

type Snapshot = ResultOf<"chat.snapshot">;

export class WorkspaceStore {
  private view: WorkspaceView = { ready: false, bots: [], imported: null, chat: null, resyncs: 0 };
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
    return this.resync();
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
      this.set({ ready: true, bots: snapshot.bots, imported: snapshot.imported, chat: snapshot.chat, resyncs: this.view.resyncs + 1 });
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
    this.set(apply(this.view, envelope.event));
  }
}

export function apply(view: WorkspaceView, event: Event): WorkspaceView {
  if (event.type === "bot.updated") {
    const bots = view.bots.some((bot) => bot.id === event.bot.id)
      ? view.bots.map((bot) => (bot.id === event.bot.id ? event.bot : bot))
      : [...view.bots, event.bot];
    return { ...view, bots };
  }
  const chat = view.chat;
  if (!chat || event.botId !== chat.botId) return view;
  const withChat = (next: ChatView): WorkspaceView => ({ ...view, chat: next });
  const update = (id: string, change: (message: MessageView) => MessageView): ChatView => ({
    ...chat,
    messages: chat.messages.map((message) => (message.id === id ? change(message) : message)),
  });
  switch (event.type) {
    case "message.added":
      if (chat.messages.some((message) => message.id === event.message.id)) return view;
      return withChat({ ...chat, messages: [...chat.messages, event.message] });
    case "message.updated":
      if (!chat.messages.some((message) => message.id === event.message.id)) return withChat({ ...chat, messages: [...chat.messages, event.message] });
      return withChat(update(event.message.id, () => event.message));
    case "turn.started":
      return withChat({ ...chat, running: { turnId: event.turnId, messageId: event.messageId }, live: [] });
    case "turn.delta":
      return withChat(update(event.messageId, (message) => ({ ...message, text: message.text + event.text })));
    case "turn.steps":
      if (chat.running?.turnId !== event.turnId) return view;
      return withChat({ ...chat, live: event.steps });
    case "turn.finished": {
      const next = update(event.messageId, (message) => ({ ...message, text: event.text, state: event.status, ...(event.cards ? { cards: event.cards } : {}) }));
      return withChat({ ...next, ...(chat.running?.turnId === event.turnId ? { running: null, live: [] } : {}) });
    }
    case "card.updated":
      return withChat(update(event.messageId, (message) => ({
        ...message,
        cards: message.cards?.map((card) => (card.id === event.cardId ? { ...card, data: event.data === "null" ? null : event.data } : card)),
      })));
    case "card.acted":
      return view;
  }
}
