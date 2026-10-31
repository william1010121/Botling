// The Worktrees control's words, English and Traditional Chinese (the app's two UI languages).
import type { WorktreesView } from "../contract";

type Item = WorktreesView["items"][number];
type Words = {
  title: string; add: string; namePlaceholder: string; create: string; cancel: string; none: string; inUse: string;
  workHere: string; useFolder: string; terminal: string; merge: (base: string) => string; discard: string; discardAnyway: string;
  clean: string; missing: string; files: (n: number) => string; commits: (n: number) => string;
  setting: { title: string; note: string; toggle: string; folder: string; hint: string };
  loses: (item: Pick<Item, "changedFiles" | "ahead">) => string;
};

const en: Words = {
  setting: { title: "Worktrees", toggle: "App-managed worktrees", folder: "Worktree folder", note: "The app makes a git worktree and branch for a project's work, tells the agent to work there, and merges or removes it when you say so. Nothing is made until you press New worktree.", hint: "Empty: the work drive for the developer project, else Botling's data folder." },
  title: "Worktrees", add: "New worktree", namePlaceholder: "Task name", create: "Create", cancel: "Cancel",
  none: "No worktrees. Make one so a task works on its own branch.", inUse: "In use", workHere: "Work here", useFolder: "Use project folder",
  terminal: "Open in terminal", merge: (base) => `Merge into ${base}`, discard: "Discard", discardAnyway: "Discard anyway",
  clean: "No changes", missing: "Folder missing",
  files: (n) => `${n} file${n === 1 ? "" : "s"} changed`, commits: (n) => `${n} commit${n === 1 ? "" : "s"} ahead`,
  loses: ({ changedFiles, ahead }) => `Discarding loses ${[changedFiles ? `${changedFiles} uncommitted file${changedFiles === 1 ? "" : "s"}` : "", ahead ? `${ahead} unmerged commit${ahead === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}.`,
};
const zh: Words = {
  setting: { title: "工作樹", toggle: "由應用程式管理工作樹", folder: "工作樹資料夾", note: "應用程式會為專案的工作建立 git 工作樹與分支，請代理人在其中作業，並在你決定後合併或移除。按下「新增工作樹」之前不會建立任何東西。", hint: "留空：開發者專案使用工作磁碟，否則使用 Botling 的資料夾。" },
  title: "工作樹", add: "新增工作樹", namePlaceholder: "任務名稱", create: "建立", cancel: "取消",
  none: "沒有工作樹。建立一個，讓任務在自己的分支上作業。", inUse: "使用中", workHere: "在此作業", useFolder: "改用專案資料夾",
  terminal: "在終端機開啟", merge: (base) => `合併至 ${base}`, discard: "捨棄", discardAnyway: "仍要捨棄",
  clean: "沒有變更", missing: "資料夾已不存在",
  files: (n) => `${n} 個檔案有變更`, commits: (n) => `領先 ${n} 個提交`,
  loses: ({ changedFiles, ahead }) => `捨棄會遺失 ${[changedFiles ? `${changedFiles} 個未提交的檔案` : "", ahead ? `${ahead} 個未合併的提交` : ""].filter(Boolean).join("與 ")}。`,
};

export const worktreeWords = (lang: string | null): Words => (lang === "zh-Hant" ? zh : en);

/** A worktree's second line: what git says about it. */
export function worktreeLine(item: Item, words: Words): string {
  if (item.missing) return words.missing;
  const parts = [item.changedFiles ? words.files(item.changedFiles) : "", item.ahead ? words.commits(item.ahead) : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : words.clean;
}
