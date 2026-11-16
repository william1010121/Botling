// A plugin frame's `ccb.composer.insertQuote` (the Note's "ask about this block"): text put into a bot's input box in the
// chat page. It is the service `composer.insertQuote` that the chat plugin (`botling.chat`, plugins/chat/index.ts) provides in the
// renderer's plugin kernel (M7-07b; it was the `:chat` stand-in of renderer-kernel.ts): the plugin's provider is `chatQuoteService`
// below, which hands the call to the quoter App registers while it is up (`setComposerQuoter`, it opens the Note's floating chat and
// asks the chat page, `askChatToQuote`). plugin-frame-host.ts calls the service for the frame's plugin through
// shell/frame-services.ts (bound from the plugin's declared `uses`, M7-04b), only for the frame's own bot (frame-broker.ts checks that).
// With the plugin refused, failed or unloaded, or with no page that has an input box, the call finds nothing and the quote is not inserted.
import { CHAT_PLUGIN, INSERT_QUOTE } from "./chat-names";
import { rendererKernel } from "./renderer-kernel";

type Quoter = (botId: string, text: string, focus: boolean) => Promise<boolean>;
let current: Quoter | null = null;

/** App's: writes `text` into bot `botId`'s input box; returns the unregister. One quoter at a time: a newer one replaces the one before, and the older one's unregister leaves the newer in place. */
export function setComposerQuoter(next: Quoter): () => void {
  current = next;
  return () => { if (current === next) current = null; };
}

/** What `botling.chat` provides as `composer.insertQuote`: the registered quoter's answer, or false while no page has an input box (read at each call, so a quoter that went is not called). */
export function chatQuoteService(botId: string, text: string, focus: boolean): Promise<boolean> {
  const quoter = current;
  return quoter ? quoter(botId, text, focus) : Promise.resolve(false);
}

/** Whether the text went into the bot's input box (false: no page has one, or the chat plugin is away). `caller`: the plugin whose frame asks. */
export async function quoteIntoComposer(botId: string, text: string, focus: boolean, caller = CHAT_PLUGIN): Promise<boolean> {
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
