// The content index on the event tap (src/server/effects/tap.ts, M1 step 13): a finished line's entry and its content
// references are written in the same transaction (`noteLine` in the tap's `lineStored` hook); pinning and hashing start
// once that command committed (`TxScope.afterCommit`).
import type { Entry } from "../../protocol";
import type { Db } from "../store";
import { finishedLine, type ContentService } from "./service";

/** What the hook needs of the transaction scope (src/server/effects `TxScope`). */
export interface AfterCommitScope {
  afterCommit(action: () => void): void;
}

/**
 * The tap's `lineStored` hook: `new EventTap({ scope, hooks: { lineStored: contentLineHook(content, scope) } })`.
 * A streaming line is skipped (it is indexed by the `message.updated` that finishes it).
 */
export function contentLineHook(service: ContentService, scope: AfterCommitScope) {
  return (tx: Db, event: { type: string; botId?: string; message?: unknown }, entry: Pick<Entry, "stream" | "seq">): void => {
    const line = finishedLine(event);
    if (!line) return;
    const noted = service.noteLine(tx, line.botId, line.line, entry);
    if (noted?.files.length) scope.afterCommit(() => { void service.afterCommit(noted).catch(() => {}); });
  };
}
