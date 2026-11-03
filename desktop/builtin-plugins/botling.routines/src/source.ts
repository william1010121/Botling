// What a frame of botling.routines reads and changes routines through: the program part (host.ts), by the frame's `ccb.call`.
import type { RoutinesSource } from "./RoutinesPanel";

/** The panel's source for one bot. */
export function frameSource(ccb: { call(method: string, params?: unknown): Promise<unknown> }, botId: string): RoutinesSource {
  return {
    list: () => ccb.call("list", { botId }) as ReturnType<RoutinesSource["list"]>,
    change: (operation, id) => ccb.call("change", { botId, operation, id }) as ReturnType<RoutinesSource["change"]>,
  };
}
