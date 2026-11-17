// What counts as a Claude model, in one place: the three family aliases the CLI takes (kept as quick picks) or
// any full model id, `claude-` then letters, digits, dots and dashes (claude-opus-5-5, claude-fable-5-2, ...).
// A new Claude model needs no code change: it is only a value the user types or picks. Settings, the worker
// launcher, the component editor and Settings' pickers all ask this one check.

/** The family aliases `claude --model` takes; the quick picks in the pickers. */
export const CLAUDE_MODEL_ALIASES = ["haiku", "sonnet", "opus"] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/**
 * An alias or a full model id, then optionally one bracket suffix such as `[1m]` (the 1M-token window Claude Code takes
 * on an alias or an id: opus[1m], claude-opus-5-5[1m]). The id after `claude-` is up to 100 characters. The class
 * excludes whitespace, quotes and newlines, so a value is safe in an argument list and in a YAML `model:` line.
 * `opusplan` and `default` are Claude Code's own modes, not models, and are not taken.
 */
const CLAUDE_MODEL = new RegExp(`^(?:${CLAUDE_MODEL_ALIASES.join("|")}|claude-[a-z0-9][a-z0-9.-]{0,99})(?:\\[[a-z0-9]{1,8}\\])?$`);

/** True for an alias or a full `claude-*` id, with an optional `[1m]`-style suffix; any other value (including a non-string) is not a Claude model. */
export function isClaudeModel(value: unknown): value is string {
  return typeof value === "string" && CLAUDE_MODEL.test(value);
}

/** `value` when it is a Claude model, else null (a saved value that is not one falls back to its default). */
export const claudeModelOrNull = (value: unknown): string | null => (isClaudeModel(value) ? value : null);

/** The message for a model Claude cannot take; says what is accepted without naming any one version. */
export const CLAUDE_MODEL_HINT = "use haiku, sonnet, opus or a full Claude model id (claude-…), with an optional [1m]";
