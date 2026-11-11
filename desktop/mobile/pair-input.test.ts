import { describe, expect, it } from 'vitest';
import { readPairingInput } from './pair-input';

const KEY = 'a'.repeat(43), SECRET = 'S'.repeat(43), CORE = 'c'.repeat(32), ORIGIN = 'https://relay.example.com';
const relay = `${ORIGIN}/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}&v=2`;

describe('readPairingInput', () => {
  it('reads a relay pairing link for this address, also inside surrounding text', () => {
    expect(readPairingInput(relay, ORIGIN)).toEqual({ kind: 'relay', link: { room: KEY, deskKey: KEY, secret: KEY, v: 2 } });
    expect(readPairingInput(`Open this:\n${relay}\nthanks`, ORIGIN)).toMatchObject({ kind: 'relay' });
    expect(readPairingInput(`#relay=${KEY}&k=${KEY}&s=${KEY}`, ORIGIN)).toMatchObject({ kind: 'relay' });
  });
  it('reads a bridge pairing link', () => {
    expect(readPairingInput(`${ORIGIN}/mobile/#pair=${SECRET}&core=${CORE}`, ORIGIN)).toEqual({ kind: 'bridge', link: { secret: SECRET, coreId: CORE } });
  });
  it('a pairing link for another address is opened there, never paired from here', () => {
    expect(readPairingInput(`https://other.example.com/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}`, ORIGIN)).toEqual({ kind: 'elsewhere', url: `https://other.example.com/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}` });
  });
  it('takes an access token as it was', () => {
    expect(readPairingInput(`  ${'t'.repeat(43)} `, ORIGIN)).toEqual({ kind: 'token', token: 't'.repeat(43) });
  });
  it('refuses anything else: no code, a short or broken code, plain http, other schemes', () => {
    for (const text of ['', '   ', 'short', `${ORIGIN}/mobile/`, `${ORIGIN}/mobile/#relay=${KEY}&k=short&s=${KEY}`,
      `http://relay.example.com/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}`, `javascript:alert(1)//#relay=${KEY}&k=${KEY}&s=${KEY}`, `${ORIGIN}/mobile/#pair=${SECRET}`])
      expect(readPairingInput(text, ORIGIN)).toEqual({ kind: 'invalid' });
  });
  it('allows plain http only on this machine (development)', () => {
    expect(readPairingInput(`http://127.0.0.1:8080/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}`, 'http://127.0.0.1:8080')).toMatchObject({ kind: 'relay' });
  });
});
