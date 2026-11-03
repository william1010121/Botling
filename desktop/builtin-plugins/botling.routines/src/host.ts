// botling.routines' program part: what its frame asks for. Botling keeps and runs the schedules (core/routines.ts,
// session-schedules.ts); this lists a bot's routines and passes on Pause, Resume and Cancel (never a new routine).
import type { BotlingApi } from "../../../../Web/host/src/api";

const OPERATIONS = ["pause", "resume", "cancel"] as const;
type Operation = (typeof OPERATIONS)[number];
const text = (value: unknown, what: string) => {
  if (typeof value !== "string" || !value) throw new Error(`${what} is missing.`);
  return value;
};

export function activate(api: BotlingApi) {
  api.ui.expose("list", (params) => api.routines.list(text((params as { botId?: unknown } | null)?.botId, "The bot")));
  api.ui.expose("change", (params) => {
    const { botId, operation, id } = (params ?? {}) as { botId?: unknown; operation?: unknown; id?: unknown };
    if (!OPERATIONS.includes(operation as Operation)) throw new Error("A routine can be paused, resumed or cancelled.");
    return api.routines.change(text(botId, "The bot"), operation as Operation, text(id, "The routine"));
  });
}
