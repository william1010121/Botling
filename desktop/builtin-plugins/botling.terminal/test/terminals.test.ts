import { describe, expect, it } from 'vitest';
import { BotTerminals } from '../src/terminals';
import { installedShells } from '../src/shells';
import { TerminalRequest } from '../src/request';
import type { IPty } from 'node-pty';

describe('terminal lifecycle and scope', () => {
  function fixture() {
    const processes: any[] = [], events: any[] = [];
    const manager = new BotTerminals(event => events.push(event), (_shell, _args, options) => {
      const process = { options, written: '', sizes: [] as number[][], killed: false,
        write(data: string) { this.written += data; }, resize(cols: number, rows: number) { this.sizes.push([cols, rows]); },
        kill() { this.killed = true; }, onData(cb: any) { this.data = cb; }, onExit(cb: any) { this.exit = cb; },
      } as any;
      processes.push(process); return process as IPty;
    });
    return { manager, processes, events };
  }
  it('creates independent tabs and preserves them across lists, hiding and bot switches', () => {
    const { manager, processes } = fixture();
    const a = manager.open('botA', process.cwd());
    const b = manager.open('botA', process.cwd());
    const c = manager.open('botB', process.cwd());
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
    processes[0].data('中文\x1b[38;2;255;0;0m彩色');
    for (let i = 0; i < 10; i++) expect(manager.list('botA')).toHaveLength(2);
    expect(processes).toHaveLength(3);
    expect(manager.list('botA')[0].output).toContain('中文\x1b[38;2;255;0;0m');
    manager.close('botA', a.sessionId);
    expect(processes.map(p => p.killed)).toEqual([true, false, false]);
    manager.remove('botA'); expect(processes[1].killed).toBe(true); expect(processes[2].killed).toBe(false);
    manager.closeAll(); expect(processes[2].killed).toBe(true);
  });
  it('enforces bot and session scope, validates shell and cwd, forwards control/resize', () => {
    const { manager, processes } = fixture(); const a = manager.open('A', process.cwd());
    expect(() => manager.input('B', a.sessionId, 'bad')).toThrow();
    expect(() => manager.close('B', a.sessionId)).toThrow();
    expect(() => manager.input('A', '00000000-0000-4000-8000-000000000000', 'bad')).toThrow();
    expect(manager.list('B')).toEqual([]);
    expect(() => manager.open('A', '.', '/bin/zsh')).toThrow();
    expect(() => manager.open('A', process.cwd(), '/bin/echo')).toThrow();
    manager.input('A', a.sessionId, '\x03中文\r'); manager.resize('A', a.sessionId, 100, 30);
    expect(processes[0].written).toBe('\x03中文\r'); expect(processes[0].sizes).toEqual([[100, 30]]);
    expect(() => manager.restart('A', a.sessionId, process.cwd())).toThrow();
    processes[0].exit({ exitCode: 3 }); expect(manager.list('A')[0].exitCode).toBe(3);
    expect(() => manager.input('A', a.sessionId, 'bad')).not.toThrow();
    expect(processes[0].written).toBe('\x03中文\r');
    const next = manager.restart('A', a.sessionId, process.cwd()); expect(next.sessionId).not.toBe(a.sessionId);
    expect(processes[1].written).toBe(''); manager.remove('A'); expect(processes[1].killed).toBe(true);
  });
  it('rejects arbitrary frame process parameters and malformed requests', () => {
    expect(TerminalRequest.safeParse({ type: 'open', botId: 'A', cwd: '/tmp', command: 'echo bad' }).success).toBe(false);
    expect(TerminalRequest.safeParse({ type: 'resize', botId: 'A', sessionId: 'x', cols: 0, rows: -1 }).success).toBe(false);
    expect(installedShells().shells).toContain(installedShells().defaultShell);
  });
  it('tells the events of a shell as they happen: output with its offset, then its exit', () => {
    const { manager, processes, events } = fixture(); const a = manager.open('A', process.cwd());
    processes[0].data('ab'); processes[0].data('c'); processes[0].exit({ exitCode: 0 });
    expect(events).toEqual([
      { type: 'data', botId: 'A', sessionId: a.sessionId, data: 'ab', offset: 2 },
      { type: 'data', botId: 'A', sessionId: a.sessionId, data: 'c', offset: 3 },
      { type: 'exit', botId: 'A', sessionId: a.sessionId, exitCode: 0 },
    ]);
  });
});

describe('streaming and shutdown', () => {
  it('bounds streaming with acknowledgements and keeps startup bytes until attach', () => {
    let data: (value: string) => void = () => {}; let paused = false;
    const manager = new BotTerminals(() => {}, (() => ({onData(cb: any) { data = cb; },onExit() {},pause() { paused = true; },resume() { paused = false; }})) as any);
    const tab = manager.open('A', process.cwd());
    data('起動');data('x'.repeat(300_000)); expect(paused).toBe(true);
    const attached = manager.attach('A', tab.sessionId);expect(attached.output.startsWith('起動')).toBe(true);
    manager.ack('A', tab.sessionId, attached.offset + 1); expect(paused).toBe(true);
    manager.ack('A', tab.sessionId, attached.offset); expect(paused).toBe(false);
  });
  it('detaches listeners and refuses late data/exit after tab close, bot removal and shutdown', () => {
    const processes: any[] = [], emitted: any[] = [];
    const manager = new BotTerminals(event => emitted.push(event), (() => {
      const p = { disposed: 0, killed: 0, onData(cb: any) { this.data = cb; return { dispose: () => this.disposed++ }; },
        onExit(cb: any) { this.exit = cb; return { dispose: () => this.disposed++ }; }, kill() { this.killed++; } } as any;
      processes.push(p); return p;
    }) as any);
    const a = manager.open('A', process.cwd()); manager.close('A', a.sessionId);
    const b = manager.open('A', process.cwd()); manager.remove('A');
    const c = manager.open('B', process.cwd()); manager.closeAll();
    for (const p of processes) { p.data('late output'); p.exit({ exitCode: 0 }); }
    expect(emitted).toEqual([]);
    expect(processes.map(p => p.disposed)).toEqual([2, 2, 2]);
    expect(processes.map(p => p.killed)).toEqual([1, 1, 1]);
    expect(manager.list('A')).toEqual([]); expect(manager.list('B')).toEqual([]);
    expect([a.sessionId, b.sessionId, c.sessionId].length).toBe(3);
  });
  it('cannot spawn a terminal after shutdown and preserves binary mouse bytes', async () => {
    let written: unknown;
    const manager = new BotTerminals(() => {}, (() => ({ onData() {}, onExit() {}, write(value: unknown) { written = value; },kill() {} })) as any);
    const tab=manager.open('A',process.cwd());
    manager.input('A',tab.sessionId,'\x1b[M\xff',true);
    expect(written).toEqual(Buffer.from([27,91,77,255]));
    await manager.closeAll();expect(()=>manager.open('A',process.cwd())).toThrow('shutting down');
  });
  it('closeAllNow (the plugin unloading) ends every shell at once and refuses new ones', () => {
    const processes: any[] = [];
    const manager = new BotTerminals(() => {}, (() => {
      const p = { killed: 0, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() { this.killed++; } } as any;
      processes.push(p); return p;
    }) as any);
    manager.open('A', process.cwd()); manager.open('B', process.cwd());
    manager.closeAllNow(0);
    expect(processes.map(p => p.killed)).toEqual([1, 1]);
    expect(manager.list('A')).toEqual([]);
    expect(() => manager.open('A', process.cwd())).toThrow('shutting down');
  });
});
