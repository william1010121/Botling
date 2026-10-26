import type { MessageView } from "./types";

/** Shared chat defaults to 1.x's bot-only intervals; desktop also counts app notices. */
export let summaryCountable = (message: Pick<MessageView, "role">): boolean => message.role === "bot";

/** Configure before rendering the first chat state. */
export function setSummaryCountable(countable: typeof summaryCountable): void {
  summaryCountable = countable;
}
