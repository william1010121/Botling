// A card's command asked for by the chat page (a component card). The page can only ask to run: whatever `approve`
// an action carries is dropped here, and the contract has no such field. A command not allowed yet answers
// `needsApproval` with the core's own command, folder and Detail command; only the app page's ApprovalSheet then
// sends `component.approve` with exactly those (plugin-platform.md §5.4, G2: a plugin in the chat page's realm
// cannot press it). A pinned card's command (botling.board) and a spec's (botling.component-studio) ask through
// their plugin's own approval route (`plugins.approvalAsk` / `plugins.approve`).
import type { ApprovalAskView, Command } from "../contract";

export type CardRun = Extract<Command, { type: "component.command" }>;
export type CardApprove = Extract<Command, { type: "component.approve" }>;

const text = (value: unknown): value is string => typeof value === "string";
const flags = (action: Record<string, unknown>, names: ("force" | "live")[]) =>
  Object.fromEntries(names.filter((name) => typeof action[name] === "boolean").map((name) => [name, action[name] as boolean]));

/** The contract request for a chat page's `componentCommand`; null when it is not one or misses a field. */
export function cardRun(action: Record<string, unknown>, botId: string | null): CardRun | null {
  const detail = text(action.detail) ? { detail: action.detail } : {};
  switch (action.type) {
    case "componentCommand":
      if (!botId || !text(action.messageID) || typeof action.index !== "number" || !text(action.command) || !text(action.folder)) return null;
      return { type: "component.command", botId, messageId: action.messageID, index: action.index, command: action.command, folder: action.folder, ...detail, ...flags(action, ["force", "live"]) };
    default:
      return null;
  }
}

/** What the sheet's "Allow and run" sends for a run that answered `needsApproval`: the core's values, never the page's. */
export function cardApprove(run: CardRun, ask: ApprovalAskView): CardApprove | null {
  const shown = { command: ask.command, folder: ask.folder, ...(ask.detail !== null ? { detail: ask.detail } : {}) };
  switch (run.type) {
    case "component.command": return { type: "component.approve", botId: run.botId, messageId: run.messageId, index: run.index, ...shown };
  }
}

/** Whether a page's action may open the sheet: only one the user asked for (a card's own timer never asks). */
export function asksUser(action: Record<string, unknown>): boolean {
  return action.live !== true;
}
