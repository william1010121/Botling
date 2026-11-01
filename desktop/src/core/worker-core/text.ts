// Text joining, one copy (shared-core spec 2.2). `ReplyText` is the head's reply (moved here from agent/stream.ts,
// which re-exports it unchanged); `TextBlocks` is a worker run's words as steps: streamed chunks cut words and code
// spans, so they join into one block that shows as one step when it closes.
import type { StreamItem } from "../agent/stream";
import type { WorkerEvent } from "./events";

/**
 * One turn's reply text from its items: deltas when claude sends them, else whole assistant
 * messages; a later text block (after a tool call) starts a new paragraph.
 */
export class ReplyText {
  text = "";
  private sawDelta = false;
  private pendingBreak = false;

  /** Feeds an item; returns the new text it added (to stream), or "". */
  add(item: StreamItem): string {
    if (item.kind === "textBlock") {
      if (this.text) this.pendingBreak = true;
      return "";
    }
    if (item.kind === "delta") {
      this.sawDelta = true;
      let piece = item.text;
      if (this.pendingBreak) {
        this.pendingBreak = false;
        piece = `\n\n${piece}`;
      }
      this.text += piece;
      return piece;
    }
    if (item.kind === "assistantText" && !this.sawDelta) {
      const piece = this.text ? `\n\n${item.text}` : item.text;
      this.text += piece;
      return piece;
    }
    if (item.kind === "result" && item.ok && !this.text && item.text) {
      this.text = item.text;
      return item.text;
    }
    return "";
  }
}

/** One closed text block of a worker's run: one `subagentText` step. */
export interface TextBlock { text: string; phase: "commentary" | "final" | null }

/**
 * A run's words as blocks: chunks join into one block; a block closes at textBreak, toolUse, toolResult, a whole
 * message, or the end. Rules:
 * 1. `textDelta` joins the open block and closes nothing.
 * 2. `textBreak`, `toolUse`, `toolResult` and `end` close the open block (shown only if non-blank).
 * 3. `textWhole` is the whole of the message the open block's chunks were streaming (claude sends both): the chunks
 *    are dropped and the whole message is the block it closes.
 * 4. `last` is the newest block that is not commentary (a run's default report).
 */
export class TextBlocks {
  private open = "";
  private lastFinal = "";

  /** Feeds one event; returns the blocks it CLOSED (each is one step), in order. */
  add(event: WorkerEvent): TextBlock[] {
    switch (event.type) {
      case "textDelta":
        this.open += event.text;
        return [];
      case "textWhole":
        this.open = "";
        return this.close(event.text, event.phase);
      case "textBreak": case "toolUse": case "toolResult": case "end":
        return this.flush();
      default:
        return [];
    }
  }

  /** Closes the open block (the run ended). */
  flush(): TextBlock[] {
    const text = this.open;
    this.open = "";
    return this.close(text, null);
  }

  /** The run's last non-commentary block so far (the default report). */
  get last(): string { return this.lastFinal; }

  private close(text: string, phase: TextBlock["phase"]): TextBlock[] {
    if (!text.trim()) return [];
    if (phase !== "commentary") this.lastFinal = text;
    return [{ text, phase }];
  }
}
