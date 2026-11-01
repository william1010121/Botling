// The words the app says when an agent changes owner (A1.7), and the interim report line for an agent whose owner is not
// its host (until A2 relays reports). Pure: the server posts them, keyed by move id so none is posted twice.
import type { AgentState } from "./agent-registry";
import type { Engine } from "./heads";
import { engineName } from "./sub-bots";

const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.trim() ?? "";

/** The old owner's chat line. */
export function movedAwayNotice(input: { title: string; to: string; host: string }): string {
  return `Moved "${input.title}" to ${input.to}. It keeps running on ${input.host}; its reports now go to ${input.to}.`;
}

/** The old owner's (and a host that is neither owner's) model note: delivered with its next message, never a wake. */
export function movedAwayNote(input: { title: string; nativeId: string; to: string }): string {
  return `(App: Your subagent "${input.title}" (${input.nativeId}) now belongs to ${input.to}. Do not message, wait for, stop or report on it. If the user asks, say it is with ${input.to}.)`;
}

const stateWords: Record<AgentState, string> = {
  running: "running", idle: "idle", reportPending: "report pending", completed: "completed", failed: "failed", stopped: "stopped", interrupted: "interrupted", lost: "lost",
};

/** The new owner's chat line. */
export function handedNotice(input: { from: string; title: string; engine: Engine; state: AgentState; host: string; folder: string; statusFile: string }): string {
  return `${input.from} handed you "${input.title}" (${engineName(input.engine)}, ${stateWords[input.state]}). It runs on ${input.host} in ${input.folder}. Status: ${input.statusFile}`;
}

/** The new owner's model note (an existing bot: with its next message, so it is not woken). */
export function handedNote(input: { from: string; title: string; nativeId: string; agentId?: string; engine: Engine; host: string; statusFile: string }): string {
  return `(App: ${input.from} handed you its ${engineName(input.engine)} agent "${input.title}" (${input.nativeId}). It keeps running on ${input.host}; its reports will come to you as app messages. Read ${input.statusFile} to see how it is going.${input.agentId ? ` ${agentTagsHelp(input.agentId)}` : ""})`;
}

/** The first message to a sub bot made to own a moved agent (a sibling of `subBotDirectFirstMessage`). */
export function subBotAdoptedFirstMessage(input: { parentName: string; name: string; from: string; title: string; nativeId: string; agentId?: string; engine: Engine; host: string; folder: string; statusFile: string; note?: string }): string {
  return [
    `You are the sub bot "${input.name}", made under "${input.parentName}" to own one agent: "${input.title}" (${engineName(input.engine)}, ${input.nativeId}), handed over by ${input.from}.`,
    `You own the agent: it keeps running on ${input.host} in ${input.folder}, and it is not restarted or re-prompted. Its status file is ${input.statusFile}; read it to see what it has done.`,
    "Its reports will come to you as app messages. Do not start the same work again yourself.",
    input.agentId ? agentTagsHelp(input.agentId) : "",
    input.note ? `Extra words from ${input.from}: ${input.note}` : "",
    "Then say in one sentence which agent you now own. The user may talk to you directly in this chat.",
  ].filter(Boolean).join("\n");
}

/** Said to a running Codex worker, only when asked for (`notifyAgent`). */
export function agentToldOfMove(to: string): string {
  return `(App: Your work now belongs to "${to}". Carry on exactly as before; the app routes your report.)`;
}

/** "Back": the host's model note when an agent is its own again. */
export function backNote(input: { title: string; nativeId: string; from: string }): string {
  return `(App: Your subagent "${input.title}" (${input.nativeId}) is yours again (it was with ${input.from}); its reports come to you as before.)`;
}

/** A1 interim: an agent owned elsewhere ended; its owner's chat says so (the host still gets its native report turn). */
export function detachedEndedNotice(input: { title: string; status: string; report: string }): string {
  const report = firstLine(input.report);
  return `"${input.title}" finished (${input.status}).${report ? ` Its report: ${report}` : ""}`;
}

/** Its host bot was removed while another bot owned it. */
export function hostLostNotice(input: { title: string; host: string; statusFile: string | null }): string {
  return `"${input.title}" is lost: the bot that ran it (${input.host}) was removed.${input.statusFile ? ` Its last status: ${input.statusFile}` : ""}`;
}

/** Its owner bot was removed: it is the host's again. */
export function ownerGoneNotice(input: { title: string; owner: string }): string {
  return `"${input.title}" is yours again: ${input.owner}, which owned it, was removed.`;
}

/** The wake note listing the agents a bot owns that run elsewhere (in the style of `subBotBriefing`). */
export function ownedAgentsBriefing(rows: { title: string; id: string; engine: Engine; host: string; state: AgentState; statusFile: string | null }[]): string {
  if (!rows.length) return "";
  const lines = rows.map((row) => `- "${row.title}" (${row.id}, ${engineName(row.engine)}, on ${row.host}, ${stateWords[row.state]})${row.statusFile ? `: status file ${row.statusFile}` : ""}`);
  return `(App: Agents handed to you that run on another bot. They keep running there; their reports come to you as app messages. To check how one is going, read its status file.)\n${lines.join("\n")}`;
}

const clipReport = (text: string, limit = 8_000) => (text.length > limit ? `${text.slice(0, limit)}\n… (cut; the rest is in its status file)` : text);

/** How the owner follows an agent up or stops it (the tags the app reads from its reply; hidden from the chat). */
export function agentTagsHelp(agentId: string): string {
  return `To continue it: <agent-message to="${agentId}">your words</agent-message>. To stop it: <agent-stop to="${agentId}"/>.`;
}

/** The owner's app message with a run's report of an agent it owns that another bot runs (A2.4). */
export function agentReportNote(input: { engine: Engine; title: string; from: string; host: string; run: number; status: string; report: string; agentId: string; statusFile: string | null }): string {
  return `(App: The ${engineName(input.engine)} agent "${input.title}" you own (from ${input.from}; it runs on ${input.host}) finished run ${input.run}: ${input.status}. Its report:\n${clipReport(input.report.trim() || "(no words)")}\n${input.statusFile ? `Its status file: ${input.statusFile}\n` : ""}Tell the user what came of it in a sentence or two. ${agentTagsHelp(input.agentId)})`;
}

/** The owner's model note when it commands an agent it does not own. */
export function notOwnedNote(to: string, owner: string | null): string {
  return `(App: You do not own the agent "${to}"${owner ? `; it belongs to ${owner}` : ""}, so nothing was sent to it.)`;
}

/** The owner's chat line after its follow-up reached the agent (or waits for its run to end). */
export function agentMessageNotice(input: { title: string; how: "steered" | "newRun" | "queued"; run: number }): string {
  return input.how === "steered" ? `Sent your words to "${input.title}"; it reads them in the run under way.`
    : input.how === "newRun" ? `Sent your words to "${input.title}"; it started run ${input.run}.`
      : `"${input.title}" is at work and takes no words until it reports; your words are sent right after its run ends.`;
}

/** The owner's chat line after queued words were sent once the agent's run ended. */
export function queuedSentNotice(input: { title: string; run: number }): string {
  return `Sent the words you left for "${input.title}"; it started run ${input.run}.`;
}

/** The first message to a sub bot made to own several agents at once (`<sub-bot subagents="…">`, "New sub bot with these…"). */
export function subBotGroupFirstMessage(input: { parentName: string; name: string; from: string; agents: { title: string; agentId: string; nativeId: string; engine: Engine; state: AgentState; host: string; statusFile: string | null }[]; task?: string }): string {
  const lines = input.agents.map((agent) => `- "${agent.title}" (${engineName(agent.engine)}, ${stateWords[agent.state]}, agent ${agent.agentId}, runs on ${agent.host}). Status file: ${agent.statusFile ?? "(not written yet)"}`);
  return [
    `You are the sub bot "${input.name}", made under "${input.parentName}" to own ${input.agents.length === 1 ? "this agent" : `these ${input.agents.length} agents`}, handed over by ${input.from}:`,
    ...lines,
    "They keep running where they are; nothing was restarted or re-prompted. Read their status files to see what they have done. Their reports come to you as app messages.",
    `To follow one up: <agent-message to="its agent id">your words</agent-message>. To stop one: <agent-stop to="its agent id"/>. Do not start the same work again yourself.`,
    input.task?.trim() ? `Your task from ${input.from}: ${input.task.trim()}` : "",
    "Then say in one sentence what you now own. The user may talk to you directly in this chat.",
  ].filter(Boolean).join("\n");
}
