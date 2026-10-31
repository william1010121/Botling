import { describe, it, expect, vi } from 'vitest';
import { parsePairingFragment, redeemPairing } from './pair';

const SECRET = 'S'.repeat(43), DEVICE = 'd'.repeat(22);
describe('pairing fragment', () => {
  it('reads the secret and core id, and rejects anything malformed', () => {
    expect(parsePairingFragment(`#pair=${SECRET}&core=${'a'.repeat(32)}`)).toEqual({ secret: SECRET, coreId: 'a'.repeat(32) });
    expect(parsePairingFragment('')).toBeNull();
    expect(parsePairingFragment('#pair=short&core=' + 'a'.repeat(32))).toBeNull();
    expect(parsePairingFragment(`#pair=${SECRET}`)).toBeNull();
  });
});
describe('redeemPairing', () => {
  const core = 'a'.repeat(32);
  it('checks the core id before sending the secret, then returns the token', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: any, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(url), 'https://h.example').pathname}`);
      if (String(url).endsWith('/core')) return new Response(JSON.stringify({ app: 'botling', coreId: core, protocol: 10, pairing: { ttlSeconds: 300 } }));
      expect(JSON.parse(init.body)).toEqual({ secret: SECRET, deviceId: DEVICE });
      expect(init.credentials).toBe('omit');
      return new Response(JSON.stringify({ token: 'T'.repeat(43), expiresAt: 5, coreId: core }));
    }) as unknown as typeof fetch;
    expect(await redeemPairing({ secret: SECRET, coreId: core }, DEVICE, 'https://h.example', fetcher)).toBe('T'.repeat(43));
    expect(calls).toEqual(['GET /api/mobile/core', 'POST /api/mobile/pair']);
  });
  it('never sends the secret to a different core', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ app: 'botling', coreId: 'b'.repeat(32), protocol: 10, pairing: { ttlSeconds: 300 } }))) as unknown as typeof fetch;
    await expect(redeemPairing({ secret: SECRET, coreId: core }, DEVICE, 'https://h.example', fetcher)).rejects.toThrow(/different Botling/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('explains an expired or used code and a rate limit without echoing the secret', async () => {
    const make = (status: number) => vi.fn(async (url: any) => String(url).endsWith('/core')
      ? new Response(JSON.stringify({ app: 'botling', coreId: core, protocol: 10, pairing: { ttlSeconds: 300 } })) : new Response('{}', { status })) as unknown as typeof fetch;
    await expect(redeemPairing({ secret: SECRET, coreId: core }, DEVICE, 'https://h.example', make(401))).rejects.toThrow(/expired or already been used/);
    await expect(redeemPairing({ secret: SECRET, coreId: core }, DEVICE, 'https://h.example', make(429))).rejects.toThrow(/Too many/);
  });
});
