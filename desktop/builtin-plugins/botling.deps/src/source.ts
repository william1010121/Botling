// What the frame reads the board from: the program part (host.ts), through the frame's `ccb.call`.
import type { DepBoard } from "../../../../Web/host/src/api";

/** How often the open page asks again (ms): a plugin turned on or off elsewhere shows within this. */
export const REFRESH_MS = 5_000;

export interface BoardSource { read(): Promise<DepBoard> }

export function frameSource(ccb: { call(method: string, params?: unknown): Promise<unknown> }): BoardSource {
  return { read: () => ccb.call("deps") as Promise<DepBoard> };
}
