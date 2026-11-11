// A plugin frame's `ccb.composer.insertQuote` (the Note's "ask about this block"): text put into a bot's input box in the
// chat page. App registers the quoter while it is up (it opens the Note's floating chat and asks the chat page,
// `composerQuote`); plugin-frame-host.ts asks it, only for the frame's own bot (frame-broker.ts checks that).
type Quoter = (botId: string, text: string, focus: boolean) => Promise<boolean>;
let quoter: Quoter | null = null;

/** App's: writes `text` into bot `botId`'s input box; returns the unregister. */
export function setComposerQuoter(next: Quoter): () => void {
  quoter = next;
  return () => { if (quoter === next) quoter = null; };
}

/** Whether the text went into the bot's input box (false: no page has one). */
export async function quoteIntoComposer(botId: string, text: string, focus: boolean): Promise<boolean> {
  if (!quoter) return false;
  return (await quoter(botId, text, focus)) === true;
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
