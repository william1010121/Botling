// What counts as a Claude model, in one place: the three family aliases the CLI takes (kept as quick picks) or
// any full model id, `claude-` then letters, digits, dots and dashes (claude-opus-5-5, claude-fable-5-2, ...).
// A new Claude model needs no code change: it is only a value the user types or picks. Settings, the worker
// launcher, the component editor and Settings' pickers all ask this one check.

/** The family aliases `claude --model` takes; the quick picks in the pickers. */
export const CLAUDE_MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/** A full model id as the CLI takes it (the same shape the worker launcher has always accepted). */
const CLAUDE_FULL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,99}$/;

/** True for an alias or a full `claude-*` id; any other value (including a non-string) is not a Claude model. */
export function isClaudeModel(value: unknown): value is string {
  return typeof value === "string" && ((CLAUDE_MODEL_ALIASES as readonly string[]).includes(value) || CLAUDE_FULL_ID.test(value));
}

/** `value` when it is a Claude model, else null (a saved value that is not one falls back to its default). */
export const claudeModelOrNull = (value: unknown): string | null => (isClaudeModel(value) ? value : null);

/** The message for a model Claude cannot take; says what is accepted without naming any one version. */
export const CLAUDE_MODEL_HINT = "use haiku, sonnet, opus or a full Claude model id (claude-…)";
