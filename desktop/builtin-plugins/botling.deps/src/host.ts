// botling.deps's program part: the one thing its frame asks for. Botling reads the plugins (`plugins.deps`: read only, any
// plugin); this only hands the answer over, read again at each ask.
import type { BotlingApi } from "../../../../Web/host/src/api";

export function activate(api: BotlingApi) {
  api.ui.expose("deps", () => api.plugins.deps());
}
