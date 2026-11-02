// The card broker: bots' cards in the chat page, heard through the frame broker (frame-broker.ts:
// a message counts only if it came from a frame registered here, matched by `event.source`, with an
// opaque origin; each card is paced). A card's message must match the strict CardMessage schema (so
// extra fields like a bot or card id are refused, not ignored). Then it becomes a contract command
// with the frame's own message and card ids, which the core checks again.
import { frameOf } from "../../../Web/src/frame-protocol";
import { CardMessage } from "../contract";
import { FrameBroker, type FrameTarget, type Refusal } from "./frame-broker";

export type { Refusal } from "./frame-broker";

export interface CardTarget {
  botId: string;
  messageId: string;
  cardId: string;
  frame: HTMLIFrameElement;
  onSize?: (height: number) => void;
}

export interface BrokerActions {
  save(target: CardTarget, data: string): Promise<unknown>;
  action(target: CardTarget, name: string, value: string): Promise<unknown>;
}

const COMPONENT_FRAMES = "iframe.component-frame";

export class CardBroker {
  private frames: FrameBroker;
  readonly accepted: { card: string; kind: string }[] = [];

  constructor(private actions: BrokerActions, target: Window = window) {
    // A library component's frame: the chat page's own component broker (Web/src) answers it.
    const component = (source: MessageEventSource | null) => !!frameOf(target.document.querySelectorAll<HTMLIFrameElement>(COMPONENT_FRAMES), source);
    this.frames = new FrameBroker(target, { ignore: component, name: "card broker", frame: "card" });
  }

  get refusals(): Refusal[] {
    return this.frames.refusals;
  }

  register(target: CardTarget): () => void {
    const frame: FrameTarget = { frame: target.frame, label: `${target.messageId}/${target.cardId}`, receive: (data) => this.receive(target, frame, data) };
    return this.frames.register(frame);
  }

  /** Sends a card its data. Only to the registered frame, and only while it still shows its card. */
  sendData(target: CardTarget, data: string | null) {
    if (data === null) return;
    target.frame.contentWindow?.postMessage({ ccbData: data }, "*");
  }

  private receive(sender: CardTarget, frame: FrameTarget, data: unknown) {
    const parsed = CardMessage.safeParse(data);
    if (!parsed.success) {
      const kind = (data as { ccb?: unknown } | null)?.ccb;
      this.frames.refuse(`a message that is not a valid ccb call (${typeof kind === "string" ? kind.slice(0, 40) : typeof data})`, frame);
      return;
    }
    const message = parsed.data;
    if (message.ccb === "size") {
      sender.onSize?.(message.height);
      return;
    }
    if (!this.frames.allow(frame)) {
      this.frames.refuse("too many calls", frame);
      return;
    }
    if (message.ccb === "save") {
      try {
        const value = JSON.parse(message.data);
        if (value === null) throw new Error();
      } catch {
        this.frames.refuse("ccb.save with data that is not JSON", frame);
        return;
      }
      this.accepted.push({ card: frame.label, kind: "save" });
      this.actions.save(sender, message.data).catch((error) => this.frames.refuse(`the core refused a save: ${(error as Error).message}`, frame));
    } else {
      this.accepted.push({ card: frame.label, kind: `action:${message.name}` });
      this.actions.action(sender, message.name, message.value).catch((error) => this.frames.refuse(`the core refused an action: ${(error as Error).message}`, frame));
    }
  }
}
