// What a frame of botling.usage reads the usage from: the program part (host.ts), through the frame's `ccb.call`.
import type { UsageView } from "../../../../Web/host/src/api";
import type { UsageSource } from "./usage-session";

/** How often a frame asks whether a bot's turn has finished since (ms). */
export const TURN_POLL_MS = 2_000;

/** The usage as the frame gets it: a read through the program part, and a turn counter it asks for while it is open. */
export function frameSource(ccb: { call(method: string, params?: unknown): Promise<unknown> }): UsageSource {
  return {
    view: () => ccb.call("usage") as Promise<UsageView>,
    onTurnFinished(fn) {
      let last: number | null = null, live = true, timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        try {
          const turns = (await ccb.call("turn")) as number;
          if (live && last !== null && turns !== last) fn();
          last = turns;
        } catch { /* asked again */ }
        if (live) timer = setTimeout(tick, TURN_POLL_MS);
      };
      void tick();
      return () => { live = false; clearTimeout(timer); };
    },
  };
}
