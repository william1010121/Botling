// What the app page answers for a plugin's frame (frame-broker.ts `PluginFrameHost`), for any frame that
// shows a plugin's web part (a panel; later its main-area views): its calls and commands go to its own
// plugin in the core, and two things the page does itself (plugin-extraction.md W4):
// - `ccb.tile`: a component of the library drawn as a Board tile (read only, as a whiteboard picture is) on
//   a card page main serves once (`card.page`, botling-card://page/<token>); the frame may frame that page
//   (PANEL_CSP lets it) and nothing else.
// - `ccb.requestApproval`: the core says what the bot's command and folder are (`plugins.approvalAsk`); the
//   page's own ApprovalSheet shows that, and only its Allow sends `plugins.approve` with the core's values. A
//   frame never gets a route to it, so a plugin cannot allow anything for the user (N1, §5.4 G2).
import type { ApprovalAskView, BotView, Command, ComponentInfoView } from "../contract";
import type { Client } from "./client";
import type { PluginFrameHost } from "./frame-broker";

/** The most of a tile's data (as JSON) a frame may give: a whiteboard picture's limit. */
export const TILE_DATA_MAX = 256_000;

export interface PluginFrameHostDeps {
  client: Client;
  /** The component library as the page has it now. */
  components: () => Record<string, ComponentInfoView>;
  /** The bots as the page has them now. */
  bots: () => BotView[];
  /** Opens the page's ApprovalSheet (`useApprovalSheet().ask`). */
  ask: (view: ApprovalAskView, approve: Command, done: (allowed: boolean) => void) => void;
}

/** A bot named as plugins name it: "main", or its id. */
const knownBot = (bots: BotView[], botId: string) => bots.some((bot) => bot.id === botId || (botId === "main" && bot.role === "main"));

export function pluginFrameHost({ client, components, bots, ask }: PluginFrameHostDeps): PluginFrameHost {
  const failed = (failure: unknown): never => {
    const error = failure as { error?: { message?: unknown }; message?: unknown } | null;
    throw new Error(String(error?.error?.message ?? error?.message ?? failure));
  };
  return {
    call: (name, method, params) => client.request({ type: "plugins.call", name, method, params, from: "frame" }).then((answer) => answer.result, failed),
    command: (name, id, args) => client.request({ type: "plugins.command", id, from: "frame", name, ...(args?.length ? { args } : {}) }),
    async tile(_plugin, { component, data, size, botId }) {
      const info = components()[component];
      if (!info) throw new Error(`No component "${component}" in the library.`);
      if (!knownBot(bots(), botId)) throw new Error("No such bot.");
      const json = JSON.stringify(data ?? null);
      if (json.length > TILE_DATA_MAX) throw new Error("The tile's data is too big.");
      const { componentPage } = await import("../../../Web/src/components");
      const page = componentPage(info.template, json, {}, size, "board", true, false);
      return (await client.request({ type: "card.page", html: page })).url;
    },
    async requestApproval(plugin, { botId, command, folder, card }) {
      const asked = await client.request({ type: "plugins.approvalAsk", name: plugin, botId, command, folder, ...(card ? { card } : {}) }).catch(failed);
      if (!asked.needsApproval) return { allowed: true };
      const view = asked.needsApproval;
      return new Promise((resolve) => ask(view, { type: "plugins.approve", name: plugin, botId, command: view.command, folder: view.folder }, (allowed) => resolve({ allowed })));
    },
  };
}
