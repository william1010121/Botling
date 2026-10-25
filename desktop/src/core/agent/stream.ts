// Reading `claude --output-format stream-json` line by line, for the long-lived head: what each
// line means (text, a tool call and its result, a permission request, the end of a turn), as
// plain items. Ported from the Swift app's `StreamEvent` (activity titles, permission summaries).

import { claudeRateLimits, claudeUsage, type RateLimits, type TokenUsage } from "../usage";

import type { SubagentRuntime } from "../subagents";

export type StreamItem =
  | { kind: "init"; sessionId: string }
  /** A piece of the reply's text (`--include-partial-messages`). */
  | { kind: "delta"; text: string }
  /** A new text block started (after a tool call): the next text is a new paragraph. */
  | { kind: "textBlock" }
  /** A whole assistant message's text (used only when no deltas came). */
  | { kind: "assistantText"; text: string }
  | { kind: "toolUse"; id: string; tool: string; title: string; detail: string; parent: string | null; input: Record<string, unknown> }
  /** What a tool call gave back; `parent`: a subagent's call. `launch`: an Agent call's structured result. */
  | { kind: "toolResult"; id: string; output: string; failed: boolean; parent: string | null; launch: Launch | null }
  /** Words a subagent said (its own assistant text). */
  | { kind: "subagentText"; parent: string; text: string }
  /** claude started a subagent (`task_started`, local_agent): it may run on in the background. */
  | { kind: "subagentStarted"; id: string; description: string; type: string | null; prompt: string; background: boolean }
  | { kind: "subagentRuntime"; id: string; runtime: SubagentRuntime; model?: string }
  | { kind: "subagentOutput"; id: string; counter: string; tokens: number }
  /** A subagent ended (`task_notification`): its status and report. */
  | { kind: "subagentEnded"; id: string; status: string; summary: string | null }
  /** A notification that is not a report: the subagent waits on its own background work. */
  | { kind: "subagentWaiting"; id: string }
  /** claude asks to use a tool (`--permission-prompt-tool stdio`). */
  | { kind: "permission"; requestId: string; tool: string; summary: string; input: Record<string, unknown> }
  | { kind: "permissionCancelled"; requestId: string }
  /** A control request the app does not handle: answer it with an error so claude does not wait. */
  | { kind: "unsupportedRequest"; requestId: string; subtype: string }
  | { kind: "controlResponse"; requestId: string }
  /** A message sent with a `uuid` (`command_lifecycle`): read into claude's queue, or its own turn starts. */
  | { kind: "command"; id: string; state: "queued" | "started" }
  /** The turn ended. */
  | { kind: "result"; ok: boolean; text: string; error: string; subtype: string }
  /** The session's cost so far (dollars; Codex: 0) and this turn's tokens (Phase 5c, 1.x's `.usage`). */
  | { kind: "usage"; totalCost: number; tokens: TokenUsage }
  /** The subscription's limits as the CLI last reported them (`.rateLimits`, `.codexRateLimits`). */
  | { kind: "rateLimits"; engine: "claude" | "codex"; limits: RateLimits };

/** An Agent call's structured result (`LaunchResult`): its agentId, and whether it went on in the background. */
export interface Launch { agentId: string | null; background: boolean }

function launchOf(value: unknown): Launch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const text = (key: string) => (typeof object[key] === "string" && object[key] ? (object[key] as string) : null);
  const agentId = text("agentId");
  const background = object.status === "async_launched" || object.isAsync === true || text("backgroundTaskId") !== null;
  return agentId || background ? { agentId, background } : null;
}

/** `StreamEvent.isStillWaiting`: claude's words for a subagent that has not reported yet. */
const stillWaiting = (summary: string) => summary.endsWith("is waiting on its own background work");

const LONGEST = 4_000;
const cut = (text: string, limit = LONGEST) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** "Run swift build", "Edit template.html" (StreamEvent.activity). */
export function activity(tool: string, input: Record<string, unknown>): string {
  const verbs: Record<string, string> = {
    Read: "Read", Write: "Write", Edit: "Edit", Bash: "Run", Glob: "Find files", Grep: "Search",
    WebSearch: "Search", WebFetch: "Open page", Task: "Delegate", Agent: "Delegate",
  };
  const verb = verbs[tool] ?? tool;
  let target: string | null = null;
  if (typeof input.file_path === "string") target = input.file_path.split(/[\\/]/).pop() ?? input.file_path;
  else {
    for (const key of ["command", "pattern", "query", "url", "description"]) {
      const value = input[key];
      if (typeof value === "string" && value) {
        const line = value.split(/\r?\n/)[0]!;
        target = line.length > 60 ? `${line.slice(0, 60)}…` : line;
        break;
      }
    }
  }
  return target ? `${verb} ${target}` : verb;
}

/** What the user is asked to allow: what will actually run, in full (StreamEvent.permissionSummary). */
export function permissionSummary(tool: string, input: Record<string, unknown>, description?: string): string {
  if (typeof input.command === "string") {
    const command = input.command;
    return command.length > 2_000 ? `${command.slice(0, 2_000)}\n… (${command.length} characters in all)` : command;
  }
  for (const key of ["file_path", "notebook_path", "path", "url"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  if (description) return description.length > 300 ? `${description.slice(0, 300)}…` : description;
  const json = JSON.stringify(input, Object.keys(input).sort());
  return json.length > 600 ? `${json.slice(0, 600)}…` : json;
}

function detail(tool: string, input: Record<string, unknown>): string {
  for (const key of ["command", "file_path", "pattern", "query", "url", "prompt", "description"]) {
    const value = input[key];
    if (typeof value === "string" && value) return cut(value);
  }
  return cut(JSON.stringify(input));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
  }
  return "";
}

/** The items one stream-json line stands for (none for a line that is not JSON). */
export function parseLine(line: string): StreamItem[] {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return []; // A warning on stdout: ignored, as the Swift side does.
  }
  if (!message || typeof message !== "object") return [];
  switch (message.type) {
    case "system":
      if (message.subtype === "init") return typeof message.session_id === "string" ? [{ kind: "init", sessionId: message.session_id }] : [];
      if (message.subtype === "task_started") {
        // Background shell commands and Monitors start tasks too; only agents are subagents.
        const type = typeof message.task_type === "string" ? message.task_type : null;
        if (typeof message.tool_use_id !== "string" || !(type === "local_agent" || (type === null && message.subagent_type != null))) return [];
        return [{
          kind: "subagentStarted", id: message.tool_use_id,
          description: typeof message.description === "string" ? message.description : "",
          type: typeof message.subagent_type === "string" ? message.subagent_type : null,
          prompt: typeof message.prompt === "string" ? message.prompt : "",
          background: message.is_backgrounded === true,
        }];
      }
      if (message.subtype === "task_notification") {
        const id = typeof message.tool_use_id === "string" ? message.tool_use_id : typeof message.task_id === "string" ? message.task_id : null;
        if (!id) return [];
        const status = typeof message.status === "string" ? message.status : "completed";
        const report = typeof message.handback_report?.text === "string" && message.handback_report.text ? message.handback_report.text : null;
        const summary = report ?? (typeof message.summary === "string" ? message.summary : null);
        if (status === "completed" && message.handback == null && summary !== null && stillWaiting(summary)) return [{ kind: "subagentWaiting", id }];
        return [{ kind: "subagentEnded", id, status, summary }];
      }
      return [];
    case "stream_event": {
      // Partial chunks of the main conversation only; a subagent's words are not the reply.
      if (message.parent_tool_use_id) return [];
      const event = message.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        const text = String(event.delta.text ?? "");
        return text ? [{ kind: "delta", text }] : [];
      }
      if (event?.type === "content_block_start" && event.content_block?.type === "text") return [{ kind: "textBlock" }];
      return [];
    }
    case "assistant": {
      const parent = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
      const content: any[] = Array.isArray(message.message?.content) ? message.message.content : [];
      const items: StreamItem[] = [];
      if (parent) {
        const model = message.message?.model;
        if (typeof model === "string" && model && !model.startsWith("<")) items.push({ kind: "subagentRuntime", id: parent, runtime: { engine: "claude" }, model });
        const tokens = message.message?.usage?.output_tokens;
        const id = message.message?.id;
        if (typeof id === "string" && id && typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0) {
          items.push({ kind: "subagentOutput", id: parent, counter: `message:${id}`, tokens });
        }
      }
      for (const block of content) {
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const input = block.input && typeof block.input === "object" ? block.input : {};
          items.push({ kind: "toolUse", id: block.id, tool: block.name, title: activity(block.name, input), detail: detail(block.name, input), parent, input });
        }
      }
      const text = content.filter((part) => part?.type === "text").map((part) => String(part.text ?? "")).join("");
      if (text && !parent) items.push({ kind: "assistantText", text });
      if (text.trim() && parent) items.push({ kind: "subagentText", parent, text });
      return items;
    }
    case "user": {
      const parent = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
      const content: any[] = Array.isArray(message.message?.content) ? message.message.content : [];
      return content
        .filter((part) => part?.type === "tool_result" && typeof part.tool_use_id === "string")
        .map((part) => {
          const failed = part.is_error === true;
          return { kind: "toolResult" as const, id: part.tool_use_id, output: cut(resultText(part.content)), failed, parent, launch: failed ? null : launchOf(message.tool_use_result) };
        });
    }
    case "control_request": {
      const requestId = message.request_id;
      const request = message.request;
      if (typeof requestId !== "string" || !request) return [];
      if (request.subtype === "can_use_tool" && typeof request.tool_name === "string") {
        const input = request.input && typeof request.input === "object" ? request.input : {};
        return [{ kind: "permission", requestId, tool: request.tool_name, summary: permissionSummary(request.tool_name, input, request.description), input }];
      }
      return [{ kind: "unsupportedRequest", requestId, subtype: String(request.subtype ?? "") }];
    }
    case "command_lifecycle": {
      // A message sent with a `uuid`: queued when claude reads it, started when its turn begins (StreamEvent.swift).
      const id = typeof message.command_uuid === "string" ? message.command_uuid.toLowerCase() : null;
      const state = message.state === "queued" || message.state === "started" ? message.state : null;
      return id && state ? [{ kind: "command", id, state }] : [];
    }
    case "control_cancel_request":
      return typeof message.request_id === "string" ? [{ kind: "permissionCancelled", requestId: message.request_id }] : [];
    case "control_response": {
      const requestId = message.response?.request_id;
      return typeof requestId === "string" ? [{ kind: "controlResponse", requestId }] : [];
    }
    case "rate_limit_event": {
      const limits = claudeRateLimits(message);
      return limits ? [{ kind: "rateLimits", engine: "claude", limits }] : [];
    }
    case "result": {
      const usage = claudeUsage(message);
      const failed = message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success");
      const text = typeof message.result === "string" ? message.result : "";
      return [...(usage ? [{ kind: "usage" as const, ...usage }] : []), {
        kind: "result" as const, ok: !failed, text, subtype: String(message.subtype ?? ""),
        error: failed ? String(message.result ?? message.subtype ?? "The agent reported an error.").slice(0, 2_000) : "",
      }];
    }
    default:
      return [];
  }
}

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
