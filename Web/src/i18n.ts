/**
 * The chat page's own words in the app's five languages. The app says which one in every state
 * (`ChatState.lang`, from Settings → General → Language); a page not told says English. What bots
 * wrote, components and the user's own data are never put through `t`.
 *
 * Each word has a key; `{name}` marks are filled from `values`. A pair `[one, other]` is a word
 * that changes with `values.n` (English plurals); languages without plurals give one string. The
 * words themselves are in `locales/`, one file a language; English's keys are the list.
 */

import { en, type Dictionary, type Key, type Word } from "./locales/en";
import { zhHant } from "./locales/zh-Hant";
import { zhHans } from "./locales/zh-Hans";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";

export type Lang = "en" | "zh-Hant" | "zh-Hans" | "ja" | "ko";
export const languages: readonly Lang[] = ["en", "zh-Hant", "zh-Hans", "ja", "ko"];

export type { Key };

export const dictionaries: Record<Lang, Dictionary> = { en, "zh-Hant": zhHant, "zh-Hans": zhHans, ja, ko };

let current: Lang = "en";

/** The language words are shown in now. */
export function language(): Lang {
  return current;
}

/** Shows words in `lang` from now on (English for anything unknown); true when it changed. */
export function setLanguage(lang: string | null | undefined): boolean {
  const next = languages.includes(lang as Lang) ? (lang as Lang) : "en";
  if (next === current) return false;
  current = next;
  document.documentElement.lang = next;
  return true;
}

/**
 * `key` in the current language cut at its `{name}` marks, for words with fields in them
 * ("Every [5] [min]" is "[5] [分]ごと" in Japanese): text pieces, and `{ mark }` where a field goes.
 */
export function pieces(key: Key): (string | { mark: string })[] {
  const text = t(key);
  const parts: (string | { mark: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ mark: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** `key` in the current language, its `{name}` marks filled from `values`. */
export function t(key: Key, values: Record<string, string | number> = {}): string {
  const word: Word = dictionaries[current][key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}
