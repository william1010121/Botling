import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty, type IDisposable } from 'node-pty';
import { killTree, processStartTime, signalGroup } from '../../../src/core/process/kill-tree';
import { installedShells, interactiveArgs } from './shells';
import type { TerminalEvent, TerminalState } from './request';

interface Session { state: TerminalState; pty: IPty; paused: boolean; acknowledged: number; subscriptions: IDisposable[]; closed: boolean }
/** The plugin host's only. Never serializes commands or sessions to disk. */
export class BotTerminals {
  private sessions = new Map<string, Session>();
  private stopping = false;
  private ending = new Set<Promise<void>>();
  constructor(private emit: (event: TerminalEvent) => void, private spawnPty = spawn) {}
  list(botId: string) { return [...this.sessions.values()].filter(s => s.state.botId === botId).map(s => ({ ...s.state })); }
  open(botId: string, cwd: string, shell?: string): TerminalState {
    if (this.stopping) throw new Error('Terminals are shutting down.');
    if (!isAbsolute(cwd) || !statSync(realpathSync(cwd)).isDirectory()) throw new Error('Bot project directory is unavailable.');
    const available = installedShells();
    shell ??= available.defaultShell;
    if (!available.shells.includes(shell)) throw new Error('Select an installed shell.');
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Botling', LANG: process.env.LANG || 'en_US.UTF-8' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const pty = this.spawnPty(shell, interactiveArgs(), { cwd: realpathSync(cwd), env, name: 'xterm-256color', cols: 80, rows: 24 });
    const state: TerminalState = { botId, sessionId: randomUUID(), shell, output: '', offset: 0, exitCode: null };
    const session: Session = { state, pty, paused: false, acknowledged: 0, subscriptions: [], closed: false };
    this.sessions.set(state.sessionId, session);
    session.subscriptions.push(pty.onData(data => {
      if (session.closed || state.exitCode !== null) return;
      state.offset += data.length;
      state.output = (state.output + data).slice(-1024 * 1024);
      this.emit({ type: 'data', botId, sessionId: state.sessionId, data, offset: state.offset });
      if (!session.closed && state.offset - session.acknowledged > 256 * 1024) { session.paused = true; pty.pause(); }
    }));
    session.subscriptions.push(pty.onExit(({ exitCode }) => {
      if (session.closed || state.exitCode !== null) return;
      state.exitCode = exitCode; this.disposeSubscriptions(session);
      this.emit({ type: 'exit', botId, sessionId: state.sessionId, exitCode });
    }));
    return { ...state };
  }
  private owned(botId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.state.botId !== botId || session.state.sessionId !== sessionId) throw new Error('Terminal session is no longer available.');
    return session;
  }
  attach(botId: string, id: string) { return { ...this.owned(botId, id).state }; }
  ack(botId: string, id: string, offset: number) {
    const s = this.owned(botId, id);
    if (offset > s.state.offset || offset < s.acknowledged) return;
    s.acknowledged = offset;
    if (s.paused && s.state.offset - offset < 64 * 1024) { s.paused = false; s.pty.resume(); }
  }
  input(botId: string, id: string, data: string, binary = false) {
    const s = this.owned(botId, id); if (s.state.exitCode !== null) return; s.pty.write(binary ? Buffer.from(data, 'binary') : data);
  }
  resize(botId: string, id: string, cols: number, rows: number) {
    const s = this.owned(botId, id); if (s.state.exitCode === null) s.pty.resize(cols, rows);
  }
  restart(botId: string, id: string, cwd: string, shell?: string) {
    const s = this.owned(botId, id);
    if (s.state.exitCode === null) throw new Error('Exit the running shell before restarting.');
    this.close(botId, id); return this.open(botId, cwd, shell);
  }
  private disposeSubscriptions(session: Session) {
    for (const subscription of session.subscriptions.splice(0)) subscription?.dispose();
  }
  /** Ends one session: SIGHUP now; `escalate` says what happens to a shell that is still the same one after 300 ms. */
  private end(s: Session, escalate: (pid: number, started: string, pty: IPty) => void) {
    s.closed = true; this.sessions.delete(s.state.sessionId);
    this.disposeSubscriptions(s);
    if (s.state.exitCode !== null) return;
    const pid = s.pty.pid;
    const started = pid > 1 ? processStartTime(pid) : null;
    if (process.platform !== 'win32') signalGroup(pid, 'SIGHUP');
    try { s.pty.kill(); } catch {}
    if (started) escalate(pid, started, s.pty);
  }
  /** Escalate only while this same shell is alive; never signal a recycled PID. */
  private static force(pid: number, started: string, pty: IPty) {
    if (processStartTime(pid) !== started) return;
    if (process.platform === 'win32') killTree(pid, 'SIGKILL');
    else signalGroup(pid, 'SIGKILL');
    try { pty.kill('SIGKILL'); } catch {}
  }
  close(botId: string, id: string) {
    const s = this.owned(botId, id);
    this.end(s, (pid, started, pty) => {
      const ending = new Promise<void>(resolve => setTimeout(() => { BotTerminals.force(pid, started, pty); resolve(); }, 300));
      this.ending.add(ending); void ending.then(() => this.ending.delete(ending));
    });
  }
  remove(botId: string) { for (const [id, s] of this.sessions) if (s.state.botId === botId) this.close(botId, id); }
  async closeAll() { this.stopping = true; for (const [id, s] of this.sessions) this.close(s.state.botId, id); await Promise.all(this.ending); }
  /**
   * `closeAll` for a plugin host that is unloading its plugin and may exit right after (nothing awaits it): SIGHUP every shell, wait
   * up to `waitMs` here, then force the ones that ignored it.
   */
  closeAllNow(waitMs = 300) {
    this.stopping = true;
    const left: [number, string, IPty][] = [];
    for (const s of [...this.sessions.values()]) this.end(s, (pid, started, pty) => left.push([pid, started, pty]));
    if (!left.length) return;
    const until = Date.now() + waitMs;
    // Nothing else runs in a host that is going; wait a little for shells to leave on their own.
    while (Date.now() < until && left.some(([pid, started]) => processStartTime(pid) === started)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    for (const [pid, started, pty] of left) BotTerminals.force(pid, started, pty);
  }
}
