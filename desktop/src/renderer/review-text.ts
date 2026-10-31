// The Review view's words, English and Traditional Chinese (the app's two UI languages).
import type { ReviewFilesView } from "../contract";

type File = ReviewFilesView["files"][number];
export type ReviewWords = {
  review: string; reviewMain: string; title: (name: string) => string; mainTitle: string; close: string; refresh: string;
  scopeBranch: (base: string) => string; scopeUncommitted: string; scopeTurn: string; turnLabel: (n: number, time: string) => string; noTurns: string;
  unified: string; split: string; loading: string;
  noChanges: string; summary: (files: number, add: number, del: number) => string; capped: string;
  status: Record<File["status"], string>;
  binary: string; tooLarge: (lines: number) => string; showAnyway: string; truncated: string; renamedFrom: (old: string) => string;
  addComment: string; commentPlaceholder: string; save: string; cancel: string; remove: string;
  commit: string; commitPlaceholder: string; commitDo: string; committing: string;
  openPr: string; prTitle: string; prBody: string; prDo: string; prDoing: string; prOpen: string; prAlready: string; prLoading: string; viewPr: string;
  pending: (n: number) => string; send: string; sending: string; discardComments: string; sentTo: (name: string) => string; sendFailed: string;
};

const en: ReviewWords = {
  review: "Review", reviewMain: "Review changes", title: (name) => `Review · ${name}`, mainTitle: "Review · working tree", close: "Close", refresh: "Refresh",
  scopeBranch: (base) => `Against ${base}`, scopeUncommitted: "Uncommitted", scopeTurn: "One turn", turnLabel: (n, time) => `Turn ${n} · ${time}`, noTurns: "No turns recorded yet",
  unified: "Unified", split: "Split", loading: "Loading…",
  noChanges: "No changes here.", summary: (files, add, del) => `${files} file${files === 1 ? "" : "s"} · +${add} −${del}`, capped: "Only the first files are listed.",
  status: { A: "Added", M: "Modified", D: "Deleted", R: "Renamed" },
  binary: "Binary file; no text to show.", tooLarge: (lines) => `This file changed ${lines} lines; showing it can be slow.`, showAnyway: "Show anyway", truncated: "The diff is cut here; open the file to see the rest.", renamedFrom: (old) => `Renamed from ${old}`,
  addComment: "Comment on this line", commentPlaceholder: "What should change here?", save: "Add comment", cancel: "Cancel", remove: "Remove",
  commit: "Commit", commitPlaceholder: "Commit message", commitDo: "Commit all changes", committing: "Committing…",
  openPr: "Open PR", prTitle: "Pull request title", prBody: "Description", prDo: "Push and open PR", prDoing: "Opening…", prOpen: "Open the pull request", prAlready: "A pull request is already open for this branch; pushing updates it.", prLoading: "Reading the commits…", viewPr: "Pull request",
  pending: (n) => `${n} comment${n === 1 ? "" : "s"} ready`, send: "Send to agent", sending: "Sending…", discardComments: "Clear", sentTo: (name) => `Sent to ${name}.`, sendFailed: "Could not send the comments.",
};
const zh: ReviewWords = {
  review: "檢視", reviewMain: "檢視變更", title: (name) => `檢視 · ${name}`, mainTitle: "檢視 · 工作目錄", close: "關閉", refresh: "重新整理",
  scopeBranch: (base) => `相對於 ${base}`, scopeUncommitted: "未提交", scopeTurn: "單一回合", turnLabel: (n, time) => `第 ${n} 回合 · ${time}`, noTurns: "尚未記錄任何回合",
  unified: "合併", split: "並排", loading: "載入中…",
  noChanges: "這裡沒有變更。", summary: (files, add, del) => `${files} 個檔案 · +${add} −${del}`, capped: "只列出前面的檔案。",
  status: { A: "新增", M: "修改", D: "刪除", R: "更名" },
  binary: "二進位檔案，沒有文字可顯示。", tooLarge: (lines) => `這個檔案變更了 ${lines} 行，顯示可能很慢。`, showAnyway: "仍要顯示", truncated: "差異在此截斷，請開啟檔案查看其餘部分。", renamedFrom: (old) => `由 ${old} 更名`,
  addComment: "在這一行留言", commentPlaceholder: "這裡應該怎麼改？", save: "加入留言", cancel: "取消", remove: "移除",
  commit: "提交", commitPlaceholder: "提交訊息", commitDo: "提交所有變更", committing: "提交中…",
  openPr: "開啟 PR", prTitle: "拉取請求標題", prBody: "說明", prDo: "推送並開啟 PR", prDoing: "開啟中…", prOpen: "開啟拉取請求", prAlready: "這個分支已有開啟中的拉取請求；推送會更新它。", prLoading: "讀取提交中…", viewPr: "拉取請求",
  pending: (n) => `${n} 則留言待送出`, send: "送給代理人", sending: "傳送中…", discardComments: "清除", sentTo: (name) => `已送給 ${name}。`, sendFailed: "無法送出留言。",
};

export const reviewWords = (lang: string | null): ReviewWords => (lang === "zh-Hant" ? zh : en);
