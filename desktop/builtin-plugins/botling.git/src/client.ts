// How the frames of botling.git ask for things: the commands the app page used to have (`worktrees.*`, `pr.*`, `review.*`, and the
// two it still has: sending a chat line, opening a link) as calls to this plugin's program part (host.ts) through the frame's `ccb`.
import type { PrCreateView, PrDraftView, ReviewDiffView, ReviewFilesView, ReviewScope, WorktreeAction, WorktreesView } from "./types";

/** The part of the frame's `ccb` the views use. */
export interface Ccb {
  panels: { register(id: string, render: (root: HTMLElement) => (() => void) | void): () => void };
  call(method: string, params?: unknown): Promise<unknown>;
  command(id: string, ...args: string[]): void;
  context?: { botId?: string };
}

/** A refusal or failure of a call, with the sentence to show. */
export class RequestFailed extends Error {
  readonly error: { message: string };
  constructor(message: string) { super(message); this.error = { message }; }
}

type Ids = { botId: string; worktreeId: string };
export interface Requests {
  "worktrees.list": [{ botId: string }, WorktreesView];
  "worktrees.create": [{ botId: string; name: string; base?: string }, WorktreeAction];
  "worktrees.use": [{ botId: string; worktreeId: string | null }, WorktreeAction];
  "worktrees.merge": [Ids, WorktreeAction];
  "worktrees.discard": [Ids & { force?: boolean }, WorktreeAction];
  "worktrees.terminal": [Ids, WorktreeAction];
  "worktrees.commit": [Ids & { message: string }, WorktreeAction];
  "pr.draft": [Ids, PrDraftView];
  "pr.create": [Ids & { title: string; body: string }, PrCreateView];
  "review.files": [{ botId: string; worktreeId: string | null; scope: ReviewScope; turn?: string }, ReviewFilesView];
  "review.diff": [{ botId: string; worktreeId: string | null; from: string; to: string; path: string; oldPath?: string; force?: boolean }, ReviewDiffView];
  "review.open": [{ botId: string; target: unknown }, null];
  "review.target": [{ botId: string }, unknown];
  "chat.send": [{ botId: string; text: string }, unknown];
  "link.open": [{ botId: string; url: string }, unknown];
}
export type Request = { [K in keyof Requests]: { type: K } & Requests[K][0] }[keyof Requests];

export interface Client {
  request<K extends keyof Requests>(command: { type: K } & Requests[K][0] & { source?: string }): Promise<Requests[K][1]>;
}

export function frameClient(ccb: Pick<Ccb, "call" | "command">): Client {
  return {
    async request(command) {
      const { type, source: _source, ...params } = command as { type: keyof Requests; source?: string } & Record<string, unknown>;
      if (type === "link.open") { ccb.command("botling.openLink", String(params.botId), String(params.url)); return null as never; }
      try {
        return (await ccb.call(type, params)) as never;
      } catch (failure) {
        throw new RequestFailed(String((failure as Error)?.message ?? failure));
      }
    },
  };
}
