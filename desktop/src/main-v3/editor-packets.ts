// The chat state the 2.x window sends its native chat page, made steady before main relays it (M1 demo bug 1), without
// changing the 2.x renderer or main. The window builds a routine's chip (renderer/payload.ts `routineChips`) with
// `started: now`, and puts it on the newest bot reply. So every state it sends (every 30 s at least, when its chat frame
// re-binds, and at every event) has a different newest row, and the chat page (Web/src/main.ts, rows keyed by their
// JSON) draws that row anew: a video playing in it starts over. A scheduled routine has not started; a cron chip shows
// when it fires, never `started`. Here that field gets one fixed value that sorts the chip where `now` did (after every
// chip that has started), so a row that did not change has the same JSON.
//
// Wired by wrapping `ipcMain.on` for the editor's `down` channel before the 2.x main registers its relay
// (src/main/editor-host.ts): its listener gets the steady packet. Imported by src/main-v3/main.ts.
import { EDITOR_CHANNEL } from "../editor-host-wire";

/** The `started` of a routine chip that has not started: after every real time, the same at every build. */
export const ROUTINE_CHIP_STARTED = Number.MAX_SAFE_INTEGER;

type Row = { tasks?: unknown };
type Chip = { id?: unknown; kind?: unknown; started?: unknown; ended?: unknown };

const isRoutineChip = (chip: Chip): boolean =>
  !!chip && typeof chip === "object" && chip.kind === "cron" && typeof chip.id === "string" && chip.id.startsWith("routine:")
  && chip.ended === null && typeof chip.started === "number" && chip.started !== ROUTINE_CHIP_STARTED;

/** A row with its routine chips' `started` fixed (the row itself when none needs it). */
function steadyRow<T extends Row>(row: T): T {
  if (!row || typeof row !== "object" || !Array.isArray(row.tasks) || !row.tasks.some(isRoutineChip)) return row;
  return { ...row, tasks: row.tasks.map((chip: Chip) => (isRoutineChip(chip) ? { ...chip, started: ROUTINE_CHIP_STARTED } : chip)) };
}

function steadyRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  let changed = false;
  const next = rows.map((row) => { const steady = steadyRow(row as Row); if (steady !== row) changed = true; return steady; });
  return changed ? next : rows;
}

/** An editor `down` packet (`{stamp, message}`) with its chat rows made steady; anything else as it is. */
export function steadyEditorPacket(packet: unknown): unknown {
  if (!packet || typeof packet !== "object") return packet;
  const message = (packet as { message?: unknown }).message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return packet;
  if (message.botling === "state") {
    const state = message.state as { messages?: unknown } | undefined;
    if (!state || typeof state !== "object") return packet;
    const messages = steadyRows(state.messages);
    return messages === state.messages ? packet : { ...packet, message: { ...message, state: { ...state, messages } } };
  }
  if (message.botling === "stateDelta") {
    const patch = message.patch as { changed?: unknown } | undefined;
    if (!patch || typeof patch !== "object") return packet;
    const changed = steadyRows(patch.changed);
    return changed === patch.changed ? packet : { ...packet, message: { ...message, patch: { ...patch, changed } } };
  }
  return packet;
}

type Listener = (event: unknown, ...args: unknown[]) => void;
export interface IpcMainLike {
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
  off?(channel: string, listener: Listener): unknown;
}

/** Makes every listener `ipc` gets for the editor's `down` channel receive the steady packet. Idempotent. */
export function installEditorPacketFilter(ipc: IpcMainLike): void {
  const marked = ipc as IpcMainLike & { __botlingSteadyDown?: true };
  if (marked.__botlingSteadyDown) return;
  marked.__botlingSteadyDown = true;
  const wrapped = new WeakMap<Listener, Listener>();
  const on = ipc.on.bind(ipc);
  const removeListener = ipc.removeListener.bind(ipc);
  const wrap = (listener: Listener): Listener => {
    let steady = wrapped.get(listener);
    if (!steady) {
      steady = (event, packet, ...rest) => listener(event, steadyEditorPacket(packet), ...rest);
      wrapped.set(listener, steady);
    }
    return steady;
  };
  ipc.on = (channel, listener) => on(channel, channel === EDITOR_CHANNEL.down ? wrap(listener) : listener);
  ipc.removeListener = (channel, listener) => removeListener(channel, channel === EDITOR_CHANNEL.down ? (wrapped.get(listener) ?? listener) : listener);
  if (ipc.off) {
    const off = ipc.off.bind(ipc);
    ipc.off = (channel, listener) => off(channel, channel === EDITOR_CHANNEL.down ? (wrapped.get(listener) ?? listener) : listener);
  }
}
