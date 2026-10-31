import { z } from 'zod';
import type { RouteBook } from './routes';
import { requestTicket } from './events';
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
  /** The request never got an answer (no connection): the case where another route may help. */
  network = false;
}

export function endpointURL(input: string, origin: string): URL {
  const url = new URL(input || '/api/mobile/command', origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.hash)
    throw new MobileError('Use a command endpoint on this page’s origin, without credentials or query parameters.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new MobileError('Open this client over HTTPS. HTTP is allowed only on localhost for development.');
  return url;
}

export function mobileGeneration(): Record<string, string> {
  const id = typeof location !== 'undefined' ? /^\/mobile\/g\/([a-f0-9]{64})\//.exec(location.pathname)?.[1] : undefined;
  return id ? { 'X-Botling-Generation': id } : {};
}
export class MobileTransport {
  private token: string;
  private routes: RouteBook | null;
  private requests = new Set<AbortController>();
  private closed = false;
  constructor(private endpoint: URL, token: string, private fetcher: typeof fetch = fetch, routes: RouteBook | null = null) {
    this.routes = routes;
    if (!token.trim() || /[\r\n]/.test(token)) throw new MobileError('Enter the server’s access token.');
    this.token = token.trim();
  }
  /** The route in use (its origin). */
  get origin(): string { return this.endpoint.origin; }
  /** Asks for a ticket for the event stream on the route in use. */
  ticket(): Promise<string> { return requestTicket(this.origin, this.token, this.fetcher); }
  /** After a failure to connect: if another route the core listed answers as this core, use it from now on.
   * The token is not involved until that route has proved its identity (RouteBook.recover sends nothing secret). */
  async recover(): Promise<boolean> {
    if (this.closed || !this.routes) return false;
    const before = this.origin, found = await this.routes.recover(this.fetcher);
    if (this.closed || !found || found === before || !this.routes.allowed(found)) return false;
    this.endpoint = endpointURL('/api/mobile/command', found);
    return true;
  }
  close() { this.closed = true; this.token = ''; for (const request of this.requests) request.abort(); this.requests.clear(); }
  async request(cmd: MobileCommand): Promise<unknown> {
    try { return await this.send(cmd); }
    catch (error) {
      if (!(error instanceof MobileError) || !error.network || !(await this.recover())) throw error;
      // A read is safe to repeat. A send is not: it may have arrived, so it is reported as unconfirmed and the next call uses the new route.
      if (error.uncertain) throw error;
      return this.send(cmd);
    }
  }
  private async send(cmd: MobileCommand): Promise<unknown> {
    if (this.closed) throw new MobileError('Disconnected. Connect again.');
    const command = Command.parse(cmd);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    const mutating = command.type !== 'chat.snapshot';
    let reached = false;
    try {
      const fetcher = this.fetcher; // Native browser fetch must not receive the transport as `this`.
      const response = await fetcher(this.endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...mobileGeneration(), Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ v: PROTOCOL_VERSION, id, cmd: command }), signal: controller.signal,
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      }).then(r => { reached = true; return r; });
      if (response.status === 409) throw new MobileError('Botling was updated. Open /mobile/ again to load the current version; keep your draft before reloading.', false, false, true);
      if (response.status === 503 && (await response.clone().json().catch(() => null))?.error?.code === 'generation_updating') throw new MobileError('Botling is updating. Try again shortly; this request was not dispatched.');
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
      const failure = new MobileError(mutating ? 'Delivery is unconfirmed. Refresh the chat before sending again; your draft is retained.' : 'Could not refresh. Check the connection and server endpoint.', false, mutating);
      failure.network = !reached && !(error instanceof DOMException && error.name === 'AbortError' && this.closed);
      throw failure;
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  async snapshot(botId?: string) {
    const snapshot = Snapshot.parse(await this.request({ type: 'chat.snapshot', ...(botId ? { botId } : {}) }));
    if (botId && snapshot.chat?.botId !== botId) throw new MobileError('The server returned a different chat.');
    return snapshot;
  }
}
