// The phone ↔ desktop protocol that rides inside the relay's opaque `d` strings. Shared by the desktop core and the
// phone web app. The relay never sees any of this in the clear except the two handshake messages, which carry only
// public keys and ids (no secret, no chat).
//
// Handshake (clear JSON):
//   phone → desk  {h:'pair', v:1, offer, device:<static pub>, eph}      first contact, from the QR code
//                 {h:'hello', v:1, device:<device id>, eph}            every later connection
//   desk → phone  {h:'ack', v:1, eph}                                  then only encrypted frames follow
//                 {h:'nope', v:1, reason}                              unknown/expired offer, unknown/revoked phone
// Encrypted (e2e.ts Channel frames), the first message each way confirms the keys:
//   phone → desk  {t:'pair', name} | {t:'hello'}; then {t:'req', id, cmd}
//   desk → phone  {t:'paired', deviceId, token, coreId, botIds, expiresAt} | {t:'ready', coreId, botIds, expiresAt};
//                 then {t:'res', env} (a ResponseEnvelope), {t:'changed', n} (something changed: read again), {t:'revoked'}
import { z } from 'zod';

export const RELAY_PROTOCOL = 1;
const B64U = /^[A-Za-z0-9_-]+$/;
const key = z.string().length(43).regex(B64U);

export const PhoneHandshake = z.discriminatedUnion('h', [
  z.strictObject({ h: z.literal('pair'), v: z.literal(1), offer: z.string().length(22).regex(B64U), device: key, eph: key }),
  z.strictObject({ h: z.literal('hello'), v: z.literal(1), device: z.string().length(22).regex(B64U), eph: key }),
]);
export type PhoneHandshake = z.infer<typeof PhoneHandshake>;
export const DeskHandshake = z.discriminatedUnion('h', [
  z.strictObject({ h: z.literal('ack'), v: z.literal(1), eph: key }),
  z.strictObject({ h: z.literal('nope'), v: z.literal(1), reason: z.enum(['offer', 'device', 'busy']) }),
]);
export type DeskHandshake = z.infer<typeof DeskHandshake>;

/** Commands a phone may send through the relay: the bridge's own (bridge.ts mobileTypes) plus stopping a turn. */
export const RELAY_COMMANDS: ReadonlySet<string> = new Set(['chat.snapshot', 'chat.history', 'chat.send', 'chat.choose', 'chat.answer', 'turn.stop']);
export const READ_COMMANDS: ReadonlySet<string> = new Set(['chat.snapshot', 'chat.history']);

export const PhoneMessage = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('pair'), name: z.string().max(40).optional() }),
  z.strictObject({ t: z.literal('hello') }),
  z.strictObject({ t: z.literal('req'), id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/), cmd: z.unknown() }),
]);
export type PhoneMessage = z.infer<typeof PhoneMessage>;
export const Grant = z.strictObject({ coreId: z.string().max(64), botIds: z.array(z.string().max(64)).max(200), expiresAt: z.number() });
export const DeskMessage = z.discriminatedUnion('t', [
  Grant.extend({ t: z.literal('paired'), deviceId: z.string().length(22), token: z.string().length(43).regex(B64U) }),
  Grant.extend({ t: z.literal('ready') }),
  z.strictObject({ t: z.literal('res'), env: z.unknown() }),
  z.strictObject({ t: z.literal('changed'), n: z.number().int() }),
  z.strictObject({ t: z.literal('revoked') }),
]);
export type DeskMessage = z.infer<typeof DeskMessage>;

/** The QR code's link: the relay's page plus, in the fragment (never sent to any server), the room, the desktop's
 * public key and the one-time pairing secret. `w` is the relay's WebSocket when it is not this page's own /ws. */
export interface RelayLink { room: string; deskKey: string; secret: string; ws?: string }
export const relayPairingURL = (page: string, link: RelayLink) =>
  `${page}#relay=${link.room}&k=${link.deskKey}&s=${link.secret}${link.ws ? `&w=${encodeURIComponent(link.ws)}` : ''}`;
export function parseRelayFragment(hash: string): RelayLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const room = params.get('relay') ?? '', deskKey = params.get('k') ?? '', secret = params.get('s') ?? '', ws = params.get('w') ?? undefined;
  const ok = [room, deskKey, secret].every(v => v.length === 43 && B64U.test(v));
  if (!ok) return null;
  if (ws !== undefined) {
    try { const url = new URL(ws); if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null; }
    catch { return null; }
  }
  return { room, deskKey, secret, ...(ws ? { ws } : {}) };
}
