import { shownTasks, type TaskCard } from "./tasks";
/** Only explicit, unambiguous relationships. Names, current head task and prompt content
 * are not evidence that a background worker belongs to the currently running task. */
export function meteredTask(cards: TaskCard[], head: "claude" | "codex", workerIds: string[], conflictingIds: Set<string>, baseId?: string): string | null {
  const visible = shownTasks(cards);
  if (!workerIds.length) return visible.find(c => c.id === baseId)?.id ?? null;
  if (workerIds.some(id => conflictingIds.has(id))) return null;
  const matches = visible.filter(c => c.subagentIDs?.some(id => workerIds.includes(id))
    && (c.owner === head || c.helps?.some(help => help.head === head)));
  return matches.length === 1 ? matches[0].id : null;
}
