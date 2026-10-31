import { describe, it, expect, vi } from 'vitest';
import { RouteBook, loadRouteBook } from './routes';
import { MobileTransport } from './transport';
import { PROTOCOL_VERSION } from '../src/contract';

const CORE = 'a'.repeat(32), OTHER = 'b'.repeat(32), TOKEN = 'K'.repeat(43);
const A = 'https://a.example', B = 'https://b.example', C = 'https://c.example';
const list = [{ kind: 'lan', origin: A }, { kind: 'tailscale', origin: B }, { kind: 'tunnel', origin: C }];
const snapshot = { epoch: 'e', seq: 1, bots: [], chat: null };
/** A little network: which origins answer the public descriptor (and as which core), and which accept commands. */
function network(descriptor: Record<string, string | 'down'>, commands: Record<string, 'ok' | 'down'>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetcher = vi.fn(async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, auth: init.headers?.Authorization ?? null });
    if (u.pathname === '/api/mobile/core') {
      const id = descriptor[u.origin];
      if (!id || id === 'down') throw new TypeError('network');
      return new Response(JSON.stringify({ app: 'botling', coreId: id, protocol: 10, routes: list, pairing: { ttlSeconds: 300 } }));
    }
    if (commands[u.origin] !== 'ok') throw new TypeError('network');
    return new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: JSON.parse(init.body).id, ok: true, result: snapshot }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const book = (current = A) => new RouteBook(CORE, list.map(r => ({ ...r })) as any, current);

describe('route book', () => {
  it('pins the core id and the routes the core itself listed, including the page origin', async () => {
    const net = network({ [A]: CORE }, {});
    const made = await loadRouteBook(A, undefined, net.fetcher);
    expect(made?.coreId).toBe(CORE);
    expect(made?.origin).toBe(A);
    expect(made?.allowed(B)).toBe(true);
    expect(made?.allowed('https://evil.example')).toBe(false);
    // A pairing link names the core: a different core on this origin is refused.
    expect(await loadRouteBook(A, OTHER, net.fetcher)).toBeNull();
    expect(await loadRouteBook(B, undefined, net.fetcher)).toBeNull(); // unreachable
  });
  it('adds the page origin when the descriptor omits it, and works with no routes at all', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ app: 'botling', coreId: CORE, routes: [] }))) as unknown as typeof fetch;
    const made = await loadRouteBook('https://solo.example', undefined, fetcher);
    expect(made?.allowed('https://solo.example')).toBe(true);
  });
  it('moves only to a route that answers as the same core, and never to a stranger', async () => {
    const b = book(A);
    expect(await b.recover(network({ [A]: 'down', [B]: OTHER, [C]: CORE }, {}).fetcher)).toBe(C);
    expect(b.origin).toBe(C);
    const c = book(A);
    expect(await c.recover(network({ [A]: 'down', [B]: OTHER, [C]: OTHER }, {}).fetcher)).toBeNull();
    expect(c.origin).toBe(A); // stays put
  });
});

describe('transport across routes', () => {
  const make = (net: ReturnType<typeof network>, from = A) => new MobileTransport(new URL('/api/mobile/command', from), TOKEN, net.fetcher, book(from));
  it('retries a read on the next verified route, and never sends the token before that route proved its identity', async () => {
    const net = network({ [A]: 'down', [B]: CORE, [C]: CORE }, { [A]: 'down', [B]: 'ok', [C]: 'ok' });
    const t = make(net);
    expect((await t.snapshot()).epoch).toBe('e');
    expect(t.origin).toBe(B);
    const withToken = net.calls.filter(c => c.auth);
    expect(withToken.map(c => new URL(c.url).origin)).toEqual([A, B]); // A failed on the network; B proved itself first
    const firstBToken = net.calls.findIndex(c => c.auth && new URL(c.url).origin === B);
    const probeB = net.calls.findIndex(c => !c.auth && c.url === `${B}/api/mobile/core`);
    expect(probeB).toBeGreaterThanOrEqual(0); expect(probeB).toBeLessThan(firstBToken);
    for (const c of net.calls.filter(c => c.url.includes('/api/mobile/core'))) expect(c.auth).toBeNull();
  });
  it('never gives the token to a host that answers as another core', async () => {
    const net = network({ [A]: 'down', [B]: OTHER, [C]: OTHER }, { [A]: 'down', [B]: 'ok', [C]: 'ok' });
    const t = make(net);
    await expect(t.snapshot()).rejects.toMatchObject({ auth: false });
    expect(net.calls.filter(c => c.auth).map(c => new URL(c.url).origin)).toEqual([A]);
    expect(t.origin).toBe(A);
  });
  it('switches after a failed send but does not repeat it: the delivery is reported unconfirmed', async () => {
    const net = network({ [A]: 'down', [B]: CORE }, { [A]: 'down', [B]: 'ok' });
    const t = make(net);
    await expect(t.request({ type: 'chat.send', botId: 'main', text: 'hi' } as any)).rejects.toMatchObject({ uncertain: true });
    expect(net.calls.filter(c => c.auth).map(c => new URL(c.url).origin)).toEqual([A]);
    expect(t.origin).toBe(B);
    expect((await t.snapshot()).epoch).toBe('e'); // the next read uses the new route
  });
  it('does not look for another route when the server answered (even with an error)', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const t = new MobileTransport(new URL('/api/mobile/command', A), TOKEN, fetcher, book());
    await expect(t.snapshot()).rejects.toThrow(/HTTP 500/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('is unchanged without a route book', async () => {
    const net = network({}, { [A]: 'down' });
    const t = new MobileTransport(new URL('/api/mobile/command', A), TOKEN, net.fetcher);
    await expect(t.snapshot()).rejects.toThrow(/Could not refresh/);
    expect(net.calls).toHaveLength(1);
  });
});
