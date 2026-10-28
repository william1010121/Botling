// Intent stays data; this policy never launches or replays it.
export const MONITOR_HANDBACK = "Monitors are coordinator-only. Return the original monitor input, working directory, purpose and completion condition to your coordinator in your task report. The coordinator may execute it only within the existing user-authorized scope and existing approval contract. Do not substitute a shell background job, retry with another tool, or treat this rejection as approval.";
export const MONITOR_HOOK = "botling-monitor-owner";
export function monitorHandback(tool: string, input: unknown, correlation: Record<string, unknown>) {
  return { code: "coordinator_only_monitor", error: MONITOR_HANDBACK, handback: { tool, input, ...correlation }, executed: false };
}
export function claudeMonitorDecision(input: any, worker = false): Record<string, unknown> {
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "Monitor") return {};
  if (!worker && !input.agent_id && !input.agent_type) return {}; // Never auto-allow the coordinator.
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: JSON.stringify(monitorHandback("Monitor", input.tool_input, {
      owner_session_id: input.session_id ?? null, requester_agent_id: input.agent_id ?? null, requester_tool_use_id: input.tool_use_id ?? null, cwd: input.cwd ?? null,
    })) } };
}
