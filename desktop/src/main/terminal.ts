import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { killTree, processStartTime, signalGroup } from '../core/process/kill-tree';
import { installedShells, interactiveArgs } from '../core/shell';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty, type IDisposable } from 'node-pty';
import type { TerminalEvent, TerminalState } from '../contract/terminal';

interface Session { state: TerminalState; owner: number; pty: IPty; paused: boolean; acknowledged: number; subscriptions: IDisposable[]; closed: boolean }
/** Main-process only. Never serializes commands or sessions to disk. */
export class BotTerminals {
  private sessions = new Map<string, Session>();
  private stopping = false;
  private ending = new Set<Promise<void>>();
  constructor(private emit: (owner: number, event: TerminalEvent) => void, private spawnPty = spawn) {}
  list(owner: number, botId: string) { return [...this.sessions.values()].filter(s => s.owner === owner && s.state.botId === botId).map(s => ({ ...s.state })); }
  open(owner: number, botId: string, cwd: string, shell?: string): TerminalState {
    if (this.stopping) throw new Error('Terminals are shutting down.');
    if (!isAbsolute(cwd) || !statSync(realpathSync(cwd)).isDirectory()) throw new Error('Bot project directory is unavailable.');
    const available = installedShells();
    shell ??= available.defaultShell;
    if (!available.shells.includes(shell)) throw new Error('Select an installed shell.');
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Botling', LANG: process.env.LANG || 'en_US.UTF-8' };
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const pty = this.spawnPty(shell, interactiveArgs(), { cwd: realpathSync(cwd), env, name: 'xterm-256color', cols: 80, rows: 24 });
    const state: TerminalState = { botId, sessionId: randomUUID(), shell, output: '', offset: 0, exitCode: null };
    const session: Session = { state, owner, pty, paused: false, acknowledged: 0, subscriptions: [], closed: false };
    this.sessions.set(state.sessionId, session);
    session.subscriptions.push(pty.onData(data => {
      if (session.closed || state.exitCode !== null) return;
      state.offset += data.length;
      state.output = (state.output + data).slice(-1024 * 1024);
      this.emit(owner, { type: 'data', botId, sessionId: state.sessionId, data, offset: state.offset });
      if (!session.closed && state.offset - session.acknowledged > 256 * 1024) { session.paused = true; pty.pause(); }
    }));
    session.subscriptions.push(pty.onExit(({ exitCode }) => {
      if (session.closed || state.exitCode !== null) return;
      state.exitCode = exitCode; this.disposeSubscriptions(session);
      this.emit(owner, { type: 'exit', botId, sessionId: state.sessionId, exitCode });
    }));
    return { ...state };
  }
  private owned(owner: number, botId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner || session.state.botId !== botId || session.state.sessionId !== sessionId) throw new Error('Terminal session is no longer owned by this window.');
    return session;
  }
  attach(owner: number, botId: string, id: string) { return { ...this.owned(owner, botId, id).state }; }
  ack(owner: number, botId: string, id: string, offset: number) {
    const s = this.owned(owner, botId, id);
    if (offset > s.state.offset || offset < s.acknowledged) return;
    s.acknowledged = offset;
    if (s.paused && s.state.offset - offset < 64 * 1024) { s.paused = false; s.pty.resume(); }
  }
  input(owner: number, botId: string, id: string, data: string, binary = false) {
    const s = this.owned(owner, botId, id); if (s.state.exitCode !== null) return; s.pty.write(binary ? Buffer.from(data, 'binary') : data);
  }
  resize(owner: number, botId: string, id: string, cols: number, rows: number) {
    const s = this.owned(owner, botId, id); if (s.state.exitCode === null) s.pty.resize(cols, rows);
  }
  restart(owner: number, botId: string, id: string, cwd: string, shell?: string) {
    const s = this.owned(owner, botId, id);
    if (s.state.exitCode === null) throw new Error('Exit the running shell before restarting.');
    this.close(owner, botId, id); return this.open(owner, botId, cwd, shell);
  }
  private disposeSubscriptions(session: Session) {
    for (const subscription of session.subscriptions.splice(0)) subscription?.dispose();
  }
  close(owner: number, botId: string, id: string) {
    const s = this.owned(owner, botId, id); s.closed = true; this.sessions.delete(id);
    this.disposeSubscriptions(s);
    if (s.state.exitCode === null) {
      const pid = s.pty.pid;
      const started = pid > 1 ? processStartTime(pid) : null;
      if (process.platform !== 'win32') signalGroup(pid, 'SIGHUP');
      try { s.pty.kill(); } catch {}
      if (started) {
        const ending = new Promise<void>(resolve => setTimeout(() => {
          // Escalate only while this same shell is alive; never signal a recycled PID.
          if (processStartTime(pid) === started) {
            if (process.platform === 'win32') killTree(pid, 'SIGKILL');
            else signalGroup(pid, 'SIGKILL');
            try { s.pty.kill('SIGKILL'); } catch {}
          }
          resolve();
        }, 300));
        this.ending.add(ending); void ending.then(() => this.ending.delete(ending));
      }
    }
  }
  remove(botId: string) { for (const [id, s] of this.sessions) if (s.state.botId === botId) this.close(s.owner, botId, id); }
  closeOwner(owner: number) { for (const [id, s] of this.sessions) if (s.owner === owner) this.close(owner, s.state.botId, id); }
  async closeAll() { this.stopping = true; for (const [id, s] of this.sessions) this.close(s.owner, s.state.botId, id); await Promise.all(this.ending); }
}
