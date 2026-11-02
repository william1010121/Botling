// The words this plugin's web part shows, in the chat page's languages (moved from Web/src/locales with
// their keys). `common.close` and `choices.recommended` are the chat page's own, repeated here.
export type Word = string | readonly [one: string, other: string];

export const en = {
  "source.unknown": "Unknown source",
  "source.showChat": "Show in chat",
  "source.you": "You",
  "source.askedBy": "asked by {author}",
  "source.pickedBy": "Picked by {author}",
  "source.originals": "Original conversation",
  "source.navigation": "Source navigation",
  "source.point": "Source for point {n}",
  "source.previous": "Previous source",
  "source.next": "Next source",
  "source.all": "All {n} messages",
  "source.readOnly": "Cards here are read-only · answer them in the chat",
  "source.done": "Done",
  "source.cited": "Cited · point {n}",
  "source.unanswered": "Not answered yet",
  "source.answerInChat": "Answer in chat",
  "source.whole": "Show whole card",
  "source.loadingCard": "Loading saved card…",
  "source.staticCard": "Read-only source card",
  "source.snapshotUnavailable": "Live preview unavailable · saved data",
  "source.openCitation": "Click to open in conversation",
  "source.openFrom": "Open source by {author} for point {n}",
  "interval.summarize": ["Summarize {n} reply", "Summarize {n} replies"],
  "interval.replies": ["{n} reply", "{n} replies"],
  "catchup.label": "Catch-up summary",
  "catchup.title": "Catch-up",
  "catchup.divider": "{n} unread · since {since}",
  "catchup.dividerNoTime": "{n} unread",
  "catchup.count": "{n} unread",
  "catchup.heads": ["{n} head", "{n} heads"],
  "catchup.writing": "Writing summary with {model}…",
  "catchup.failed": "Couldn’t write a summary",
  "catchup.nothingLost": "Nothing was lost — all {n} messages are below.",
  "catchup.retry": "Retry",
  "catchup.show": "Show {n} messages",
  "catchup.latest": "Latest · {line}",
  "catchup.by": "Summary by {model} · may leave out details",
  "catchup.decide": "Waiting for your decision:",
  "catchup.manualTitle": "Summary",
  "catchup.manualRange": "Summary · {n} messages",
  "catchup.messages": "{n} messages",
  "catchup.links": "Links & artifacts",
  "catchup.tasks": ["{n} task", "{n} tasks"],
  "common.close": "Close",
  "choices.recommended": "Recommended",
} satisfies Record<string, Word>;

export type Key = keyof typeof en;

const zhHant: Record<Key, Word> = {
  "source.unknown": "未知來源",
  "source.showChat": "在聊天中顯示",
  "source.you": "你",
  "source.askedBy": "提問者：{author}",
  "source.pickedBy": "由 {author} 選擇",
  "source.originals": "原始對話",
  "source.navigation": "來源導覽",
  "source.point": "第 {n} 點的來源",
  "source.previous": "上一個來源",
  "source.next": "下一個來源",
  "source.all": "全部 {n} 則訊息",
  "source.readOnly": "此處卡片為唯讀 · 請回聊天作答",
  "source.done": "完成",
  "source.cited": "引用 · 第 {n} 點",
  "source.unanswered": "尚未作答",
  "source.answerInChat": "回聊天作答",
  "source.whole": "顯示完整卡片",
  "source.loadingCard": "載入已保存的卡片…",
  "source.staticCard": "唯讀來源卡片",
  "source.snapshotUnavailable": "無法取得即時畫面 · 已保存資料",
  "source.openCitation": "點擊開啟原始對話",
  "source.openFrom": "開啟第 {n} 點由 {author} 撰寫的來源",
  "interval.summarize": "Summarize {n} 則回覆",
  "interval.replies": "{n} 則回覆",
  "catchup.label": "未讀摘要",
  "catchup.title": "未讀摘要",
  "catchup.divider": "{n} 則未讀 · 自 {since}",
  "catchup.dividerNoTime": "{n} 則未讀",
  "catchup.count": "{n} 則未讀",
  "catchup.heads": "{n} 個引擎",
  "catchup.writing": "正在用 {model} 撰寫摘要…",
  "catchup.failed": "無法產生摘要",
  "catchup.nothingLost": "沒有遺失任何內容，{n} 則訊息都在下方。",
  "catchup.retry": "重試",
  "catchup.show": "顯示 {n} 則訊息",
  "catchup.latest": "最新 · {line}",
  "catchup.by": "摘要由 {model} 產生 · 可能省略細節",
  "catchup.decide": "等你決定：",
  "catchup.manualTitle": "對話摘要",
  "catchup.manualRange": "摘要範圍 · {n} 則訊息",
  "catchup.messages": "{n} 則訊息",
  "catchup.links": "連結與產出",
  "catchup.tasks": "{n} 件事",
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
