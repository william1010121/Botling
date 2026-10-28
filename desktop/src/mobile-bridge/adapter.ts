import { ContractError, RequestEnvelope, errorResponse, okResponse, type Command, type ResponseEnvelope, type ResultOf } from '../contract';
import { MAIN_BOT_ID } from '../core/store/records';
type MobileCommand = Extract<Command, { type: 'chat.snapshot' | 'chat.send' | 'chat.choose' | 'chat.answer' }>;
export interface MobileAccess {
  pending(botId: string): readonly unknown[];
  snapshot(botId?: string): ResultOf<'chat.snapshot'>;
  handle(command: MobileCommand): Promise<unknown>;
}
/** Must run inside the core event loop. handle(chat.send) synchronously consumes the queue
 * before its first await; NEVER put IPC, an await or deferred callback between guard/handle. */
export async function mobileCommand(access: MobileAccess, raw: unknown, allowedBots: readonly string[]): Promise<ResponseEnvelope> {
  const parsed = RequestEnvelope.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid', { code: 'bad_request', message: 'Invalid mobile envelope.' });
  const { id, cmd } = parsed.data;
  try {
    if (cmd.type !== 'chat.snapshot' && cmd.type !== 'chat.send' && cmd.type !== 'chat.choose' && cmd.type !== 'chat.answer')
      throw new ContractError('forbidden', 'Command not available on mobile.');
    const botId = cmd.botId ?? MAIN_BOT_ID;
    if (!allowedBots.includes(botId)) throw new ContractError('forbidden', 'Bot not authorized.');
    if (cmd.type === 'chat.answer' && cmd.images?.length) throw new ContractError('forbidden', 'Mobile answers are text only.');
    if (cmd.type === 'chat.snapshot') {
      // snapshot() is read-only; chat.read would clear unread/catch-up state.
      const snapshot = access.snapshot(botId);
      return okResponse(id, { epoch: snapshot.epoch, seq: snapshot.seq,
        bots: snapshot.bots.filter(bot => allowedBots.includes(bot.id)).map(({ id, name, role, working, approvals, unread, problem, heads }) => ({ id, name, role, working, approvals, unread, problem, heads })),
        chat: snapshot.chat ? { botId: snapshot.chat.botId, messages: snapshot.chat.messages, tasks: snapshot.chat.tasks,
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
