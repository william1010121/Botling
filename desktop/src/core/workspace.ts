// What plugins may read of the workspace (`api.workspace`, plugin-extraction.md §4.3): read-only, the
// same for first-party and other plugins. The core answers each method from what the whiteboard
// shows today (server.ts `workspaceSource`); this file holds the shapes and the change watch.
//
// The watch (`workspace.onChange`): while some plugin listens, the core keeps a digest of what each
// method would answer, per bot and kind, and tells the plugins when it differs from the last digest
// told, naming the bots and kinds. The first digest is taken when the host says someone listens; the
// host says so before the listener's plugin can ask anything (host.ts `announceNow`), so whatever it
// reads is at least that new and no later change goes untold (spec/models/workspace).
import type { TaskView, WaitingView } from "../contract";
import type { AgyWorker } from "./agy-usage-db";

export const WORKSPACE_KINDS = ["bots", "tasks", "memory", "waiting", "results", "current"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** The event the host is sent when the workspace changed; a plugin listens with `workspace.onChange`. */
export const WORKSPACE_EVENT = "workspace.changed";

/** A bot as plugins see it. The main bot's id is "main", as in `bots.list`. */
export interface BotSummary {
  id: string;
  name: string;
  role: "main" | "manager" | "bot";
  /** A sub bot's project bot (null: not a sub bot). */
  parent: string | null;
  /** The name of its folder (not the path). */
  folder: string;
  /** Its primary head. */
  engine: "claude" | "codex" | "agy";
  busy: boolean;
  asleep: boolean;
  /** The face's shape, which its avatar is drawn from (`face`). */
  avatar: string;
  pinned: boolean;
  /** When it last did something (ISO time), if ever. */
  lastActivity: string | null;
  /** What it is for (a bot of its own), if it has a job. */
  job: string | null;
  /** Its subagents at work, and whether a guest bot answers in its chat now. */
  subagents: number;
  guest: boolean;
  /** Its tool approvals waiting for the user. */
  approvals: number;
  /** The app's own words for its state: `key` says which dot to draw. */
  status: { key: string; text: string };
  /** The main bot's latest reply as written (cut at 400 characters); null for any other bot. */
  lastReply: string | null;
}

/** Its memory.md's sections, as the whiteboard and Waiting on you read them. */
export interface MemorySections { currentStatus: string[]; inProgress: string[]; decided: string[]; waitingOnYou: string[] }
export interface DoneDayView { day: string; done: number; manual: number }
export interface ResultLink { label: string; url: string }
export interface PendingApproval { tool: string; text: string; at: string | null }

/**
 * The chat the user has open in the main window (`workspace.current`; kind "current" in `onChange`, naming the bot
 * shown before and the one shown now). The renderer says so (`chat.shown`); null until it has, or with no chat shown.
 */
export interface CurrentChat {
  /** As in `bots` ("main": the main bot). */
  botId: string;
  /** Its primary head, as in `bots`. */
  engine: "claude" | "codex" | "agy";
  /** That head's session (Claude: the session id its log file is named by; Codex: the thread id); null: none started yet. */
  sessionId: string | null;
  /** Every head of the chat and its session, the primary first. */
  heads: { engine: "claude" | "codex" | "agy"; sessionId: string | null }[];
  /** What the main area shows of it: the chat, the Board, a plugin's tab, or a subagent's run. */
  view: "chat" | "board" | "tab" | "subagent";
  /** With view "tab": "<plugin>/<view id>"; otherwise null. */
  tab: string | null;
}

/** What the main window last said it shows (`chat.shown`), by the core's bot id. */
export interface ShownChat { botId: string; view: CurrentChat["view"]; tab: string | null }

/** `workspace.current` for the bot shown (`botId` as plugins see it): its primary head's session first. */
export function currentChat(shown: ShownChat, botId: string, primary: CurrentChat["engine"], sessions: CurrentChat["heads"]): CurrentChat {
  const heads = [...sessions.filter((head) => head.engine === primary), ...sessions.filter((head) => head.engine !== primary)];
  return {
    botId, engine: primary, sessionId: heads[0]?.engine === primary ? heads[0].sessionId : null, heads,
    view: shown.view, tab: shown.view === "tab" ? shown.tab : null,
  };
}

/** What the core answers plugins' `workspace.*` asks with; a bot that is not there throws. */
export interface WorkspaceSource {
  bots(): BotSummary[];
  memory(botId: string): MemorySections;
  tasks(botId: string, limit: number): TaskView[];
  taskHistory(botId: string, days: number): DoneDayView[];
  results(botId: string, limit: number): ResultLink[];
  waiting(): WaitingView;
  ignoreWaiting(botId: string, text: string): void;
  pendingApprovals(botId: string): PendingApproval[];
  face(botId: string, look: "original" | "cute"): string;
  /** Absent: a world with no main window (tests, spec adapters); plugins are told null. */
  current?(): CurrentChat | null;
  /** The agy workers the agy head session `sessionId` started; absent: a world with no registry (plugins get []). */
  agyWorkers?(sessionId: string): AgyWorker[];
}

/** What `onChange` tells. */
export interface WorkspaceChange { stamp: string; botIds: string[]; kinds: WorkspaceKind[] }

/** Each bot's data as text, by kind: what a change is noticed by. */
export type WorkspaceDigest = Record<string, Partial<Record<WorkspaceKind, string>>>;

export class WorkspaceWatch {
  /** What was last told (or there when listening began); null while nobody listens. */
  private seen: WorkspaceDigest | null = null;
  private told = 0;

  constructor(private readonly epoch: string) {}

  get watching(): boolean { return this.seen !== null; }
  /** Moves exactly when a change is told (`server.ts` whiteboard's stamp, the same way). */
  get stamp(): string { return `${this.epoch}:${this.told}`; }

  /** Someone listens: `now` is what they may have read, so nothing is told for it. Already listening: kept. */
  start(now: WorkspaceDigest) {
    this.seen ??= now;
  }

  /** Nobody listens any more. */
  stop() {
    this.seen = null;
  }

  /** What changed since the last digest told, or null (nothing, or nobody listens). */
  check(now: WorkspaceDigest): WorkspaceChange | null {
    const seen = this.seen;
    if (!seen) return null;
    const botIds = new Set<string>();
    const kinds = new Set<WorkspaceKind>();
    for (const botId of new Set([...Object.keys(seen), ...Object.keys(now)])) {
      for (const kind of WORKSPACE_KINDS) {
        if (seen[botId]?.[kind] === now[botId]?.[kind]) continue;
        botIds.add(botId);
        kinds.add(kind);
      }
    }
    if (!botIds.size) return null;
    this.seen = now;
    this.told++;
    return { stamp: this.stamp, botIds: [...botIds].sort(), kinds: WORKSPACE_KINDS.filter((kind) => kinds.has(kind)) };
  }
}
