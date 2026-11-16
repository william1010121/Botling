// What the app page answers for a plugin's frame (frame-broker.ts `PluginFrameHost`), for any frame that
// shows a plugin's web part (a panel; later its main-area views): its calls and commands go to its own
// plugin in the core, and two things the page does itself (plugin-extraction.md W4):
// - `ccb.tile`: a component of the library drawn as a Board tile (read only, as a whiteboard picture is) on
//   a card page main serves once (`card.page`, botling-card://page/<token>); the frame may frame that page
//   (PANEL_CSP lets it) and nothing else.
// - `ccb.card`: a component drawn as in a chat reply (the Note tab's cards), on a card page main serves once.
// - `ccb.snapshot`: a picture of a part of the frame that asks (clipped to it and to the window), taken by main
//   (`plugins.noteSnapshot`) and kept in the bot's note-assets.
// - `ccb.requestApproval`: the core says what the bot's command and folder are (`plugins.approvalAsk`); the
//   page's own ApprovalSheet shows that, and only its Allow sends `plugins.approve` with the core's values. A
//   frame never gets a route to it, so a plugin cannot allow anything for the user (N1, §5.4 G2).
import type { ApprovalAskView, BotView, Command, ComponentInfoView } from "../contract";
import type { Client } from "./client";
import type { ComponentInfo } from "../../../Web/src/types";
import type { PluginFrameHost } from "./frame-broker";
import { openReport } from "./report-opener";
import { callFrameService } from "./shell/frame-services";
import { shellStorage } from "./shell/storage";

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
    call: (name, method, params) => client.request({ type: "plugins.call", name, method, params, from: "frame" }, undefined, { plugin: name }).then((answer) => answer.result, failed),
    command: (name, id, args) => client.request({ type: "plugins.command", id, from: "frame", name, ...(args?.length ? { args } : {}) }, undefined, { plugin: name }),
    async tile(plugin, { component, data, size, botId }) {
      const info = components()[component];
      if (!info) throw new Error(`No component "${component}" in the library.`);
      if (!knownBot(bots(), botId)) throw new Error("No such bot.");
      const json = JSON.stringify(data ?? null);
      if (json.length > TILE_DATA_MAX) throw new Error("The tile's data is too big.");
      // The pictures its data names are the core's to find (the bot's folder): a tile never reads a path itself.
      const { images } = await client.request({ type: "plugins.tileImages", name: plugin, botId, data: json }, undefined, { plugin }).catch(failed);
      const { componentPage } = await import("../../../Web/src/components");
      const page = componentPage(info.template, json, images, size, "board", true, false);
      return (await client.request({ type: "card.page", html: page }, undefined, { plugin })).url;
    },
    async card(plugin, { component, data, botId }) {
      const info = components()[component];
      if (!info) throw new Error(`No component "${component}" in the library.`);
      if (!knownBot(bots(), botId)) throw new Error("No such bot.");
      const json = JSON.stringify(data ?? null);
      if (json.length > TILE_DATA_MAX) throw new Error("The card's data is too big.");
      const { images } = await client.request({ type: "plugins.tileImages", name: plugin, botId, data: json }, undefined, { plugin }).catch(failed);
      const { componentPage, chatSize } = await import("../../../Web/src/components");
      // As in a chat reply (chatSize reads only its sizes): at its widest size, its height its content's; it can neither answer nor save there.
      const page = componentPage(info.template, json, images, chatSize({ sizes: info.sizes } as ComponentInfo), "chat", false, false);
      return (await client.request({ type: "card.page", html: page }, undefined, { plugin })).url;
    },
    async snapshot(plugin, frame, { botId, rect }) {
      // Only inside the frame that asked, and only what is on screen of it: never another part of the window.
      const box = frame.getBoundingClientRect();
      const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
      const right = Math.min(box.width, rect.x + rect.width), bottom = Math.min(box.height, rect.y + rect.height);
      const x = Math.max(box.left + left, 0), y = Math.max(box.top + top, 0);
      const width = Math.min(box.left + right, window.innerWidth) - x, height = Math.min(box.top + bottom, window.innerHeight) - y;
      if (!(width >= 1 && height >= 1)) throw new Error("That part of the frame is not on screen.");
      return client.request({ type: "plugins.noteSnapshot", name: plugin, botId, rect: { x, y, width, height } }, undefined, { plugin }).catch(failed);
    },
    async openLink(plugin, { botId, href }) {
      // The core decides what the href names and main opens it as a chat link (plugin-link.ts); a Markdown file comes
      // back as a report page this page shows, as the chat's own report links do.
      const bot = bots().find((each) => each.id === botId || (botId === "main" && each.role === "main"));
      if (!bot) throw new Error("No such bot.");
      // The bot by its own id (not "main"): a web link opens in that bot's browser tabs.
      const result = await client.request({ type: "plugins.openLink", name: plugin, botId: bot.id, href }, undefined, { plugin }).catch(failed);
      if (result.previewURL && !openReport(bot.id, result.previewURL)) throw new Error("This page shows no report preview.");
      return { opened: result.opened };
    },
    async composerQuote(plugin, { botId, text, focus }) {
      // The broker has checked it is the frame's own bot; the chat surface's service writes into that bot's input box
      // (composer-quote.ts), called through the renderer's plugin kernel for the frame's plugin, as its manifest declares
      // it uses the service (shell/frame-services.ts): a plugin that does not, or no provider, finds nothing.
      if (!bots().some((each) => each.id === botId)) return { inserted: false };
      try {
        const called = callFrameService<Promise<boolean>>(plugin, "composer.insertQuote", botId, text, focus);
        return { inserted: !called.absent && (await called.value) === true };
      } catch { return { inserted: false }; }
    },
    // async: a refusal that throws at once (a name that is no namespace, `:shell` not loaded) still answers the frame.
    async storage(plugin, req) {
      const store = shellStorage(plugin);
      if (req.op === "get") return store.get(req.key);
      if (req.op === "set") return store.set(req.key, req.value);
      return store.remove(req.key);
    },
    // Only the frame's own plugin (the broker passes the one it registered): what the core's view says of its program part.
    async hostStatus(plugin) {
      const { plugins } = await client.request({ type: "plugins.list" }).catch(failed);
      return plugins.find((each) => each.name === plugin)?.hostState ?? "none";
    },
    async requestApproval(plugin, { botId, command, folder, card, detail }) {
      const asked = await client.request({ type: "plugins.approvalAsk", name: plugin, botId, command, folder, ...(card ? { card } : {}), ...(detail ? { detail } : {}) }, undefined, { plugin }).catch(failed);
      if (!asked.needsApproval) return { allowed: true };
      const view = asked.needsApproval;
      return new Promise((resolve) => ask(view, { type: "plugins.approve", name: plugin, botId, command: view.command, folder: view.folder, ...(view.detail ? { detail: view.detail } : {}) }, (allowed) => resolve({ allowed })));
    },
  };
}
