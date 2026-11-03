// botling.terminal's program part: the shells of the Terminal panel. It owns the pseudo-terminals (node-pty), one list of tabs per
// bot, and answers the panel's frame (web.ts) through one exposed method, "terminal", with the requests of request.ts; what a shell
// prints goes to that bot's frames as the push "terminal" (`ui.emit`). A frame cannot choose a folder or a program: the folder is
// the bot's own (`bots.folder`) and the shell one of the installed ones.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { installedShells } from "./shells";
import { TerminalRequest, type TerminalAnswer } from "./request";
import { BotTerminals } from "./terminals";

export interface Options { spawnPty?: ConstructorParameters<typeof BotTerminals>[1]; fontFile?: string }

export async function activate(api: BotlingApi, options: Options = {}) {
  const terminals = new BotTerminals((event) => api.ui.emit("terminal", event, { botId: event.botId }), options.spawnPty);
  /** Bots removed from Botling: nothing opens for them any more. */
  const removed = new Set<string>();
  api.subscriptions.push(
    api.events.on("botRemoved", ({ botId }) => { removed.add(botId); terminals.remove(botId); }),
    // The plugin goes (turned off, reloaded, Botling quitting): its shells are ended, and the ones that ignore SIGHUP forced.
    () => terminals.closeAllNow(),
  );
  // The key is the page's own to run (it shows or hides the panel of the bot on screen); registered so the Plugins page counts it.
  api.subscriptions.push(api.commands.register("botling.terminal.toggle", () => {}));

  const folderFor = async (botId: string): Promise<string> => {
    // Resolved from the core's own state after validation; the frame cannot choose a folder or arguments.
    const folder = removed.has(botId) ? null : await api.bots.folder(botId);
    if (!folder || removed.has(botId)) throw new Error("Bot is no longer available.");
    return folder;
  };
  let font: string | null = null;
  const answer = async (raw: unknown): Promise<TerminalAnswer> => {
    const request = TerminalRequest.parse(raw);
    if (request.type === "shells") return installedShells();
    if (request.type === "font") return { font: (font ??= readFileSync(options.fontFile ?? join(api.plugin.dir, "assets", "MesloLGS-NF-Regular.ttf")).toString("base64")) };
    if (request.type === "list") return terminals.list(request.botId);
    if (request.type === "attach") return terminals.attach(request.botId, request.sessionId);
    if (request.type === "ack") { terminals.ack(request.botId, request.sessionId, request.offset); return null; }
    if (request.type === "close") { terminals.close(request.botId, request.sessionId); return null; }
    if (request.type === "input") { terminals.input(request.botId, request.sessionId, request.data, request.binary); return null; }
    if (request.type === "resize") { terminals.resize(request.botId, request.sessionId, request.cols, request.rows); return null; }
    const folder = await folderFor(request.botId);
    if (request.type === "restart") return terminals.restart(request.botId, request.sessionId, folder, request.shell);
    return terminals.open(request.botId, folder, request.shell);
  };
  api.subscriptions.push(api.ui.expose("terminal", answer));
  return { terminals };
}
