// The thinking-effort levels each engine's own control takes, shared by the core (what it launches with) and the
// Settings page (what it offers): Claude's `--effort`, Codex's `effort`, Antigravity's ACP `thinking_level`.
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
export const EFFORTS_BY_ENGINE: Record<"claude" | "codex" | "agy", readonly EffortLevel[]> = {
  claude: EFFORT_LEVELS,
  codex: ["low", "medium", "high", "xhigh"],
  agy: ["low", "medium", "high"],
};
