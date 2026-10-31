import { describe, it, expect, vi } from 'vitest';
import { cleanRoutes, pickRoute } from './routes';
import { betterRoute, deviceName } from './pair';

const CORE = 'a'.repeat(32), SECRET = 'S'.repeat(43);
const A = 'https://a.example', B = 'https://b.example', C = 'https://c.example';
const answer = (reachable: Record<string, string | 'down'>, routes: unknown) => vi.fn(async (url: any) => {
  const origin = new URL(String(url)).origin;
  if (new URL(String(url)).pathname !== '/api/mobile/core') throw new Error('unexpected path');
  const coreId = reachable[origin];
  if (!coreId || coreId === 'down') throw new TypeError('network');
  return new Response(JSON.stringify({ app: 'botling', coreId, protocol: 10, routes, pairing: { ttlSeconds: 300 } }));
}) as unknown as typeof fetch;
const list = [{ kind: 'lan', origin: A }, { kind: 'tailscale', origin: B }, { kind: 'tunnel', origin: C }];

describe('route list', () => {
  it('keeps only well-formed https origins, once each, at most six', () => {
    expect(cleanRoutes([{ kind: 'lan', origin: A }, { kind: 'lan', origin: A }, { kind: 'x', origin: B }, { kind: 'tunnel', origin: 'http://evil.example' },
      { kind: 'tunnel', origin: 'https://c.example/path' }, { kind: 'tunnel', origin: 'http://localhost:1' }, 'junk', null])).toEqual([{ kind: 'lan', origin: A }, { kind: 'tunnel', origin: 'http://localhost:1' }]);
    expect(cleanRoutes('no')).toEqual([]);
    expect(cleanRoutes(Array.from({ length: 9 }, (_, i) => ({ kind: 'lan', origin: `https://h${i}.example` })))).toHaveLength(6);
  });
  it('picks the first route in order that answers as this core, and never one that is another core', async () => {
    expect(await pickRoute(cleanRoutes(list), CORE, answer({ [A]: 'down', [B]: CORE, [C]: CORE }, list))).toBe(B);
    expect(await pickRoute(cleanRoutes(list), CORE, answer({ [A]: 'b'.repeat(32), [B]: 'down', [C]: CORE }, list))).toBe(C);
    expect(await pickRoute(cleanRoutes(list), CORE, answer({ [A]: 'down', [B]: 'down', [C]: 'down' }, list))).toBeNull();
    expect(await pickRoute([], CORE)).toBeNull();
  });
  it('gives up on a silent route after the probe timeout and probes without credentials or custom headers', async () => {
    const seen: any[] = [];
    const fetcher = vi.fn((url: any, init: any) => { seen.push(init); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))); }) as unknown as typeof fetch;
    expect(await pickRoute(cleanRoutes(list.slice(0, 1)), CORE, fetcher, 20)).toBeNull();
    expect(seen[0]).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(seen[0].headers).toBeUndefined();
  });
});

describe('pairing link on a slower route', () => {
  const link = { secret: SECRET, coreId: CORE };
  it('moves to an earlier reachable route of the same core, once, keeping the secret in the fragment', async () => {
    const fetcher = answer({ [A]: CORE, [B]: CORE, [C]: CORE }, list);
    expect(await betterRoute(link, C, fetcher)).toBe(`${A}/mobile/#pair=${SECRET}&core=${CORE}&hop=1`);
    expect(await betterRoute({ ...link, hopped: true }, C, fetcher)).toBeNull();
    expect(await betterRoute(link, A, fetcher)).toBeNull();
  });
  it('stays when nothing earlier answers, or the page is on an unlisted origin, or the core is another one', async () => {
    expect(await betterRoute(link, C, answer({ [A]: 'down', [B]: 'down', [C]: CORE }, list))).toBeNull();
    expect(await betterRoute(link, 'https://other.example', answer({ [A]: CORE, 'https://other.example': CORE }, list))).toBe(`${A}/mobile/#pair=${SECRET}&core=${CORE}&hop=1`);
    expect(await betterRoute(link, C, answer({ [A]: CORE, [C]: 'b'.repeat(32) }, list))).toBeNull();
  });
  it('names the device from the browser, short and without detail', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('iPhone');
    expect(deviceName('Mozilla/5.0 (Linux; Android 14)')).toBe('Android');
    expect(deviceName('curl/8')).toBe('Browser');
  });
});
