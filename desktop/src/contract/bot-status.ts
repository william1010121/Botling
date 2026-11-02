// What the app says about a bot's state: the dot's key and the words beside it (the column, the chat header,
// the board). Shared so a plugin reading the workspace (`workspace.bots`) is told the same.
import type { BotView } from "./index";

export function status(bot: BotView): string {
  // An outage first, then Codex waiting to retry, then claude retrying the API (both shown as cut off).
  if (bot.connection === "disconnected") return "disconnected";
  if (bot.working && bot.codexRetry && !bot.approvals) return "retrying";
  if (bot.connection) return "disconnected";
  if (bot.working) return "working";
  if (bot.approvals) return "waiting";
  return bot.phase;
}

export function statusText(bot: BotView): string {
  // 1.x Workspace+Components.statusText: an outage wins over work; approvals win over retries.
  if ((bot.phase === "awake" || bot.phase === "asleep") && bot.connection === "disconnected") return "網路中斷";
  // Codex waiting to try a refused request again (the chat's typing bubble says when).
  if (bot.working && bot.codexRetry && !bot.approvals) return bot.codexRetry.reason === "rateLimited" ? "Codex rate limited, retrying…" : "Codex reconnecting…";
  if (bot.phase === "awake" && bot.connection === "retrying" && !bot.approvals) return "網路中斷，重試中…";
  if (bot.working && bot.approvals) return "Waiting for your answer";
  if (bot.working) return "Writing…";
  if (bot.phase === "tidying") return "Tidying its notes…";
  if (bot.phase === "switching") return "Writing handoff";
  if (bot.subagents) return `${bot.subagents} subagent${bot.subagents === 1 ? "" : "s"} at work`;
  if (bot.phase === "awake") return "Awake";
  return "Asleep";
}
