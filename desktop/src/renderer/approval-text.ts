// The ApprovalSheet's words (a card's command waiting for your OK), English and Traditional Chinese.

type Words = { title: string; line: (card: string) => string; detailLine: string; remembered: string; cancel: string; allow: string };

const en: Words = {
  title: "Allow this command to run?",
  line: (card) => `“${card}” gets its data by running this command in`,
  detailLine: "and, for details when you open one, this command:",
  remembered: "Remembered for this command in this folder: it runs again without asking.",
  cancel: "Cancel",
  allow: "Allow and run",
};
const zh: Words = {
  title: "允許執行這個指令嗎？",
  line: (card) => `「${card}」的資料來自執行這個指令，執行位置：`,
  detailLine: "另外，打開詳細內容時會執行這個指令：",
  remembered: "這個資料夾會記住這個指令的允許，之後執行不再詢問。",
  cancel: "取消",
  allow: "允許並執行",
};

export const approvalWords = (lang: string | null | undefined): Words => (lang === "zh-Hant" ? zh : en);
