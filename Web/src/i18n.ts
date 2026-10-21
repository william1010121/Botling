/**
 * The chat page's own words in the app's five languages. The app says which one in every state
 * (`ChatState.lang`, from Settings → General → Language); a page not told says English. What bots
 * wrote, components and the user's own data are never put through `t`.
 *
 * Each word has a key; `{name}` marks are filled from `values`. A pair `[one, other]` is a word
 * that changes with `values.n` (English plurals); languages without plurals give one string.
 */

export type Lang = "en" | "zh-Hant" | "zh-Hans" | "ja" | "ko";
export const languages: readonly Lang[] = ["en", "zh-Hant", "zh-Hans", "ja", "ko"];

type Word = string | readonly [one: string, other: string];

const en = {
  // steps.ts
  "steps.worked": "Worked",
  "steps.notes": ["{n} note", "{n} notes"],
  "steps.steps": ["{n} step", "{n} steps"],
} as const satisfies Record<string, Word>;

export type Key = keyof typeof en;
type Dictionary = Record<Key, Word>;

const zhHant: Dictionary = {
  "steps.worked": "已處理",
  "steps.notes": "{n} 段說明",
  "steps.steps": "{n} 個步驟",
};

const zhHans: Dictionary = {
  "steps.worked": "已处理",
  "steps.notes": "{n} 段说明",
  "steps.steps": "{n} 个步骤",
};

const ja: Dictionary = {
  "steps.worked": "作業済み",
  "steps.notes": "メモ {n} 件",
  "steps.steps": "{n} ステップ",
};

const ko: Dictionary = {
  "steps.worked": "작업함",
  "steps.notes": "메모 {n}개",
  "steps.steps": "{n}단계",
};

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

/** `key` in the current language, its `{name}` marks filled from `values`. */
export function t(key: Key, values: Record<string, string | number> = {}): string {
  const word: Word = dictionaries[current][key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}
