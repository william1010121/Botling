// Botling Web's scope: the all-bots scope (no sign-in grants it any more) keeps the same four commands;
// bearer clients keep their explicit lists and minimal snapshot; the web assets are served safely.
import { afterEach, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Clients, frameHostCSP, handler, tokenHash, webChatCSP, type BridgeOptions } from './bridge';
import { mobileCommand, webSnapshot, type MobileAccess } from './adapter';
import { ALL_BOTS, botAllowed } from './scope';
import { MutationLedger } from './ledger';
import { MAIN_BOT_ID } from '../core/store/records';
import { MAINTAINER_BOT_ID, okResponse } from '../contract';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const origin = 'https://bridge.example.invalid';

const bot = (id: string, name: string, role: string, folder = '') => ({ id, name, role, avatar: 'circle', folder, phase: 'awake', working: false, approvals: 0,
  unread: 0, subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [], openTasks: 2, lastActivity: null });
const bots = [bot(MAIN_BOT_ID, 'Main bot', 'main'), bot(MAINTAINER_BOT_ID, 'Maintainer', 'bot'), bot('project-a', 'botling', 'manager', '/Users/someone/tool/botling'),
  bot('project-b', 'hotel', 'manager', '/Users/someone/hotel')];
function access(handled: unknown[] = []): MobileAccess {
  return {
    pending: () => [],
    snapshot: (botId) => ({ epoch: 'e', seq: 7, bots, imported: { source: '/Users/someone/.old', at: '', bots: 1, messages: 1, skipped: [] },
      chat: { botId: botId ?? MAIN_BOT_ID, messages: [], running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [], pendingFiles: [] },
      components: { card: { name: 'card' } }, plugins: { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null },
      settings: { language: null, effectiveLanguage: 'en', botLook: 'cute', chatAvatarSize: null, messageColumnWidth: null, rightPanelCollapsed: false, railCollapsed: false,
        pinnedBots: ['project-b'], developerMode: true, developerProject: 'project-a', claudeBypassPermissions: true, summaryPrompt: 'secret prompt' },
      doctor: { problems: [] }, waiting: { items: [], doing: {} }, web: { sites: [] }, spec: null } as any),
    handle: async (command) => { handled.push(command); return { messageId: 'm', turnId: null }; },
  };
}

it('the all-bots scope is never a real bot id and allows any bot only through botAllowed', () => {
  expect(botAllowed([ALL_BOTS], 'project-a')).toBe(true);
  expect(botAllowed([MAIN_BOT_ID], 'project-a')).toBe(false);
  expect(() => Clients.parse([{ id: 'phone', tokenHash: 'a'.repeat(64), botIds: [ALL_BOTS], expiresAt: Date.now() + 1000 }])).toThrow();
  expect(Clients.parse([{ id: 'phone', tokenHash: 'a'.repeat(64), botIds: [MAIN_BOT_ID, 'project-a'], expiresAt: Date.now() + 1000 }])).toHaveLength(1);
});

it('the browser scope snapshot lists every bot the desktop does, with display settings only', async () => {
  const response = await mobileCommand(access(), { v: 10, id: 's', cmd: { type: 'chat.snapshot', botId: 'project-a' } }, [ALL_BOTS]);
  expect(response.ok).toBe(true);
  const result = (response as any).result;
  expect(result.bots.map((row: any) => row.id)).toEqual([MAIN_BOT_ID, MAINTAINER_BOT_ID, 'project-a', 'project-b']);
  expect(result.bots.find((row: any) => row.id === 'project-a')).toMatchObject({ folder: 'botling', openTasks: 2, avatar: 'circle', phase: 'awake' });
  expect(result.chat.botId).toBe('project-a');
  expect(result.components).toEqual({ card: { name: 'card' } });
  expect(Object.keys(result.settings).sort()).toEqual(['botLook', 'chatAvatarSize', 'effectiveLanguage', 'language', 'messageColumnWidth', 'pinnedBots', 'railCollapsed', 'rightPanelCollapsed']);
  for (const hidden of ['plugins', 'doctor', 'web', 'spec']) expect(result).not.toHaveProperty(hidden);
  expect(result.imported).toBeNull();
  expect(JSON.stringify(result)).not.toContain('/Users/someone');
  expect(webSnapshot(access().snapshot()).bots).toHaveLength(bots.length);
});

it('an explicit bot list keeps the minimal snapshot and refuses other bots', async () => {
  const response = await mobileCommand(access(), { v: 10, id: 's', cmd: { type: 'chat.snapshot' } }, [MAIN_BOT_ID]);
  const result = (response as any).result;
  expect(result.bots).toEqual([{ id: MAIN_BOT_ID, name: 'Main bot', role: 'main', working: false, approvals: 0, unread: 0, problem: null, heads: ['claude'] }]);
  expect(Object.keys(result).sort()).toEqual(['bots', 'chat', 'epoch', 'seq']);
  const denied = await mobileCommand(access(), { v: 10, id: 'd', cmd: { type: 'chat.snapshot', botId: 'project-a' } }, [MAIN_BOT_ID]);
  expect(denied).toMatchObject({ ok: false, error: { code: 'forbidden' } });
});

it('the browser scope still has only the four mobile commands', async () => {
  const handled: unknown[] = [];
  const sent = await mobileCommand(access(handled), { v: 10, id: 'x', cmd: { type: 'chat.send', botId: 'project-b', text: 'hi' } }, [ALL_BOTS]);
  expect(sent.ok).toBe(true); expect(handled).toHaveLength(1);
  for (const cmd of [{ type: 'chat.read', botId: 'project-b' }, { type: 'bots.remove', botId: 'project-b' }, { type: 'settings.set', change: { key: 'railCollapsed', value: true } }]) {
    const refused = await mobileCommand(access(handled), { v: 10, id: 'y', cmd }, [ALL_BOTS]);
    expect(refused).toMatchObject({ ok: false, error: { code: expect.stringMatching(/forbidden|bad_request/) } });
  }
  expect(handled).toHaveLength(1);
});

function assetHandler() {
  const dir = mkdtempSync(join(tmpdir(), 'web-assets-')); dirs.push(dir);
  for (const name of ['index.html', 'web.js', 'styles.css', 'web.css', 'chat.html', 'chat.js', 'chat.css', 'frame.css', 'frame-host.html', 'frame-host.js']) writeFileSync(join(dir, name), name);
  mkdirSync(join(dir, 'plugins/ccb-latex/fonts'), { recursive: true });
  writeFileSync(join(dir, 'plugins/ccb-latex/fonts/KaTeX_Main-Regular.woff2'), 'font');
  writeFileSync(join(dir, 'secret.txt'), 'no');
  const token = 'a'.repeat(43);
  let dispatched = 0;
  const options: BridgeOptions = { origin, host: '127.0.0.1', port: 8443, tls: {}, assets: dir,
    clients: () => [{ id: 'phone', tokenHash: tokenHash(token), botIds: [MAIN_BOT_ID], expiresAt: Date.now() + 60_000 }],
    ledger: new MutationLedger(join(dir, 'ledger')), core: { mobileCommand: async raw => { dispatched++; return okResponse((raw as any).id, {}); } } };
  const call = async (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) => {
    const req: any = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: { host: 'bridge.example.invalid', ...headers } });
    const set: Record<string, unknown> = {}; let status = 0, text = '';
    const res: any = { setHeader(name: string, value: unknown) { set[name.toLowerCase()] = value; },
      writeHead(code: number, extra?: Record<string, string>) { status = code; for (const [k, v] of Object.entries(extra ?? {})) set[k.toLowerCase()] = v; },
      end(value?: Buffer | string) { text = value ? String(value) : ''; } };
    await handler(options)(req, res); return { status, headers: set, text };
  };
  return { call, token, dispatched: () => dispatched };
}

it('serves the web shell and sandboxed chat page, and nothing else', async () => {
  const { call } = assetHandler();
  const chat = await call('GET', '/mobile/chat.html');
  const chatCSP = webChatCSP(origin);
  expect(chat.status).toBe(200); expect(chat.headers['content-security-policy']).toBe(chatCSP);
  expect(chatCSP).toContain("connect-src 'none'"); expect(chatCSP).toContain("frame-ancestors 'self'");
  // The chat page may frame only the frame host (component and card pages); nothing else.
  expect(chatCSP.split('; ').filter(rule => rule.startsWith('frame-src'))).toEqual([`frame-src ${origin}/mobile/frame-host.html`]);
  // The frame host is an opaque origin by its own response, with no network, frames or forms.
  const host = await call('GET', '/mobile/frame-host.html', { 'sec-fetch-site': 'cross-site' });
  expect(host.status).toBe(200);
  const hostCSP = String(host.headers['content-security-policy']);
  expect(hostCSP).toBe(frameHostCSP(origin));
  const rules = hostCSP.split('; ');
  expect(rules[0]).toBe('sandbox allow-scripts');
  for (const rule of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "default-src 'none'", "worker-src 'none'"]) expect(rules).toContain(rule);
  expect(hostCSP).not.toContain('allow-same-origin');
  expect((await call('GET', '/mobile/frame-host.js', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  const shell = await call('GET', '/mobile/');
  expect(shell.status).toBe(200); expect(shell.headers['content-security-policy']).toBe("frame-ancestors 'none'");
  for (const name of ['web.js', 'styles.css', 'web.css', 'chat.js', 'chat.css', 'frame.css']) expect((await call('GET', `/mobile/${name}`)).status).toBe(200);
  // The opaque-origin chat frame loads KaTeX fonts with CORS (`Origin: null`).
  const font = await call('GET', '/mobile/plugins/ccb-latex/fonts/KaTeX_Main-Regular.woff2', { origin: 'null', 'sec-fetch-site': 'cross-site' });
  expect(font.status).toBe(200); expect(font.headers['access-control-allow-origin']).toBe('*'); expect(font.headers['content-type']).toBe('font/woff2');
  for (const path of ['/mobile/secret.txt', '/mobile/../secret.txt', '/mobile/plugins/ccb-latex/fonts/../../../secret.txt', '/mobile/web.js.map'])
    expect((await call('GET', path)).status).toBe(404);
});

it('an opaque origin never reaches the API', async () => {
  const { call, token, dispatched } = assetHandler();
  const body = { v: 10, id: 'n', cmd: { type: 'chat.snapshot' } };
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  expect((await call('POST', '/api/mobile/command', { ...headers, origin: 'null' }, body)).status).toBe(403);
  expect(dispatched()).toBe(0);
  expect((await call('POST', '/api/mobile/command', headers, body)).status).toBe(200);
  expect(dispatched()).toBe(1);
});
