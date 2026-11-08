// The relay's rooms. A desktop opens a room with a room key (the room id is that key's SHA-256, so only the key's
// holder can be the desktop of that room) and tells the relay which access tokens may join (their hashes, in
// memory only, gone when the desktop leaves). A phone joins with a token. After that the relay only moves the
// `d` strings between the desktop and that phone: end-to-end encrypted frames it cannot read and never parses,
// logs or stores. What the relay does see: room ids, token hashes, peer ids, frame sizes and timing.
//
// Wire (JSON text frames, `v: 1`):
//   desktop → relay  {t:'desk', v, key}                  open/take over the room; reply {t:'ready', room}
//                    {t:'allow', tokens:[{h, exp?}]}      replace the allow list (hex SHA-256 of tokens, optional expiry ms)
//                    {t:'to', peer, d}                    forward d to one phone
//                    {t:'kick', peer}                     close that phone
//   relay → desktop  {t:'open', peer, h} / {t:'from', peer, d} / {t:'close', peer}
//   phone → relay    {t:'join', v, room, token}           reply {t:'joined', peer} or {t:'error', code} and close
//                    {t:'d', d}                           forward to the desktop
//   relay → phone    {t:'d', d}
// Close codes: 4400 bad message, 4401 replaced, 4403 denied/revoked, 4404 desktop offline, 4408 hello timeout,
// 4413 too large, 4429 rate limited, 4503 relay full.
import { createHash, randomBytes } from 'node:crypto';
import { KeyedLimiter, TokenBucket } from './limits.ts';
import type { RelayConfig } from './config.ts';

export interface Socket {
  send(text: string): void;
  close(code: number, reason: string): void;
}
export const CLOSE = { bad: 4400, replaced: 4401, denied: 4403, offline: 4404, timeout: 4408, tooLarge: 4413, limited: 4429, full: 4503 } as const;

const B64U = /^[A-Za-z0-9_-]+$/;
const HEX64 = /^[a-f0-9]{64}$/;
const MAX_ALLOW = 1_000;
export const roomOf = (key: string) => createHash('sha256').update(Buffer.from(key, 'base64url')).digest('base64url');
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

interface Room { id: string; desk: Conn; allow: Map<string, number>; peers: Map<string, Conn> }
interface Conn {
  socket: Socket; ip: string; bucket: TokenBucket; timer: ReturnType<typeof setTimeout> | null;
  role: 'new' | 'desk' | 'phone' | 'closed'; room?: Room; peer?: string; tokenHash?: string;
}

export class Relay {
  private rooms = new Map<string, Room>();
  private conns = new Set<Conn>();
  private connects: KeyedLimiter;
  private failedJoins: KeyedLimiter;
  private readonly config: RelayConfig;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval>;

  constructor(config: RelayConfig, now: () => number = Date.now) {
    this.config = config; this.now = now;
    this.connects = new KeyedLimiter(config.connectsPerMinute, now);
    this.failedJoins = new KeyedLimiter(config.failedJoinsPerMinute, now);
    this.sweeper = setInterval(() => { this.connects.sweep(); this.failedJoins.sweep(); this.expire(); }, 30_000);
    this.sweeper.unref?.();
  }

  stats() { let peers = 0; for (const room of this.rooms.values()) peers += room.peers.size; return { connections: this.conns.size, rooms: this.rooms.size, peers }; }

  /** Whether a new connection from this address may be accepted at all (checked before the WebSocket upgrade). */
  admit(ip: string): 'ok' | 'limited' | 'full' {
    if (this.conns.size >= this.config.maxConnections) return 'full';
    return this.connects.take(ip) ? 'ok' : 'limited';
  }

  /** A connection opened; returns the handlers its socket feeds. */
  attach(socket: Socket, ip: string): { message(text: string): void; closed(): void } {
    const conn: Conn = { socket, ip, role: 'new', timer: null,
      bucket: new TokenBucket(this.config.messagesPerSecond, this.config.messageBurst, this.now) };
    conn.timer = setTimeout(() => { if (conn.role === 'new') this.close(conn, CLOSE.timeout, 'hello timeout'); }, this.config.helloTimeoutSeconds * 1000);
    conn.timer.unref?.();
    this.conns.add(conn);
    return { message: text => this.message(conn, text), closed: () => this.gone(conn) };
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const conn of [...this.conns]) this.close(conn, 1001, 'relay restarting');
  }

  private message(conn: Conn, text: string) {
    if (conn.role === 'closed') return;
    if (!conn.bucket.take()) return this.close(conn, CLOSE.limited, 'rate limited');
    let msg: any;
    try { msg = JSON.parse(text); } catch { return this.close(conn, CLOSE.bad, 'bad message'); }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.close(conn, CLOSE.bad, 'bad message');
    if (conn.role === 'new') return this.hello(conn, msg);
    if (conn.role === 'desk') return this.fromDesk(conn, msg);
    if (conn.role === 'phone') return this.fromPhone(conn, msg);
  }

  private hello(conn: Conn, msg: any) {
    if (msg.v !== 1) return this.close(conn, CLOSE.bad, 'unsupported version');
    if (msg.t === 'desk') {
      if (typeof msg.key !== 'string' || msg.key.length !== 43 || !B64U.test(msg.key)) return this.close(conn, CLOSE.bad, 'bad key');
      const id = roomOf(msg.key);
      const old = this.rooms.get(id);
      if (!old && this.rooms.size >= this.config.maxRooms) return this.close(conn, CLOSE.full, 'relay full');
      this.settle(conn, 'desk');
      const room: Room = { id, desk: conn, allow: new Map(), peers: new Map() };
      if (old) {
        // A desktop reconnecting (or a second copy of it): the newest one has the room. Phones of the old one rejoin.
        old.desk.room = undefined;
        this.close(old.desk, CLOSE.replaced, 'replaced');
        for (const peer of old.peers.values()) this.close(peer, CLOSE.offline, 'desktop reconnected');
      }
      this.rooms.set(id, room);
      conn.room = room;
      this.send(conn, { t: 'ready', room: id });
      return;
    }
    if (msg.t === 'join') {
      if (!this.failedJoins.allows(conn.ip)) return this.close(conn, CLOSE.limited, 'too many refused joins');
      const refuse = (code: number, reason: string) => { this.failedJoins.take(conn.ip); this.send(conn, { t: 'error', code: reason }); this.close(conn, code, reason); };
      if (typeof msg.room !== 'string' || msg.room.length !== 43 || !B64U.test(msg.room)
        || typeof msg.token !== 'string' || msg.token.length < 16 || msg.token.length > 200) return refuse(CLOSE.bad, 'bad_join');
      const room = this.rooms.get(msg.room);
      if (!room) return refuse(CLOSE.offline, 'desk_offline');
      const h = hashToken(msg.token);
      const exp = room.allow.get(h);
      if (exp === undefined || (exp !== 0 && exp <= this.now())) return refuse(CLOSE.denied, 'denied');
      if (room.peers.size >= this.config.maxPeersPerRoom) return refuse(CLOSE.full, 'room_full');
      this.settle(conn, 'phone');
      const peer = randomBytes(12).toString('base64url');
      conn.room = room; conn.peer = peer; conn.tokenHash = h;
      room.peers.set(peer, conn);
      this.send(room.desk, { t: 'open', peer, h });
      this.send(conn, { t: 'joined', peer });
      return;
    }
    this.close(conn, CLOSE.bad, 'hello first');
  }

  private fromDesk(conn: Conn, msg: any) {
    const room = conn.room;
    if (!room) return this.close(conn, CLOSE.replaced, 'replaced');
    switch (msg.t) {
      case 'allow': {
        if (!Array.isArray(msg.tokens) || msg.tokens.length > MAX_ALLOW) return this.close(conn, CLOSE.bad, 'bad allow list');
        const allow = new Map<string, number>();
        for (const entry of msg.tokens) {
          if (!entry || typeof entry.h !== 'string' || !HEX64.test(entry.h)) return this.close(conn, CLOSE.bad, 'bad allow list');
          const exp = entry.exp === undefined ? 0 : entry.exp;
          if (!Number.isSafeInteger(exp) || exp < 0) return this.close(conn, CLOSE.bad, 'bad allow list');
          allow.set(entry.h, exp);
        }
        room.allow = allow;
        // A token taken off the list ends its connections now (revocation does not wait for a reconnect).
        for (const peer of [...room.peers.values()]) if (!allow.has(peer.tokenHash!)) this.close(peer, CLOSE.denied, 'revoked');
        return;
      }
      case 'to': {
        if (typeof msg.d !== 'string') return this.close(conn, CLOSE.bad, 'bad frame');
        const peer = typeof msg.peer === 'string' ? room.peers.get(msg.peer) : undefined;
        if (peer) this.send(peer, { t: 'd', d: msg.d });
        else this.send(conn, { t: 'close', peer: String(msg.peer).slice(0, 32) });
        return;
      }
      case 'kick': {
        const peer = typeof msg.peer === 'string' ? room.peers.get(msg.peer) : undefined;
        if (peer) this.close(peer, CLOSE.denied, 'denied');
        return;
      }
      case 'ping': this.send(conn, { t: 'pong' }); return;
      default: this.close(conn, CLOSE.bad, 'unknown message');
    }
  }

  private fromPhone(conn: Conn, msg: any) {
    const room = conn.room;
    if (!room || this.rooms.get(room.id) !== room) return this.close(conn, CLOSE.offline, 'desk_offline');
    if (msg.t === 'd' && typeof msg.d === 'string') { this.send(room.desk, { t: 'from', peer: conn.peer, d: msg.d }); return; }
    if (msg.t === 'ping') { this.send(conn, { t: 'pong' }); return; }
    this.close(conn, CLOSE.bad, 'unknown message');
  }

  private settle(conn: Conn, role: 'desk' | 'phone') {
    conn.role = role;
    if (conn.timer) { clearTimeout(conn.timer); conn.timer = null; }
  }

  /** Allow-list entries that expired (pairing tokens) stop admitting; their open connections are left alone. */
  private expire() {
    const now = this.now();
    for (const room of this.rooms.values()) for (const [h, exp] of room.allow) if (exp !== 0 && exp <= now) room.allow.delete(h);
  }

  private send(conn: Conn, msg: unknown) {
    if (conn.role === 'closed') return;
    try { conn.socket.send(JSON.stringify(msg)); } catch { this.close(conn, 1011, 'send failed'); }
  }

  private close(conn: Conn, code: number, reason: string) {
    if (conn.role === 'closed') return;
    this.gone(conn);
    try { conn.socket.close(code, reason); } catch { /* already gone */ }
  }

  /** The connection is over (closed by either side): forget it and tell whoever cares. */
  private gone(conn: Conn) {
    if (conn.role === 'closed') return;
    const role = conn.role;
    conn.role = 'closed';
    if (conn.timer) clearTimeout(conn.timer);
    this.conns.delete(conn);
    const room = conn.room;
    if (!room) return;
    if (role === 'desk' && room.desk === conn) {
      // The desktop left: the room and its allow list are gone (nothing persists), and so are its phones' connections.
      this.rooms.delete(room.id);
      for (const peer of [...room.peers.values()]) this.close(peer, CLOSE.offline, 'desk_offline');
    } else if (role === 'phone' && conn.peer && room.peers.get(conn.peer) === conn) {
      room.peers.delete(conn.peer);
      if (this.rooms.get(room.id) === room) this.send(room.desk, { t: 'close', peer: conn.peer });
    }
  }
}
