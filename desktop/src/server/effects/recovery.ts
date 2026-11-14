// Recovery at start (protocol v1 §12), one writer command before the worker and any front end run:
// - every `started` turn row becomes exactly one `turn.interrupted{turnId, messageId: its reply, text}` (the checkpoint
//   text when `bots.liveTurnId` is that turn, else empty) and the row `interrupted`: it is never started again;
// - a turn's checkpoint left without a started row (a turn whose row the crash lost with its batch) is interrupted too;
// - `started` remove rows go back to `queued` (removing a bot is idempotent; the worker runs them again);
// - `queued` rows stay: their intent committed, nothing began them, the worker runs them now.
// The entry and the row's state commit together, so a second recovery finds nothing to do.
import type { StreamId } from "../../protocol";
import { listCheckpoints } from "../live";
import type { Db } from "../store";
import { appendFitted, clearLive, ensureBot } from "./log-ops";
import type { TxScope } from "./scope";
import { effectsIn, findTurnEffect, moveEffect, type TurnPayload } from "./table";

export interface RecoveryReport {
  /** The turns interrupted, as "<botId>/<turnId>". */
  interrupted: string[];
  /** Remove rows put back to queued. */
  requeued: number;
}

export function recoverEffects(scope: TxScope, tx: Db, now: number, log?: (line: string) => void): RecoveryReport {
  const report: RecoveryReport = { interrupted: [], requeued: 0 };
  for (const row of effectsIn(tx, "started")) {
    if (row.kind === "remove") {
      if (moveEffect(tx, row.effectId, ["started"], "queued", now)) report.requeued += 1;
      continue;
    }
    const turnId = row.turnId!;
    const text = clearLive(tx, row.botId, turnId) ?? "";
    const replyId = (row.payload as TurnPayload).replyId;
    ensureBot(tx, row.botId);
    appendFitted(scope, tx, row.stream as StreamId, "turn.interrupted", { botId: row.botId, turnId, messageId: replyId, text }, { log });
    moveEffect(tx, row.effectId, ["started"], "interrupted", now);
    report.interrupted.push(`${row.botId}/${turnId}`);
  }
  for (const checkpoint of listCheckpoints(tx)) {
    const row = findTurnEffect(tx, checkpoint.botId, checkpoint.turnId);
    clearLive(tx, checkpoint.botId, checkpoint.turnId);
    if (row) continue; // its row ended (or was just interrupted above): only the stale checkpoint goes
    const stream = ensureBot(tx, checkpoint.botId);
    appendFitted(scope, tx, stream, "turn.interrupted", { botId: checkpoint.botId, turnId: checkpoint.turnId, text: checkpoint.text }, { log });
    report.interrupted.push(`${checkpoint.botId}/${checkpoint.turnId}`);
  }
  if (report.interrupted.length || report.requeued) {
    log?.(`effects: recovery interrupted ${report.interrupted.length} turn(s), queued ${report.requeued} removal(s) again`);
  }
  return report;
}
