import { ContractError, RequestEnvelope, errorResponse, okResponse, type Command, type ResponseEnvelope, type ResultOf } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';
import { ALL_BOTS, botAllowed } from './scope';
type MobileCommand = Extract<Command, { type: 'chat.snapshot' | 'chat.history' | 'chat.send' | 'chat.choose' | 'chat.answer' }>;
export interface MobileAccess {
  pending(botId: string): readonly unknown[];
  snapshot(botId?: string): ResultOf<'chat.snapshot'>;
  history?(command: Extract<Command, { type: 'chat.history' }>): ResultOf<'chat.history'>;
  handle(command: MobileCommand): Promise<unknown>;
}
/** Must run inside the core event loop. handle(chat.send) synchronously consumes the queue
 * before its first await; NEVER put IPC, an await or deferred callback between guard/handle. */
export async function mobileCommand(access: MobileAccess, raw: unknown, allowedBots: readonly string[]): Promise<ResponseEnvelope> {
  const parsed = RequestEnvelope.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid', { code: 'bad_request', message: 'Invalid mobile envelope.' });
  const { id, cmd } = parsed.data;
  try {
    if (cmd.type !== 'chat.snapshot' && cmd.type !== 'chat.history' && cmd.type !== 'chat.send' && cmd.type !== 'chat.choose' && cmd.type !== 'chat.answer')
      throw new ContractError('forbidden', 'Command not available on mobile.');
    const botId = cmd.botId ?? MAIN_BOT_ID;
    if (!botAllowed(allowedBots, botId)) throw new ContractError('forbidden', 'Bot not authorized.');
    if (cmd.type === 'chat.answer' && cmd.images?.length) throw new ContractError('forbidden', 'Mobile answers are text only.');
    // Older lines of a chat (the snapshot holds only its newest page): read-only, for a bot the client may read.
    if (cmd.type === 'chat.history') {
      if (!access.history) throw new ContractError('forbidden', 'Command not available on mobile.');
      return okResponse(id, access.history(cmd));
    }
    if (cmd.type === 'chat.snapshot') {
      // snapshot() is read-only; chat.read would clear unread/catch-up state.
      const snapshot = access.snapshot(botId);
      if (allowedBots.includes(ALL_BOTS)) return okResponse(id, webSnapshot(snapshot));
      return okResponse(id, { epoch: snapshot.epoch, seq: snapshot.seq,
        bots: snapshot.bots.filter(bot => allowedBots.includes(bot.id)).map(({ id, name, role, working, approvals, unread, problem, heads }) => ({ id, name, role, working, approvals, unread, problem, heads })),
        chat: snapshot.chat ? { botId: snapshot.chat.botId, messages: snapshot.chat.messages, tasks: snapshot.chat.tasks, ...(snapshot.chat.history ? { history: snapshot.chat.history } : {}),
          pendingFiles: (snapshot.chat.pendingFiles ?? []).map(({ id, name }) => ({ id, name })) } : null });
    }
    if (cmd.type === 'chat.send' && access.pending(botId).length)
      throw new ContractError('conflict', 'Desktop attachments are queued. Clear or send them on desktop first.');
    const result = await access.handle(cmd);
    // Preserve accepted:false, stoppedBy and nullable turnId; do not synthesize success.
    return okResponse(id, result);
  } catch (error) {
    return errorResponse(id, error instanceof ContractError ? error.toWire() : { code: 'internal', message: 'Mobile command failed. Check chat before sending again.' });
  }
}

/** What the desktop renderer draws, for the owner's all-bots browser session (Botling Web): the left
 * column (every bot), the chat on screen and the right panel. Only display settings go out, project
 * folders as their last path segment, and nothing of plugins, the doctor, web AIs, imports or specs. */
export function webSnapshot(snapshot: ResultOf<'chat.snapshot'>) {
  const settings = snapshot.settings;
  return {
    epoch: snapshot.epoch, seq: snapshot.seq,
    bots: snapshot.bots.map(bot => ({ ...bot, folder: bot.folder.split(/[\\/]/).filter(Boolean).pop() ?? '' })),
    imported: null,
    chat: snapshot.chat,
    components: snapshot.components,
    settings: settings ? { language: settings.language, effectiveLanguage: settings.effectiveLanguage, botLook: settings.botLook,
      chatAvatarSize: settings.chatAvatarSize, messageColumnWidth: settings.messageColumnWidth, rightPanelCollapsed: settings.rightPanelCollapsed,
      railCollapsed: settings.railCollapsed, pinnedBots: settings.pinnedBots } : undefined,
    waiting: snapshot.waiting,
    teams: snapshot.teams,
  };
}
