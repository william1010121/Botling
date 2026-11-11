// The app tools, defined once (provider-layer plan 4.1). A coordinator steers its workers and the app through these
// tools: app_handoff, app_send_message, app_cancel_task, the report tools (app_task_checkpoint, app_reconcile_report),
// routines (app_routines, every engine) and monitors. A worker gets one tool of its own, app_notify_owner (`workerAppTools`): a note to the bot that
// started it while it keeps working. Coordinators and workers alike get the browser tools; the Note tools (app_note_*)
// go to every coordinator, their three read tools to workers too. Each engine gets them over its own transport: Claude's in-process MCP server (head.ts
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
  | "app_notify_owner" | "app_component_usage"
  | "app_browser_tabs" | "app_browser_open" | "app_browser_requests" | "app_browser_extract"
  | "app_note_outline" | "app_note_read" | "app_note_search"
  | "app_note_edit" | "app_note_insert" | "app_note_delete" | "app_note_move" | "app_note_split" | "app_note_merge" | "app_note_branch";
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
  group: () => ({ type: "string", description: "The job this worker is for, a short name (e.g. \"Compare GPU clouds\"). Give every worker you start for the same job the same group, so the app lists them as one job." }),
  subagent_type: () => text,
  model: () => text,
  // The levels the provider's own engine takes (its workers run on it): Claude's or Codex's.
  effort: ({ provider = "claude" }) => ({ type: "string", enum: [...EFFORTS_BY_ENGINE[provider === "codex" ? "codex" : "claude"]] }),
  engine: ({ engines = ["agy", "codex"] }) => ({ type: "string", enum: [...engines] }),
  machine: () => ({ type: "string", description: "Optional: run this worker on another machine the user set up in Settings › Machines (its name). The project goes there as its current commit (uncommitted changes stay here); the worker works on a branch there, and the branch comes back here when its run ends. Omit to run it where this bot's workers run by default (here, unless its settings name a machine); \"local\" runs it here." }),
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
  kind: () => ({ type: "string", enum: ["once", "recurring", "watch"] }),
  task: () => text,
  request_id: () => text,
  at: () => text,
  cron: () => text,
  timezone: () => text,
  id: () => text,
  command: () => text,
  monitor_id: () => text,
  files: () => ({ type: "array", items: text, maxItems: 20, description: "Full paths of files the note is about (a plan, a progress file, a result)." }),
  // The in-app browser tools (browser-bot.ts, core/browser-tools.ts).
  tab_id: () => ({ type: "string", description: "A tab of your browser pane, from app_browser_tabs (e.g. t3). Default: the tab the user has selected." }),
  url: () => ({ type: "string", description: "An http(s) address." }),
  url_contains: () => ({ type: "string", description: "Only requests whose URL contains this text (case does not matter)." }),
  resource_type: () => ({ type: "string", description: "Only this DevTools resource type: document, xhr (Fetch/XHR), script, stylesheet, image, font, media, websocket, other." }),
  method: () => ({ type: "string", description: "Only this HTTP method (GET, POST, …)." }),
  limit: () => ({ type: "integer", minimum: 1, maximum: 200, description: "The newest this many matching requests (default 50)." }),
  include_bodies: () => ({ type: "boolean", description: "Include response bodies (text; base64 for binary). Default false." }),
  unmasked_headers: () => ({ type: "boolean", description: "Show Cookie, Set-Cookie and Authorization values instead of <masked>. Only when the user asked for them." }),
  what: () => ({ type: "string", enum: ["tables", "text", "links", "selector", "script"], description: "tables: every <table> as headers + rows (default); text: the page's visible text; links: every link; selector: the elements matching selector; script: your own read-only script." }),
  selector: () => ({ type: "string", description: "A CSS selector (what: selector)." }),
  script: () => ({ type: "string", description: "what: script. The body of an async function run in the page (an isolated world, sees the DOM): return JSON-able data, e.g. return [...document.querySelectorAll('.price')].map(e => e.textContent). Read-only: clicking, submitting, typing, navigation and network calls are refused." }),
  save_as: () => ({ type: "string", enum: ["json", "csv", "txt"], description: "Save the full result to a file (csv: rows or the first table) and get its path; give the user that path as a link in your reply. Large results are saved anyway." }),
  // The Note tools (note-tools.ts): a bot's Note by cell id.
  bot: () => ({ type: "string", description: "Whose Note: a bot of this project, by name or id. Default: your own." }),
  ids: () => ({ type: "array", items: text, maxItems: 200, description: "Cell or branch ids (from app_note_outline)." }),
  route: () => ({ type: "string", description: "A route id (from app_note_outline)." }),
  query: () => ({ type: "string", description: "The text to find (case does not matter)." }),
  rev: () => ({ type: "integer", minimum: 1, description: "The rev you read; a different one means someone changed it since." }),
  text: () => ({ type: "string", description: "Markdown. <!-- cell --> lines or a <show> card in it cut it into several cells." }),
  old_text: () => ({ type: "string", description: "Text that is in the cell exactly once." }),
  new_text: () => ({ type: "string", description: "What replaces old_text." }),
  after: () => ({ type: "string", description: "A cell or branch id: right after it." }),
  before: () => ({ type: "string", description: "A cell or branch id: right before it." }),
  line: () => ({ type: "integer", minimum: 2, description: "The cell's line (1-based) where the new cell starts." }),
  next_rev: () => ({ type: "integer", minimum: 1, description: "Optional: the next cell's rev you read." }),
  names: () => ({ type: "array", items: text, maxItems: 20, description: "op create: the routes' names, in order (default \"路線 1\", \"路線 2\")." }),
  branch: () => ({ type: "string", description: "A branch id (from app_note_outline)." }),
  keep: () => ({ type: "string", description: "op dissolve: the route id whose cells stay where the branch was." }),
  op: () => text,
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
      params: ["name", "instructions", "group", "subagent_type", "model", "effort", "machine"], required: ["instructions"] },
    agy: { description: "Assign an authorized task to an app-managed agy or Codex worker; engine identity cannot change on resume. Returns task_id immediately. A correlated app_task_result arrives later. Does not grant tool permissions.",
      params: ["instructions", "name", "group", "engine"], required: ["instructions"] },
    codex: { description: "Assign one independently accepted deliverable to an app-managed worker. Returns acceptance and task_id immediately, not a completed result. Continue other independent, authorized handoffs and required report decisions in the current dispatch phase, then finish the turn without waiting. The app delivers correlated app_task_result reports in later turns. A new handoff does not resolve the active report. Optional effort sets the worker's reasoning effort (low, medium, high, xhigh; default: the Codex workers setting, else yours). Optional model runs the worker on a Codex model Codex offers, by slug (e.g. gpt-6-luna) or short name (e.g. luna); default: the Codex workers setting, else yours. Workers are always Codex; model picks only which Codex model.",
      params: ["instructions", "name", "group", "role", "isolated_git", "effort", "model"], required: ["instructions"] },
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
  { name: "app_routines", forms: routinesForms() },
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
  { name: "app_component_usage", forms: componentUsageForms() },
  ...browserTools(),
  ...noteTools(),
];

/**
 * The Note tools (note-sqlite design, phase 1; note-tools.ts, note-db.ts): a bot's Note (the Note tab, note.md, kept in
 * note.db) read and changed by cell id, each change one transaction checked by rev. Every engine the same words, all at
 * once (a Codex tool list change restarts its coordinator threads). A bot reads its own and its project's bots' Notes
 * and changes only its own; a worker gets the three read tools.
 */
function noteTools(): AppToolDef[] {
  const same = (form: ToolForm): Partial<Record<AppToolProvider, ToolForm>> => ({ claude: form, agy: form, codex: form });
  const id = (what: string) => ({ type: "string", description: what });
  const at = { type: "string", enum: ["start", "end"], description: "With route (or with none of after / before / route: the Note itself): its start or its end (default end)." };
  return [
    { name: "app_note_outline", forms: same({
      description: "The outline of a bot's Note (the user's Note tab, note.md) by id: each cell's id, kind (text, card, image), rev and first line, and each branch with its routes (ids, names) and the cells in them, nested. Start here, then read cells with app_note_read. Ids never change; note.md shows them as <!-- cell: <id> --> lines.",
      params: ["bot"] }) },
    { name: "app_note_read", forms: same({
      description: "Read cells of a bot's Note with their ids, revs, paths (the branch › route they are in) and text: ids (cells or branches), or route (a route id, or \"Branch › Route\" by name) for all in it, or neither for the whole Note in order. A deleted id reads as deleted, with its last text and the note rev it went at. Give the rev back when you change a cell.",
      params: ["bot", "ids", "route"], schemas: { route: { type: "string", description: "A route id, or \"Branch › Route\" by name (nested: \"Outer › Route › Inner › Route\")." } } }) },
    { name: "app_note_search", forms: same({
      description: "Find text in a bot's Note: the cells (id, rev, path, line number, the line), branch and route names that contain query. bot \"all\": every Note of this project.",
      params: ["query", "bot", "limit"], required: ["query"],
      schemas: { bot: { type: "string", description: "Whose Note: a bot of this project by name or id, or \"all\" for every Note of this project. Default: your own." }, limit: { type: "integer", minimum: 1, maximum: 200, description: "At most this many matches (default 20)." } } }) },
    { name: "app_note_edit", forms: same({
      description: "Change one cell of your own Note: text (the whole new cell) with rev, or old_text and new_text (old_text in the cell exactly once; no rev needed, so changes elsewhere never get in the way). A stale rev, or old_text not found once, is refused with the cell's current text and rev: read it and retry. Text that holds <!-- cell --> lines or a <show> card becomes several cells (the first keeps the id; added lists the others). Change the Note with these tools, not by editing note.md. Other bots' Notes are read-only.",
      params: ["id", "rev", "text", "old_text", "new_text"], required: ["id"], schemas: { id: id("The cell's id.") } }) },
    { name: "app_note_insert", forms: same({
      description: "Add cells to your own Note: text goes after or before a cell or branch, or into a route, or with none of these to the Note itself (at: start or end, default end). Returns the new ids.",
      params: ["text", "after", "before", "route", "at"], required: ["text"], schemas: { at } }) },
    { name: "app_note_delete", forms: same({
      description: "Delete a cell of your own Note (rev optional: refused if it changed since). It stays as a tombstone: reading its id says it was deleted, with its last text. A branch: app_note_branch.",
      params: ["id", "rev"], required: ["id"], schemas: { id: id("The cell's id.") } }) },
    { name: "app_note_move", forms: same({
      description: "Move a cell or a whole branch of your own Note: after or before a cell or branch, into a route (into or out of a branch), or with none of these to the Note's top level (at: start or end). Ids and revs stay.",
      params: ["id", "after", "before", "route", "at"], required: ["id"], schemas: { id: id("The cell's or branch's id."), at } }) },
    { name: "app_note_split", forms: same({
      description: "Split a cell of your own Note in two at line: the lines before it keep the id, the rest become a new cell right after (new_id). rev is required. Not inside a code, math or card block.",
      params: ["id", "rev", "line"], required: ["id", "rev", "line"], schemas: { id: id("The cell's id.") } }) },
    { name: "app_note_merge", forms: same({
      description: "Merge a cell of your own Note with the next cell in its route: the next one's text joins it (on a new line) and the next one is deleted. rev (this cell's) is required. A card does not merge.",
      params: ["id", "rev", "next_rev"], required: ["id", "rev"], schemas: { id: id("The cell's id.") } }) },
    { name: "app_note_branch", forms: same({
      description: "Branches in your own Note (alternative routes for one part; the Note tab shows one route at a time). op create: ids (cells next to each other, in order) become the first route, or give a place (after / before / route / at) for an empty branch; name the branch, names its routes. add_route: branch, name. rename: branch or route, name. delete_route: route (not a branch's last one). dissolve: branch, keep (the route whose cells stay in its place; the rest go). delete: branch, all in it. rev: optional, the branch's or route's. Returns the ids made.",
      params: ["op", "ids", "name", "names", "branch", "route", "keep", "after", "before", "at", "rev"], required: ["op"],
      schemas: {
        op: { type: "string", enum: ["create", "add_route", "rename", "delete_route", "dissolve", "delete"] },
        name: { type: "string", description: "op create: the branch's name; add_route: the new route's; rename: the new name." },
        route: { type: "string", description: "A route id: op rename / delete_route, the route; op create, the route the new branch goes into." },
        ids: { type: "array", items: text, maxItems: 200, description: "op create: cells (or branches) next to each other that become the first route." },
        at,
      } }) },
  ];
}
const NOTE_READ_TOOL_NAMES: readonly AppToolName[] = ["app_note_outline", "app_note_read", "app_note_search"];
const NOTE_TOOL_NAMES: readonly AppToolName[] = [...NOTE_READ_TOOL_NAMES, "app_note_edit", "app_note_insert", "app_note_delete", "app_note_move", "app_note_split", "app_note_merge", "app_note_branch"];

/**
 * The in-app browser tools (phase 2, browser-bot.ts): every engine's coordinators and workers, the same words. They
 * read only the user's own browser pane beside this bot's chat (its tabs, their captured traffic, the page) and may
 * open a page there; they never click, type or submit.
 */
function browserTools(): AppToolDef[] {
  const same = (form: ToolForm): Partial<Record<AppToolProvider, ToolForm>> => ({ claude: form, agy: form, codex: form });
  return [
    { name: "app_browser_tabs", forms: same({
      description: "List the tabs open in the user's in-app browser pane beside your chat: tab_id, url, title, which one is selected, and how many network requests were captured. The pane is the user's own browser (their sign-ins); you read it, you do not drive it.",
      params: [] }) },
    { name: "app_browser_open", forms: same({
      description: "Open an http(s) address in a tab of the user's browser pane beside your chat (it shows the pane; an open tab on that address is selected instead). Its network traffic is captured from then on, for app_browser_requests. Returns tab_id; the page loads in the background.",
      params: ["url"], required: ["url"] }) },
    { name: "app_browser_requests", forms: same({
      description: "Read the network requests a tab of the user's browser pane made (captured in the background since the tab opened, the latest 500): method, URL, type, status, request and response headers, post data, and response bodies with include_bodies. Filter with url_contains, resource_type, method, limit. Cookie, Set-Cookie and Authorization are masked unless unmasked_headers. Use it to find a site's API and build a tool on it. save_as json saves everything to a file.",
      params: ["tab_id", "url_contains", "resource_type", "method", "limit", "include_bodies", "unmasked_headers", "save_as"] }) },
    { name: "app_browser_extract", forms: same({
      description: "Read data from the page in a tab of the user's browser pane: its tables, visible text, links, the elements matching a CSS selector, or your own read-only script's result (JSON). Nothing on the page is clicked, typed or submitted. Data the user should get (a table, a CSV) goes to a file with save_as; link that file in your reply.",
      params: ["tab_id", "what", "selector", "script", "save_as"] }) },
  ];
}
const BROWSER_TOOL_NAMES: readonly AppToolName[] = ["app_browser_tabs", "app_browser_open", "app_browser_requests", "app_browser_extract"];

/**
 * app_routines: this bot's schedules (routines.ts `appRoutinesCall`). Every engine's coordinator gets it with the same
 * words (2026-11-11: Claude and Antigravity too, not only Codex); Codex's form is unchanged, so its threads keep their tools.
 */
function routinesForms(): Partial<Record<AppToolProvider, ToolForm>> {
  const form: ToolForm = {
    description: "Manage this bot's persistent routines directly. Operations: list; create kind=once with at (ISO-8601 seconds and explicit offset/Z), or kind=recurring with cron (5 fields), or kind=watch with cron and command (the app runs that shell command in this bot's folder on the schedule without waking you, and wakes you only when it exits non-zero, times out or prints a line starting with ALERT; task is its name). create requires task and unique request_id (reuse on retries), optional timezone (IANA, defaults to local at creation). Returns saved id/status; use id for pause/resume/cancel. List includes legacy cron IDs. Reschedule by cancel then create with a new request_id. Once jobs overdue while closed run on next app check; recurring catches up only today in its saved timezone. fired means the trigger reached the app router, not proof of agent startup or task completion. delivery_uncertain means a crash may have interrupted dispatch: never auto retry. Cancel stops future dispatch, not active work. App must be running; no OS wakeup. Do not edit app-owned schedule JSON or use shell/cron for this tool.",
    params: ["operation", "kind", "task", "request_id", "at", "cron", "timezone", "id", "command"], required: ["operation"],
  };
  return { claude: form, agy: form, codex: form };
}

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

/**
 * app_component_usage (2026-11-11, components on demand): the wake note lists each component in one line; a coordinator
 * reads one component's whole usage (its about.md) only when it needs it. Every engine's coordinator, the same words.
 */
function componentUsageForms(): Partial<Record<AppToolProvider, ToolForm>> {
  const form: ToolForm = {
    description: "Read the full usage of one in-chat component (its about.md: data format, options, examples), by the name the app's component list gives. Call it before you fill a component's JSON or use one of its options; a component listed as (command) needs only <show name=\"name\"></show>.",
    params: ["name"], required: ["name"],
    schemas: { name: { type: "string", description: "The component's name, as the component list gives it." } },
  };
  return { claude: form, agy: form, codex: form };
}

/** Which tools each provider's coordinator gets, in the order it lists them. */
const PROVIDER_TOOLS: Record<AppToolProvider, readonly AppToolName[]> = {
  claude: ["app_handoff", "app_send_message", "app_cancel_task", "app_routines", "app_component_usage", ...BROWSER_TOOL_NAMES, ...NOTE_TOOL_NAMES],
  agy: ["app_task_checkpoint", "app_reconcile_report", "app_handoff", "app_send_message", "app_cancel_task", "app_routines", "app_component_usage", ...BROWSER_TOOL_NAMES, ...NOTE_TOOL_NAMES],
  codex: ["app_routines", "app_monitor_start", "app_monitor_status", "app_monitor_cancel", "app_handoff", "app_send_message", "app_task_checkpoint", "app_component_usage", ...BROWSER_TOOL_NAMES, ...NOTE_TOOL_NAMES],
};

/** The tools an app-managed worker gets (never a coordinator): app_notify_owner, the browser tools and the Note read tools. */
export const WORKER_APP_TOOLS: readonly AppToolName[] = ["app_notify_owner", ...BROWSER_TOOL_NAMES, ...NOTE_READ_TOOL_NAMES];

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
