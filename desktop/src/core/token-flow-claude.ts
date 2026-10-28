import type { MeteredTurn } from "./token-flow-ledger";
import { noTokens, type TokenUsage } from "./usage";

export type ClaudeMeasurement = Omit<MeteredTurn, "botId" | "head" | "taskId">;
type Capture = { id: string; parent: string | null; startedAt: number; tokens: TokenUsage | null; activities: Set<MeteredTurn["activities"][number]> };
const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function tokens(usage: any): TokenUsage | null {
  if (!usage || ![usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0].every(count)) return null;
  // Claude input excludes both cache buckets. Thinking is already part of output.
  return { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
}
function activity(c: Capture, block: any) {
  if (block?.type !== "tool_use") return;
  c.activities.add(["Agent", "Task", "SendMessage"].includes(block.name) ? "coordination"
    : ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"].includes(block.name) ? "execution" : "unclassified");
}
/** Message IDs survive transport replay / process resume. Never add result.usage: that
 * aggregate can include children already measured here. Partial snapshots remain explicit. */
export class ClaudeTokenFlowMeter {
  private toolParents = new Map<string,string>();
  private active = new Map<string, Capture>();
  constructor(private session: string) {}
  observe(line: string, at = Date.now()): ClaudeMeasurement[] {
    let frame: any;
    try { frame = JSON.parse(line); } catch { return []; }
    if (!frame || typeof frame !== "object") return [];
    if (typeof frame.session_id === "string" && frame.session_id) this.session = frame.session_id;
    const parent = typeof frame.parent_tool_use_id === "string" && frame.parent_tool_use_id ? frame.parent_tool_use_id : null;
    const key = JSON.stringify([this.session, parent]);
    const event = frame.type === "stream_event" ? frame.event : null;
    const message = frame.type === "assistant" ? frame.message : event?.type === "message_start" ? event.message : null;
    let c = this.active.get(key);
    if (message && typeof message.id === "string" && message.id && !String(message.model ?? "").startsWith("<")) {
      if (!c || c.id !== message.id) {
        if (this.active.size >= 256) this.active.delete(this.active.keys().next().value!);
        c = { id: message.id, parent, startedAt: at, tokens: null, activities: new Set() };
        this.active.set(key, c);
      }
      c.tokens = tokens(message.usage) ?? c.tokens;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        activity(c, block);
        if (block?.type === "tool_use" && typeof block.id === "string") this.toolParents.set(block.id,parent ? `${this.session}:${parent}` : this.session);
      }
    }
    if (!c) return [];
    if (event?.type === "content_block_start") {
      activity(c, event.content_block);
      const block=event.content_block;
      if (block?.type === "tool_use" && typeof block.id === "string") this.toolParents.set(block.id,parent ? `${this.session}:${parent}` : this.session);
    }
    if(this.toolParents.size>4096) this.toolParents.delete(this.toolParents.keys().next().value!);
    if (event?.type === "message_delta" && count(event.usage?.output_tokens) && c.tokens) c.tokens = { ...c.tokens, output: event.usage.output_tokens };
    const complete = event?.type === "message_stop" || (typeof message?.stop_reason === "string" && !!message.stop_reason);
    if (!message && event?.type !== "message_delta" && event?.type !== "message_stop" && event?.type !== "content_block_start") return [];
    const record: ClaudeMeasurement = {
      threadId: parent ? `${this.session}:${parent}` : this.session, turnId: `message:${c.id}`,
      workerId: parent, parentThreadId: parent ? this.toolParents.get(parent) ?? null : null, run: null,
      startedAt: c.startedAt, endedAt: at, source: "provider-message", scope: "exclusive",
      tokens: c.tokens ?? noTokens(), ...(c.tokens ? {} : { missingUsage: true }),
      activities: [...c.activities].sort(), complete: complete && c.tokens !== null,
    };
    if (complete) this.active.delete(key);
    return [record];
  }
}
