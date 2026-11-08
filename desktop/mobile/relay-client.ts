// The phone's side of the relay: one WebSocket to the relay, one end-to-end encrypted channel to the desktop inside
// it. Pairing (from the QR code) and every later connection use the same handshake (src/mobile-relay/e2e.ts); the
// relay only carries ciphertext. Requests are the bridge's own commands; a mutation keeps its request id across a
// reconnect, so the desktop's journal answers a resend with the first outcome instead of running it twice.
import { z } from 'zod';
import { Command, RequestId, ResponseEnvelope } from '../src/contract';
import { b64u, deriveChannel, deviceIdOf, generateKeyPair, offerIdOf, pairTokenOf, type Channel, type KeyPair } from '../src/mobile-relay/e2e';
import { DeskHandshake, DeskMessage, type RelayLink } from '../src/mobile-relay/protocol';
import { MobileError, type MobileCommand } from './transport';

/** What the phone keeps after pairing (relay-session.ts stores it; the private key is never exportable). */
export interface RelaySession {
  ws: string; room: string; deskKey: string; deviceId: string; token: string; keys: KeyPair;
  coreId: string; botIds: string[]; expiresAt: number;
}
interface SocketLike {
  readonly readyState: number;
  send(data: string): void; close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null; onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null; onerror: ((event: unknown) => void) | null;
}
export interface RelayClientOptions {
  socket?: (url: string) => SocketLike;
  /** Something changed on the desktop: read again. */
  onChange?: () => void;
  /** Whether the channel is up. */
  onLive?: (live: boolean) => void;
  /** The desktop revoked this phone (or the relay no longer admits its token): sign in again. */
  onRevoked?: (error: MobileError) => void;
  timeoutMs?: number;
  waits?: number[];
}

/** The relay's WebSocket for a link: the one it names, or this page's own /ws. */
export function relaySocketURL(link: Pick<RelayLink, 'ws'>, origin: string): string {
  if (link.ws) return link.ws;
  const page = new URL(origin);
  return `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/ws`;
}

const WAITS = [1_000, 3_000, 10_000, 30_000];
interface Pending { id: string; cmd: Command; resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; sent: boolean }
type Hello = { kind: 'pair'; link: RelayLink; secret: Uint8Array; name: string; done: (session: RelaySession) => void; fail: (error: MobileError) => void } | { kind: 'session' };

export class RelayClient {
  private socket: SocketLike | null = null;
  private channel: Channel | null = null;
  private ephemeral: KeyPair | null = null;
  private stage: 'idle' | 'joining' | 'keys' | 'ready' | 'closed' = 'idle';
  private pending = new Map<string, Pending>();
  private hello: Hello = { kind: 'session' };
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private live = false;
  private firstReady: { resolve: () => void; reject: (error: MobileError) => void } | null = null;
  private inbox: Promise<unknown> = Promise.resolve();

  private constructor(private session: RelaySession | null, private options: RelayClientOptions) {}

  /** Pairs with the desktop that showed the code. The connection stays open as this phone's first session. */
  static async pair(link: RelayLink, origin: string, name: string, options: RelayClientOptions = {}): Promise<{ client: RelayClient; session: RelaySession }> {
    const client = new RelayClient(null, options);
    const secret = b64u.decode(link.secret);
    const session = await new Promise<RelaySession>((done, fail) => {
      client.hello = { kind: 'pair', link: { ...link, ws: relaySocketURL(link, origin) }, secret, name, done, fail };
      void client.open();
    });
    return { client, session };
  }
  /** Reconnects as an already paired phone. Resolves once the desktop has confirmed the channel. */
  static async connect(session: RelaySession, options: RelayClientOptions = {}): Promise<RelayClient> {
    const client = new RelayClient(session, options);
    await new Promise<void>((resolve, reject) => { client.firstReady = { resolve, reject }; void client.open(); });
    return client;
  }

  get closed() { return this.stage === 'closed'; }
  /** For WebApp: the host this session goes through. */
  get origin(): string { return this.session ? new URL(this.session.ws).host : ''; }

  /** Sets the change and liveness listeners (the workspace sync). Returns a stop function. */
  watch(onChange: () => void, onLive: (live: boolean) => void): () => void {
    this.options.onChange = onChange; this.options.onLive = onLive;
    if (this.live) onLive(true);
    return () => { if (this.options.onChange === onChange) { this.options.onChange = undefined; this.options.onLive = undefined; } };
  }

  close() {
    if (this.stage === 'closed') return;
    this.stage = 'closed';
    clearTimeout(this.timer);
    this.channel?.close();
    try { this.socket?.close(1000, 'bye'); } catch { /* gone */ }
    this.socket = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new MobileError('Disconnected. Connect again.')); }
    this.pending.clear();
    this.setLive(false);
  }

  async request(cmd: MobileCommand): Promise<unknown> {
    if (this.stage === 'closed') throw new MobileError('Disconnected. Connect again.');
    const command = Command.parse(cmd);
    const id = crypto.randomUUID();
    const mutating = command.type !== 'chat.snapshot' && command.type !== 'chat.history';
    const envelope = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MobileError(mutating ? 'Delivery is unconfirmed. Refresh the chat before sending again; your draft is retained.' : 'Could not refresh. Check the connection.', false, mutating));
      }, this.options.timeoutMs ?? 15_000);
      const pending: Pending = { id, cmd: command, resolve, reject, timer, sent: false };
      this.pending.set(id, pending);
      if (this.stage === 'ready') void this.transmit(pending);
    });
    const parsed = ResponseEnvelope.parse(envelope);
    if (parsed.id !== id) throw new Error('Response does not match this request.');
    if (!parsed.ok) throw new MobileError(parsed.error.message, false, false, parsed.error.code === 'forbidden');
    if (command.type === 'chat.send') return z.object({ messageId: RequestId, turnId: RequestId.nullable(), stoppedBy: z.string().optional() }).parse(parsed.result);
    if (command.type === 'chat.choose' || command.type === 'chat.answer') {
      const result = z.object({ accepted: z.boolean() }).parse(parsed.result);
      if (!result.accepted) throw new MobileError('This question is no longer accepting that answer. Refresh the chat.');
      return result;
    }
    return parsed.result;
  }

  // ---- Connection.

  private async open() {
    if (this.stage === 'closed') return;
    const ws = this.hello.kind === 'pair' ? this.hello.link.ws! : this.session!.ws;
    const token = this.hello.kind === 'pair' ? await pairTokenOf(this.hello.secret) : this.session!.token;
    const room = this.hello.kind === 'pair' ? this.hello.link.room : this.session!.room;
    if (this.closed) return;
    let socket: SocketLike;
    try { socket = (this.options.socket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(ws); }
    catch { return this.lost(); }
    this.socket = socket; this.channel = null; this.stage = 'joining';
    socket.onopen = () => { if (this.socket === socket) socket.send(JSON.stringify({ t: 'join', v: 1, room, token })); };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      const data = event.data;
      this.inbox = this.inbox.then(() => this.fromRelay(data)).catch(error => this.fail(error instanceof MobileError ? error : new MobileError('The connection to Botling failed a security check.')));
    };
    socket.onerror = () => { /* onclose follows */ };
    // After the messages that came before it (a refusal arrives just ahead of its close).
    socket.onclose = () => { if (this.socket === socket) { this.socket = null; this.inbox = this.inbox.then(() => this.lost()); } };
  }

  private send(msg: unknown) { if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(msg)); }

  private async fromRelay(text: string) {
    const msg = JSON.parse(text);
    if (msg.t === 'error') {
      // The relay no longer admits this token: the desktop revoked it (or the pairing code expired).
      if (msg.code === 'denied') throw new MobileError(this.hello.kind === 'pair' ? 'This code has expired or already been used. Show a new code on your computer.' : 'This phone was signed out on your computer. Pair it again.', true);
      if (msg.code === 'desk_offline' && this.hello.kind === 'pair') throw new MobileError('Botling is not connected to the relay. Keep it running and try again.', true);
      return; // desktop offline: the close follows and we try again
    }
    if (msg.t === 'joined') {
      this.ephemeral = await generateKeyPair();
      if (this.hello.kind === 'pair') {
        const keys = await generateKeyPair();
        this.session = { ws: this.hello.link.ws!, room: this.hello.link.room, deskKey: this.hello.link.deskKey, deviceId: await deviceIdOf(keys.publicKey),
          token: '', keys, coreId: '', botIds: [], expiresAt: 0 };
        this.send({ t: 'd', d: JSON.stringify({ h: 'pair', v: 1, offer: await offerIdOf(this.hello.secret), device: b64u.encode(keys.publicKey), eph: b64u.encode(this.ephemeral.publicKey) }) });
      } else this.send({ t: 'd', d: JSON.stringify({ h: 'hello', v: 1, device: this.session!.deviceId, eph: b64u.encode(this.ephemeral.publicKey) }) });
      this.stage = 'keys';
      return;
    }
    if (msg.t !== 'd' || typeof msg.d !== 'string') return;
    if (this.stage === 'keys' && !this.channel) {
      const answer = DeskHandshake.parse(JSON.parse(msg.d));
      if (answer.h === 'nope') throw new MobileError(answer.reason === 'offer' ? 'This code has expired or already been used. Show a new code on your computer.' : 'This phone was signed out on your computer. Pair it again.', true);
      const s = this.session!;
      this.channel = await deriveChannel('phone', { static: s.keys, ephemeral: this.ephemeral! }, {
        mode: this.hello.kind, room: s.room, deviceId: s.deviceId, deskStatic: b64u.decode(s.deskKey), phoneStatic: s.keys.publicKey,
        phoneEphemeral: this.ephemeral!.publicKey, deskEphemeral: b64u.decode(answer.eph), pairSecret: this.hello.kind === 'pair' ? this.hello.secret : undefined });
      this.ephemeral = null;
      this.send({ t: 'd', d: await this.channel.seal(this.hello.kind === 'pair' ? { t: 'pair', name: this.hello.name } : { t: 'hello' }) });
      return;
    }
    if (!this.channel) return;
    const message = DeskMessage.parse(await this.channel.open(msg.d));
    switch (message.t) {
      case 'paired': {
        if (this.hello.kind !== 'pair' || this.stage !== 'keys') throw new MobileError('Unexpected answer from Botling.');
        const done = this.hello.done;
        this.session = { ...this.session!, deviceId: message.deviceId, token: message.token, coreId: message.coreId, botIds: message.botIds, expiresAt: message.expiresAt };
        if (message.deviceId !== await deviceIdOf(this.session.keys.publicKey)) throw new MobileError('Unexpected answer from Botling.');
        this.hello = { kind: 'session' };
        this.ready();
        done(this.session);
        return;
      }
      case 'ready':
        if (this.stage !== 'keys') throw new MobileError('Unexpected answer from Botling.');
        this.session = { ...this.session!, coreId: message.coreId, botIds: message.botIds, expiresAt: message.expiresAt };
        this.ready();
        return;
      case 'res': {
        const id = (message.env as { id?: unknown })?.id;
        const pending = typeof id === 'string' ? this.pending.get(id) : undefined;
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(pending.id);
        pending.resolve(message.env);
        return;
      }
      case 'changed': this.options.onChange?.(); return;
      case 'revoked': throw new MobileError('This phone was signed out on your computer. Pair it again.', true);
    }
  }

  private ready() {
    this.stage = 'ready'; this.failures = 0;
    this.setLive(true);
    this.firstReady?.resolve(); this.firstReady = null;
    // Anything asked while the channel was down goes now, with its original id (a resent mutation is answered from the desktop's journal).
    for (const pending of this.pending.values()) void this.transmit(pending);
  }

  private async transmit(pending: Pending) {
    if (this.stage !== 'ready' || !this.channel) return;
    pending.sent = true;
    try { this.send({ t: 'd', d: await this.channel.seal({ t: 'req', id: pending.id, cmd: pending.cmd }) }); } catch { /* the close follows */ }
  }

  private setLive(value: boolean) { if (this.live !== value) { this.live = value; this.options.onLive?.(value); } }

  /** The connection dropped: try again with growing waits, unless closed. Pending requests wait (or time out). */
  private lost() {
    this.channel?.close(); this.channel = null;
    this.setLive(false);
    if (this.stage === 'closed') return;
    if (this.hello.kind === 'pair') return this.fail(new MobileError('Could not reach Botling through the relay. Check the connection and scan the code again.', true));
    if (this.firstReady) return this.fail(new MobileError('Could not reach Botling through the relay. Keep Botling running on your computer and try again.'));
    this.stage = 'idle';
    const waits = this.options.waits ?? WAITS;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.open(); }, waits[Math.min(this.failures++, waits.length - 1)]);
  }

  /** A security failure, a refusal or a revocation: stop for good and say why. */
  private fail(error: MobileError) {
    if (this.stage === 'closed') return;
    const hello = this.hello, first = this.firstReady;
    this.firstReady = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.close();
    if (hello.kind === 'pair') hello.fail(error);
    else if (first) first.reject(error);
    else if (error.auth) this.options.onRevoked?.(error);
  }
}
