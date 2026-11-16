// The words botling.pin-area's page draws (English and Traditional Chinese, as the chat page's own).
const en = {
  "strip.label": "Pinned",
  "strip.title": "Pinned {n}",
  "strip.keys": "⌘1–{n}",
  "strip.key": "⌘1",
  "row.open": "Open {title}",
  "row.unread": "New",
  "tag.user": "pinned by you",
  "tag.bot": "bot says so",
  "tag.app": "confirmed",
  "state.wait": "Waiting for you",
  "state.run": "Working",
  "state.done": "Done",
  "panel.close": "Close (Esc)",
  "panel.unpin": "Unpin",
  "panel.before": "Before:",
  "panel.left": "{n} steps left",
  "panel.leftOne": "1 step left",
  "panel.updates": "{n} updates · {last}",
  "panel.say": "Say something to “{title}”…",
  "panel.send": "Send",
  "panel.empty": "Nothing here yet. Write below and it goes to the bot.",
  "panel.again": "Just sent that",
  "receipt.sent": "sent",
  "receipt.seen": "bot has seen it",
  "bot.name": "bot",
  "msg.pin": "Pin",
  "toast.pinned": "Pinned “{title}”",
  "toast.unpinned": "You unpinned “{title}”",
  "toast.seen": "“{title}” was seen, unpinned",
  "toast.undo": "Pin back",
  "toast.failed": "Could not do that: {why}",
};

type Key = keyof typeof en;

const zhHant: Record<Key, string> = {
  "strip.label": "釘選",
  "strip.title": "釘選 {n}",
  "strip.keys": "⌘1–{n}",
  "strip.key": "⌘1",
  "row.open": "打開 {title}",
  "row.unread": "有新的",
  "tag.user": "你釘的",
  "tag.bot": "bot 自己說的",
  "tag.app": "已確認",
  "state.wait": "等你",
  "state.run": "進行中",
  "state.done": "完成",
  "panel.close": "關閉（Esc）",
  "panel.unpin": "取消釘選",
  "panel.before": "原本：",
  "panel.left": "剩 {n} 步",
  "panel.leftOne": "剩 1 步",
  "panel.updates": "{n} 則更新 · {last}",
  "panel.say": "對「{title}」說…",
  "panel.send": "送出",
  "panel.empty": "這裡還沒有對話。在下面寫，會直接送給 bot。",
  "panel.again": "剛送過了",
  "receipt.sent": "已送出",
  "receipt.seen": "bot 已看到",
  "bot.name": "bot",
  "msg.pin": "釘選",
  "toast.pinned": "已釘選「{title}」",
  "toast.unpinned": "你取消釘選「{title}」",
  "toast.seen": "「{title}」…看過了，已取消釘選",
  "toast.undo": "釘回",
  "toast.failed": "沒做成：{why}",
};

export type Lang = "en" | "zh-Hant";
export type Words = (key: Key, values?: Record<string, string | number>) => string;

export function wordsFor(lang: () => string): Words {
  return (key, values = {}) => {
    const text = (lang() === "zh-Hant" ? zhHant : en)[key] ?? en[key];
    return text.replace(/\{(\w+)\}/g, (mark, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : mark));
  };
}
