// The shapes botling.whiteboard's two halves share: main.ts (its program part, in the plugin host) builds a
// `BoardView` from the workspace, ui.tsx (its frame) draws it. Plain data, so it crosses `ccb.call` as JSON.
export type Look = "original" | "cute";
export type Lang = "en" | "zh-Hant";

/** A bot as the board needs it (the workspace's `BotSummary`, under the names the board always used). */
export interface Bot {
  id: string;
  name: string;
  role: "main" | "manager" | "bot";
  folder: string;
  job: string | null;
  phase: "awake" | "asleep";
  working: boolean;
  subagents: number;
  guest: boolean;
  approvals: number;
  lastActivity?: string | null;
}

export interface WaitingItem { botId: string; text: string; messageId: string | null; at?: string }
export interface Waiting { items: WaitingItem[]; doing: Record<string, string>; acked?: string[] }

export interface Approval { tool: string; text: string; at: string | null }
export interface Result { label: string; url: string }

/** A bot's picture on its card: a library component and the data it draws (the command's output once it ran). */
export interface Picture {
  name: string;
  /** The data as JSON text; "null": nothing to draw yet. */
  data: string;
  size: "1x1" | "2x1";
  command: string | null;
  /** The folder the command runs in (the bot's own); null without a command. */
  folder: string | null;
  /** "approve": waits for the user's OK; "failed", "empty": nothing to draw; null/other: drawn. */
  status: "approve" | "idle" | "running" | "done" | "failed" | "empty" | null;
  error: string | null;
  ranAt: string | null;
}

/** One bot's part of the board (the core's `WhiteboardBotView`). */
export interface Entry {
  botId: string;
  currentStatus: string[];
  inProgress: string[];
  decided: string[];
  results: Result[];
  picture: Picture | null;
  description?: string | null;
  approvals?: Approval[];
}

export type AskKind = "question" | "call" | "approval";
export interface Lanes { waiting: Bot[]; running: Bot[]; quiet: Bot[] }

/** What the frame asks main.ts for (`board`): everything the page shows, with a stamp that moves when it changes. */
export interface BoardView {
  stamp: string;
  /** Answered to an ask that carried the stamp it has: nothing changed, the rest is left out. */
  same?: boolean;
  look: Look;
  lang: Lang;
  mainBotId: string;
  /** The main bot's latest reply (the board's last section). */
  mainReply: string | null;
  bots: Bot[];
  pinned: string[];
  waiting: Waiting;
  entries: Entry[];
  /** Each bot's face as a data URL. */
  faces: Record<string, string>;
  /** The app's words for each bot's state: the dot's key and its text. */
  statuses: Record<string, { key: string; text: string }>;
  /** The Idle & asleep shelf's details list is open (kept for the next start). */
  shelfOpen: boolean;
}
