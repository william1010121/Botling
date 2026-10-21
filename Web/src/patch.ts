import type { ChatState, MessageView, StatePatch } from "./types";

/**
 * The state `patch` brings `last` to, or null when it cannot (no earlier state for what it left
 * out, or a message it names that neither has): then the page asks for the whole state again.
 * Messages that did not change are the same objects as in `last`, so drawing can skip them.
 */
export function applyPatch(last: ChatState | null, patch: StatePatch): ChatState | null {
  if (!last && (!patch.base || !patch.components)) return null;
  const known = new Map<string, MessageView>();
  for (const message of last?.messages ?? []) known.set(message.id, message);
  for (const message of patch.changed) known.set(message.id, message);
  const messages: MessageView[] = [];
  for (const id of patch.order) {
    const message = known.get(id);
    if (!message) return null;
    messages.push(message);
  }
  const base = patch.base ?? last!;
  return { ...base, messages, components: patch.components ?? last!.components } as ChatState;
}
