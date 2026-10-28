// SYNTHETIC UI TEST FIXTURE ONLY. Never connects to a real Core or user data.
// Binds loopback, uses a non-secret test token, and exits with its invoking process.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('./dist/', import.meta.url));
const bots = ['Main', 'Research', 'Staged files'].map((name, index) => ({ id: `bot${index}`, name, role: index ? 'manager' : 'main', working: false, approvals: index ? 0 : 1, unread: 0, problem: null, heads: index ? ['claude'] : ['claude', 'codex'] }));
const message = (id, role, text, extra = {}) => ({ id, role, text, time: new Date().toISOString(), ...extra });
const chats = bots.map(bot => ({ botId: bot.id, messages: [message(`${bot.id}-welcome`, 'bot', `Welcome to ${bot.name}. This is a synthetic test conversation.`)], tasks: [], pendingFiles: bot.id === 'bot2' ? [{ id: 'file', name: 'desktop-staged.txt' }] : [] }));
chats[0].messages.push(message('question', 'bot', 'Which direction should we explore?', { choices: [{ label: 'Mobile first', detail: 'Start with the phone', recommended: true, action: null }, { label: 'Desktop first', detail: null, recommended: false, action: null }], chosen: null, answer: null }));
chats[0].messages.push(message('unsafe', 'bot', '<img src=x onerror="alert(1)"> is displayed as text.'));
let seq = 0;
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST' && req.url === '/api/mobile/command') {
      if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 200000) { res.writeHead(413).end(); return; } }
      const { v, id, cmd } = JSON.parse(body); const chat = chats.find(row => row.botId === (cmd.botId || 'bot0'));
      let result;
      if (cmd.type === 'chat.snapshot') result = { epoch: 'fixture', seq, bots, chat };
      else if (cmd.type === 'chat.send') {
        console.log(JSON.stringify({ fixtureMutationRequest: id, type: cmd.type }));
        const messageId = `sent-${++seq}`; chat.messages.push(message(messageId, 'user', cmd.text, { ...(cmd.to && cmd.to !== 'both' ? { to: cmd.to } : {}), ...(cmd.replyTo ? { replyTo: cmd.replyTo } : {}) }));
        chat.messages.push(message(`reply-${seq}`, 'bot', `Received: ${cmd.text}`, { engine: 'claude' })); result = { messageId, turnId: null };
        if (cmd.text === '/uncertain') { req.socket.destroy(); return; }
      } else if (cmd.type === 'chat.choose' || cmd.type === 'chat.answer') {
        const question = chat.messages.find(row => row.id === cmd.messageId);
        if (cmd.type === 'chat.choose') question.chosen = cmd.index; else question.answer = cmd.text;
        seq++; result = { accepted: true };
      } else { res.writeHead(400).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ v, id, ok: true, result })); return;
    }
    const path = new URL(req.url, 'http://localhost').pathname;
    const filename = path === '/' || path === '/mobile/' ? 'index.html' : path.replace(/^\/mobile\//, '').replace(/^\//, '');
    if (!['index.html', 'mobile.js', 'mobile.css', 'icon.svg', 'manifest.webmanifest'].includes(filename)) { res.writeHead(404).end(); return; }
    const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', webmanifest: 'application/manifest+json' }[filename.split('.').at(-1)];
    res.writeHead(200, { 'Content-Type': mime, 'Content-Security-Policy': "frame-ancestors 'none'" }).end(await readFile(join(root, filename)));
  } catch { res.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`Synthetic mobile fixture: http://127.0.0.1:${server.address().port}/mobile/ (token: fixture-token)`));
