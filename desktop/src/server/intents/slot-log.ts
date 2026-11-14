// The slot rules' log (server/slots `SlotLog`) on the real bot log (server/log): outcome entries (`cmd.applied`,
// `cmd.refused`, `cmd.cancelled`, `cmd.skipped`) go into the target stream in the command's transaction, cut to fit one
// frame like every other entry. The server's incarnation (`inc`, D49) is the logId of its own `srv:<serverId>` stream.
import type { Cursor, LogId, StreamId } from "../../protocol";
import { ensureStream } from "../log";
import type { SlotLog } from "../slots";
import { appendFitted, serverStreamOf, type TxScope } from "../effects";

export function dbSlotLog(scope: TxScope, log?: (line: string) => void): SlotLog {
  return {
    serverInc: (tx) => ensureStream(tx, serverStreamOf(tx)).logId as LogId,
    logId: (tx, stream) => ensureStream(tx, stream).logId as LogId,
    appendEntry(tx, stream: StreamId, kind, body, slot): Cursor {
      const entry = appendFitted(scope, tx, stream, kind, body, { ...(slot ? { slot } : {}), log });
      if (!entry) throw new Error(`slots: a ${kind} entry for ${stream} could not be stored`);
      return { logId: entry.logId, seq: entry.seq };
    },
  };
}
