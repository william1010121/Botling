import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotTerminals } from '../../src/main/terminal';
import { CoreHarness, MAIN } from '../core-harness';
import { tempDir, until } from '../helpers';

it('durably checkpoints agent work while terminal shutdown joins cleanup without replaying commands', async () => {
  const dir = tempDir('terminal-restart-combined');
  const cores: CoreHarness[] = [];
  const start = () => {
    const core = new CoreHarness(dir, { FAKE_CLAUDE_LOG: join(dir, 'starts.log'), FAKE_CLAUDE_INPUT: join(dir, 'input.log'), BOTLING_IMPORT_FROM: '', BOTLING_ROUTINE_TICK_MS: '0', BOTLING_UPDATE_PENDING: '0', BOTLING_QUIT_TIDY_MS: '0' });
    cores.push(core); return core;
  };
  const processes: any[] = [];
  const terminal = new BotTerminals(() => {}, (() => {
    const p = { disposed: 0, killed: false, written: '', onData() { return { dispose: () => p.disposed++ }; }, onExit() { return { dispose: () => p.disposed++ }; }, write(data: string) { p.written += data; }, kill() { p.killed = true; } };
    processes.push(p); return p;
  }) as any);
  try {
    const first = start();
    await first.call({ type: 'chat.send', botId: MAIN, text: '/slow' });
    await until(() => first.of('turn.delta').length, { what: 'agent starts' });
    const tab = terminal.open(1, MAIN, dir);
    terminal.input(1, MAIN, tab.sessionId, 'TERMINAL_COMMAND_MUST_NOT_REPLAY\r');
    first.post({ botling: 'prepareRestart', id: 918 });
    expect(await until(() => first.responses.get(918 as unknown as string), { what: 'durable checkpoint' })).toMatchObject({ ok: true });
    const checkpoint = readFileSync(join(dir, 'restart-continuation.json'), 'utf8');
    expect(checkpoint).not.toContain('TERMINAL_COMMAND_MUST_NOT_REPLAY');
    expect(checkpoint).not.toContain(tab.sessionId);
    await Promise.allSettled([terminal.closeAll(), first.kill('SIGTERM')]);
    expect(processes.map(p => [p.killed, p.disposed])).toEqual([[true, 2]]);
    expect(terminal.list(1, MAIN)).toEqual([]);
    expect(() => terminal.open(1, MAIN, dir)).toThrow('shutting down');
    const second = start();
    await until(() => second.of('turn.finished').length, { what: 'simulated provider continuation' });
    const input = readFileSync(join(dir, 'input.log'), 'utf8');
    expect(input).toContain('explicitly approved restarting');
    expect(input).not.toContain('TERMINAL_COMMAND_MUST_NOT_REPLAY');
    expect(processes).toHaveLength(1);
    await second.kill('SIGTERM');
    const third = start(); await third.chat();
    expect(readFileSync(join(dir, 'input.log'), 'utf8')).toBe(input);
  } finally {
    await terminal.closeAll();
    await Promise.all(cores.map(core => core.kill('SIGTERM')));
  }
});
