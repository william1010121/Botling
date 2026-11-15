// Slots and receipts (protocol v1 §11.1–§11.5): exactly-once intent per (origin, originEpoch, target), stored in
// server.db in the command's transaction. The apply step, the log and the read models are injected (types.ts).
export { admit, cancelAnswer, cancelAnswered, HELD_LIMIT, SlotEngine, statedScope, type Admission, type BegunEnd, type CancelAnswer, type CancelNotedMessage, type CancelStatus, type CmdResultMessage, type CmdRetryMessage, type ReceiveOptions, type ReceiveStatus, type ReplySink, type SlotEngineOptions, type SlotInput, type SlotReply } from "./slot-engine";
export { CARD_COMMANDS, checkBasis, checkTarget, dbBasisReader, localOnly } from "./basis";
export { cmdHash } from "./hash";
export { findReceipt, readNext, type QueueRef, type StoredReceipt } from "./tables";
export { SlotRefusal, type ApplyContext, type ApplyFn, type Audit, type AuditEvent, type Authorize, type BasisReader, type SlotLog } from "./types";
