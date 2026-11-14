// Recovery at start (protocol v1 §12), one writer command before the worker and any front end run:
// - every `started` turn row becomes exactly one `turn.interrupted{turnId, messageId: its reply, text}` (the checkpoint
//   text when `bots.liveTurnId` is that turn, else empty) and the row `interrupted`: it is never started again;
// - a turn's checkpoint left without a started row (a turn whose row the crash lost with its batch) is interrupted too;
// - `started` remove rows go back to `queued` (removing a bot is idempotent; the worker runs them again);
// - `queued` rows stay: their intent committed, nothing began them, the worker runs them now.
// - first, the user's line of every `chat.send` turn row still queued or started goes into the engine's own chat
//   (`engine.userLine`, which leaves a line it has alone): the intent put it there, but the core's rows commit in the
//   next transaction, so a crash in between would leave the log with a line the core's chat (chat.json, the history)
//   never gets once the turn is interrupted.
// The entry and the row's state commit together, so a second recovery finds nothing to do.
import type { StreamId } from "../../protocol";
import { listCheckpoints } from "../live";
import type { Db } from "../store";
import { appendFitted, clearLive, ensureBot } from "./log-ops";
import type { TurnEngine } from "./engine";
import type { TxScope } from "./scope";
import { effectsIn, findTurnEffect, moveEffect, type EffectRow, type TurnPayload } from "./table";

export interface RecoveryReport {
  /** The turns interrupted, as "<botId>/<turnId>". */
  interrupted: string[];
  /** Remove rows put back to queued. */
  requeued: number;
}

/** The user's line of a `chat.send` row, back into the engine's chat if it is missing there (see the header). */
function restoreUserLine(tx: Db, row: EffectRow, engine: Pick<TurnEngine, "userLine">, log?: (line: string) => void): void {
  const payload = row.payload as TurnPayload;
  if (row.kind !== "turn" || payload.origin !== "chat" || !payload.userId || !payload.send || !engine.userLine) return;
  const stored = tx.prepare("SELECT body FROM messages WHERE botId = ? AND msgId = ?").get(row.botId, payload.userId);
  let time: string | null = null;
  try { time = stored ? (JSON.parse(String(stored.body)) as { time?: unknown }).time as string ?? null : null; } catch { /* the row's own time below */ }
  try {
    engine.userLine(row.botId, {
      id: payload.userId, text: payload.send.text.trim(), time: typeof time === "string" ? time : new Date(row.startedAt ?? Date.now()).toISOString(),
      ...(payload.send.replyTo ? { replyTo: payload.send.replyTo } : {}), ...(payload.send.to ? { to: payload.send.to } : {}),
    });
  } catch (error) {
    log?.(`effects: recovery could not put line ${payload.userId} back into ${row.botId}'s chat (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function recoverEffects(scope: TxScope, tx: Db, now: number, log?: (line: string) => void, engine?: Pick<TurnEngine, "userLine">): RecoveryReport {
  const report: RecoveryReport = { interrupted: [], requeued: 0 };
  if (engine?.userLine) for (const row of [...effectsIn(tx, "queued"), ...effectsIn(tx, "started")]) restoreUserLine(tx, row, engine, log);
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
