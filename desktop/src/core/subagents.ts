// A bot's subagents (the Agent tool's), followed from claude's stream as the Swift `TraceBook`
// does (Trace.swift), and kept in subagents.json in 1.x's `Subagent` format: what each was sent
// to do, its tool calls and words (lines with its `parent_tool_use_id`), how it ended and what it
// handed back. A subagent sent to the background ends only with its `task_notification`.
//
// Dates are Swift dates (seconds since 2001); keys 2.0 does not know are kept on each record.
import type { Launch } from "./agent/stream";
import { characterPrefix } from "./briefing";
import { fromSwiftDate, toSwiftDate, type StepRecord } from "./store/records";

export type SubagentStatus = "running" | "completed" | "failed" | "stopped";

/** A row for the left column / "Settled" (the contract's SubagentRowView). */
export interface SubagentRow { outputTokens?: number | null; id: string; title: string; status: SubagentStatus; head: "claude" | "codex" | null; startedAt: number; endedAt: number | null; unsettledAt: number | null; settled: boolean; prompt: string }

export { LISTED_AFTER_ENDING_MS, LISTED_AT_MOST, listedRows, settledRows } from "../contract";

export interface SubagentRuntime {
  engine?: "claude" | "codex" | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}

export interface SubagentExecution {
  run: number;
  ownerSessionId: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface PreviousRunEnd { status: SubagentStatus; result: string }

export interface SubagentRun {
  execution?: SubagentExecution;
  prompt: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt?: number;
  result?: string;
  steps: StepRecord[];
}

/** Swift's absolute output counters: malformed/missing is unknown, never parent usage. */
export function reportedOutputTokens(subagent: SubagentRecord): number | null {
  const counters = subagent.outputTokenCounters;
  if (!counters || typeof counters !== "object" || Array.isArray(counters)) return null;
  const values = Object.values(counters);
  if (!values.length || values.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return null;
  const total = (values as number[]).reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

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
  execution?: SubagentExecution;
  previousRuns?: SubagentRun[];
  runStartedAt?: number;
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
  const record: SubagentRecord = {
    ...raw,
    id: raw.id,
    description: typeof raw.description === "string" ? raw.description : "",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    status: STATUSES.has(raw.status as SubagentStatus) ? (raw.status as SubagentStatus) : "stopped",
    background: raw.background === true,
    startedAt: raw.startedAt,
    steps: Array.isArray(raw.steps) ? (raw.steps as StepRecord[]).filter((step) => step && typeof step.id === "string") : [],
  };
  const execution = readExecution(raw.execution);
  if (execution) record.execution = execution;
  else delete record.execution;
  if (Array.isArray(raw.previousRuns)) record.previousRuns = raw.previousRuns.flatMap((run) => {
    const saved = run && typeof run === "object" ? readSubagent({ ...run, id: raw.id, previousRuns: undefined }) : null;
    return saved ? [{ prompt: saved.prompt, status: saved.status, startedAt: saved.startedAt, endedAt: saved.endedAt, result: saved.result, steps: saved.steps, execution: saved.execution }] : [];
  });
  else delete record.previousRuns;
  return record;
}

function readExecution(value: unknown): SubagentExecution | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.run !== "number" || !Number.isSafeInteger(raw.run) || raw.run < 1) return;
  const text = (key: string) => typeof raw[key] === "string" ? (raw[key] as string).slice(0, 200) : null;
  return { run: raw.run, ownerSessionId: text("ownerSessionId"), threadId: text("threadId"), turnId: text("turnId") };
}

/** Its tool calls so far (`Subagent.toolCount`). */
export const toolCount = (subagent: SubagentRecord) => subagent.steps.filter((step) => step.kind === "tool" || step.kind === "subagent").length;

export class SubagentBook {
  constructor(public list: SubagentRecord[] = [], private retained: () => ReadonlySet<string> = () => new Set()) {}

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

  started(item: { id: string; description: string; type: string | null; prompt: string; background: boolean; execution?: SubagentExecution; previousRunEnd?: PreviousRunEnd }, now = toSwiftDate()): boolean {
    const existing = this.get(item.id);
    if (existing) {
      if (existing.status !== "running" || (item.execution && existing.execution && item.execution.run !== existing.execution.run)) {
        existing.previousRuns = [...(existing.previousRuns ?? []), {
          execution: existing.execution, prompt: existing.prompt, status: item.previousRunEnd?.status ?? existing.status,
          startedAt: existing.runStartedAt ?? existing.startedAt, endedAt: item.previousRunEnd ? now : existing.endedAt, result: item.previousRunEnd?.result ?? existing.result, steps: existing.steps,
        }];
        existing.steps = [];
        existing.runStartedAt = now;
        delete existing.result;
        delete existing.endedAt;
      }
      if (existing.status !== "running") { existing.status = "running"; delete existing.endedAt; }
      if (item.description) existing.description = item.description;
      if (item.prompt) existing.prompt = item.prompt;
      if (item.type) existing.type = item.type;
      existing.background = item.background;
      if (item.execution) existing.execution = item.execution;
      return true;
    }
    const record: SubagentRecord = { id: item.id, description: item.description, prompt: item.prompt, status: "running", background: item.background, startedAt: now, steps: [] };
    if (item.type) record.type = item.type;
    if (item.execution) record.execution = item.execution;
    if (item.execution) record.runStartedAt = now;
    this.list.push(record);
    this.trim();
    return true;
  }

  execution(id: string, execution: SubagentExecution): boolean {
    const child = this.get(id);
    if (!child || (child.execution && child.execution.run > execution.run)) return false;
    child.execution = execution;
    return true;
  }

  /** Presentation metadata changes no status or task ownership. */
  runtime(id: string, runtime: SubagentRuntime, model?: string): boolean {
    const child = this.resolve(id);
    if (!child) return false;
    const changed = JSON.stringify(child.runtime) !== JSON.stringify(runtime) || (!!model && child.model !== model);
    child.runtime = runtime;
    if (model) child.model = model;
    return changed;
  }

  output(id: string, counter: string, tokens: number): boolean {
    const child = this.resolve(id);
    if (!child || !counter || !Number.isSafeInteger(tokens) || tokens < 0) return false;
    const previous = child.outputTokenCounters;
    const counters = previous && typeof previous === "object" && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
    const before = counters[counter];
    if (typeof before === "number" && before >= tokens) return false;
    child.outputTokenCounters = { ...counters, [counter]: tokens };
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

  /**
   * Settles it (`TraceBook.settle`): its row leaves the left column for "Settled" in the right panel; it
   * does not stop it. `false` brings it back (an ended one stays listed for 10 minutes from now). 1.x keeps
   * the time as `dismissedAt`. True when it changed.
   */
  settle(id: string, settled: boolean, now = toSwiftDate()): boolean {
    const subagent = this.list.findLast((candidate) => candidate.id === id);
    if (!subagent) return false;
    const isSettled = typeof subagent.dismissedAt === "number";
    if (settled === isSettled) return false;
    if (settled) subagent.dismissedAt = now;
    else { delete subagent.dismissedAt; subagent.unsettledAt = now; }
    return true;
  }

  /** The rows the left column and "Settled" draw: the ones the bot sent itself (not a subagent's own). */
  rows(head: "claude" | "codex" | null): SubagentRow[] {
    return this.list.filter((subagent) => !subagent.parentID).map((subagent) => ({
      id: subagent.id.slice(0, 200),
      title: subagent.description.slice(0, 400),
      status: subagent.status,
      head,
      outputTokens: reportedOutputTokens(subagent),
      startedAt: fromSwiftDate(subagent.startedAt),
      endedAt: typeof subagent.endedAt === "number" ? fromSwiftDate(subagent.endedAt) : null,
      unsettledAt: typeof subagent.unsettledAt === "number" ? fromSwiftDate(subagent.unsettledAt) : null,
      settled: typeof subagent.dismissedAt === "number",
      prompt: subagent.prompt.slice(0, 1_000),
    }));
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
    const retained = this.retained();
    const done = this.list.filter((subagent) => subagent.status !== "running" && !retained.has(subagent.id));
    if (done.length <= KEPT) return;
    const drop = new Set(done.slice(0, done.length - KEPT).map((subagent) => subagent.id));
    this.list = this.list.filter((subagent) => !drop.has(subagent.id));
  }
}
