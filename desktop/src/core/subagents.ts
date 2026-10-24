// A bot's subagents (the Agent tool's), followed from claude's stream as the Swift `TraceBook`
// does (Trace.swift), and kept in subagents.json in 1.x's `Subagent` format: what each was sent
// to do, its tool calls and words (lines with its `parent_tool_use_id`), how it ended and what it
// handed back. A subagent sent to the background ends only with its `task_notification`.
//
// Dates are Swift dates (seconds since 2001); keys 2.0 does not know are kept on each record.
import type { Launch } from "./agent/stream";
import { characterPrefix } from "./briefing";
import { toSwiftDate, type StepRecord } from "./store/records";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

export interface SubagentRecord {
  id: string;
  description: string;
  type?: string;
  prompt: string;
  status: SubagentStatus;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  steps: StepRecord[];
  result?: string;
  parentID?: string;
  name?: string;
  agentID?: string;
  model?: string;
  [key: string]: unknown;
}

/** `TraceBook.subagentTools`. */
export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/** `TraceBook.keptSubagents`: the newest ended ones kept; running ones always stay. */
const KEPT = 40;
const STATUSES = new Set<SubagentStatus>(["running", "completed", "failed", "stopped"]);

/** `TaskEnd`: claude's words for how a task ended. */
function ended(status: string): SubagentStatus {
  const word = status.toLowerCase();
  if (word === "completed" || word === "done") return "completed";
  if (word === "failed" || word === "error") return "failed";
  return "stopped";
}

/** What a subagent is for, from its call (`subagentDescribed`): the description's first line, else the prompt's, ≤ 60 characters. */
function describe(input: Record<string, unknown>): string {
  const firstLine = (text: string) => text.split(/[\n\r\u2028\u2029]+/).find((line) => line.length > 0) ?? "";
  const about = typeof input.description === "string" ? input.description.trim() : "";
  const said = about ? firstLine(about) : typeof input.prompt === "string" ? firstLine(input.prompt) : "";
  return [...said].length > 60 ? `${characterPrefix(said, 60)}…` : said;
}

export function readSubagent(value: unknown): SubagentRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.startedAt !== "number") return null;
  return {
    ...raw,
    id: raw.id,
    description: typeof raw.description === "string" ? raw.description : "",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    status: STATUSES.has(raw.status as SubagentStatus) ? (raw.status as SubagentStatus) : "stopped",
    background: raw.background === true,
    startedAt: raw.startedAt,
    steps: Array.isArray(raw.steps) ? (raw.steps as StepRecord[]).filter((step) => step && typeof step.id === "string") : [],
  };
}

/** Its tool calls so far (`Subagent.toolCount`). */
export const toolCount = (subagent: SubagentRecord) => subagent.steps.filter((step) => step.kind === "tool" || step.kind === "subagent").length;

export class SubagentBook {
  constructor(public list: SubagentRecord[] = []) {}

  get(id: string) { return this.list.find((subagent) => subagent.id === id); }
  /** By its call's id, or by the agentId/name claude reaches it by. */
  private resolve(id: string) { return this.get(id) ?? this.list.findLast((subagent) => subagent.agentID === id || subagent.name === id); }
  get running() { return this.list.filter((subagent) => subagent.status === "running"); }

  /** A tool call: a step of the subagent it is in (`parent`), and a new subagent if it is an Agent call. True when the list changed. */
  toolUse(item: { id: string; tool: string; title: string; detail: string; parent: string | null; input: Record<string, unknown> }, now = toSwiftDate()): boolean {
    const isSubagent = SUBAGENT_TOOLS.has(item.tool);
    let changed = false;
    if (item.parent) {
      const owner = this.get(item.parent);
      if (owner) {
        owner.steps.push({ id: item.id, kind: isSubagent ? "subagent" : "tool", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
        changed = true;
      }
    }
    if (!isSubagent || this.get(item.id)) return changed;
    const record: SubagentRecord = {
      id: item.id, description: describe(item.input), prompt: typeof item.input.prompt === "string" ? item.input.prompt : item.detail,
      status: "running", background: item.input.run_in_background === true, startedAt: now, steps: [],
    };
    if (typeof item.input.subagent_type === "string" && item.input.subagent_type) record.type = item.input.subagent_type;
    if (item.parent) record.parentID = item.parent;
    if (typeof item.input.name === "string" && item.input.name) record.name = item.input.name;
    if (typeof item.input.model === "string" && item.input.model) record.model = item.input.model;
    this.list.push(record);
    this.trim();
    return true;
  }

  /** A call's result: its step in the subagent it is in; for an Agent call that did not go to the background, its end. */
  toolResult(item: { id: string; output: string; failed: boolean; parent: string | null; launch: Launch | null }, now = toSwiftDate()): boolean {
    let changed = false;
    const subagent = this.get(item.id);
    if (subagent && !subagent.agentID) {
      const agentId = item.launch?.agentId ?? /agentId: ([A-Za-z0-9_-]+)/.exec(item.output)?.[1];
      if (agentId) { subagent.agentID = agentId; changed = true; }
    }
    if (item.parent) {
      const owner = this.get(item.parent);
      const step = owner?.steps.findLast((candidate) => candidate.id === item.id);
      if (step) {
        step.output = item.output;
        step.failed = item.failed;
        step.done = true;
        changed = true;
      }
    }
    if (!subagent || subagent.status !== "running") return changed;
    if (subagent.background || item.launch?.background || item.output.startsWith("Async agent launched")) {
      if (!subagent.background) { subagent.background = true; changed = true; }
      return changed;
    }
    this.end(subagent, item.failed ? "failed" : "completed", item.output, now);
    return true;
  }

  text(parent: string, text: string): boolean {
    const owner = this.get(parent);
    const words = text.trim();
    if (!owner || !words) return false;
    owner.steps.push({ id: `${parent}:text:${owner.steps.length}`, kind: "text", title: words, failed: false, done: true });
    return true;
  }

  started(item: { id: string; description: string; type: string | null; prompt: string; background: boolean }, now = toSwiftDate()): boolean {
    const existing = this.get(item.id);
    if (existing) {
      if (existing.status !== "running") { existing.status = "running"; delete existing.endedAt; }
      if (item.description) existing.description = item.description;
      if (item.prompt) existing.prompt = item.prompt;
      if (item.type) existing.type = item.type;
      existing.background = item.background;
      return true;
    }
    const record: SubagentRecord = { id: item.id, description: item.description, prompt: item.prompt, status: "running", background: item.background, startedAt: now, steps: [] };
    if (item.type) record.type = item.type;
    this.list.push(record);
    this.trim();
    return true;
  }

  /** Its notification: the end, and what it handed back. Returns the subagent when this ended it. */
  ended(item: { id: string; status: string; summary: string | null }, now = toSwiftDate()): SubagentRecord | null {
    const subagent = this.resolve(item.id);
    if (!subagent || subagent.status !== "running") return null;
    this.end(subagent, ended(item.status), item.summary ?? subagent.result, now);
    return subagent;
  }

  private end(subagent: SubagentRecord, status: SubagentStatus, result: string | undefined, now: number) {
    subagent.status = status;
    subagent.endedAt = now;
    if (result !== undefined) subagent.result = result;
    // The call that started it, in the subagent that sent it.
    if (subagent.parentID) {
      const step = this.get(subagent.parentID)?.steps.findLast((candidate) => candidate.id === subagent.id);
      if (step) { step.done = true; step.failed = status === "failed"; }
    }
    this.trim();
  }

  /** Its process went away: every one still at work stopped with it (`TraceBook.stopRunning`). */
  stopRunning(now = toSwiftDate()): boolean {
    let changed = false;
    for (const subagent of this.list) {
      if (subagent.status !== "running") continue;
      subagent.status = "stopped";
      subagent.endedAt = now;
      changed = true;
    }
    return changed;
  }

  private trim() {
    const done = this.list.filter((subagent) => subagent.status !== "running");
    if (done.length <= KEPT) return;
    const drop = new Set(done.slice(0, done.length - KEPT).map((subagent) => subagent.id));
    this.list = this.list.filter((subagent) => !drop.has(subagent.id));
  }
}
