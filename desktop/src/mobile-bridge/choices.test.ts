import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handler, tokenHash, type BridgeOptions } from './bridge';
import { MutationLedger } from './ledger';
import { Core } from '../core/server';
import { Bot } from '../core/bot';
import { MAIN_BOT_ID as botId } from '../core/store/records';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it.each(['permissionTool', 'denialAsks', 'appQuestions'] as const)('mobile %s retains token, bot, pending choice and core checks', async kind => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-choice-')); dirs.push(dir);
  const effect = vi.fn();
  const record: any = { id: 'question', role: 'bot', choices: [{ label: 'Allow', action: 'allowOnce' }] };
  const bot: any = Object.create(Bot.prototype);
  Object.assign(bot, { options: { profile: { id: botId } }, records: [record], appQuestions: new Map(), appAnswers: new Map(), cardPicks: new Map(),
    denialAsks: new Map(), approvals: new Map(), sessionRules: [], rulesGivenAfter: new Map(), toolCalls: new Map(),
    changed: vi.fn(), updated: vi.fn(), log: vi.fn(), tellReviewOutcome: vi.fn(), tellHead: effect });
  if (kind === 'permissionTool') {
    record.permissionTool = 'Bash';
    bot.approvals.set(record.id, { tool: 'Bash', requestId: 'request', input: {}, head: { answer: effect } });
  } else if (kind === 'denialAsks') {
    bot.denialAsks.set(record.id, { tool: 'Bash', rule: 'Bash(example)', summary: 'example', allowedBefore: false });
  } else bot.appQuestions.set(record.id, effect); // Same callback boundary as App install confirmations; never invokes an installer.
  const core: any = Object.create(Core.prototype);
  Object.assign(core, { activated: true, bots: new Map([[botId, bot]]), conversations: { isCalledIn: () => false } });
  const token = 'a'.repeat(43);
  const options: BridgeOptions = { origin: 'https://127.0.0.1:8443', host: '127.0.0.1', port: 8443, tls: {}, assets: dir,
    clients: () => [{ id: 'phone', tokenHash: tokenHash(token), botIds: [botId], expiresAt: Date.now() + 60_000 }], ledger: new MutationLedger(join(dir, 'ledger')), core };
  let seq = 0;
  const call = async (index: number, auth = token, target = botId, messageId = record.id) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify({ v: 10, id: 'choice-' + ++seq, cmd: { type: 'chat.choose', botId: target, messageId, index } }))]);
    Object.assign(req, { method: 'POST', url: '/api/mobile/command', headers: { host: '127.0.0.1:8443', authorization: 'Bearer ' + auth, 'content-type': 'application/json' } });
    let status = 0, body: any;
    const res: any = { setHeader() {}, writeHead(code: number) { status = code; }, end(value?: string) { body = value ? JSON.parse(value) : undefined; } };
    await handler(options)(req, res); return { status, body };
  };
  expect((await call(0, 'b'.repeat(43))).status).toBe(401);
  expect((await call(0, token, 'other')).status).toBe(403);
  expect((await call(0, token, botId, 'missing')).body.ok).toBe(false);
  const invalid = await call(99); expect(invalid.body.ok && invalid.body.result.accepted).toBeFalsy();
  core.activated = false; expect((await call(0)).body.ok).toBe(false); core.activated = true;
  expect(effect).not.toHaveBeenCalled();
  const accepted = await call(0); expect(accepted.body.result).toEqual({ accepted: true }); expect(effect).toHaveBeenCalledOnce();
  expect((await call(0)).body.result).toEqual({ accepted: false }); expect(effect).toHaveBeenCalledOnce();
  if (kind === 'permissionTool') {
    record.chosen = null; // An open-looking record without a live approval must still fail closed.
    expect((await call(0)).body.result).toEqual({ accepted: false }); expect(effect).toHaveBeenCalledOnce();
  }
});
