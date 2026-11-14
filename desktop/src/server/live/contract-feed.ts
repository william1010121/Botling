// Feeds the 2.x core's contract events (core/main.ts `emit`) into the live channel (D10: `turn.delta` goes here,
// never into the log). Only the turn events matter:
// - `turn.started` → start; `turn.finished` → end (the log's entries replace the live text);
// - `turn.delta` → append; `message.updated` of the running turn's line → its whole text so far (the core sends it
//   when the shown text is not an extension, e.g. a held-back tag was dropped);
// - `turn.steps` with more steps than before → a step boundary (a tool call or card started a new step). The caller
//   commits the finished segment in its own `turn.steps` entry; see live-channel.ts for the order.
// Returns whether the event was the live channel's (callers still put every other event in the log).
import type { Event as ContractEvent } from "../../contract";
import type { LiveChannel } from "./live-channel";

interface Known {
  turnId: string;
  messageId: string;
  steps: number;
}

export class ContractLiveFeed {
  private readonly turns = new Map<string, Known>();

  constructor(private readonly live: LiveChannel) {}

  feed(event: ContractEvent): boolean {
    switch (event.type) {
      case "turn.started":
        this.turns.set(event.botId, { turnId: event.turnId, messageId: event.messageId, steps: 0 });
        this.live.start(event.botId, event.turnId);
        return false; // also an entry
      case "turn.delta":
        this.live.delta(event.botId, event.turnId, event.text);
        return true;
      case "turn.steps": {
        const known = this.turns.get(event.botId);
        if (known && known.turnId === event.turnId && event.steps.length > known.steps) {
          known.steps = event.steps.length;
          this.live.step(event.botId, event.turnId);
        }
        return false;
      }
      case "message.updated": {
        const known = this.turns.get(event.botId);
        if (known && known.messageId === event.message.id) this.live.replaceTurnText(event.botId, known.turnId, event.message.text);
        return false;
      }
      case "turn.finished": {
        const known = this.turns.get(event.botId);
        if (known && known.turnId === event.turnId) this.turns.delete(event.botId);
        this.live.end(event.botId, event.turnId);
        return false;
      }
      default:
        return false;
    }
  }
}
