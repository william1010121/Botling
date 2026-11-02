// botling.usage's program part: what its frames ask for. Botling reads the usage (`usage.view`); this only hands it over,
// and counts the bots' finished turns so a frame can refresh when one ends (a frame is not told anything, it asks).
import type { BotlingApi } from "../../../../Web/host/src/api";

export function activate(api: BotlingApi) {
  let turns = 0;
  api.subscriptions.push(api.events.on("turnFinished", () => { turns += 1; }));
  api.ui.expose("usage", () => api.usage.view());
  api.ui.expose("turn", () => turns);
}
