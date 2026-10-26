// Relationships come only from saved task ids, its chat line's Agent steps, and explicit parent ids.
// Descriptions, titles, prompts and time proximity are never relationship evidence.
import type { TaskAgentView } from "../contract";
import type { TaskCard } from "./tasks";
import type { ChatRecord } from "./store/records";
import type { SubagentRecord } from "./subagents";

export interface AgentSource { engine: "claude" | "codex"; list: SubagentRecord[] }

export function taskAgentIds(card: TaskCard, messages: ChatRecord[], sources: AgentSource[]): string[] {
  const ids = new Set(card.subagentIDs ?? []);
  const mine = new Set(card.messageIDs);
  for (const message of messages) {
    if (!mine.has(message.id)) continue;
    for (const step of message.steps ?? []) if (step.kind === "subagent" && typeof step.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(step.id)) ids.add(step.id);
  }
  // Descendants can arrive before their parent in a restored file.
  const all = sources.flatMap((source) => source.list);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of all) if (agent.parentID && ids.has(agent.parentID) && /^[A-Za-z0-9_.:-]{1,200}$/.test(agent.id) && !ids.has(agent.id)) { ids.add(agent.id); changed = true; }
  }
  return [...ids];
}

export function relatedTaskAgents(card: TaskCard, messages: ChatRecord[], sources: AgentSource[]): TaskAgentView[] {
  return taskAgentIds(card, messages, sources).map((id): TaskAgentView => {
    const source = sources.find((source) => source.list.some((agent) => agent.id === id));
    const agent = source?.list.find((agent) => agent.id === id);
    if (!agent) return { id, title: "Subagent record unavailable", engine: null, status: null, available: false, run: null };
    const runtime = agent.runtime as { engine?: unknown } | undefined;
    const engine = runtime?.engine === "claude" || runtime?.engine === "codex" ? runtime.engine
      : agent.type === "codex-worker" || agent.type === "codex" ? "codex" : source!.engine;
    return { id, title: agent.description.slice(0, 400) || "Subagent", engine, status: agent.status, available: /^[A-Za-z0-9_.:-]{1,200}$/.test(id), run: agent.execution?.run ?? null };
  }).sort((a, b) => Number(b.status === "running") - Number(a.status === "running"));
}
