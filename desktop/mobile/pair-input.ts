// What the sign-in page was given, typed, pasted or scanned: a relay pairing link, a bridge pairing link, or an
// access token. A pairing link is the same one-time, expiring secret the QR code carries (pasting it is scanning it),
// so it pairs only with the Botling that showed it, once, within its minutes. The secret stays in the caller.
import { parseRelayFragment, type RelayLink } from '../src/mobile-relay/protocol';
import { parsePairingFragment, type PairingLink } from './pair';

export type PairingInput =
  | { kind: 'relay'; link: RelayLink }
  | { kind: 'bridge'; link: PairingLink }
  | { kind: 'token'; token: string }
  /** A pairing link for another address: the page there pairs it (this page may talk only to its own origin). */
  | { kind: 'elsewhere'; url: string }
  | { kind: 'invalid' };

const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

export function readPairingInput(text: string, origin: string): PairingInput {
  // Pasted from a message or a note: the link may come with words or line breaks around it.
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'invalid' };
  const found = /https?:\/\/[^\s<>"']+/i.exec(trimmed)?.[0] ?? (trimmed.startsWith('#') ? trimmed : null);
  if (found) {
    let url: URL;
    try { url = new URL(found, origin); } catch { return { kind: 'invalid' }; }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return { kind: 'invalid' };
    const relay = parseRelayFragment(url.hash), bridge = relay ? null : parsePairingFragment(url.hash);
    if (!relay && !bridge) return { kind: 'invalid' };
    if (url.origin !== new URL(origin).origin) return { kind: 'elsewhere', url: url.href };
    return relay ? { kind: 'relay', link: relay } : { kind: 'bridge', link: bridge! };
  }
  return TOKEN.test(trimmed) ? { kind: 'token', token: trimmed } : { kind: 'invalid' };
}
