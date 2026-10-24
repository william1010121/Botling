// The card broker: the only listener for card frames' postMessage. A message counts only if it
// came from a frame the app registered (matched by `event.source`, never by anything in the
// message), from an opaque origin (the frame is still sandboxed), and matches the strict CardMessage
// schema (so extra fields like a bot or card id are refused, not ignored). Then it becomes a
// contract command with the frame's own message and card ids, which the core checks again.
import { CardMessage } from "../contract";

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

export interface Refusal { at: number; reason: string; card: string | null }

const RATE = { burst: 20, perSecond: 10 };

export class CardBroker {
  private targets = new Set<CardTarget>();
  private buckets = new WeakMap<CardTarget, { tokens: number; at: number }>();
  readonly refusals: Refusal[] = [];
  readonly accepted: { card: string; kind: string }[] = [];

  constructor(private actions: BrokerActions, private target: Window = window) {
    target.addEventListener("message", this.onMessage);
  }

  register(target: CardTarget): () => void {
    this.targets.add(target);
    return () => this.targets.delete(target);
  }

  /** Sends a card its data. Only to the registered frame, and only while it still shows its card. */
  sendData(target: CardTarget, data: string | null) {
    if (data === null) return;
    target.frame.contentWindow?.postMessage({ ccbData: data }, "*");
  }

  private refuse(reason: string, card: CardTarget | null) {
    const entry = { at: Date.now(), reason, card: card ? `${card.messageId}/${card.cardId}` : null };
    this.refusals.push(entry);
    if (this.refusals.length > 200) this.refusals.shift();
    console.warn(`[card broker] refused: ${reason}`, entry.card ?? "");
  }

  private allow(target: CardTarget): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(target) ?? { tokens: RATE.burst, at: now };
    bucket.tokens = Math.min(RATE.burst, bucket.tokens + ((now - bucket.at) / 1000) * RATE.perSecond);
    bucket.at = now;
    this.buckets.set(target, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private onMessage = (event: MessageEvent) => {
    // Not from a card frame at all (this page itself, or the page it sits in): not ours to handle.
    if (event.source === this.target || (this.target.parent !== this.target && event.source === this.target.parent)) return;
    let sender: CardTarget | null = null;
    for (const target of this.targets) if (target.frame.contentWindow && target.frame.contentWindow === event.source) sender = target;
    if (!sender) {
      this.refuse("a message from a frame that is not a registered card", null);
      return;
    }
    if (event.origin !== "null") {
      this.refuse(`a card frame with origin ${event.origin} (expected an opaque, sandboxed origin)`, sender);
      return;
    }
    const parsed = CardMessage.safeParse(event.data);
    if (!parsed.success) {
      const kind = (event.data as { ccb?: unknown } | null)?.ccb;
      this.refuse(`a message that is not a valid ccb call (${typeof kind === "string" ? kind.slice(0, 40) : typeof event.data})`, sender);
      return;
    }
    const message = parsed.data;
    if (message.ccb === "size") {
      sender.onSize?.(message.height);
      return;
    }
    if (!this.allow(sender)) {
      this.refuse("too many calls", sender);
      return;
    }
    if (message.ccb === "save") {
      try {
        const value = JSON.parse(message.data);
        if (value === null) throw new Error();
      } catch {
        this.refuse("ccb.save with data that is not JSON", sender);
        return;
      }
      this.accepted.push({ card: `${sender.messageId}/${sender.cardId}`, kind: "save" });
      this.actions.save(sender, message.data).catch((error) => this.refuse(`the core refused a save: ${(error as Error).message}`, sender));
    } else {
      this.accepted.push({ card: `${sender.messageId}/${sender.cardId}`, kind: `action:${message.name}` });
      this.actions.action(sender, message.name, message.value).catch((error) => this.refuse(`the core refused an action: ${(error as Error).message}`, sender));
    }
  };
}
