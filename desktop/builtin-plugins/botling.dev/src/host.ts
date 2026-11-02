// botling.dev's program part (program.ts does the work).
import type { BotlingApi } from "../../../../Web/host/src/api";
import { Program } from "./program";

export function activate(api: BotlingApi) {
  // Without an app around (a headless core) there is nothing to install or photograph: the first ask fails and the tags do nothing.
  void new Program(api).start().catch(() => {});
}
