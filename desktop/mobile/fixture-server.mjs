// SYNTHETIC UI TEST FIXTURE ONLY. Never connects to a real Core or user data.
// Binds loopback; simulated browser sessions never represent Google validation.
// Serves the built Botling Web (dist/) and answers the bridge routes with the all-bots browser
// scope and the snapshot shape the bridge sends it (src/mobile-bridge/adapter.ts webSnapshot).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const MAIN = '6A0B0000-0000-4000-8000-000000000002', MAINTAINER = 'DEC0DE00-0000-4000-8000-00000000DEC0';
const minutes = n => new Date(Date.now() - n * 60_000).toISOString();
const bot = (id, name, role, extra = {}) => ({ id, name, role, avatar: 'circle', folder: role === 'manager' ? name : '', phase: 'awake', working: false,
  connection: null, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [], openTasks: 0, lastActivity: minutes(60), ...extra });
const row = (id, title, status, head = 'claude') => ({ id, title, status, head, startedAt: Date.now() - 600_000, endedAt: status === 'running' ? null : Date.now() - 60_000,
  unsettledAt: null, settled: false, prompt: title });
const bots = [
  bot(MAIN, 'Main bot', 'main', { unread: 1, lastActivity: minutes(3) }),
  bot(MAINTAINER, 'Maintainer', 'bot', { openTasks: 4, unread: 2, job: 'Keeps Botling itself in shape', subagentRows: [row('m1', '更新紀錄卡 kit 遷移', 'running'), row('m2', '差異檢視卡審查', 'completed')] }),
  bot('proj-botling', 'botling', 'manager', { heads: ['claude', 'codex'], working: true, openTasks: 15, lastActivity: minutes(1),
    subagentRows: [row('b1', 'Task 欄累積整合', 'running'), row('b2', 'Implement task panel', 'running', 'codex'), row('b3', 'Rust 接續交付', 'completed')] }),
  bot('proj-jenytsian', 'jenytsian_progress', 'manager', { lastActivity: minutes(30) }),
  bot('proj-csit', 'CSIT', 'manager', { phase: 'asleep', lastActivity: minutes(90) }),
  bot('proj-flux', 'flux-k8s', 'manager', { phase: 'asleep', lastActivity: minutes(200) }),
  bot('proj-hotel', 'hotel', 'manager', { openTasks: 3, lastActivity: minutes(240) }),
  bot('proj-rl', 'RL', 'manager', { openTasks: 2, approvals: 1, lastActivity: minutes(300) }),
  bot('proj-disk', 'disk', 'manager', { openTasks: 1, phase: 'asleep', lastActivity: minutes(400) }),
  bot('bot-news', 'Morning news', 'bot', { job: 'A short news digest each morning', phase: 'asleep', lastActivity: minutes(900) }),
  bot('group-release', 'Release crew', 'group', { members: [MAINTAINER, 'proj-botling'], heads: ['claude'], lastActivity: minutes(1000) }),
];
const message = (id, role, text, extra = {}) => ({ id, role, text, time: minutes(extra.ago ?? 5), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'ago')) });
const task = (id, name, state, now, owner = 'claude') => ({ id, name, state, owner, now, next: null, blocked: null, messageIds: [], updatedAt: minutes(2), createdAt: minutes(120) });
const chat = (botId, messages, more = {}) => ({ botId, messages, running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null,
  intervalSummaries: [], pins: [], floating: [], pinChoices: [], pendingFiles: [], ...more });
const chats = new Map(bots.map(b => [b.id, chat(b.id, [message(`${b.id}-hello`, 'bot', `Hi, I'm **${b.name}**. This is a synthetic fixture conversation.`, { ago: 50 })])]));
chats.set('proj-botling', chat('proj-botling', [
  message('u1', 'user', 'How is "Task 與報告重新設計" going? Please report where it stands.', { ago: 12 }),
  message('r1', 'bot', 'The task panel redesign is implemented and packaged in `.11`, awaiting your **Install and restart** confirmation and in-app verification.\n\nThe report redesign is still underway:\n\n- desktop layout: done\n- mobile layout: in review\n- screenshots: pending\n\n```sh\nnode mobile/build.mjs\n```', { ago: 11, engine: 'codex' }),
  message('u2', 'user', '請繼續做', { ago: 4, to: 'claude' }),
  message('r2', 'bot', 'Continuing. I will rebuild the web client and compare it against the desktop app at **1440×900** and **390×844**.', { ago: 3, engine: 'claude' }),
], { heads: { engines: ['claude', 'codex'], answerWith: 'claude', handoffsOn: true, rounds: null, handoffs: [] },
  tasks: [task('t1', 'Task 與報告重新設計', 'running', 'Task panel packaged; report redesign underway'), task('t2', '桌面瀏覽器網頁版', 'running', '實作桌面瀏覽器介面並共用元件', 'codex'),
    task('t3', '手機版', 'running', '實作手機介面與連線流程'), task('t4', 'GitHub 整合與 CI', 'waiting', '盤點工作流程並補齊 CI'), task('t5', 'Bypass release', 'done', 'Verified installable bundle')] }));
chats.set(MAIN, chat(MAIN, [
  message('m-hi', 'bot', 'Good morning. Three projects moved overnight; **RL** is waiting on you.', { ago: 30 }),
  message('question', 'bot', 'Which direction should we explore?', { ago: 20, choices: [{ label: 'Mobile first', detail: 'Start with the phone', recommended: true, action: null }, { label: 'Desktop first', detail: null, recommended: false, action: null }], chosen: null, answer: null }),
  message('unsafe', 'bot', '<img src=x onerror="alert(1)"> is displayed as text.', { ago: 10 }),
]));
// Library components. FIXTURE_COMPONENTS_DIR may point at a local components folder (<name>/template.html)
// to draw real templates; otherwise small synthetic ones that read ccb.data.
const synthetic = {
  choices: `<div id="q" style="display:flex;flex-direction:column;gap:6px"></div><script>const d = window.ccb.data; for (const [i, o] of d.options.entries()) {
    const b = document.createElement('button'); b.textContent = o.label + (o.detail ? ' · ' + o.detail : ''); b.style.cssText = 'text-align:left;padding:8px 12px;border-radius:10px;border:1px solid #2E2E35;background:#1B1B1F;color:#EDEDF0;font:inherit';
    b.onclick = () => window.ccb.answer({ index: i }); document.getElementById('q').append(b); }</script>`,
  'cpu-load': `<div style="font-weight:600">Synthetic CPU card</div><div id="v" style="font-size:34px"></div><script>document.getElementById('v').textContent = window.ccb.data.cpuPercent + '%'</script>`,
};
const template = name => { try { return readFileSync(join(process.env.FIXTURE_COMPONENTS_DIR, name, 'template.html'), 'utf8'); } catch { return synthetic[name]; } };
const components = Object.fromEntries(['choices', 'cpu-load'].map(name => [name, { template: template(name), version: 1, updated: false, sizes: ['2x2', '4x2'], icon: null, title: null }]));
chats.get('proj-botling').messages.push(
  message('cpu', 'bot', 'CPU looks busy; here is the load card (Run is the desktop\'s).', { ago: 2, engine: 'claude', displays: [{ name: 'cpu-load',
    data: JSON.stringify({ headline: 'BTLEServer is using most of the CPU', cpuPercent: 83, loadAvg: [9.7, 11, 12.4], cores: 10,
      processes: [{ name: 'BTLEServer', cpu: 87, note: 'Bluetooth reconnecting', flag: 'warn' }, { name: 'WindowServer', cpu: 24 }], nextStep: 'Turn Bluetooth off and watch BTLEServer.' }),
    at: null, command: 'python3 ~/.claudecodebot/plugins/ccb-components/scripts/cpu-load.py', folder: null, detail: null, card: 'cpu/0', status: 'done', error: null,
    ranAt: minutes(2), images: null, pinned: false, every: null }] }),
  message('card0', 'bot', 'A Phase 0 card:', { ago: 1, engine: 'claude', cards: [{ id: 'c1', data: null,
    html: '<div style="padding:10px;border:1px solid #444;border-radius:10px">Phase 0 card <b>rendered</b> <script>document.write(" (script ran)")</script></div>' }] }));
const settings = { language: null, effectiveLanguage: 'en', botLook: 'cute', chatAvatarSize: null, messageColumnWidth: null, rightPanelCollapsed: false, railCollapsed: false, pinnedBots: ['proj-jenytsian', 'proj-csit'] };
const waiting = { items: [{ botId: 'proj-rl', text: 'Approve the training run budget', messageId: null }], doing: { 'proj-botling': 'Task 與報告重新設計' } };
let seq = 0, authenticated = true, denied = false;
const csrf = 'f'.repeat(43);
const snapshot = botId => ({ epoch: 'fixture', seq, bots, imported: null, chat: chats.get(botId ?? MAIN) ?? null, components, settings, waiting, teams: [] });
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', webmanifest: 'application/manifest+json', woff2: 'font/woff2' };
// The bridge's policies (src/mobile-bridge/bridge.ts webChatCSP, frameHostCSP) for this origin.
const chatCSP = origin => `default-src 'none'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; frame-src ${origin}/mobile/frame-host.html; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'self'`;
const hostCSP = origin => `sandbox allow-scripts; default-src 'none'; script-src ${origin}/mobile/frame-host.js 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'`;
// Every request the fixture saw (for isolation-check.mjs: what actually reached the server).
const hits = [];
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && req.url === '/fixture/hits') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(hits)); return; }
    hits.push({ method: req.method, url: req.url, origin: req.headers.origin ?? null, site: req.headers['sec-fetch-site'] ?? null, dest: req.headers['sec-fetch-dest'] ?? null });
    if (req.method === 'POST' && req.url === '/fixture/control') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw Error(); }
      const control = JSON.parse(body); if (typeof control.authenticated === 'boolean') authenticated = control.authenticated;
      if (typeof control.denied === 'boolean') denied = control.denied;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return;
    }
    if (req.method === 'GET' && req.url === '/api/mobile/login') { authenticated = true; denied = false; res.writeHead(303, { Location: '/mobile/' }).end(); return; }
    if (req.method === 'POST' && ['/api/mobile/session', '/api/mobile/logout', '/api/mobile/browser/command'].includes(req.url)) {
      if (!authenticated) { res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"code":"auth_required"}}'); return; }
      if (req.url === '/api/mobile/session') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fixture-session=1; Path=/; HttpOnly; SameSite=Strict' })
          .end(JSON.stringify({ principal: 'f'.repeat(64), csrf, expiresAt: Date.now() + 3600000, botIds: ['*'] })); return;
      }
      if (req.headers['x-botling-csrf'] !== csrf || !req.headers.cookie?.includes('fixture-session=1')) { res.writeHead(403).end(); return; }
      if (req.url === '/api/mobile/logout') { authenticated = false; res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fixture-session=; Path=/; Max-Age=0' }).end('{"loggedOut":true}'); return; }
    }
    if (req.method === 'POST' && req.url === '/api/mobile/browser/command') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 200000) { res.writeHead(413).end(); return; } }
      const { v, id, cmd } = JSON.parse(body);
      const target = chats.get(cmd.botId ?? MAIN);
      if (denied || !target) { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v, id, ok: false, error: { code: 'forbidden', message: 'Fixture bot denied' } })); return; }
      let result;
      if (cmd.type === 'chat.snapshot') result = snapshot(cmd.botId);
      else if (cmd.type === 'chat.send') {
        console.log(JSON.stringify({ fixtureMutationRequest: id, type: cmd.type }));
        const messageId = `sent-${++seq}`; target.messages.push(message(messageId, 'user', cmd.text, { ago: 0, ...(cmd.to && cmd.to !== 'both' ? { to: cmd.to } : {}), ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}) }));
        target.messages.push(message(`reply-${seq}`, 'bot', `Received: ${cmd.text}`, { ago: 0, engine: 'claude' })); result = { messageId, turnId: null };
      } else if (cmd.type === 'chat.choose' || cmd.type === 'chat.answer') {
        const question = target.messages.find(row => row.id === cmd.messageId);
        if (cmd.type === 'chat.choose') question.chosen = cmd.index; else question.answer = cmd.text;
        seq++; result = { accepted: true };
      } else { res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v, id, ok: false, error: { code: 'forbidden', message: 'Command not available on mobile.' } })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v, id, ok: true, result })); return;
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    const name = path === '/' || path === '/mobile/' ? 'index.html' : path.replace(/^\/mobile\//, '');
    if (!/^(?:[a-z-]+\.(?:html|js|css|svg|webmanifest)|plugins\/ccb-latex\/katex\.min\.css|plugins\/ccb-latex\/fonts\/[A-Za-z0-9_-]+\.woff2)$/.test(name)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)], 'Content-Security-Policy': name === 'chat.html' ? chatCSP(`http://${req.headers.host}`) : name === 'frame-host.html' ? hostCSP(`http://${req.headers.host}`) : "frame-ancestors 'none'",
      ...(name.endsWith('.woff2') ? { 'Access-Control-Allow-Origin': '*' } : {}) }).end(await readFile(join(root, name)));
  } catch { if (!res.headersSent) res.writeHead(500).end(); }
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => console.log(`Synthetic mobile fixture: http://127.0.0.1:${server.address().port}/mobile/`));
