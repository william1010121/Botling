// The words this plugin's web part shows, in the chat page's languages (moved from Web/src/locales with
// their keys). `common.close` and `choices.recommended` are the chat page's own, repeated here.
export type Word = string | readonly [one: string, other: string];

export const en = {
  "source.showChat": "Show in chat",
  "source.you": "You",
  "source.askedBy": "asked by {author}",
  "source.pickedBy": "Picked by {author}",
  "source.originals": "Original conversation",
  "source.readOnly": "Cards here are read-only · answer them in the chat",
  "source.done": "Done",
  "source.unanswered": "Not answered yet",
  "source.answerInChat": "Answer in chat",
  "source.whole": "Show whole card",
  "source.loadingCard": "Loading saved card…",
  "source.staticCard": "Read-only source card",
  "source.snapshotUnavailable": "Live preview unavailable · saved data",
  "catchup.label": "While you were away",
  "catchup.away": "While you were away · {n} important",
  "catchup.awayNone": "While you were away",
  "catchup.show": "Show {n} messages",
  "catchup.messages": "{n} messages",
  "common.close": "Close",
  "choices.recommended": "Recommended",
} satisfies Record<string, Word>;

export type Key = keyof typeof en;

const zhHant: Record<Key, Word> = {
  "source.showChat": "在聊天中顯示",
  "source.you": "你",
  "source.askedBy": "提問者：{author}",
  "source.pickedBy": "由 {author} 選擇",
  "source.originals": "原始對話",
  "source.readOnly": "此處卡片為唯讀 · 請回聊天作答",
  "source.done": "完成",
  "source.unanswered": "尚未作答",
  "source.answerInChat": "回聊天作答",
  "source.whole": "顯示完整卡片",
  "source.loadingCard": "載入已保存的卡片…",
  "source.staticCard": "唯讀來源卡片",
  "source.snapshotUnavailable": "無法取得即時畫面 · 已保存資料",
  "catchup.label": "你不在時",
  "catchup.away": "你不在時 · {n} 件重要",
  "catchup.awayNone": "你不在時",
  "catchup.show": "顯示 {n} 則訊息",
  "catchup.messages": "{n} 則訊息",
  "common.close": "關閉",
  "choices.recommended": "建議",
};

const dictionaries: Record<string, Record<Key, Word>> = { en, "zh-Hant": zhHant };

/** The page's language (the chat sets <html lang>), English for anything else. */
export const language = () => (document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "en");

/** `key` in the page's language, its `{name}` marks filled from `values` (Web/src/i18n.ts `t`). */
export function t(key: Key, values: Record<string, string | number> = {}): string {
  const word: Word = dictionaries[language()][key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}
