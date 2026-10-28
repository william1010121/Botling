import { z } from 'zod';
import { BotView, MessageView, TaskView, Command, PROTOCOL_VERSION, ResponseEnvelope, RequestId } from '../src/contract';

// Validate just the fields rendered here; the core remains the authority for commands.
export const Snapshot = z.object({
  epoch: z.string(), seq: z.number().int().nonnegative(),
  bots: z.array(BotView.pick({ id: true, name: true, role: true, working: true, approvals: true, unread: true, problem: true, heads: true })),
  chat: z.object({ botId: z.string(), messages: z.array(MessageView), tasks: z.array(TaskView),
    pendingFiles: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  }).nullable(),
});
export type MobileSnapshot = z.infer<typeof Snapshot>;
export type MobileCommand = Extract<Command, { type: 'chat.snapshot' | 'chat.send' | 'chat.choose' | 'chat.answer' }>;
export class MobileError extends Error {
  /** `revoked`: refused before the bridge looked at the request (no bridge envelope): the session itself
   * is no longer accepted, unlike a bridge's refusal of one bot or command. */
  constructor(message: string, public auth = false, public uncertain = false, public denied = false, public revoked = false) { super(message); }
}

export function endpointURL(input: string, origin: string): URL {
  const url = new URL(input || '/api/mobile/command', origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.hash)
    throw new MobileError('Use a command endpoint on this page’s origin, without credentials or query parameters.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new MobileError('Open this client over HTTPS. HTTP is allowed only on localhost for development.');
  return url;
}

export class MobileTransport {
  private token: string;
  private csrf: string;
  private requests = new Set<AbortController>();
  private closed = false;
  constructor(private endpoint: URL, token: string | { csrf: string }, private fetcher: typeof fetch = fetch) {
    if (typeof token === 'string' && (!token.trim() || /[\r\n]/.test(token))) throw new MobileError('Enter the server’s access token.');
    this.token = typeof token === 'string' ? token.trim() : '';
    this.csrf = typeof token === 'string' ? '' : token.csrf;
  }
  close() { this.closed = true; this.token = ''; this.csrf = ''; for (const request of this.requests) request.abort(); this.requests.clear(); }
  async request(cmd: MobileCommand): Promise<unknown> {
    if (this.closed) throw new MobileError('Disconnected. Connect again.');
    const command = Command.parse(cmd);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    const mutating = command.type !== 'chat.snapshot';
    try {
      const fetcher = this.fetcher; // Native browser fetch must not receive the transport as `this`.
      const response = await fetcher(this.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.csrf ? { 'X-Botling-CSRF': this.csrf } : { Authorization: `Bearer ${this.token}` }) },
        body: JSON.stringify({ v: PROTOCOL_VERSION, id, cmd: command }), signal: controller.signal,
        cache: 'no-store', credentials: this.csrf ? 'same-origin' : 'omit', redirect: this.csrf ? 'manual' : 'error', referrerPolicy: 'no-referrer',
      });
      if (response.type === 'opaqueredirect' || response.status === 401) throw new MobileError('Your session expired or is unavailable. Connect again; drafts remain in this tab.', true);
      if (response.status === 403) {
        // Only a matching bridge envelope identifies a bot denial; edge HTML is not trusted.
        const body = ResponseEnvelope.safeParse(await response.json().catch(() => null));
        const botDenied = body.success && body.data.id === id && !body.data.ok && body.data.error.code === 'forbidden';
        throw new MobileError(botDenied ? 'This bot or action is not authorized. Choose an allowed chat.' : 'Access was denied before the request could be completed. Check your account access.', false, false, true, !botDenied);
      }
      if (!response.ok) throw new MobileError(`Server returned HTTP ${response.status}.`, false, mutating);
      const envelope = ResponseEnvelope.parse(await response.json());
      if (envelope.id !== id) throw new Error('Response does not match this request.');
      if (!envelope.ok) throw new MobileError(envelope.error.message, false, false, envelope.error.code === 'forbidden');
      if (command.type === 'chat.send') return z.object({ messageId: RequestId, turnId: RequestId.nullable(), stoppedBy: z.string().optional() }).parse(envelope.result);
      if (command.type === 'chat.choose' || command.type === 'chat.answer') {
        const result = z.object({ accepted: z.boolean() }).parse(envelope.result);
        if (!result.accepted) throw new MobileError('This question is no longer accepting that answer. Refresh the chat.');
        return result;
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof MobileError) throw error;
      throw new MobileError(mutating ? 'Delivery is unconfirmed. Refresh the chat before sending again; your draft is retained.' : 'Could not refresh. Check the connection and server endpoint.', false, mutating);
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  async snapshot(botId?: string) {
    const snapshot = Snapshot.parse(await this.request({ type: 'chat.snapshot', ...(botId ? { botId } : {}) }));
    if (botId && snapshot.chat?.botId !== botId) throw new MobileError('The server returned a different chat.');
    return snapshot;
  }
}
