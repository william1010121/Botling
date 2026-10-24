// The chat as the renderer knows it: a snapshot plus the events after it. Events carry the core's
// epoch and a gapless seq; a new epoch (the core restarted) or a gap means the view may be wrong,
// so the store asks for a fresh snapshot instead of patching on guesses. Events that arrive while a
// snapshot is on its way are buffered and replayed if newer than it.
import type { Event, EventEnvelope, MessageView, ResultOf } from "../contract";

export interface ChatView {
  ready: boolean;
  messages: MessageView[];
  running: string | null;
  /** Times the store re-synced from a snapshot (for tests and diagnostics). */
  resyncs: number;
}

export class ChatStore {
  private view: ChatView = { ready: false, messages: [], running: null, resyncs: 0 };
  private epoch: string | null = null;
  private seq = 0;
  private syncing = false;
  private buffer: EventEnvelope[] = [];
  private listeners = new Set<() => void>();

  constructor(private fetchSnapshot: () => Promise<ResultOf<"chat.snapshot">>) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getView = () => this.view;

  private set(view: ChatView) {
    this.view = view;
    for (const listener of this.listeners) listener();
  }

  async resync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const snapshot = await this.fetchSnapshot();
      this.epoch = snapshot.epoch;
      this.seq = snapshot.seq;
      this.set({ ready: true, messages: snapshot.messages, running: snapshot.running, resyncs: this.view.resyncs + 1 });
    } finally {
      this.syncing = false;
    }
    const buffered = this.buffer;
    this.buffer = [];
    for (const envelope of buffered) this.receive(envelope);
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

export function apply(view: ChatView, event: Event): ChatView {
  const update = (id: string, change: (message: MessageView) => MessageView): ChatView => ({
    ...view,
    messages: view.messages.map((message) => (message.id === id ? change(message) : message)),
  });
  switch (event.type) {
    case "message.added":
      if (view.messages.some((message) => message.id === event.message.id)) return view;
      return { ...view, messages: [...view.messages, event.message] };
    case "turn.started":
      return { ...view, running: event.turnId };
    case "turn.delta":
      return update(event.messageId, (message) => ({ ...message, text: message.text + event.text }));
    case "turn.finished": {
      const next = update(event.messageId, (message) => ({ ...message, text: event.text, state: event.status, ...(event.cards ? { cards: event.cards } : {}) }));
      return { ...next, running: view.running === event.turnId ? null : view.running };
    }
    case "card.updated":
      return update(event.messageId, (message) => ({
        ...message,
        cards: message.cards?.map((card) => (card.id === event.cardId ? { ...card, data: event.data === "null" ? null : event.data } : card)),
      }));
    case "card.acted":
      return view;
  }
}
