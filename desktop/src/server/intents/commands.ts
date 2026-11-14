// Every contract command, and how Botling 3's server takes it (M1 brief §3, step 6):
// - intent: the core set. Its intent handler (handlers.ts) runs inside the command's transaction: the intent entries,
//   effect rows, `cmd.applied` and the receipt commit together; the engine is asked only after the commit (effects).
// - legacy: "legacy apply" (legacy.ts). The core's own handler runs first; then one transaction stores the events it
//   emitted and the receipt. A crash between the two loses the receipt, so the sender's re-send runs the handler
//   again: `risk` says what a second run does.
// - read: changes nothing the server keeps; answered by the engine directly, never through a slot.
// - app: handled by the desktop app's main process (windows, dialogs, Finder, updates); never reaches the server.
// `Record<CommandType, …>` makes a new contract command a type error here until it is classified.
import type { CommandType } from "../../contract";

export type RerunRisk = "none" | "low" | "medium" | "high";

export type CommandRoute =
  | { kind: "intent" }
  | { kind: "legacy"; why: string; risk: RerunRisk; rerun: string }
  | { kind: "read" }
  | { kind: "app" };

const intent: CommandRoute = { kind: "intent" };
const read: CommandRoute = { kind: "read" };
const app: CommandRoute = { kind: "app" };
const legacy = (why: string, risk: RerunRisk, rerun: string): CommandRoute => ({ kind: "legacy", why, risk, rerun });

const ASYNC = "its handler is asynchronous (it waits on a process, the network or plugin code), so it cannot run inside the writer's synchronous transaction";
const OUTSIDE = "its state lives outside the chat log (settings files, plugin folders, machines and pairing files), which the core keeps; nothing reads it from server.db in M1";
const SAME = "a second run sets the same value again";

export const COMMAND_ROUTES: Record<CommandType, CommandRoute> = {
  // The core set (intent handlers).
  "chat.send": intent,
  "chat.choose": intent,
  "chat.answer": intent,
  "chat.ignoreQuestion": intent,
  "chat.react": intent,
  "turn.stop": intent,
  "component.approve": intent,
  "bots.create": intent,
  "bots.remove": intent,
  "settings.set": intent,

  // Reads.
  "project.files": read,
  "project.preview": read,
  "chat.snapshot": read,
  "chat.history": read,
  "task.output": read,
  "attachment.file": read,
  "subagent.view": read,
  "agent.targets": read,
  "results.list": read,
  "storage.list": read,
  "plugins.list": read,
  "plugins.store": read,
  "plugins.panel": read,
  "plugins.web": read,
  "plugins.file": read,
  "settings.get": read,
  "agy.runtime.check": read,
  "bot.settings": read,
  "mobile.view": read,
  "machines.view": read,
  "machines.hosts": read,
  "doctor.view": read,
  "usage.view": read,
  "codex.models": read,
  "engine.models": read,
  "routines.list": read,
  "component.detail": read,
  "waiting.list": read,
  "turn.await": read,
  "card.image": read,

  // The desktop app's main process.
  "files.pick": app,
  "storage.pick": app,
  "projects.pick": app,
  "link.open": app,
  "link.drag": app,
  "result.open": app,
  "storage.open": app,
  "storage.drag": app,
  "worker.file": app,
  "card.page": app,
  "chat.reloadPage": app,
  "plugins.openLink": app,
  "doctor.copy": app,
  "updates.check": app,
  "updates.open": app,
  "updates.restart": app,
  "updates.stage": app,

  // Legacy apply.
  "boot.commit": legacy("the 2.x update handshake (the boot receipt), part of the core's start", "none", "activating again does nothing"),
  "plugins.enable": legacy(OUTSIDE, "none", SAME),
  "plugins.storeInstall": legacy(ASYNC, "low", "installs the same plugin version again"),
  "plugins.storeDismiss": legacy(OUTSIDE, "none", SAME),
  "plugins.revert": legacy("Maintainer's git work on the plugin folder; " + OUTSIDE, "medium", "may revert one more change of the plugin, or be refused (nothing to revert)"),
  "plugins.remove": legacy(OUTSIDE, "low", "refused: the plugin is already gone"),
  "plugins.setting": legacy(OUTSIDE, "none", SAME),
  "plugins.secret": legacy(OUTSIDE, "none", SAME),
  "plugins.command": legacy(ASYNC, "high", "the plugin's command runs twice"),
  "plugins.linkCommand": legacy(ASYNC, "high", "the plugin's link command runs twice"),
  "plugins.tabCommand": legacy(ASYNC, "high", "the plugin's tab command runs twice"),
  "plugins.call": legacy(ASYNC, "high", "the plugin's method runs twice"),
  "plugins.approvalAsk": legacy("asks the plugin host, which posts the card itself", "medium", "a second approval card may be posted"),
  "plugins.approve": legacy(OUTSIDE, "none", SAME),
  "plugins.tileImages": legacy(OUTSIDE, "none", "writes the same images again"),
  "plugins.noteSnapshot": legacy(OUTSIDE, "none", "writes the same picture again"),
  "plugins.linkTarget": legacy("a plugin's web part asks where a link goes (it may open a chat)", "low", "the link target is opened again"),
  "plugins.loaded": legacy("a plugin web part's start report (memory only)", "none", "reported again"),
  "plugins.failed": legacy("a plugin web part's failure report (memory only)", "none", "reported again"),
  "plugins.notice": legacy("a plugin web part's notice (shown, not kept)", "low", "the notice shows twice"),
  "agy.runtime.install": legacy(ASYNC, "low", "installs the same runtime again"),
  "projects.add": legacy("adds a project bot from a folder; rare, " + OUTSIDE, "low", "answers added: false (the project is there)"),
  "subagent.settle": legacy("a worker's settled flag; not on the M1 path", "none", SAME),
  "link.authorize": legacy("authorizes a link a line asked for; not on the M1 path", "none", SAME),
  "storage.add": legacy(OUTSIDE, "low", "the same paths are added again (the list keeps one of each)"),
  "storage.remove": legacy(OUTSIDE, "none", "refused or nothing: already removed"),
  "waiting.ignore": legacy("the waiting list (core memory and settings)", "none", SAME),
  "engineDefaults.applyAll": legacy(OUTSIDE, "none", SAME),
  "mobile.pair": legacy(ASYNC, "low", "a second pairing code; the first one expires unused"),
  "mobile.revoke": legacy(OUTSIDE, "none", "already revoked"),
  "mobile.relay": legacy(OUTSIDE, "none", SAME),
  "machines.add": legacy(ASYNC, "low", "finds the machine already added"),
  "machines.pair": legacy(ASYNC, "low", "a second pairing request; the first expires"),
  "machines.approve": legacy(ASYNC, "low", "approves an already approved machine (nothing new)"),
  "machines.decline": legacy(ASYNC, "none", "already declined"),
  "machines.revoke": legacy(OUTSIDE, "none", "already revoked"),
  "machines.remove": legacy(OUTSIDE, "none", "already removed"),
  "machines.check": legacy(ASYNC, "none", "checks again"),
  "bot.configure": legacy("a bot's head settings (bot.json), applied by the core's head restart rules", "none", SAME),
  "bot.restart": legacy("restarts the bot's head process", "medium", "the head restarts twice; a turn begun in between is cut"),
  "files.add": legacy("the input box's files (core memory)", "low", "a second copy of the files waits in the input box"),
  "files.data": legacy(ASYNC, "low", "a second copy of the file waits in the input box"),
  "files.remove": legacy("the input box's files (core memory)", "none", "already removed"),
  "heads.set": legacy("a bot's heads (bot.json), applied by the core's head rules", "none", SAME),
  "heads.answerWith": legacy("a bot's heads (bot.json)", "none", SAME),
  "handoff.stop": legacy("stops a hand-off between heads (core memory)", "none", "already stopped"),
  "rounds.stop": legacy("stops the heads' rounds (core memory)", "none", "already stopped"),
  "doctor.run": legacy(ASYNC, "none", "runs the checks again"),
  "worker.cwd": legacy("a worker's folder (agents.json)", "none", SAME),
  "agent.move": legacy(ASYNC, "low", "refused: the agent already moved"),
  "agent.message": legacy(ASYNC, "high", "the agent gets the message twice"),
  "agent.stop": legacy(ASYNC, "none", "already stopped"),
  "agent.group": legacy(ASYNC, "medium", "a second sub bot may be made for agents that already moved, or it is refused"),
  "subbot.close": legacy(ASYNC, "low", "refused or nothing: already closed"),
  "chat.shown": legacy("what the window shows (core memory, unread counts)", "none", SAME),
  "chat.read": legacy("unread counts (bot.json)", "none", SAME),
  "component.command": legacy("runs a component's command (a process)", "high", "the component's command runs twice"),
  "component.save": legacy("a component's saved data (its folder)", "none", "saves the same data again"),
  "component.report": legacy(ASYNC, "medium", "the report is sent twice"),
  "component.revert": legacy("Maintainer's git work on a component", "medium", "may revert one more change, or be refused"),
  "chat.feedback": legacy(ASYNC, "medium", "the feedback is sent twice"),
  "routines.change": legacy("a bot's routines (routines.json); the core drops a repeated add with the same requestId", "low", "an add without a requestId makes a second routine"),
};

export function routeOf(type: CommandType): CommandRoute {
  return COMMAND_ROUTES[type];
}

/** The legacy table as Markdown (written to the M1 artifacts; `npm run` is not needed: a test prints it). */
export function legacyTable(): string {
  const rows = Object.entries(COMMAND_ROUTES)
    .filter((entry): entry is [string, Extract<CommandRoute, { kind: "legacy" }>] => entry[1].kind === "legacy")
    .sort(([a], [b]) => a.localeCompare(b));
  const lines = ["| Command | Why it is not converted (M1) | Re-run risk | What a second run does |", "|---|---|---|---|"];
  for (const [type, route] of rows) lines.push(`| \`${type}\` | ${route.why} | ${route.risk} | ${route.rerun} |`);
  return lines.join("\n");
}
