// Sub bots: a running subagent moved out into a bot of its own that the user can open and talk to.
// A sub bot is a full Bot that is hidden from the left column and hangs under its project bot
// (`parent`), in the same folder. The hand-off is: the subagent writes .bot/subagents/<id>/handoff.md
// and ends (the project bot asked it with SendMessage), the core waits for that, and only when it does
// not end in time stops the whole turn and writes the handoff file itself from what the subagent is
// known to have done. This file holds the pure parts; the server wires them to the bots.
import type { StepRecord } from "./store/records";
import type { Engine } from "./heads";

/** How long the core waits for the subagent to end by itself before it stops the turn (the design says 60-90 seconds). */
export const SUB_BOT_WAIT_MS = 75_000;
export const SUB_BOT_POLL_MS = 500;

/** A folder-safe form of an agent id (the id is claude's, but it is written into a path). */
export function safeToken(token: string): string {
  const safe = token.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return safe || "subagent";
}

/** <folder>/.bot/subagents/<id>/: where a moved subagent's handoff.md and its sub bot's progress.md live. */
export function handoffFolder(folder: string, token: string): string {
  return `${folder.replace(/\/+$/, "")}/.bot/subagents/${safeToken(token)}`;
}
export const handoffFile = (folder: string, token: string) => `${handoffFolder(folder, token)}/handoff.md`;
export const progressFile = (folder: string, token: string) => `${handoffFolder(folder, token)}/progress.md`;

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * handoff.md written by the app when the subagent did not write one itself: what it was asked, then what
 * it is known to have done (its steps, from its file), and a note that the rest is for the next owner to check.
 */
export function fallbackHandoff(input: { name: string; description: string; prompt: string; steps: StepRecord[]; status: string; result: string; reason: string; engine?: Engine; id?: string; threadId?: string | null; run?: number | null }): string {
  const steps = input.steps.filter((step) => step.kind === "tool" || step.kind === "text" || step.kind === "subagent");
  const done = steps.slice(-40).map((step) => {
    const line = step.kind === "text" ? `said: ${clip((step.detail ?? step.title).replace(/\s+/g, " "), 200)}` : `${step.tool ?? step.kind}: ${clip((step.title || step.detail || "").replace(/\s+/g, " "), 160)}${step.failed ? " (failed)" : ""}`;
    return `- ${line}`;
  });
  return [
    `# Handoff: ${input.name}`,
    "",
    `Written by the app, not by the subagent: ${input.reason}`,
    // Where its own record lives, for the next owner to look at if the list below is not enough.
    input.engine && input.engine !== "claude" ? `\nIt ran as a ${input.engine === "codex" ? "Codex" : "Antigravity"} worker${input.id ? ` (task ${input.id}` : ""}${input.run ? `, run ${input.run}` : ""}${input.threadId ? `, thread ${input.threadId}` : ""}${input.id ? ")" : ""}.` : "",
    "",
    "## What it was asked",
    input.description ? `${input.description}\n` : "",
    clip(input.prompt, 4_000) || "(unknown)",
    "",
    "## What it is known to have done",
    done.length ? done.join("\n") : "(No steps were recorded.)",
    input.result ? `\n## Its last report\n${clip(input.result, 4_000)}` : "",
    "",
    "## Next steps",
    `The subagent was ${input.status} when this was written. Check the files it touched (git status / git diff) against the list above, finish what the request asked for, and do not redo what is already done.`,
    "",
  ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}

export interface HandoffPorts {
  /** The subagent's status now ("missing": it is no longer known). */
  status(): "running" | "completed" | "failed" | "stopped" | "missing";
  /** Stops the subagent and marks it stopped (claude: the whole turn, it cannot stop one subagent alone; a worker: that worker alone). */
  forceStop(): Promise<void>;
  /** Asks the subagent to write handoff.md and end, when the app (not the project bot) has to say so (a Codex worker). Called once, while it runs. */
  ask?(): void | Promise<void>;
  /** The subagent cannot take a message while it works (an Antigravity worker): stop it at once instead of waiting. */
  stopAtOnce?: boolean;
  /** What the app knows of its work, as a handoff file's text; asked only when the file must be written. */
  fallbackText(reason: string): string;
  /** Whether handoff.md has words in it. */
  written(): boolean;
  write(text: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  waitMs?: number;
  pollMs?: number;
}
export interface HandoffResult {
  /** ended: it ended by itself; forced: the turn was stopped after the wait ran out. */
  outcome: "ended" | "forced";
  /** handoff.md was written by the app (the subagent did not, or was cut off). */
  wroteFallback: boolean;
}

/** Waits for the subagent to end, forces it only on timeout, and makes sure handoff.md exists either way. */
export async function runHandoff(ports: HandoffPorts): Promise<HandoffResult> {
  const waitMs = ports.waitMs ?? SUB_BOT_WAIT_MS;
  const pollMs = ports.pollMs ?? SUB_BOT_POLL_MS;
  const until = ports.now() + waitMs;
  if (!ports.stopAtOnce && ports.ask && ports.status() === "running") await ports.ask();
  while (!ports.stopAtOnce && ports.status() === "running" && ports.now() < until) await ports.sleep(pollMs);
  let outcome: HandoffResult["outcome"] = "ended";
  const forcedAtOnce = Boolean(ports.stopAtOnce) && ports.status() === "running";
  if (ports.status() === "running") {
    await ports.forceStop();
    outcome = "forced";
  }
  if (ports.written()) return { outcome, wroteFallback: false };
  ports.write(ports.fallbackText(outcome === "forced"
    ? forcedAtOnce
      ? "the subagent cannot take a message while it works, so the app stopped it at once and wrote this from the steps it had recorded."
      : "the subagent did not end in time, so the app stopped it and wrote this from the steps it had recorded."
    : "the subagent ended without writing a handoff, so the app wrote this from the steps it had recorded."));
  return { outcome, wroteFallback: true };
}

/** The first message to a new sub bot: take over from handoff.md and keep progress.md. */
export function subBotFirstMessage(input: { parentName: string; name: string; handoff: string; progress: string; note: string }): string {
  return [
    `You are the sub bot "${input.name}", moved out of "${input.parentName}" from a subagent that was working on this folder.`,
    `Read ${input.handoff} now and take over exactly where it stops, starting with its next steps.`,
    `Keep ${input.progress} current as you work: what is done, what you are doing now, what is next, anything waiting on the user. Its first line is "Status: working", and "Status: done" when your job is finished. ${input.parentName} reads this file to answer the user's progress questions.`,
    input.note ? `Extra words from ${input.parentName}: ${input.note}` : "",
    "Then say in one sentence what you are continuing. The user may talk to you directly in this chat, and you may start your own subagents.",
  ].filter(Boolean).join("\n");
}

/** The first message to a new, empty sub bot made directly (no subagent behind it): its task, and progress.md. */
export function subBotDirectFirstMessage(input: { parentName: string; name: string; task: string; progress: string }): string {
  return [
    `You are the sub bot "${input.name}", made by "${input.parentName}" for one job in this folder. Your job:`,
    input.task,
    `Keep ${input.progress} current as you work: what is done, what you are doing now, what is next, anything waiting on the user. Its first line is "Status: working", and "Status: done" when your job is finished. ${input.parentName} reads this file to answer the user's progress questions.`,
    "Then say in one sentence what you are starting. The user may talk to you directly in this chat, and you may start your own subagents.",
  ].join("\n");
}

/** The engine a directly made sub bot runs on: the one asked for when the project bot has it, else the project bot's own. */
export function directSubBotEngine(asked: string | undefined, parent: { engine: Engine; heads: Engine[] }): { engine: Engine; note: string } {
  if (asked === "claude" || asked === "codex" || asked === "agy") return subBotEngine(asked, parent);
  return { engine: parent.engine, note: asked ? `"${asked}" is not an engine (claude, codex or agy), so the sub bot runs on ${engineName(parent.engine)}.` : "" };
}

/** One sub bot as the project bot's wake note lists it. */
export interface SubBotRow { name: string; progress: string; working: boolean; status: string | null }

/** The sub bot list a project bot wakes with (like the main bot's project list): who, and where to read their progress. */
export function subBotBriefing(rows: SubBotRow[]): string {
  if (!rows.length) return "";
  const lines = rows.map((row) => `- ${row.name}${row.status ? ` (${row.status})` : ""}${row.working ? " (working now)" : ""}: progress file ${row.progress}`);
  return `(App: Your sub bots. To check how one is going, read its progress file and do not wake it; the user can also open it and talk to it directly.)\n${lines.join("\n")}`;
}

/** progress.md's first "Status:" line, lower-cased ("done", "working"…), or null. */
export function progressStatus(text: string): string | null {
  const match = /^\s*status\s*:\s*([^\n]*)/i.exec(text);
  return match ? match[1]!.trim().toLowerCase().slice(0, 60) || null : null;
}

/** What the app says to a Codex worker at work when its work is moving to a sub bot (it joins the worker's turn like a follow-up). */
export function wrapUpMessage(file: string): string {
  return [
    `(App: Your work is being handed to a new owner now. Stop starting new work. Write ${file} (create its folder if needed): what is done, what is left, the next steps, the files you touched, and anything the next owner must know.`,
    "Then end your turn with a one-sentence report that says it was handed off. Do not finish the remaining work yourself.)",
  ].join(" ");
}

const ENGINE_NAMES: Record<Engine, string> = { claude: "Claude", codex: "Codex", agy: "Antigravity" };
export const engineName = (engine: Engine) => ENGINE_NAMES[engine];

/**
 * The engine a sub bot runs on: the moved worker's own, so it continues as the same kind of agent, when its project bot
 * can use that engine (one of its heads); otherwise the project bot's own, and `note` says so.
 */
export function subBotEngine(workerEngine: Engine, parent: { engine: Engine; heads: Engine[] }): { engine: Engine; note: string } {
  if (workerEngine === parent.engine || parent.heads.includes(workerEngine)) return { engine: workerEngine, note: "" };
  return { engine: parent.engine, note: `${engineName(workerEngine)} is not one of this project bot's engines, so the sub bot runs on ${engineName(parent.engine)}.` };
}
