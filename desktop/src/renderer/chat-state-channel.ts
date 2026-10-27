import type { ChatState, StatePatch } from "../../../Web/src/types";
import type { FrameExtras } from "./payload";
import type { ShellMessage } from "./chat-frame/protocol";

export interface ChatPacket {
  state: ChatState;
  extras: FrameExtras;
  libraryVersion: number;
  resyncs: number;
  messageColumnWidth: number | null;
  traceId?: string;
}

/** Batches business updates before building/serializing them. Ready/resync bypass the timer. */
export class ChatStateChannel {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last: ChatPacket | undefined;
  private revision = 0;
  private messages = new Map<string, string>();
  constructor(private build: () => ChatPacket | null, private send: (message: ShellMessage) => void) {}

  schedule = () => {
    if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 32);
  };
  reset = () => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.last = undefined;
    this.messages.clear();
  };
  flush = (full = false) => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const packet = this.build();
    if (!packet) return;
    const { state, extras, messageColumnWidth, traceId } = packet;
    const previous = this.last;
    const next = new Map(state.messages.map(message => [message.id, JSON.stringify(message)]));
    const revision = this.revision + 1;
    if (full || !previous || previous.state.botID !== state.botID || previous.resyncs !== packet.resyncs) {
      this.send({ botling: "state", state, extras, messageColumnWidth, traceId, revision });
    } else {
      const { messages: _messages, components: _components, ...base } = state;
      const { messages: _oldMessages, components: _oldComponents, ...oldBase } = previous.state;
      const patch: StatePatch = { order: state.messages.map(message => message.id),
        changed: state.messages.filter(message => next.get(message.id) !== this.messages.get(message.id)) };
      if (JSON.stringify(base) !== JSON.stringify(oldBase)) patch.base = base;
      if (packet.libraryVersion !== previous.libraryVersion) patch.components = state.components;
      if (!patch.changed.length && !patch.base && !patch.components
        && JSON.stringify(patch.order) === JSON.stringify(previous.state.messages.map(message => message.id))
        && JSON.stringify(extras) === JSON.stringify(previous.extras) && messageColumnWidth === previous.messageColumnWidth) return;
      this.send({ botling: "stateDelta", botID: state.botID, baseRevision: this.revision, revision,
        patch, extras, messageColumnWidth, traceId });
    }
    this.revision = revision;
    this.last = packet;
    this.messages = next;
  };
}
