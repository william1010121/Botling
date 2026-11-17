// The words this plugin's web part shows, in the chat page's languages: the chips' (moved from Web/src/locales with their keys). The page sets <html lang>.
export type Word = string | readonly [one: string, other: string];

export const en = {
  "specChip.building": "Building…",
  "specChip.buildingTitle": "Maintainer is building it; show its progress",
  "specChip.component": "Component",
  "specChip.filling": "Filling in · {bot}",
  "specChip.fillingTitle": "Built; {bot} is drawing it with this reply's data",
  "specChip.newVersion": "Building a new version · {name}",
  "specChip.restore": "Restore",
  "specChip.restoreTitle": "Put the component back on the bot's list",
  "specChip.spec": "Component spec",
  "specChip.suggested": "Suggested component",
  "specChip.suggestedTitle": "Make it into a component: Maintainer builds it now",
  "specChip.undo": "Undo",
  "specChip.undoTitle": "Take it off the bot's list; it stays in the library and Restore puts it back",
};

export const zhHant = {
  "specChip.building": "建置中…",
  "specChip.buildingTitle": "Maintainer 正在建置；顯示進度",
  "specChip.component": "元件",
  "specChip.filling": "填入中 · {bot}",
  "specChip.fillingTitle": "已建好；{bot} 正用這則回覆的資料畫出它",
  "specChip.newVersion": "建置新版本中 · {name}",
  "specChip.restore": "還原",
  "specChip.restoreTitle": "把元件放回機器人的清單",
  "specChip.spec": "元件規格",
  "specChip.suggested": "建議的元件",
  "specChip.suggestedTitle": "做成元件：Maintainer 現在就建置",
  "specChip.undo": "復原",
  "specChip.undoTitle": "從機器人的清單移除；元件仍留在元件庫，可按「還原」放回",
};

export type Key = keyof typeof en;
const dictionaries: Record<string, Record<Key, Word>> = { en, "zh-Hant": zhHant as Record<Key, Word> };

/** The page's language (the chat sets <html lang>), English for anything else. */
export const language = () => (document.documentElement.lang === "zh-Hant" ? "zh-Hant" : "en");

/** `key` in the page's language, its `{name}` marks filled from `values` (Web/src/i18n.ts `t`). */
export function t(key: Key, values: Record<string, string | number> = {}): string {
  const word: Word = dictionaries[language()][key] ?? en[key];
  const text = typeof word === "string" ? word : values.n === 1 ? word[0] : word[1];
  return text.replace(/\{(\w+)\}/g, (mark, name: string) => (name in values ? String(values[name]) : mark));
}
