// A running head's model or effort changed without a restart ("hot switch"): which engines take which
// change in place. Anything a head refuses (or a request that fails) falls back to the restart before the
// next message, as before. Tests replace this module to cover the paths that are off here.

/** The model or effort a running head should have from its next turn on; an absent key is left as it is. */
export interface HotSettings {
  model?: string | null;
  effort?: string | null;
}

/**
 * Claude's effort through `apply_flag_settings` `{effortLevel}`: claude 2.1.311 answers success, but whether
 * the next request really uses it has not been measured. Off: an effort change restarts the head.
 * (Claude's model goes through `set_model`, checked on 2.1.311: always on.)
 */
export function claudeHotEffortEnabled(): boolean { return false; }

/**
 * Antigravity's `session/set_model` and `thinking_level` in a conversation already under way: both are used
 * at startup, but the pinned ACP 1.4.3 server has not been checked to apply them mid-conversation. Off: a
 * change restarts the head (in the same conversation).
 */
export function agyHotSettingsEnabled(): boolean { return false; }

/** Only the keys of `target` that differ from what the head has now. */
export function settingsChange(target: HotSettings, current: { model?: string | null; effort?: string | null }): HotSettings {
  const change: HotSettings = {};
  if ("model" in target && (target.model ?? null) !== (current.model ?? null)) change.model = target.model ?? null;
  if ("effort" in target && (target.effort ?? null) !== (current.effort ?? null)) change.effort = target.effort ?? null;
  return change;
}
