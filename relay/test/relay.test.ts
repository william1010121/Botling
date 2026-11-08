// The relay end to end over real loopback WebSockets: rooms, allow lists, opaque forwarding, revocation, limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig, type RelayConfig } from '../src/config.ts';
import { startRelay } from '../src/server.ts';
import { TokenBucket } from '../src/limits.ts';
import { roomOf } from '../src/relay.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const config = (over: Partial<RelayConfig> = {}): RelayConfig => ({ ...loadConfig({}), host: '127.0.0.1', port: 0, ...over });

interface Client { ws: WebSocket; next(): Promise<any>; closed: Promise<{ code: number; reason: string }>; send(msg: unknown): void }
function connect(port: number, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const queue: any[] = [], waiters: ((m: any) => void)[] = [];
    ws.on('message', (data: Buffer) => { const msg = JSON.parse(data.toString()); const w = waiters.shift(); if (w) w(msg); else queue.push(msg); });
    const closed = new Promise<{ code: number; reason: string }>(done => ws.on('close', (code: number, reason: Buffer) => done({ code, reason: reason.toString() })));
    ws.on('open', () => resolve({ ws, closed, send: msg => ws.send(JSON.stringify(msg)),
      next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise(done => waiters.push(done)) }));
    ws.on('error', reject);
  });
}

async function desk(port: number) {
  const key = randomBytes(32).toString('base64url');
  const c = await connect(port);
  c.send({ t: 'desk', v: 1, key });
  const ready = await c.next();
  assert.equal(ready.t, 'ready');
  assert.equal(ready.room, roomOf(key));
  return { ...c, key, room: ready.room as string };
}

test('forwards opaque frames between a desktop and a phone holding an allowed token', async () => {
  const relay = await startRelay(config());
  try {
    const d = await desk(relay.port);
    const token = randomBytes(32).toString('base64url');
    d.send({ t: 'allow', tokens: [{ h: sha(token) }] });
    const p = await connect(relay.port);
    p.send({ t: 'join', v: 1, room: d.room, token });
    const joined = await p.next();
    assert.equal(joined.t, 'joined');
    const open = await d.next();
    assert.deepEqual(open, { t: 'open', peer: joined.peer, h: sha(token) });
    // The relay passes `d` through untouched, whatever it is: it never parses it.
    const opaque = randomBytes(300).toString('base64url') + '.{"not":"json';
    p.send({ t: 'd', d: opaque });
    assert.deepEqual(await d.next(), { t: 'from', peer: joined.peer, d: opaque });
    d.send({ t: 'to', peer: joined.peer, d: opaque });
    assert.deepEqual(await p.next(), { t: 'd', d: opaque });
    p.ws.close();
    assert.deepEqual(await d.next(), { t: 'close', peer: joined.peer });
    assert.deepEqual(relay.relay.stats(), { connections: 1, rooms: 1, peers: 0 });
  } finally { await relay.close(); }
});

test('refuses unknown tokens, missing desktops and expired pairing tokens', async () => {
  const now = Date.now();
  const relay = await startRelay(config());
  try {
    const d = await desk(relay.port);
    const pairToken = randomBytes(32).toString('base64url');
    d.send({ t: 'allow', tokens: [{ h: sha(pairToken), exp: now + 60_000 }] });
    const stranger = await connect(relay.port);
    stranger.send({ t: 'join', v: 1, room: d.room, token: randomBytes(32).toString('base64url') });
    assert.deepEqual(await stranger.next(), { t: 'error', code: 'denied' });
    assert.equal((await stranger.closed).code, 4403);
    const lost = await connect(relay.port);
    lost.send({ t: 'join', v: 1, room: roomOf(randomBytes(32).toString('base64url')), token: pairToken });
    assert.deepEqual(await lost.next(), { t: 'error', code: 'desk_offline' });
    assert.equal((await lost.closed).code, 4404);
    d.send({ t: 'allow', tokens: [{ h: sha(pairToken), exp: now - 1 }] });
    const late = await connect(relay.port);
    late.send({ t: 'join', v: 1, room: d.room, token: pairToken });
    assert.deepEqual(await late.next(), { t: 'error', code: 'denied' });
  } finally { await relay.close(); }

});

test('a token taken off the allow list (a revoked phone) is disconnected at once and cannot rejoin', async () => {
  const relay = await startRelay(config());
  try {
    const d = await desk(relay.port);
    const token = randomBytes(32).toString('base64url');
    d.send({ t: 'allow', tokens: [{ h: sha(token) }] });
    const p = await connect(relay.port);
    p.send({ t: 'join', v: 1, room: d.room, token });
    await p.next(); await d.next();
    d.send({ t: 'allow', tokens: [] });
    assert.equal((await p.closed).code, 4403);
    const again = await connect(relay.port);
    again.send({ t: 'join', v: 1, room: d.room, token });
    assert.deepEqual(await again.next(), { t: 'error', code: 'denied' });
  } finally { await relay.close(); }
});

test('the desktop leaving closes its phones and forgets the room; a reconnecting desktop takes it over', async () => {
  const relay = await startRelay(config());
  try {
    const d = await desk(relay.port);
    const token = randomBytes(32).toString('base64url');
    d.send({ t: 'allow', tokens: [{ h: sha(token) }] });
    const p = await connect(relay.port);
    p.send({ t: 'join', v: 1, room: d.room, token });
    await p.next(); await d.next();
    // Same key again: the new connection has the room, the old one and its phones are closed.
    const d2 = await connect(relay.port);
    d2.send({ t: 'desk', v: 1, key: d.key });
    assert.equal((await d2.next()).room, d.room);
    assert.equal((await d.closed).code, 4401);
    assert.equal((await p.closed).code, 4404);
    // The allow list did not carry over (nothing persists): the phone is refused until the desktop sends it again.
    const p2 = await connect(relay.port);
    p2.send({ t: 'join', v: 1, room: d.room, token });
    assert.deepEqual(await p2.next(), { t: 'error', code: 'denied' });
    d2.ws.close();
    await d2.closed;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(relay.relay.stats().rooms, 0);
  } finally { await relay.close(); }
});

test('rejects bad hellos, binary frames, oversized frames and message floods', async () => {
  const relay = await startRelay(config({ maxFrameBytes: 2048, messagesPerSecond: 1, messageBurst: 3 }));
  try {
    const a = await connect(relay.port);
    a.send({ t: 'to', peer: 'x', d: 'y' });
    assert.equal((await a.closed).code, 4400);
    const b = await connect(relay.port);
    b.ws.send('not json');
    assert.equal((await b.closed).code, 4400);
    const c = await desk(relay.port);
    c.ws.send(JSON.stringify({ t: 'to', peer: 'x', d: 'z'.repeat(4096) }));
    assert.equal((await c.closed).code, 1009);
    const flood = await desk(relay.port);
    for (let i = 0; i < 10; i++) flood.send({ t: 'ping' });
    assert.equal((await flood.closed).code, 4429);
  } finally { await relay.close(); }
});

test('browser origins: only the relay itself or ALLOWED_ORIGINS; native clients (no Origin) pass', async () => {
  const relay = await startRelay(config({ allowedOrigins: ['https://relay.example'] }));
  try {
    await assert.rejects(connect(relay.port, { Origin: 'https://evil.example' }));
    (await connect(relay.port, { Origin: 'https://relay.example' })).ws.close();
    (await connect(relay.port)).ws.close();
  } finally { await relay.close(); }
});

test('limits new connections per address', async () => {
  const relay = await startRelay(config({ connectsPerMinute: 2 }));
  try {
    (await connect(relay.port)).ws.close();
    (await connect(relay.port)).ws.close();
    await assert.rejects(connect(relay.port));
  } finally { await relay.close(); }
});

test('health endpoint and static phone app with the chat page CSP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Botling</title>');
  writeFileSync(join(dir, 'chat.html'), '<!doctype html>');
  const relay = await startRelay(config({ staticDir: dir }));
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const index = await fetch(`${base}/mobile/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy')!, /connect-src 'self'/);
    const chat = await fetch(`${base}/mobile/chat.html`);
    assert.match(chat.headers.get('content-security-policy')!, /connect-src 'none'.*frame-ancestors 'self'/);
    assert.equal((await fetch(`${base}/mobile/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/mobile/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
  } finally { await relay.close(); }
});

test('token bucket refills over time', () => {
  let now = 0;
  const bucket = new TokenBucket(1, 2, () => now);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  now = 1_000;
  assert.equal(bucket.take(), true);
});

test('config: env parsing and validation', () => {
  const c = loadConfig({ PORT: '9000', ALLOWED_ORIGINS: 'https://a.example, https://b.example', TRUST_PROXY: '1' });
  assert.equal(c.port, 9000);
  assert.deepEqual(c.allowedOrigins, ['https://a.example', 'https://b.example']);
  assert.equal(c.trustProxy, true);
  assert.throws(() => loadConfig({ PORT: 'x' }));
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'https://a.example/path' }));
});
