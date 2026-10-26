// A bot (or its subagents) stopped because the network went away (1.x's NetworkResume.swift). What
// the app sees of that is in claude's stream-json: `system`/`api_retry` lines with no HTTP status
// while claude retries, then an API error with no HTTP status (`isConnectionLoss`) that ends the turn
// (the process stays alive, waiting for the next message) or a subagent, or, rarely, the process
// exiting with it on stderr (`mentionsConnectionError`). Once Claude's API answers again
// (`probeNetwork`), the bot carries on: within `WARM_WINDOW_MS` in the same session, continuing its
// subagents; later, cut-off subagents start over as new ones. The texts are 1.x's, word for word.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 1.x's `Outage`. */
export interface Outage {
  /** When the run failed (ms); the 50-minute cache window counts from here. */
  since: number;
  /** The bot's own turn ended with the connection error. */
  turnFailed: boolean;
  /** Subagents it cut off, by the id of the tool call that started them. */
  subagents: string[];
  /** The process went away too: the session to `--resume` while its cache is warm. */
  lostSession: string | null;
}

/** Back within this long, the session (and its subagents) go on where they were: the prompt cache (1-hour TTL) is still warm. */
export const WARM_WINDOW_MS = 50 * 60_000;
/** The line added to a cut-off subagent's prompt when it starts over. */
export const RESTART_LINE = "這個任務剛剛被中斷了，請從 worktree 的現況接著做";
/** The status and chat word for it. */
export const NETWORK_LABEL = "網路中斷";

/**
 * claude's API error (`is_api_error_message` on an assistant line) that had no answer from the API: no
 * HTTP status, filed as `server_error` or `unknown`, and no typed kind (`api_error`) but `no_response`.
 */
export function isConnectionLoss(line: Record<string, unknown>): boolean {
  if (line.is_api_error_message !== true || (line.api_error_status !== undefined && line.api_error_status !== null)) return false;
  const filed = typeof line.error === "string" ? line.error : "unknown";
  if (filed !== "server_error" && filed !== "unknown") return false;
  const kind = line.api_error;
  return kind === undefined || kind === null || kind === "no_response";
}

/** The chat line when a run fails this way. */
export function lostText(detail: string): string {
  const trimmed = detail.trim();
  return `${NETWORK_LABEL}：連不上 Claude（${trimmed || "connection lost"}）。網路恢復後會自動接著做。`;
}

export type ResumeMode = "carryOn" | "restartSubagents";

/** Back within the warm window, or with no subagent cut off: it carries on; else subagents start over. */
export function resumeMode(elapsedMs: number, subagents: number): ResumeMode {
  return elapsedMs <= WARM_WINDOW_MS || subagents === 0 ? "carryOn" : "restartSubagents";
}

const minutesOf = (elapsedMs: number) => Math.max(1, Math.round(elapsedMs / 60_000));

/** The divider when it comes back. */
export function restoredText(elapsedMs: number, mode: ResumeMode): string {
  return `網路恢復 · 中斷約 ${minutesOf(elapsedMs)} 分鐘 · ${mode === "carryOn" ? "接著原本的工作" : "重新開始被中斷的子代理"}`;
}

/** A subagent that was cut off, with what it takes to continue or restart it. */
export interface CutOff { description: string; type: string | null; prompt: string; agentId: string | null }

/** A cut-off subagent's prompt for starting over: the original, plus the one line. */
export function restartPrompt(original: string): string {
  const trimmed = original.trim();
  return trimmed ? `${trimmed}\n${RESTART_LINE}` : RESTART_LINE;
}

/** What the bot is told when the network is back (1.x's `resumeNote`). */
export function resumeNote(elapsedMs: number, carryOn: boolean, subagents: CutOff[]): string {
  const minutes = minutesOf(elapsedMs);
  const parts = [`(App: ${NETWORK_LABEL}: the network connection was lost about ${minutes} minute${minutes === 1 ? "" : "s"} ago and is back now.)`];
  if (carryOn || !subagents.length) parts.push("Carry on with what you were doing when it dropped, from where you left off; do not start over or redo finished steps.");
  if (!subagents.length) return parts.join("\n");
  if (resumeMode(elapsedMs, subagents.length) === "carryOn") {
    parts.push(`These subagents were cut off by it. Continue each one where it stopped by sending it a message with SendMessage (to: its agentId), so it keeps its context; only if it can no longer be reached, start a new one of the same type in the same worktree with its original prompt plus the line "${RESTART_LINE}".`);
    for (const subagent of subagents) {
      parts.push(`- "${subagent.description}"` + (subagent.agentId ? ` (agentId: ${subagent.agentId})` : "") + (subagent.type ? `, subagent_type: ${subagent.type}` : ""));
    }
  } else {
    parts.push("These subagents were cut off more than 50 minutes ago, so do not continue them. Start each again as a NEW subagent of the same type, working in the same worktree it used (do not make a new one), with exactly the prompt given here (its original prompt with one line added at the end):");
    for (const subagent of subagents) {
      parts.push(`- "${subagent.description}"` + (subagent.type ? ` (subagent_type: ${subagent.type})` : "") + `:\n<prompt>\n${restartPrompt(subagent.prompt)}\n</prompt>`);
    }
  }
  return parts.join("\n");
}

/** Words in an error line that mean the connection itself failed (1.x's `ConnectionErrorText.connectionMarkers`). */
const CONNECTION_MARKERS = [
  "connection error", "unable to connect", "timed out", "timeout", "econnreset", "econnrefused",
  "enotfound", "etimedout", "eai_again", "enetunreach", "ehostunreach", "enetdown", "econnaborted",
  "socket hang up", "fetch failed", "network", "epipe", "connection closed", "connection reset",
  "connection lost", "connection refused",
];

/** One line of claude's own API error for a lost connection. Certificate problems are not the network going away. */
export function isConnectionErrorLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  const fromAPI = lower.includes("api error") || lower.startsWith("unable to connect to api");
  if (!fromAPI || lower.includes("ssl") || lower.includes("certificate")) return false;
  return CONNECTION_MARKERS.some((marker) => lower.includes(marker));
}

/** A subagent's report that is claude's connection error: its first line is. */
export function isConnectionError(text: string): boolean {
  const first = text.split(/\r?\n/).find((line) => line.trim());
  return first !== undefined && isConnectionErrorLine(first);
}

/** Any line is (stderr of a process that exited, a failed subagent's notification). */
export function mentionsConnectionError(text: string): boolean {
  return text.split(/\r?\n/).some(isConnectionErrorLine);
}

/** The first line that is a connection error, or "". */
export function connectionErrorLine(text: string): string {
  return text.split(/\r?\n/).find(isConnectionErrorLine) ?? "";
}

/** Where bots reach the API (1.x's `NetworkProbe.endpoint`): ANTHROPIC_BASE_URL from the app's environment or Claude Code's settings.json, else Anthropic's. */
export function probeEndpoint(env: NodeJS.ProcessEnv = process.env, configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): string {
  let configured = env.ANTHROPIC_BASE_URL;
  if (!configured) {
    try {
      const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
      const value = settings?.env?.ANTHROPIC_BASE_URL;
      if (typeof value === "string") configured = value;
    } catch { /* none */ }
  }
  try {
    const url = new URL((configured ?? "").trim());
    if ((url.protocol === "https:" || url.protocol === "http:") && url.host) return url.toString();
  } catch { /* not a URL */ }
  return "https://api.anthropic.com/";
}

/** Whether Claude's API can be reached again: any HTTP answer from it counts (even an error status), only no answer at all does not. */
export async function probeNetwork(endpoint = probeEndpoint(), timeoutMs = 10_000): Promise<boolean> {
  try {
    await fetch(endpoint, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
