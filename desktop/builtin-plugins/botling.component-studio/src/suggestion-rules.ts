// The anti-nag rules for a bot's <suggest-component> (ADR-006 M4). The chip under a reply is the only thing the
// app adds; these rules decide whether it is added at all. Pure, so they are tested without a core.
//
// 1. Look up what exists first: a library component (a plugin's too) that already does it is offered instead
//    of a new build, and dropped when the bot already has it.
// 2. Never for one-shot output: a draft that says it is one-off, or says nothing, gets no chip.
// 3. At most one suggestion per turn (the user's message and everything the bot says until the next one).
// 4. Not again what the user took back (Undo): a name the user undid is not suggested again.
//
// Building stays Maintainer-only; nothing here builds or installs.

export type SuggestionVerdict =
  | { allow: true; existing?: string }
  | { allow: false; reason: "invalid" | "one-per-turn" | "undone" | "one-shot" | "already-has" };

export interface SuggestionInput {
  /** The safe name the bot gave (empty: it gave none that can be used). */
  name: string;
  /** The bot's one line: what it would show and where its data comes from. */
  draft: string;
  /** Every component in the library, plugins' included. */
  libraryNames: readonly string[];
  /** The components on this bot's list (null: it has no list, so it may use the whole library). */
  botNames: readonly string[] | null;
  /** Suggestion chips already made in this turn. */
  suggestionsThisTurn: number;
  /** Names of components the user took back (Undo) in this chat. */
  undoneNames: readonly string[];
}

/** A draft shorter than this says nothing about what the component would show. */
export const MIN_DRAFT = 12;
/** Words that mark an answer as one-off. */
const ONE_SHOT = /\b(one[- ]?off|one[- ]?time|one[- ]?shot|just (?:this|once)|only (?:this|once)|this once|single use|throwaway)\b|一次性|只這一次|僅此一次|僅一次/i;

const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean);

/**
 * The library component that already does what `name` says: the same name, the same words in another order, or
 * a longer name that holds all the words of a shorter one of two or more words (git-status / git-status-card).
 */
export function findExisting(name: string, libraryNames: readonly string[]): string | undefined {
  if (libraryNames.includes(name)) return name;
  const wanted = tokens(name);
  if (!wanted.length) return undefined;
  const key = [...wanted].sort().join(" ");
  const same = libraryNames.find((other) => [...tokens(other)].sort().join(" ") === key);
  if (same) return same;
  return libraryNames.find((other) => {
    const have = tokens(other);
    const [short, long] = wanted.length <= have.length ? [wanted, have] : [have, wanted];
    return short.length >= 2 && short.every((word) => long.includes(word));
  });
}

export function judgeSuggestion(input: SuggestionInput): SuggestionVerdict {
  if (!input.name) return { allow: false, reason: "invalid" };
  if (input.suggestionsThisTurn > 0) return { allow: false, reason: "one-per-turn" };
  if (input.undoneNames.includes(input.name)) return { allow: false, reason: "undone" };
  const draft = input.draft.trim();
  if (draft.length < MIN_DRAFT || ONE_SHOT.test(draft)) return { allow: false, reason: "one-shot" };
  const existing = findExisting(input.name, input.libraryNames);
  if (existing === undefined) return { allow: true };
  if (input.botNames === null || input.botNames.includes(existing)) return { allow: false, reason: "already-has" };
  return { allow: true, existing };
}
