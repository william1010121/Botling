const en = {
  "gallery.label": "Image gallery",
  "gallery.previous": "Previous image",
  "gallery.next": "Next image",
  "fold.showMore": "Show more",
  "fold.showLess": "Show less",
  "paste.title": "Pasted text",
  "paste.lines": "{lines} lines",
  "paste.stats": "{lines} lines · {chars} chars",
  "paste.copy": "Copy",
  "paste.expand": "Expand into input",
  "paste.close": "Close",
  "paste.remove": "Remove pasted text",
};

type Key = keyof typeof en;

const zhHant: Record<Key, string> = {
  "gallery.label": "圖片集",
  "gallery.previous": "上一張圖片",
  "gallery.next": "下一張圖片",
  "fold.showMore": "顯示更多",
  "fold.showLess": "收合",
  "paste.title": "貼上的文字",
  "paste.lines": "{lines} 行",
  "paste.stats": "{lines} 行 · {chars} 字",
  "paste.copy": "複製",
  "paste.expand": "展開到輸入框",
  "paste.close": "關閉",
  "paste.remove": "移除貼上的文字",
};

/** `key` in the chat page's language (it sets `<html lang>`; English otherwise), `{name}` marks filled from `values`. */
export function t(key: Key, values: Record<string, string | number> = {}): string {
  const words = document.documentElement.lang === "zh-Hant" ? zhHant : en;
  return words[key].replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}
