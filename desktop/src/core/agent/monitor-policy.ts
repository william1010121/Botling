// Claude workers may use the native Monitor tool (2026-11-18, the user): their row says "Monitor running" while it lives
// (claude-workers.ts). Only the Codex side still has no Monitor for a worker: `app_monitor_*` are the coordinator's own app
// tools, so a worker's call of one is handed back as data (intent stays data; this policy never launches or replays it).
export const MONITOR_HANDBACK = "Monitors are coordinator-only. Return the original monitor input, working directory, purpose and completion condition to your coordinator in your task report. The coordinator may execute it only within the existing user-authorized scope and existing approval contract. Do not substitute a shell background job, retry with another tool, or treat this rejection as approval.";
export function monitorHandback(tool: string, input: unknown, correlation: Record<string, unknown>) {
  return { code: "coordinator_only_monitor", error: MONITOR_HANDBACK, handback: { tool, input, ...correlation }, executed: false };
}
