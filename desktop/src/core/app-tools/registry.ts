// The app tools, defined once (provider-layer plan 4.1). A coordinator steers its workers and the app through these
// tools: app_handoff, app_send_message, app_cancel_task, the report tools (app_task_checkpoint, app_reconcile_report),
// routines and monitors. A worker gets one tool of its own, app_notify_owner (`workerAppTools`): a note to the bot that
// started it while it keeps working. Each engine gets them over its own transport: Claude's in-process MCP server (head.ts
// `appMcp`) and the agy bridge (agy-mcp.ts `AgyMcpBridge.tools`) take MCP tools, Codex takes dynamic tools on
// `thread/start` (codex.ts `MANAGED_TOOLS`).
//
// Step 1 only moves the definitions here: every engine keeps its own tool set, wording and parameters, rendered byte
// for byte as before (test/unit/app-tools-registry.test.ts). Codex's tools are fixed when a coordinator thread starts,
// so any change to what `codexDynamicTools` renders changes MANAGED_TOOL_SIGNATURE and restarts every Codex coordinator
// thread: unify the wording in one planned Codex tool update, not piecemeal.

export type AppToolProvider = "claude" | "agy" | "codex";
export type AppToolName =
  | "app_handoff" | "app_send_message" | "app_cancel_task" | "app_task_checkpoint" | "app_reconcile_report"
  | "app_routines" | "app_monitor_start" | "app_monitor_status" | "app_monitor_cancel"
  | "app_notify_owner";
type JsonSchema = Record<string, unknown>;
/** A tool as an MCP server lists it (Claude's `appMcp`, the agy bridge). */
export interface McpTool { name: string; description: string; inputSchema: JsonSchema }
/** A tool as Codex takes it in `thread/start`'s `dynamicTools`. */
export type CodexDynamicTool = { type: "function"; name: string; description: string; inputSchema: JsonSchema };

export interface AppToolOptions {
  /** The engines app_handoff may start (its `engine` parameter, agy only; default agy and Codex). */
  engines?: readonly string[];
}

import { EFFORTS_BY_ENGINE } from "../../contract/efforts";

const text = { type: "string" };
const run = { type: "integer", minimum: 1 };
const PARAMS = {
  instructions: () => text,
  name: () => text,
  subagent_type: () => text,
  model: () => text,
  // The levels the provider's own engine takes (its workers run on it): Claude's or Codex's.
  effort: ({ provider = "claude" }) => ({ type: "string", enum: [...EFFORTS_BY_ENGINE[provider === "codex" ? "codex" : "claude"]] }),
  engine: ({ engines = ["agy", "codex"] }) => ({ type: "string", enum: [...engines] }),
  role: () => ({ type: "string", enum: ["component-editor"], description: "Only for the plugin-library Maintainer: launch its existing Claude ccb-core component editor on its configured model. No new folders, tools, authorization or settings. Omit for ordinary work." }),
  isolated_git: () => ({
    type: "object",
    description: "Optional explicit authorization for an implementation task only. Enables single-request automatic approval of creation of a NEW isolated bot/ worktree, staging these exact task-owned files and commits on that branch. repo must equal this bot workspace root; baseCommit is an existing full commit SHA. worktree must be a new direct child /private/tmp/botling-2x-* or /Volumes/My-SSD/botling-work/<name>. Unknown/invalid ownership falls back to manual approval. Never use for research-only tasks. Any app_send_message revokes this grant; push/merge/deletion/shared checkout and shell chains always retain normal approval.",
    properties: { implementationAuthorized: { type: "boolean", enum: [true] }, repo: text, worktree: text, branch: text, baseCommit: text, files: { type: "array", items: text, minItems: 1 } },
    required: ["implementationAuthorized", "repo", "worktree", "branch", "baseCommit", "files"],
    additionalProperties: false,
  }),
  task_id: () => text,
  message: () => text,
  run: () => run,
  outcome: () => ({ type: "string", enum: ["complete", "waiting_user", "waiting_dependency", "blocked"] }),
  evidence: () => text,
  dependency_task_id: () => text,
  action: () => ({ type: "string", enum: ["acknowledge", "retry"] }),
  operation: () => ({ type: "string", enum: ["list", "create", "pause", "resume", "cancel"] }),
  kind: () => ({ type: "string", enum: ["once", "recurring"] }),
  task: () => text,
  request_id: () => text,
  at: () => text,
  cron: () => text,
  timezone: () => text,
  id: () => text,
  command: () => text,
  monitor_id: () => text,
  files: () => ({ type: "array", items: text, maxItems: 20, description: "Full paths of files the note is about (a plan, a progress file, a result)." }),
} satisfies Record<string, (options: AppToolOptions & { provider?: AppToolProvider }) => JsonSchema>;
type ParamName = keyof typeof PARAMS;

/** One provider's form of a tool: its description, its parameters in order, and the required ones (absent: no `required` key). */
interface ToolForm {
  description: string; params: readonly ParamName[]; required?: readonly ParamName[];
  /** Parameters whose schema differs for this tool from the shared one (app_notify_owner's `kind`). */
  schemas?: Partial<Record<ParamName, JsonSchema>>;
}
interface AppToolDef { name: AppToolName; forms: Partial<Record<AppToolProvider, ToolForm>> }

const APP_TOOLS: readonly AppToolDef[] = [
  { name: "app_handoff", forms: {
    claude: { description: "Start an app-managed worker: a Claude subagent that runs as its own session in this bot's folder and reports back to you. Use it wherever you would use the Agent tool (which is off here): give a short name and complete, self-contained instructions; subagent_type picks a .claude/agents definition, model overrides the worker's model (haiku, sonnet, opus), effort its thinking effort (low, medium, high, xhigh, max; default: the bot's subagent effort, else yours). Returns task_id and run at once; the worker's report arrives later as an app message (<app_task_result>). Finish your turn instead of waiting or polling.",
      params: ["name", "instructions", "subagent_type", "model", "effort"], required: ["instructions"] },
    agy: { description: "Assign an authorized task to an app-managed agy or Codex worker; engine identity cannot change on resume. Returns task_id immediately. A correlated app_task_result arrives later. Does not grant tool permissions.",
      params: ["instructions", "name", "engine"], required: ["instructions"] },
    codex: { description: "Assign one independently accepted deliverable to an app-managed worker. Returns acceptance and task_id immediately, not a completed result. Continue other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn without waiting. The app delivers correlated app_task_result reports in later turns. A new handoff does not resolve the active report. Optional effort sets the worker's reasoning effort (low, medium, high, xhigh; default: the Codex workers setting, else yours). Optional model runs the worker on a Codex model Codex offers, by slug (e.g. gpt-6-luna) or short name (e.g. luna); default: the Codex workers setting, else yours. Workers are always Codex; model picks only which Codex model.",
      params: ["instructions", "name", "role", "isolated_git", "effort", "model"], required: ["instructions"] },
  } },
  { name: "app_send_message", forms: {
    claude: { description: "Send words to one of your workers by task_id: joined into its run while it works, or the start of its next run (same session, same task) once it has reported. Its next report comes as an app message.",
      params: ["task_id", "message", "run"], required: ["task_id", "message"] },
    agy: { description: "Send words to an existing worker task by task_id and run: a busy worker reads them at its next tool call (if its run ends first, at the start of its next run); an idle worker starts its next run. Does not authorize a new deliverable.",
      params: ["task_id", "run", "message"], required: ["task_id", "run", "message"] },
    codex: { description: "Send a follow-up within the same worker task/session; never append a new independent deliverable. Busy workers receive steering; idle workers start a new turn. Returns acceptance, not the completed result. Continue other eligible dispatches and required report decisions before ending the dispatch phase. Only continuation of the active report task_id resolves that report.",
      params: ["task_id", "message"], required: ["task_id", "message"] },
  } },
  { name: "app_cancel_task", forms: {
    claude: { description: "Stop one of your workers by task_id. Its work so far stays; no report is made.",
      params: ["task_id", "run"], required: ["task_id"] },
    agy: { description: "Stop one app-managed worker and its active tools.",
      params: ["task_id", "run"], required: ["task_id", "run"] },
  } },
  { name: "app_task_checkpoint", forms: {
    agy: { description: "Resolve this task/run report with concrete acceptance evidence or a specific blocker. Does not grant authorization.",
      params: ["task_id", "run", "outcome", "evidence", "dependency_task_id"], required: ["task_id", "run", "outcome", "evidence"] },
    codex: { description: "Resolve the active app_task_result against the authorized user objective. Worker completed means only its execution turn ended. Record concrete acceptance evidence, an exact user input/permission needed, a real blocker, or an actively running dependency. Continue the same authorized task with app_send_message when needed. A new handoff or a message to another task does not resolve this report; after dispatching a separate downstream worker, explicitly record waiting_dependency with its task_id. A bare waiting status is not completion. This checkpoint grants no new authorization.",
      params: ["task_id", "outcome", "evidence", "dependency_task_id"], required: ["task_id", "outcome", "evidence"] },
  } },
  { name: "app_reconcile_report", forms: {
    agy: { description: "Needs no user approval card. Acknowledge an uncertain report as received, or retry only its delivery. Never replays the worker task.",
      params: ["task_id", "run", "action"], required: ["task_id", "run", "action"] },
  } },
  { name: "app_routines", forms: {
    codex: { description: "Manage this bot's persistent routines directly. Operations: list; create kind=once with at (ISO-8601 seconds and explicit offset/Z), or kind=recurring with cron (5 fields). create requires task and unique request_id (reuse on retries), optional timezone (IANA, defaults to local at creation). Returns saved id/status; use id for pause/resume/cancel. List includes legacy cron IDs. Reschedule by cancel then create with a new request_id. Once jobs overdue while closed run on next app check; recurring catches up only today in its saved timezone. fired means the trigger reached the app router, not proof of agent startup or task completion. delivery_uncertain means a crash may have interrupted dispatch: never auto retry. Cancel stops future dispatch, not active work. App must be running; no OS wakeup. Do not edit app-owned schedule JSON or use shell/cron for this tool.",
      params: ["operation", "kind", "task", "request_id", "at", "cron", "timezone", "id"], required: ["operation"] },
  } },
  { name: "app_monitor_start", forms: {
    codex: { description: "Coordinator only; workers must return command intent in their task report. Start one already authorized command in this bot workspace after an explicit Allow once card, including in auto mode. Supply command as shell text. This is a completion monitor, not a polling/line-event monitor. Returns monitor_id and awaitingApproval immediately; finish the turn without polling. The app queues app_monitor_result on success or nonzero failure with monitor_id, owner_session_id, exit_code and bounded output. No network or permission escalation. Never use to expand scope, bypass a denial or rerun interrupted work. Stop/cancel suppresses callbacks. Commands are not replayed on restart; unconfirmed executions become interrupted. Callback dispatch interrupted before acknowledgement is uncertain and never automatically duplicated; inspect status/owner thread.",
      params: ["command"], required: ["command"] },
  } },
  { name: "app_monitor_status", forms: {
    codex: { description: "Get one monitor by monitor_id, or list this owner session’s monitors when omitted. Includes execution result and wake delivery state; no external PID adoption.",
      params: ["monitor_id"] },
  } },
  { name: "app_monitor_cancel", forms: {
    codex: { description: "Cancel one owned monitor and suppress any queued completion wake. Cancellation is best effort; side effects cannot be undone. A finished command keeps its actual exit status.",
      params: ["monitor_id"], required: ["monitor_id"] },
  } },
  { name: "app_notify_owner", forms: notifyForms() },
];

/**
 * app_notify_owner, the one tool an app-managed worker has (every engine the same words): interim news or a question
 * for the bot that started it, while it keeps working.
 */
function notifyForms(): Partial<Record<AppToolProvider, ToolForm>> {
  const form: ToolForm = {
    description: "Send a short note to your owner, the bot that started you, while you keep working; it returns at once. kind \"report\": news your owner can act on now (a milestone others can build on, a plan or progress file ready: give its full paths in files). kind \"question\": a question whose answer changes your work; your owner answers with a message that joins this run (you read it at your next step), so carry on with what does not depend on it, or wait for it. It reaches only your owner, never the user or another bot. Not for chatter or routine progress, and never instead of your final report: the last message of your run is still your report.",
    params: ["kind", "message", "files"], required: ["kind", "message"],
    schemas: { kind: { type: "string", enum: ["report", "question"] } },
  };
  return { claude: form, agy: form, codex: form };
}

/** Which tools each provider's coordinator gets, in the order it lists them. */
const PROVIDER_TOOLS: Record<AppToolProvider, readonly AppToolName[]> = {
  claude: ["app_handoff", "app_send_message", "app_cancel_task"],
  agy: ["app_task_checkpoint", "app_reconcile_report", "app_handoff", "app_send_message", "app_cancel_task"],
  codex: ["app_routines", "app_monitor_start", "app_monitor_status", "app_monitor_cancel", "app_handoff", "app_send_message", "app_task_checkpoint"],
};

/** The tools an app-managed worker gets (never a coordinator): only app_notify_owner. */
export const WORKER_APP_TOOLS: readonly AppToolName[] = ["app_notify_owner"];

const render = (provider: AppToolProvider, names: readonly AppToolName[], options: AppToolOptions): McpTool[] => names.map((name) => {
  const form = APP_TOOLS.find((tool) => tool.name === name)!.forms[provider];
  if (!form) throw new Error(`${provider} has no form of ${name}`);
  const properties = Object.fromEntries(form.params.map((param) => [param, form.schemas?.[param] ?? PARAMS[param]({ ...options, provider })]));
  return { name, description: form.description, inputSchema: { type: "object", properties, ...(form.required ? { required: [...form.required] } : {}), additionalProperties: false } };
});

/** A provider's app tools, as MCP lists them. */
export function appTools(provider: AppToolProvider, options: AppToolOptions = {}): McpTool[] {
  return render(provider, PROVIDER_TOOLS[provider], options);
}

/** The tools a provider's app-managed worker gets, as MCP lists them (Claude's worker `appMcp`, the agy worker bridge). */
export function workerAppTools(provider: AppToolProvider): McpTool[] {
  return render(provider, WORKER_APP_TOOLS, {});
}

/** The same tools in Codex's dynamic-tool form. */
export function codexDynamicTools(tools: readonly McpTool[]): CodexDynamicTool[] {
  return tools.map(({ name, description, inputSchema }) => ({ type: "function", name, description, inputSchema }));
}
