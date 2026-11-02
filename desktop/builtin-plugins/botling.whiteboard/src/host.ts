// botling.whiteboard's program part (program.ts does the work).
import type { BotlingApi } from "../../../../Web/host/src/api";
import { legacyReader, Program } from "./program";

export function activate(api: BotlingApi) {
  new Program(api, {
    now: () => Date.now(),
    legacy: legacyReader(api.plugin.storageDir),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return { cancel: () => clearTimeout(timer) };
    },
  }).start();
}
