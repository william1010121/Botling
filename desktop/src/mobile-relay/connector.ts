// The desktop's side of the relay: when the relay is on (Settings › Phone), keep one outbound WebSocket to it, open
// this desktop's room, tell the relay which phone tokens may join, and serve each paired phone over its own
// end-to-end encrypted channel with the same core calls the HTTPS bridge makes (core.mobileCommand, the mutation
// ledger, change notices). The relay only ever carries ciphertext; this file is where frames are opened.
import { createHash, randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, RequestEnvelope, errorResponse, type ResponseEnvelope } from '../contract';
import type { MobileCore } from '../mobile-bridge/bridge';
import type { MutationLedger } from '../mobile-bridge/ledger';
import { ALL_BOTS, botAllowed } from '../mobile-bridge/scope';
import { MAIN_BOT_ID } from '../core/store/records';
import { b64u, deriveChannel, deviceIdOf, generateKeyPair, offerIdOf, pairTokenOf, type Channel } from './e2e';
import { PhoneHandshake, PhoneMessage, READ_COMMANDS, RELAY_COMMANDS, relayPairingURL } from './protocol';
import { PAIRED_TTL_MS, RelayStore, relayPage, type RelayDevice } from './store';

export const RELAY_PAIR_TTL_MS = 5 * 60_000;
const MAX_OFFERS = 5;
const HANDSHAKE_MS = 15_000;
const NOTICE_MS = 250;
/** Leave room under the relay's default 4 MiB frame limit for the relay's own wrapping. */
const MAX_FRAME_CHARS = 3_800_000;
const WAITS = [1_000, 2_000, 5_000, 10_000, 30_000];
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 40) : '';

export type RelayState = 'off' | 'connecting' | 'online' | 'offline';
export interface RelayView { url: string | null; state: RelayState }

/** The few parts of a WebSocket used here (the global one in Node 24 / Electron, or a test's). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export interface ConnectorOptions {
  store: RelayStore;
  core: MobileCore;
  /** The mutation journal (shared with the bridge, `<data>/mobile-mutations`), made on first use. */
  ledger: () => MutationLedger;
  coreId: () => string;
  socket?: (url: string) => SocketLike;
  now?: () => number;
  waits?: number[];
}

/** `claim`: the peer whose handshake took this offer; another phone is told nope while that peer is open. */
interface Offer { id: string; secret: Uint8Array; tokenHash: string; botIds: string[]; expiresAt: number; used: boolean; claim?: Peer }
interface Peer {
  id: string; tokenHash: string; stage: 'new' | 'keys' | 'ready' | 'closed';
  channel?: Channel; mode?: 'pair' | 'session'; offer?: Offer; devicePublicKey?: string; deviceId?: string;
  inbox: Promise<unknown>; outbox: Promise<unknown>; timer?: ReturnType<typeof setTimeout>; notice?: ReturnType<typeof setTimeout>; count: number;
}

/** The peer was closed (forgotten) while an await was pending: a step resuming on it does nothing. */
const gone = (peer: Peer) => peer.stage === 'closed';

export class RelayConnector {
  private socket: SocketLike | null = null;
  private state: RelayState = 'off';
  private room: string | null = null;
  private peers = new Map<string, Peer>();
  private offers = new Map<string, Offer>();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private stopListening: (() => void) | undefined;
  private stopped = false;
  private readonly now: () => number;

  constructor(private options: ConnectorOptions) {
    this.now = options.now ?? Date.now;
  }

  view(): RelayView { return { url: this.options.store.url(), state: this.state }; }

  /** Connects when the relay is on; call again after the address changed. */
  start() {
    this.stopped = false;
    this.stopListening ??= this.options.core.onChange?.(change => this.changed(change.botId));
    this.reconnect();
  }
  stop() {
    this.stopped = true;
    this.stopListening?.(); this.stopListening = undefined;
    this.disconnect('off');
  }

  async setURL(url: string | null): Promise<RelayView> {
    await this.options.store.setURL(url);
    this.offers.clear();
    if (!this.stopped) this.reconnect();
    return this.view();
  }

  /** A one-time pairing link (shown as a QR code) for these bots; by default every bot (`*`, bots added later too).
   * The secret is returned once and kept only in memory. */
  async pair(botIds: string[] = [ALL_BOTS]): Promise<{ url: string; expiresAt: number }> {
    const url = this.options.store.url(), settings = this.options.store.settings();
    if (!url || !settings) throw new Error('Turn the relay on first.');
    if (this.state !== 'online' || !this.room) throw new Error('Botling is not connected to the relay yet. Check the address and try again.');
    this.expireOffers();
    if ([...this.offers.values()].filter(o => !o.used).length >= MAX_OFFERS) throw new Error('Too many pending pairing codes; wait for them to expire.');
    const secret = new Uint8Array(randomBytes(32));
    const offer: Offer = { id: await offerIdOf(secret), secret, tokenHash: sha(await pairTokenOf(secret)), botIds: botIds.includes(ALL_BOTS) ? [ALL_BOTS] : [...botIds], expiresAt: this.now() + RELAY_PAIR_TTL_MS, used: false };
    this.offers.set(offer.id, offer);
    this.pushAllow();
    return { url: relayPairingURL(relayPage(url), { room: this.room, deskKey: settings.publicKey, secret: b64u.encode(secret) }), expiresAt: offer.expiresAt };
  }

  devices(): RelayDevice[] { return this.options.store.devices(); }

  /** Ends a phone's access now: an open channel is told and closed, then its token leaves the relay's allow list. */
  async revoke(deviceId: string): Promise<boolean> {
    const removed = this.options.store.revoke(deviceId);
    await Promise.all([...this.peers.values()].filter(peer => peer.deviceId === deviceId).map(peer => this.end(peer, true)));
    this.pushAllow();
    return removed;
  }

  // ---- The relay connection.

  private reconnect() {
    this.disconnect(this.options.store.url() ? 'connecting' : 'off');
    if (this.state === 'off' || this.stopped) return;
    this.connect();
  }

  private connect() {
    const url = this.options.store.url();
    const settings = this.options.store.settings();
    if (!url || !settings || this.stopped) { this.state = 'off'; return; }
    this.state = 'connecting';
    let socket: SocketLike;
    try { socket = (this.options.socket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(url); }
    catch { this.scheduleRetry(); return; }
    this.socket = socket;
    socket.onopen = () => { if (this.socket === socket) socket.send(JSON.stringify({ t: 'desk', v: 1, key: settings.roomKey })); };
    socket.onmessage = event => { if (this.socket === socket && typeof event.data === 'string') this.fromRelay(event.data); };
    socket.onerror = () => { /* onclose follows */ };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null; this.room = null;
      this.dropPeers();
      // Another copy of this desktop took the room (a core hand-over runs two for a moment): back off the longest wait.
      if ((event as { code?: number } | null)?.code === 4401) this.failures = Number.MAX_SAFE_INTEGER;
      this.state = this.options.store.url() && !this.stopped ? 'offline' : 'off';
      if (this.state === 'offline') this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    clearTimeout(this.retry);
    this.state = 'offline';
    const waits = this.options.waits ?? WAITS;
    this.retry = setTimeout(() => { this.retry = undefined; if (!this.stopped) this.connect(); }, waits[Math.min(this.failures++, waits.length - 1)]);
    this.retry.unref?.();
  }

  private disconnect(next: RelayState) {
    clearTimeout(this.retry); this.retry = undefined;
    const socket = this.socket;
    this.socket = null; this.room = null;
    this.dropPeers();
    if (socket) try { socket.close(1000, 'bye'); } catch { /* gone */ }
    this.state = next;
  }

  private send(msg: unknown) {
    const socket = this.socket;
    if (socket && socket.readyState === 1) try { socket.send(JSON.stringify(msg)); } catch { /* onclose follows */ }
  }

  private pushAllow() {
    if (!this.room) return;
    this.expireOffers();
    const tokens = [...this.options.store.devices().map(d => ({ h: d.tokenHash })),
      ...[...this.offers.values()].map(o => ({ h: o.tokenHash, exp: o.expiresAt }))];
    this.send({ t: 'allow', tokens });
  }

  private expireOffers() { const now = this.now(); for (const [id, offer] of this.offers) if (offer.expiresAt <= now) this.offers.delete(id); }

  private fromRelay(text: string) {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg?.t) {
      case 'ready':
        if (typeof msg.room !== 'string') return;
        this.room = msg.room; this.state = 'online'; this.failures = 0;
        this.pushAllow();
        return;
      case 'open': {
        if (typeof msg.peer !== 'string' || typeof msg.h !== 'string') return;
        const peer: Peer = { id: msg.peer, tokenHash: msg.h, stage: 'new', inbox: Promise.resolve(), outbox: Promise.resolve(), count: 0 };
        peer.timer = setTimeout(() => { if (peer.stage !== 'ready') this.end(peer); }, HANDSHAKE_MS);
        peer.timer.unref?.();
        this.peers.set(peer.id, peer);
        return;
      }
      case 'from': {
        const peer = this.peers.get(msg.peer);
        if (!peer || typeof msg.d !== 'string') return;
        // One frame at a time per phone, in arrival order.
        peer.inbox = peer.inbox.then(() => this.fromPhone(peer, msg.d)).catch(() => this.end(peer));
        return;
      }
      case 'close': {
        const peer = this.peers.get(msg.peer);
        if (peer) this.forget(peer);
        return;
      }
    }
  }

  // ---- One phone.

  private async fromPhone(peer: Peer, d: string) {
    if (peer.stage === 'closed') return;
    if (peer.stage === 'new') return this.handshake(peer, d);
    const msg = PhoneMessage.parse(await peer.channel!.open(d));
    // Closed while the frame was opened (the phone left, a revoke): nothing more for it, and no code spent on it.
    if (gone(peer)) return;
    if (peer.stage === 'keys') return this.confirm(peer, msg);
    if (msg.t !== 'req') throw new Error('Unexpected message.');
    const device = this.options.store.device(peer.deviceId!);
    if (!device || device.tokenHash !== peer.tokenHash && peer.mode === 'session') return void this.end(peer, true);
    const response = await this.request(device, msg.id, msg.cmd);
    let frame = await peer.channel!.seal({ t: 'res', env: response });
    if (frame.length > MAX_FRAME_CHARS) frame = await peer.channel!.seal({ t: 'res', env: errorResponse(msg.id, { code: 'internal', message: 'This answer is too large for the relay. Open it on the desktop.' }) });
    this.toPeer(peer, frame);
  }

  private async handshake(peer: Peer, d: string) {
    const hello = PhoneHandshake.parse(JSON.parse(d));
    const nope = (reason: 'offer' | 'device') => { this.send({ t: 'to', peer: peer.id, d: JSON.stringify({ h: 'nope', v: 1, reason }) }); this.end(peer); };
    const room = this.room!;
    const identity = await this.options.store.keyPair();
    const ephemeral = await generateKeyPair();
    if (gone(peer)) return;
    let deviceId: string, phoneStatic: Uint8Array, pairSecret: Uint8Array | undefined;
    if (hello.h === 'pair') {
      this.expireOffers();
      const offer = this.offers.get(hello.offer);
      // The relay admitted this phone with the offer's own token, and the offer is still unused and not taken by
      // another open handshake (that phone would win at confirm and this one would only see its socket close).
      if (!offer || offer.used || offer.tokenHash !== peer.tokenHash || (offer.claim && offer.claim !== peer && offer.claim.stage !== 'closed')) return nope('offer');
      offer.claim = peer;
      phoneStatic = b64u.decode(hello.device);
      deviceId = await deviceIdOf(phoneStatic);
      pairSecret = offer.secret;
      peer.offer = offer; peer.devicePublicKey = hello.device;
    } else {
      const device = this.options.store.device(hello.device);
      // A phone's token and key belong together: the relay admitted this token, the handshake proves this key.
      if (!device || device.tokenHash !== peer.tokenHash) return nope('device');
      phoneStatic = b64u.decode(device.publicKey);
      deviceId = device.id;
    }
    peer.channel = await deriveChannel('desk', { static: identity, ephemeral }, { mode: hello.h === 'pair' ? 'pair' : 'session', room, deviceId,
      deskStatic: identity.publicKey, phoneStatic, phoneEphemeral: b64u.decode(hello.eph), deskEphemeral: ephemeral.publicKey, pairSecret });
    if (gone(peer)) return;
    peer.mode = hello.h === 'pair' ? 'pair' : 'session';
    peer.deviceId = deviceId;
    peer.stage = 'keys';
    this.send({ t: 'to', peer: peer.id, d: JSON.stringify({ h: 'ack', v: 1, eph: b64u.encode(ephemeral.publicKey) }) });
  }

  /** The phone's first encrypted message proves it holds the keys (and, pairing, the QR secret). */
  private async confirm(peer: Peer, msg: PhoneMessage) {
    const coreId = this.options.coreId();
    if (peer.mode === 'pair') {
      const offer = peer.offer!;
      if (msg.t !== 'pair' || offer.used || offer.expiresAt <= this.now()) return this.end(peer);
      offer.used = true; // single use; its relay token stays listed until it expires, so this connection carries on
      const token = randomBytes(32).toString('base64url');
      const now = this.now();
      const device: RelayDevice = { id: peer.deviceId!, publicKey: peer.devicePublicKey!, tokenHash: sha(token), botIds: offer.botIds,
        pairedAt: now, expiresAt: now + PAIRED_TTL_MS, ...(label(msg.name) ? { label: label(msg.name) } : {}) };
      this.options.store.add(device);
      peer.stage = 'ready'; clearTimeout(peer.timer);
      this.toPeer(peer, await peer.channel!.seal({ t: 'paired', deviceId: device.id, token, coreId, botIds: device.botIds, expiresAt: device.expiresAt }));
      this.pushAllow();
      return;
    }
    if (msg.t !== 'hello') return this.end(peer);
    const device = this.options.store.device(peer.deviceId!);
    if (!device) return this.end(peer, true);
    peer.stage = 'ready'; clearTimeout(peer.timer);
    this.toPeer(peer, await peer.channel!.seal({ t: 'ready', coreId, botIds: device.botIds, expiresAt: device.expiresAt }));
  }

  /** The bridge's checks (bridge.ts) for one command, then the same core call and journal. */
  private async request(device: RelayDevice, id: string, cmd: unknown): Promise<ResponseEnvelope> {
    const parsed = RequestEnvelope.safeParse({ v: PROTOCOL_VERSION, id, cmd });
    if (!parsed.success) return errorResponse(id, { code: 'bad_request', message: 'Invalid mobile request.' });
    const request = parsed.data, command = request.cmd;
    const botId = 'botId' in command && typeof command.botId === 'string' ? command.botId : undefined;
    if (!RELAY_COMMANDS.has(command.type) || (botId === undefined && command.type !== 'chat.snapshot')
      || (botId !== undefined && !botAllowed(device.botIds, botId)) || (botId === undefined && !device.botIds.length)
      || (command.type === 'chat.answer' && command.images?.length))
      return errorResponse(id, { code: 'forbidden', message: 'Command or bot not authorized.' });
    // A snapshot without a bot reads Main (the core's default) when the phone may, else the first bot it may use.
    const routed = command.type === 'chat.snapshot' && botId === undefined && !botAllowed(device.botIds, MAIN_BOT_ID)
      ? { ...request, cmd: { ...command, botId: device.botIds[0] } } : request;
    const dispatch = () => this.options.core.mobileCommand(routed, device.botIds);
    try { return READ_COMMANDS.has(command.type) ? await dispatch() : await this.options.ledger().run(`relay-${device.id}`, request, dispatch); }
    catch { return errorResponse(id, { code: 'core_unavailable', message: 'Mobile bridge unavailable. Check chat before sending again.' }); }
  }

  private changed(botId: string | undefined) {
    for (const peer of this.peers.values()) {
      if (peer.stage !== 'ready' || peer.notice) continue;
      const device = this.options.store.device(peer.deviceId!);
      if (!device) { void this.end(peer, true); continue; }
      if (botId !== undefined && !botAllowed(device.botIds, botId)) continue;
      peer.notice = setTimeout(() => {
        peer.notice = undefined;
        if (peer.stage === 'ready') void peer.channel!.seal({ t: 'changed', n: ++peer.count }).then(frame => this.toPeer(peer, frame), () => this.end(peer));
      }, NOTICE_MS);
    }
  }

  private toPeer(peer: Peer, frame: string) { if (peer.stage !== 'closed') this.send({ t: 'to', peer: peer.id, d: frame }); }

  /** Closes one phone's channel (telling it first when its access was revoked) and asks the relay to drop it. */
  private async end(peer: Peer, revoked = false): Promise<void> {
    if (peer.stage === 'closed') return;
    const channel = peer.channel;
    if (revoked && peer.stage === 'ready' && channel) {
      this.forget(peer, false);
      const kick = () => { channel.close(); this.send({ t: 'kick', peer: peer.id }); };
      await channel.seal({ t: 'revoked' }).then(frame => { this.send({ t: 'to', peer: peer.id, d: frame }); kick(); }, kick);
      return;
    }
    this.send({ t: 'kick', peer: peer.id });
    this.forget(peer);
  }
  private forget(peer: Peer, closeChannel = true) {
    peer.stage = 'closed';
    clearTimeout(peer.timer); clearTimeout(peer.notice);
    if (closeChannel) peer.channel?.close();
    this.peers.delete(peer.id);
  }
  private dropPeers() { for (const peer of [...this.peers.values()]) this.forget(peer); }
}
