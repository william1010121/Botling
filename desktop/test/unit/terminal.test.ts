import { describe, expect, it } from 'vitest';
import { BotTerminals, installedShells } from '../../src/main/terminal';
import { TerminalRequest } from '../../src/contract/terminal';
import type { IPty } from 'node-pty';

describe('terminal lifecycle and ownership', () => {
  function fixture() {
    const processes: any[] = [], events: any[] = [];
    const manager = new BotTerminals((owner, event) => events.push({ owner, event }), (_shell, _args, options) => {
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
    const a = manager.open(1, 'botA', process.cwd());
    const b = manager.open(1, 'botA', process.cwd());
    const c = manager.open(1, 'botB', process.cwd());
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
    processes[0].data('中文\x1b[38;2;255;0;0m彩色');
    for (let i = 0; i < 10; i++) expect(manager.list(1, 'botA')).toHaveLength(2);
    expect(processes).toHaveLength(3);
    expect(manager.list(1, 'botA')[0].output).toContain('中文\x1b[38;2;255;0;0m');
    manager.close(1, 'botA', a.sessionId);
    expect(processes.map(p => p.killed)).toEqual([true, false, false]);
    manager.remove('botA'); expect(processes[1].killed).toBe(true); expect(processes[2].killed).toBe(false);
    manager.closeAll(); expect(processes[2].killed).toBe(true);
  });
  it('enforces owner, bot and session scope, validates shell and cwd, forwards control/resize', () => {
    const { manager, processes } = fixture(); const a = manager.open(7, 'A', process.cwd());
    expect(() => manager.input(8, 'A', a.sessionId, 'bad')).toThrow();
    expect(() => manager.input(7, 'B', a.sessionId, 'bad')).toThrow();
    expect(() => manager.close(8, 'A', a.sessionId)).toThrow();
    expect(manager.list(8, 'A')).toEqual([]);
    expect(() => manager.open(7, 'A', '.', '/bin/zsh')).toThrow();
    expect(() => manager.open(7, 'A', process.cwd(), '/bin/echo')).toThrow();
    manager.input(7, 'A', a.sessionId, '\x03中文\r'); manager.resize(7, 'A', a.sessionId, 100, 30);
    expect(processes[0].written).toBe('\x03中文\r'); expect(processes[0].sizes).toEqual([[100, 30]]);
    expect(() => manager.restart(7, 'A', a.sessionId, process.cwd())).toThrow();
    processes[0].exit({ exitCode: 3 }); expect(manager.list(7, 'A')[0].exitCode).toBe(3);
    expect(() => manager.input(7, 'A', a.sessionId, 'bad')).toThrow();
    const next = manager.restart(7, 'A', a.sessionId, process.cwd()); expect(next.sessionId).not.toBe(a.sessionId);
    expect(processes[1].written).toBe(''); manager.closeOwner(7); expect(processes[1].killed).toBe(true);
  });
  it('rejects arbitrary renderer process parameters and malformed requests', () => {
    expect(TerminalRequest.safeParse({ type: 'open', botId: 'A', cwd: '/tmp', command: 'echo bad' }).success).toBe(false);
    expect(TerminalRequest.safeParse({ type: 'resize', botId: 'A', sessionId: 'x', cols: 0, rows: -1 }).success).toBe(false);
    expect(installedShells().shells).toContain(installedShells().defaultShell);
  });
});

describe('terminal IPC authority', () => {
  it('rejects foreign frames, nonexistent bots, and navigation while resolving cwd', async () => {
    const { installTerminalIPC } = await import('../../src/main/terminal-ipc');
    let handler: any; let valid = false;
    const ipc = { handle(_channel: string, h: any) { handler = h; } } as any;
    const event = { sender: { id: 1, isDestroyed: () => false } } as any;
    const manager = new BotTerminals(() => {});
    installTerminalIPC(ipc, manager, () => valid, async () => null);
    await expect(handler(event, { type: 'shells' })).rejects.toThrow('main frame');
    valid = true; await expect(handler(event, { type: 'open', botId: 'missing' })).rejects.toThrow('no longer available');
    installTerminalIPC(ipc, manager, () => valid, async () => { valid = false; return process.cwd(); });
    await expect(handler(event, { type: 'open', botId: 'A' })).rejects.toThrow('no longer available');
  });
  it('bounds streaming with acknowledgements and keeps startup bytes until attach', () => {
    let data: (value: string) => void = () => {}; let paused = false;
    const manager = new BotTerminals(() => {}, (() => ({onData(cb: any) { data = cb; },onExit() {},pause() { paused = true; },resume() { paused = false; }})) as any);
    const tab = manager.open(1, 'A', process.cwd());
    data('起動');data('x'.repeat(300_000)); expect(paused).toBe(true);
    const attached = manager.attach(1, 'A', tab.sessionId);expect(attached.output.startsWith('起動')).toBe(true);
    manager.ack(1, 'A', tab.sessionId, attached.offset + 1); expect(paused).toBe(true);
    manager.ack(1, 'A', tab.sessionId, attached.offset); expect(paused).toBe(false);
  });
});

describe('late PTY events after terminal disposal', () => {
  it('detaches listeners and refuses late data/exit after tab close, bot removal and shutdown', () => {
    const processes: any[] = [], emitted: any[] = [];
    const manager = new BotTerminals((owner, event) => emitted.push({ owner, event }), (() => {
      const p = { disposed: 0, killed: 0, onData(cb: any) { this.data = cb; return { dispose: () => this.disposed++ }; },
        onExit(cb: any) { this.exit = cb; return { dispose: () => this.disposed++ }; }, kill() { this.killed++; } } as any;
      processes.push(p); return p;
    }) as any);
    const a = manager.open(1, 'A', process.cwd()); manager.close(1, 'A', a.sessionId);
    const b = manager.open(1, 'A', process.cwd()); manager.remove('A');
    const c = manager.open(1, 'B', process.cwd()); manager.closeAll();
    for (const p of processes) { p.data('late output'); p.exit({ exitCode: 0 }); }
    expect(emitted).toEqual([]);
    expect(processes.map(p => p.disposed)).toEqual([2, 2, 2]);
    expect(processes.map(p => p.killed)).toEqual([1, 1, 1]);
    expect(manager.list(1, 'A')).toEqual([]); expect(manager.list(1, 'B')).toEqual([]);
    expect([a.sessionId, b.sessionId, c.sessionId].length).toBe(3);
  });
});

it('drops delivery only for destroyed destinations, preserving other transport errors', async () => {
  const { sendTerminalEvent } = await import('../../src/main/terminal-transport');
  const event = { type: 'exit', botId: 'A', sessionId: 'tab', exitCode: 0 } as const;
  let destroyed = true, sends = 0;
  const contents = { isDestroyed: () => destroyed, send: () => { sends++; } };
  expect(sendTerminalEvent(contents, event)).toBe(false);expect(sends).toBe(0);
  destroyed = false;expect(sendTerminalEvent(contents, event)).toBe(true);expect(sends).toBe(1);
  contents.send = () => { destroyed = true; throw new Error('Object has been destroyed'); };
  expect(sendTerminalEvent(contents, event)).toBe(false);
  destroyed = false; contents.send = () => { throw new Error('genuine transport defect'); };
  expect(() => sendTerminalEvent(contents, event)).toThrow('genuine transport defect');
});
it('cannot spawn a terminal after shutdown and preserves binary mouse bytes', async () => {
  let written: unknown;
  const manager = new BotTerminals(() => {}, (() => ({ onData() {}, onExit() {}, write(value: unknown) { written = value; },kill() {} })) as any);
  const tab=manager.open(1,'A',process.cwd());
  manager.input(1,'A',tab.sessionId,'\x1b[M\xff',true);
  expect(written).toEqual(Buffer.from([27,91,77,255]));
  await manager.closeAll();expect(()=>manager.open(1,'A',process.cwd())).toThrow('shutting down');
});
