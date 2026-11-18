// Bot log streams of `botlingd` (protocol v1 §8.1, §8.3, §8.4, §7.6, D50): entries with (logId, seq) and the hash
// chain appended inside writer transactions, cursors, `snap`, `history`, `reset` and rewind detection, eviction.
export { GENESIS_HASH, hashEntry, verifyChain, type ChainCheck } from "./chain";
export {
  appendEntries, botIdOf, ENTRY_BYTES_LIMIT, ensureStream, evictEntries, hashAfter, listRetired, LogError, newLogId, nextHlc,
  okeyOf, readEntries, readStream, lostTailRewind, retireOwnStreams, retireStream, sameAsStored, verifyStream,
  type AppendItem, type ReadOptions, type RetiredLog, type StreamRow, type StreamState,
} from "./log-store";
export { applyReadModel, isCard, isOpenCard } from "./read-model";
export { inRead, readHistory, readSnap, SnapTooLargeError, type ServerSnapView, type Snap } from "./snap";
export { LogHub, LogReader, type LogHubOptions, type LogStore, type SubResult } from "./hub";
