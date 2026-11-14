// A plugin frame's `ccb.composer.insertQuote` (the Note's "ask about this block"): text put into a bot's input box in the
// chat page. It is the service `composer.insertQuote` of the chat surface in the renderer's plugin kernel
// (renderer-kernel.ts): App provides it while it is up (it opens the Note's floating chat and asks the chat page,
// `composerQuote`); plugin-frame-host.ts calls it for the frame's plugin, only for the frame's own bot (frame-broker.ts
// checks that). With no provider the call finds nothing and the quote is not inserted.
import { CHAT_SURFACE, INSERT_QUOTE, rendererKernel } from "./renderer-kernel";

type Quoter = (botId: string, text: string, focus: boolean) => Promise<boolean>;
let current: Quoter | null = null;

/** App's: writes `text` into bot `botId`'s input box (the chat surface provides the service); returns the unregister. */
export function setComposerQuoter(next: Quoter): () => void {
  // One provider at a time: the one before goes first (every undo here is synchronous, so it is gone on return).
  if (rendererKernel.state(CHAT_SURFACE) !== "absent") void rendererKernel.requestUnload(CHAT_SURFACE);
  current = next;
  void rendererKernel.load(CHAT_SURFACE, (plugin) => { rendererKernel.provide(plugin, INSERT_QUOTE, next); });
  return () => {
    if (current !== next) return;
    current = null;
    void rendererKernel.requestUnload(CHAT_SURFACE);
  };
}

/** Whether the text went into the bot's input box (false: no page has one). `caller`: the plugin whose frame asks. */
export async function quoteIntoComposer(botId: string, text: string, focus: boolean, caller = CHAT_SURFACE): Promise<boolean> {
  const called = rendererKernel.call<Promise<boolean>>(caller, INSERT_QUOTE, botId, text, focus);
  if (called.absent) return false;
  return (await called.value) === true;
}

/** How long the chat page has to answer a quote before it counts as not inserted. */
export const QUOTE_ANSWER_MS = 3_000;
const asked = new Map<number, (inserted: boolean) => void>();
let lastAsk = 0;

/** Asks the chat page (`post`: postToChat) to put `text` into chat `botId`'s input box; resolves whether it did. */
export function askChatToQuote(post: (message: { botling: "composerQuote"; requestID: number; botID: string; text: string; focus: boolean }) => void,
  botId: string, text: string, focus: boolean, wait = QUOTE_ANSWER_MS): Promise<boolean> {
  const requestID = ++lastAsk;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { asked.delete(requestID); resolve(false); }, wait);
    asked.set(requestID, (inserted) => { clearTimeout(timer); asked.delete(requestID); resolve(inserted); });
    try { post({ botling: "composerQuote", requestID, botID: botId, text, focus }); } catch { asked.get(requestID)?.(false); }
  });
}

/** The chat page's answer (action `composerQuoteResult`); one nobody asked for is ignored. */
export function chatQuoteAnswered(requestID: unknown, inserted: unknown): void {
  if (typeof requestID === "number") asked.get(requestID)?.(inserted === true);
}
