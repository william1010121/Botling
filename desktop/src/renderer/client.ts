// The renderer's side of the contract: typed requests with ids and cancellation over the preload
// bridge, and the event stream.
import {
  PROTOCOL_VERSION, ResponseEnvelope, EventEnvelope,
  type Command, type CommandType, type ResultOf, type WireError, type EventEnvelope as EventEnvelopeT,
} from "../contract";

export interface Bridge {
  protocol: number;
  post(envelope: unknown): void;
  subscribe(listener: (message: unknown) => void): () => void;
}

export class RequestFailed extends Error {
  constructor(public error: WireError) {
    super(`${error.code}: ${error.message}`);
  }
}

export class Client {
  private counter = 0;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  private eventListeners = new Set<(event: EventEnvelopeT) => void>();

  constructor(private bridge: Bridge) {
    bridge.subscribe((message) => this.receive(message));
  }

  private receive(message: unknown) {
    const event = EventEnvelope.safeParse(message);
    if (event.success) {
      for (const listener of this.eventListeners) listener(event.data);
      return;
    }
    const response = ResponseEnvelope.safeParse(message);
    if (!response.success) return;
    const pending = this.pending.get(response.data.id);
    if (!pending) return;
    this.pending.delete(response.data.id);
    if (response.data.ok) pending.resolve(response.data.result);
    else pending.reject(new RequestFailed(response.data.error));
  }

  request<T extends CommandType>(cmd: Extract<Command, { type: T }>, options: { signal?: AbortSignal } = {}): Promise<ResultOf<T>> {
    const id = `r${++this.counter}`;
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new RequestFailed({ code: "cancelled", message: "Cancelled before sending." }));
        return;
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      options.signal?.addEventListener("abort", () => this.bridge.post({ v: PROTOCOL_VERSION, cancel: id }), { once: true });
      this.bridge.post({ v: PROTOCOL_VERSION, id, cmd });
    });
  }

  onEvent(listener: (event: EventEnvelopeT) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}
