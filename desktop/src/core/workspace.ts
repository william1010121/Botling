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

export const WORKSPACE_KINDS = ["bots", "tasks", "memory", "waiting", "results"] as const;
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
}

/** Its memory.md's sections, as the whiteboard and Waiting on you read them. */
export interface MemorySections { currentStatus: string[]; inProgress: string[]; decided: string[]; waitingOnYou: string[] }
export interface DoneDayView { day: string; done: number; manual: number }
export interface ResultLink { label: string; url: string }
export interface PendingApproval { tool: string; text: string; at: string | null }

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
