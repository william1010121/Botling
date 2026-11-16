// botling.pin-area, program part. The pins (the cards above the chat), what bots and the user do to them, and what the chat page
// draws (`chat.setData`) are pins.ts; the rules are model.ts. Design: ../DESIGN.md.
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activatePins } from "./pins";

type Params = Record<string, unknown>;
const paramsOf = (params: unknown): Params => (params && typeof params === "object" ? params as Params : {});

export function activate(api: BotlingApi) {
  const expose = (method: string, fn: (params: Params) => unknown) => api.ui.expose(method, (params) => fn(paramsOf(params)));
  api.subscriptions.push(...activatePins(api, expose));
}
