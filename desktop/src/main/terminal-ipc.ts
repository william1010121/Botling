import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { TerminalRequest } from '../contract/terminal';
import { BotTerminals, installedShells } from './terminal';
export function installTerminalIPC(ipc: Pick<IpcMain, 'handle'>, terminals: BotTerminals,
  allowed: (event: IpcMainInvokeEvent) => boolean,
  folderFor: (botId: string) => Promise<string | null>) {
  ipc.handle('botling:terminal', async (event, raw: unknown) => {
    if (!allowed(event)) throw new Error('Terminal requires the app main frame.');
    const request = TerminalRequest.parse(raw), owner = event.sender.id;
    if (request.type === 'shells') return installedShells();
    if (request.type === 'list') return terminals.list(owner, request.botId);
    if (request.type === 'attach') return terminals.attach(owner, request.botId, request.sessionId);
    if (request.type === 'ack') { terminals.ack(owner, request.botId, request.sessionId, request.offset); return null; }
    if (request.type === 'close') { terminals.close(owner, request.botId, request.sessionId); return null; }
    if (request.type === 'input') { terminals.input(owner, request.botId, request.sessionId, request.data, request.binary); return null; }
    if (request.type === 'resize') { terminals.resize(owner, request.botId, request.sessionId, request.cols, request.rows); return null; }
    // Resolve from trusted core state after validation; renderer cannot choose cwd or args.
    const folder = await folderFor(request.botId);
    if (!folder || event.sender.isDestroyed() || !allowed(event)) throw new Error('Bot is no longer available.');
    if (request.type === 'restart') return terminals.restart(owner, request.botId, request.sessionId, folder, request.shell);
    return terminals.open(owner, request.botId, folder, request.shell);
  });
}
