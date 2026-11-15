// The intent handlers of `callin.ask` and `callin.cancel` (M5-02b), run inside the command's transaction.
import type { Command } from "../../contract";
import { ensureBot, callInEffectId, insertEffect, moveEffect, openCallIns, readEffect, type CallInPayload, type EffectWorker, type TxScope } from "../effects";
import { readStream } from "../log";
import type { ApplyContext } from "../slots";
import { SlotRefusal } from "../slots";
import type { CallInGuest } from "./guest";

/** Call-ins a bot may hold at once (queued or running); more are refused, so a peer cannot pile up turns. */
export const MAX_OPEN_CALLINS = 8;

export interface CallInIntakeDeps {
  scope: TxScope;
  worker: EffectWorker;
  callIns: CallInGuest;
  now: () => number;
}

/** `callin.ask`: the checks that need our own rows, then one `callin` row (at most one per sender, guest and callId). */
export function callInAsk(deps: CallInIntakeDeps, { tx, slot }: ApplyContext, cmd: Extract<Command, { type: "callin.ask" }>) {
  deps.callIns.admit(slot.origin, cmd);
  const effectId = callInEffectId(slot.origin, cmd.botId, cmd.callId);
  if (readEffect(tx, effectId)) throw new SlotRefusal("invalid", "that call-in was already received");
  if (openCallIns(tx, cmd.botId) >= MAX_OPEN_CALLINS) throw new SlotRefusal("invalid", "too many call-ins are waiting for that bot");
  const stream = ensureBot(tx, cmd.botId);
  const payload: CallInPayload = {
    kind: "callin", callId: cmd.callId, origin: slot.origin, host: cmd.host, transcript: cmd.transcript,
    asked: cmd.asked, by: cmd.by, depth: cmd.depth, replied: false,
  };
  insertEffect(tx, { effectId, stream, botId: cmd.botId, turnId: null, kind: "callin", payload, state: "queued", seq: readStream(tx, stream)?.head ?? 0, startedAt: null, endedAt: null });
  deps.scope.afterCommit(() => deps.worker.kick());
  return { result: { applied: true as const } };
}

/**
 * `callin.cancel` (D51): only the sender's own call-in (the row id includes the sender). Queued: cancelled, no turn, no
 * reply. Started: the guest turn is aborted after the commit and answers `failed` "cancelled". Anything else (unknown,
 * already answered): nothing to do, and nothing is sent.
 */
export function callInCancel(deps: CallInIntakeDeps, { tx, slot }: ApplyContext, cmd: Extract<Command, { type: "callin.cancel" }>) {
  const effectId = callInEffectId(slot.origin, cmd.botId, cmd.callId);
  const row = readEffect(tx, effectId);
  if (row?.state === "queued") moveEffect(tx, effectId, ["queued"], "cancelled", deps.now());
  else if (row?.state === "started") deps.scope.afterCommit(() => deps.callIns.cancel(effectId));
  return { result: { applied: true as const } };
}
