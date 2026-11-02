// The Claude worker limit row's words (Settings → Engines → Claude subagents), English and Traditional Chinese.

type Words = { label: string; hint: string };

const en: Words = { label: "Claude workers at once", hint: "For each bot. More wait in line. Codex and Antigravity workers are not limited." };
const zh: Words = { label: "同時執行的 Claude 工作者", hint: "每個 bot 各自計算。超過的會排隊等候。Codex 與 Antigravity 工作者不受限制。" };

export const workerLimitWords = (lang: string | null): Words => (lang === "zh-Hant" ? zh : en);
