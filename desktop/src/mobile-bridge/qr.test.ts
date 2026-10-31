import { describe, it, expect } from 'vitest';
import { qrEncode, qrPath, QR_MAX_BYTES } from './qr';
import { pairingURL } from './pairing';

describe('qr encoder', () => {
  const link = pairingURL('https://botling-bridge.driseam.com', 'a'.repeat(32), 'S'.repeat(43));
  it('makes a square code with three finder patterns, a timing line, and the size its version says', () => {
    const m = qrEncode(link);
    expect((m.length - 17) % 4).toBe(0);
    expect(m.length).toBeGreaterThanOrEqual(45); // a 130-byte link needs version 7 or more at level M
    expect(m.every(row => row.length === m.length)).toBe(true);
    const finder = (x: number, y: number) => [0, 6].every(i => m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]) && !m[y + 1][x + 1] && m[y + 3][x + 3];
    expect(finder(0, 0) && finder(m.length - 7, 0) && finder(0, m.length - 7)).toBe(true);
    for (let i = 8; i < m.length - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
    expect(m[m.length - 8][8]).toBe(true); // the always-dark module
  });
  it('is deterministic, differs with the text, and rejects text that does not fit', () => {
    expect(qrEncode(link)).toEqual(qrEncode(link));
    expect(qrEncode(link)).not.toEqual(qrEncode(link.replace('S', 'T')));
    expect(qrEncode('x'.repeat(QR_MAX_BYTES))).toBeTruthy();
    expect(() => qrEncode('x'.repeat(QR_MAX_BYTES + 1))).toThrow();
    expect(qrEncode('hi').length).toBe(21); // version 1
  });
  it('renders path data inside its view box', () => {
    const { d, size } = qrPath(qrEncode('hi'));
    expect(size).toBe(29);
    expect(d.startsWith('M')).toBe(true);
    for (const [, x, y] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) { expect(+x).toBeGreaterThanOrEqual(4); expect(+y).toBeLessThan(size - 4); }
  });
});
