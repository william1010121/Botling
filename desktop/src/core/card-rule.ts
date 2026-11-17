// The one line a Claude bot is told about `<card>` (worker-cards.ts). Its own file: the generated instructions (prompts.ts) import it,
// and it must not pull the reply parser in.
export const CARD_TAG_RULE = "- <card title=\"short title\">what to show and where its data is</card> starts a haiku worker that gathers the data, picks any component (also ones not listed here) and draws a card in the chat; the user can reply on it. Its result also reaches you: don't repeat it. Never in code.";
