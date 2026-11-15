// The effect outbox of `botlingd` (protocol v1 §12, M1 step 6): effect rows committed with their intent, the worker
// that runs them after the commit, recovery at start (a started turn becomes exactly one `turn.interrupted`), the
// event tap (engine events → log entries, `turn.delta` → live channel) and oversized entries (fit.ts).
export { effectCheckpointSink } from "./checkpoint-sink";
export type { ApplyNowCommand, CallInAnswer, CallInOptions, DeferredTurnRequest, EngineHost, TurnEngine, TurnRunning, TurnStart, TurnStatus, UserLine } from "./engine";
export { BODY_BYTES_LIMIT, cutNote, fitBody, prefixWithin, type Fitted } from "./fit";
export { appendFitted, botKnown, botStream, clearLive, ensureBot, markLive, readFullText, serverStreamOf, type AppendOptions } from "./log-ops";
export { recoverEffects, type RecoveryReport } from "./recovery";
export { TxScope, type Submitter } from "./scope";
export {
  callInEffectId, effectsIn, findTurnEffect, insertEffect, moveEffect, openCallIns, queuedEffects, readEffect, setEffectPayload,
  type CallInPayload, type EffectKind, type EffectPayload, type EffectRow, type EffectState, type RemovePayload, type TurnOrigin, type TurnPayload,
} from "./table";
export { botOfEvent, EventTap, type EventTapOptions, type TapHooks } from "./tap";
export { EffectWorker, type CallInRunner, type EffectWorkerOptions } from "./worker";
