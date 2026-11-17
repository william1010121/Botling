// No background wait of a Botling-run Claude session may outlast 50 minutes. Claude's prompt cache lives 1 hour; a
// wait that ends later wakes the model on a cold cache (a full rewrite instead of a cheap read). Session dd51206a
// (2026-11-17) ran Bash with run_in_background and timeout 3 700 000 ms; the next model call came 1.01 h after the last.
//
// Botling registers a PreToolUse hook (head.ts `BACKGROUND_CAP_HOOK`, matcher Bash|Monitor) on every non-harmless
// claude session, bot heads and app-managed workers alike. The CLI (2.1.323) honours `updatedInput` from a
// PreToolUse hook and passes `additionalContext` to the model, so the call runs with the capped timeout and the model
// is told, and re-arms the wait if it is still needed. The permission decision is left out on purpose: the normal
// permission flow (auto mode, allow rules, the user's card) still decides, on the capped input.
//
// What is not capped: a background Bash with no `timeout` (the CLI stops it after 30 minutes by itself) and a
// persistent Monitor (it has no deadline, and each event it reports wakes the model).

export const BACKGROUND_WAIT_CAP_MS = 50 * 60 * 1000;
export const BACKGROUND_CAP_HOOK = "botling-background-cap";

const own = (object: unknown, key: string): unknown =>
  object && typeof object === "object" && Object.hasOwn(object, key) ? (object as Record<string, unknown>)[key] : undefined;
// The CLI's schemas accept "true" and "3700000" for a boolean and a number; a string never slips past the cap.
const isTrue = (value: unknown): boolean => value === true || value === "true";
const asMs = (value: unknown): number | null => {
  const ms = typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
  return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
};

/** The hook's answer: the same call with its wait capped (and a note for the model), or `{}` when nothing needs capping. */
export function backgroundCapDecision(input: any): Record<string, unknown> {
  if (input?.hook_event_name !== "PreToolUse") return {};
  const call = input.tool_input;
  let field: "timeout" | "timeout_ms" | null = null;
  if (input.tool_name === "Bash" && isTrue(own(call, "run_in_background"))) field = "timeout";
  else if (input.tool_name === "Monitor" && !isTrue(own(call, "persistent"))) field = "timeout_ms";
  const asked = field ? asMs(own(call, field)) : null;
  if (!field || asked === null || asked <= BACKGROUND_WAIT_CAP_MS) return {};
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    updatedInput: { ...call, [field]: BACKGROUND_WAIT_CAP_MS },
    additionalContext: `Botling capped this background wait at 50 minutes (${field} ${BACKGROUND_WAIT_CAP_MS} ms; you asked for ${asked} ms) so the prompt cache stays warm. If it ends at the cap and you still need the result, start the wait again.` } };
}
