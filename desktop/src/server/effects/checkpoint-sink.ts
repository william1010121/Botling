// The live channel's checkpoint sink for the effect outbox (protocol v1 §9.3, §12). It only updates the text of the
// bot's running turn: `bots.liveTurnId` is set by the `turn.started` entry's transaction (tap.ts) and cleared by the
// `turn.finished` entry's (or by recovery), never by the sink. So a checkpoint write queued behind the turn's end
// cannot bring an ended turn back, and a crash always finds `liveTurnId` exactly while the turn's row is `started`.
import type { CheckpointSink } from "../live";
import type { Submitter } from "./scope";

export function effectCheckpointSink(store: Submitter): CheckpointSink {
  return {
    write: async (checkpoint) => {
      await store.submit((db) => {
        db.prepare("UPDATE bots SET liveText = ?, liveAt = ? WHERE botId = ? AND liveTurnId = ?")
          .run(checkpoint.text, checkpoint.at, checkpoint.botId, checkpoint.turnId);
      });
    },
    // The turn's `turn.finished` entry clears it in the same transaction (tap.ts).
    clear: async () => {},
  };
}
