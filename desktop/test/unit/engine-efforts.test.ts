// Thinking effort per engine: each engine has its own (bot.json `efforts`), the old single `effort` is the
// value for every engine that has none of its own, and each engine's head is launched with its own.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const fixture = vi.hoisted(() => {
  const heads: any[] = [];
  const make = (kind: string) => class {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = []; sent: string[] = []; kind = kind;
    constructor(readonly config: any, readonly handlers: any) { heads.push(this); }
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: 'init', sessionId: this.config.sessionId })); }
    send(text: string) { this.sent.push(text); }
    steer(text: string) { this.sent.push(text); return true; }
    endTurn() { this.handlers.onItem({ kind: 'result', ok: true, text: 'Finished', subtype: 'end_turn' }); }
    async terminate() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: '', expected: true, silent: false }); return { killed: [], forced: false }; }
  };
  return { heads, make };
});
vi.mock('../../src/core/agent/head', async original => ({ ...await original<any>(), ClaudeHead: fixture.make('claude') }));
vi.mock('../../src/core/agent/codex', async original => ({ ...await original<any>(), CodexHead: fixture.make('codex') }));
vi.mock('../../src/core/agent/agy-acp', () => ({ verifyAcpRuntime() {}, AgyAcpHead: fixture.make('agy') }));
import { Bot } from '../../src/core/bot';
import { mainProfile } from '../../src/core/store/workspace';
import { botPrompts } from '../../src/core/prompts';
import { CodexThreads } from '../../src/core/agent/codex';
import { EFFORTS_BY_ENGINE, effortFor } from '../../src/core/engine-defaults';
import { tempDir, until } from '../helpers';

const bots: Bot[] = [];
afterEach(async () => { for (const b of bots.splice(0)) await b.shutdown({ tidy: false }); fixture.heads.length = 0; });

function make(settings: Record<string, unknown>) {
  const folder = tempDir('engine-efforts'), profile = mainProfile(folder); mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, 'bot.json'), JSON.stringify({ engine: 'claude', heads: { engines: ['claude', 'codex', 'agy'], answerWith: 'claude' }, ...settings }));
  const b = new Bot({ profile, deferStartup: true, welcome: false, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: '/never-spawn', cwd: folder, allowedTools: [] }; },
    agyConfig(_p, c) { return { ...c, transport: 'acp', command: '/never-spawn' }; },
    codexConfig(_p, c) { return { command: '/never-spawn', cwd: folder, threads: new CodexThreads(join(folder, 'threads')), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (engine, heads) => botPrompts({ profile, engine, heads }), emit() {}, log() {}, idleMs: 600000, approvalTimeoutMs: 1000, interruptGraceMs: 10 }); bots.push(b); return b;
}

it('offers each engine only the efforts it supports', () => {
  expect(EFFORTS_BY_ENGINE.claude).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(EFFORTS_BY_ENGINE.codex).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(EFFORTS_BY_ENGINE.agy).toEqual(['low', 'medium', 'high']);
});

it('resolves an engine own effort, else the legacy one, else none', () => {
  expect(effortFor({ efforts: { codex: 'xhigh' }, effort: 'low' }, 'codex')).toBe('xhigh');
  expect(effortFor({ efforts: { codex: 'xhigh' }, effort: 'low' }, 'claude')).toBe('low');
  expect(effortFor({ effort: 'high' }, 'agy')).toBe('high');
  expect(effortFor({}, 'claude')).toBeNull();
  // A level the engine does not support is not used (Antigravity has no "max").
  expect(effortFor({ effort: 'max' }, 'agy')).toBeNull();
  expect(effortFor({ efforts: { agy: 'xhigh' }, effort: 'medium' }, 'agy')).toBe('medium');
  expect(effortFor({ efforts: 'nonsense' }, 'claude')).toBeNull();
});

it('launches each engine with its own effort', async () => {
  const b = make({ efforts: { claude: 'max', codex: 'low', agy: 'medium' } });
  for (const to of ['claude', 'codex', 'agy'] as const) { b.send(`hi ${to}`, { to }); await until(() => fixture.heads.some(h => h.kind === to && h.sent.length)); }
  const effort = (kind: string) => fixture.heads.find(h => h.kind === kind).config.effort;
  expect({ claude: effort('claude'), codex: effort('codex'), agy: effort('agy') }).toEqual({ claude: 'max', codex: 'low', agy: 'medium' });
});

it('a bot with only the old effort launches every engine with it, and the view says so', async () => {
  const b = make({ effort: 'high' });
  for (const to of ['claude', 'codex', 'agy'] as const) { b.send(`hi ${to}`, { to }); await until(() => fixture.heads.some(h => h.kind === to && h.sent.length)); }
  expect(fixture.heads.map(h => h.config.effort)).toEqual(['high', 'high', 'high']);
  expect(b.settingsView().efforts).toEqual({ claude: 'high', codex: 'high', agy: 'high' });
});

it('setting one engine effort leaves the others, and only that engine is told', () => {
  const b = make({ effort: 'high' });
  expect(b.configure({ efforts: { codex: 'low' } }).efforts).toEqual({ claude: 'high', codex: 'low', agy: 'high' });
  expect(b.configure({ efforts: { codex: null } }).efforts).toEqual({ claude: 'high', codex: 'high', agy: 'high' });
  expect(b.configure({ effort: null, efforts: { claude: 'max', codex: null, agy: null } }).efforts).toEqual({ claude: 'max', codex: null, agy: null });
  expect(() => b.configure({ efforts: { agy: 'max' } })).toThrow();
});
