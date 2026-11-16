// The one place the chat's card answer is sent (M7-07b, decision Q-M7-C5, plan-change C5). The chat draws the tool-approval cards (a question
// with buttons); pressing one is the user's own click inside the chat page, and the page posts an `answer` action. That is a request that
// needs the `approve` scope, and the chat is a plugin now (`botling.chat`, its web part is this frame): the shell sends the answer only
// when the plugin running is the code the FE build shipped, i.e. `approveRoute` says "direct" for its name and the hash the loader ran it
// under (shell/approve-route.ts: 06a's rule, checked again here at each answer, never cached). Any other source, a framed third party
// (plugin-frame-host.ts `requestApproval`), a changed hash, a plugin the host says is away, goes through the shell's own ApprovalSheet
// (ApprovalSheet.tsx) or is not sent: a chat answer has no command and folder the sheet could show, so for the chat the other route is a
// refusal. A card's command (`component.command` needing `component.approve`) is not an answer: it keeps going through the sheet whoever asks.
//
// A page the shell never started a loader for (Botling Web 2.x, a test): the host has said nothing about the plugin, and the answer goes as
// it always did (the same three states as regions.tsx `regionShown("main")`).
import type { Command } from "../../contract";
import type { Client } from "../client";
import { actionPicks } from "../answer-picks";
import { CHAT_PLUGIN, CHAT_UNAVAILABLE } from "../chat-names";
import { approveRoute } from "../shell/approve-route";
import { inPageHost, type InPageHost } from "../shell/inpage-host";

export type ChatAnswer = Extract<Command, { type: "chat.answer" }>;
export type AnswerRoute = "direct" | "refused";

/** The `chat.answer` for the chat page's `answer` action in chat `botId`; null when the action misses a field or says nothing. */
export function chatAnswerCommand(action: Record<string, unknown>, botId: string | null | undefined): ChatAnswer | null {
  if (!botId || typeof action.messageID !== "string" || typeof action.text !== "string") return null;
  // A component's answer may bring pictures (`{name, base64}`), kept as attachments by the core.
  const images = Array.isArray(action.images) ? (action.images as unknown[]).flatMap((entry) => {
    const image = entry as { name?: unknown; base64?: unknown };
    return typeof image?.name === "string" && typeof image.base64 === "string" && image.base64 ? [{ name: image.name.slice(0, 255) || "picture.png", base64: image.base64 }] : [];
  }).slice(0, 10) : [];
  // A question group's answers, one per question; the core writes the bot's message from them.
  const picks = actionPicks(action.picks);
  if (picks?.length) return { type: "chat.answer", botId, messageId: action.messageID, text: action.text, picks };
  if (!action.text.trim() && !images.length) return null;
  return { type: "chat.answer", botId, messageId: action.messageID, text: action.text, ...(images.length ? { images } : {}) };
}

/** What the shell does with the chat's answer now: send it ("direct") or not ("refused"). Fails closed on anything it cannot read. */
export function chatAnswerRoute(host: Pick<InPageHost, "loaded" | "unavailable" | "feManifest"> = inPageHost): AnswerRoute {
  try {
    const running = host.loaded().find((entry) => entry.name === CHAT_PLUGIN);
    if (running) return approveRoute(running, host.feManifest) === "direct" ? "direct" : "refused";
    return host.unavailable(CHAT_PLUGIN) ? "refused" : "direct";
  } catch {
    return "refused";
  }
}

/** Sends the answer when the route allows it; otherwise reports "Chat is unavailable." through `onError` and sends nothing. */
export function sendChatAnswer(command: ChatAnswer, deps: { client: Pick<Client, "request">; onError: (failure: unknown) => void; host?: Parameters<typeof chatAnswerRoute>[0] }): "sent" | "refused" {
  if (chatAnswerRoute(deps.host) !== "direct") {
    deps.onError(new Error(CHAT_UNAVAILABLE));
    return "refused";
  }
  void deps.client.request(command).catch(deps.onError);
  return "sent";
}
