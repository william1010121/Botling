// The live channel of `botlingd` (protocol v1 §9, D10): coalesced `live` frames per running turn, segments per step,
// `live.resync`, catch-up for a reader that (re)attaches mid-turn, and the 5 s checkpoint in `bots.liveText`.
export { clearCheckpoint, listCheckpoints, readCheckpoint, storeCheckpointSink, writeCheckpoint, type CheckpointSink, type LiveCheckpoint } from "./checkpoint";
export { systemClock, type Clock, type TimerHandle } from "./clock";
export { ContractLiveFeed } from "./contract-feed";
export {
  CHECKPOINT_INTERVAL_MS, LiveChannel, MAX_FRAME_UNITS, MIN_FRAME_INTERVAL_MS, splitUnits, streamOf,
  type LiveChannelOptions, type LiveSend, type LiveSubscription, type RunningTurn,
} from "./live-channel";
export { LiveReceiver, type ApplyResult, type LiveFrame, type LiveSegmentView } from "./receiver";
