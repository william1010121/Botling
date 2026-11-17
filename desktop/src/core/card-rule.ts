// The one line a Claude bot is told about `<card>` (worker-cards.ts). Its own file: the generated instructions (prompts.ts) import it,
// and it must not pull the reply parser in.
export const CARD_TAG_RULE = "- <card title=\"short title\">full prompt</card> starts a worker that gathers data and draws a card in the chat; the user can reply on it. Its result also reaches you: don't repeat it. Never in code.";
