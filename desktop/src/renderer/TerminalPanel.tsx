import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { TerminalBridge, TerminalState, TerminalEvent } from '../contract/terminal';
const bridge = () => (window as unknown as { botling?: { terminal?: TerminalBridge } }).botling?.terminal;

/** Mounted for the lifetime of the shell page; hiding never destroys a PTY or emulator. */
export function TerminalPanels({ botId, botIds, onHide }: { botId?: string; botIds: string[]; onHide?: () => void }) {
  const [opened, setOpened] = useState<string[]>([]);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const toggle = () => {
    if (!botId) return;
    if (visible[botId]) requestAnimationFrame(() => onHide?.());
    setOpened(ids => ids.includes(botId) ? ids : [...ids, botId]);
    setVisible(value => ({ ...value, [botId]: !value[botId] }));
  };
  useEffect(() => bridge()?.onToggle(toggle), [botId, visible]);
  if (!bridge()) return null;
  return <>
    <button className="terminal-toggle" onClick={toggle} title="Toggle terminal (⌘J)">Terminal</button>
    {opened.filter(id => botIds.includes(id)).map(id => <TerminalPanel key={id} botId={id} visible={id === botId && !!visible[id]} hide={() => { setVisible(v => ({ ...v, [id]: false })); requestAnimationFrame(() => onHide?.()); }} />)}
  </>;
}
function TerminalPanel({ botId, visible, hide }: { botId: string; visible: boolean; hide: () => void }) {
  const [tabs, setTabs] = useState<TerminalState[]>([]);
  const [active, setActive] = useState('');
  const [shells, setShells] = useState<string[]>([]);
  const [shell, setShell] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const initialized = useRef(false);
  const closing = useRef(new Set<string>());
  const api = bridge()!;
  const fail = (e: unknown) => setError(String(e));
  const add = async () => {
    setBusy(true); setError('');
    try {
      const tab = await api.request({ type: 'open', botId, ...(shell ? { shell } : {}) }) as TerminalState;
      setTabs(t => [...t, tab]); setActive(tab.sessionId);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (initialized.current) return; initialized.current = true;
    void (async () => {
      try {
        const available = await api.request({ type: 'shells' }) as { shells: string[]; defaultShell: string };
        setShells(available.shells); setShell(available.defaultShell);
        const existing = await api.request({ type: 'list', botId }) as TerminalState[];
        if (existing.length) { setTabs(existing); setActive(existing[0].sessionId); setBusy(false); }
        else await add();
      } catch (e) { fail(e); setBusy(false); }
    })();
  }, []);
  const close = async (tab: TerminalState) => {
    closing.current.add(tab.sessionId);
    try { await api.request({ type: 'close', botId, sessionId: tab.sessionId });
      setTabs(t => t.filter(x => x.sessionId !== tab.sessionId));
      if (active === tab.sessionId) setActive(tabs.find(x => x.sessionId !== tab.sessionId)?.sessionId || '');
    } catch (e) { closing.current.delete(tab.sessionId); fail(e); }
  };
  const restart = async (tab: TerminalState) => {
    closing.current.add(tab.sessionId);
    try {
      const next = await api.request({ type: 'restart', botId, sessionId: tab.sessionId, shell }) as TerminalState;
      setTabs(t => t.map(x => x.sessionId === tab.sessionId ? next : x)); setActive(next.sessionId);
    } catch (e) { closing.current.delete(tab.sessionId); fail(e); }
  };
  return <section className="terminal-panel" hidden={!visible} aria-label="Bot terminal">
    <div className="terminal-toolbar">
      <div role="tablist" aria-label="Terminals">{tabs.map((tab, i) => <span key={tab.sessionId}>
        <button role="tab" aria-selected={active === tab.sessionId} onClick={() => setActive(tab.sessionId)}>{i + 1}: {tab.shell.split('/').pop()}</button>
        <button aria-label={`Close terminal ${i + 1}`} title="Close tab and stop its shell" onClick={() => void close(tab)}>×</button>
      </span>)}</div>
      <select aria-label="Shell for new terminal" value={shell} onChange={e => setShell(e.target.value)}>{shells.map(s => <option key={s}>{s}</option>)}</select>
      <button disabled={busy} onClick={() => void add()} aria-label="New terminal">+</button>
      <button onClick={hide} aria-label="Hide terminal panel">−</button>
    </div>
    {error && <div role="alert">{error}</div>}
    {tabs.map(tab => <TerminalTab key={tab.sessionId} tab={tab} visible={visible && active === tab.sessionId} onError={e => { if (!closing.current.has(tab.sessionId)) fail(e); }} restart={() => void restart(tab)} />)}
    {!tabs.length && <div className="terminal-empty">Use + to open a shell in this bot’s project.</div>}
  </section>;
}
function TerminalTab({ tab, visible, onError, restart }: { tab: TerminalState; visible: boolean; onError: (e: unknown) => void; restart: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [exit, setExit] = useState(tab.exitCode);
  useEffect(() => {
    const api = bridge()!;
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, fontSize: 13, fontFamily: '"Botling Terminal", "MesloLGS NF", "SFMono-Regular", Menlo, monospace', scrollback: 5000, theme: { background: '#111318', foreground: '#e5e7eb' } });
    const fitter = new FitAddon(); term.loadAddon(fitter); term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
    terminal.current = term; fit.current = fitter;
    term.open(host.current!);
    void document.fonts.load('13px "Botling Terminal"').then(() => { if (terminal.current === term) { term.refresh(0, term.rows - 1); if (host.current?.offsetHeight) fitter.fit(); } });
    const send = (request: Parameters<TerminalBridge['request']>[0]) => void api.request(request).catch(onError);
    let attached = false, disposed = false, offset = 0;
    const pending: TerminalEvent[] = [];
    const accept = (event: TerminalEvent) => {
      if (event.type === 'data') {
        if (event.offset <= offset) return;
        offset = event.offset;
        term.write(event.data, () => { if (!disposed) send({ type: 'ack', botId: tab.botId, sessionId: tab.sessionId, offset: event.offset }); });
      } else setExit(event.exitCode);
    };
    const unsub = api.subscribe(event => {
      if (event.botId !== tab.botId || event.sessionId !== tab.sessionId) return;
      if (!attached) pending.push(event); else accept(event);
    });
    void api.request({ type: 'attach', botId: tab.botId, sessionId: tab.sessionId }).then(value => {
      if (disposed) return;
      const state = value as TerminalState; offset = state.offset; setExit(state.exitCode);
      term.write(state.output, () => { if (!disposed) send({ type: 'ack', botId: tab.botId, sessionId: tab.sessionId, offset: state.offset }); });
      attached = true; pending.forEach(accept); pending.length = 0;
    }).catch(onError);
    const input = term.onData(data => send({ type: 'input', botId: tab.botId, sessionId: tab.sessionId, data }));
    const binaryInput = term.onBinary(data => send({ type: 'input', botId: tab.botId, sessionId: tab.sessionId, data, binary: true }));
    const resize = term.onResize(({ cols, rows }) => send({ type: 'resize', botId: tab.botId, sessionId: tab.sessionId, cols, rows }));
    // Keep terminal control keys out of app-level keyboard shortcuts; native Edit handles Cmd+C/V.
    term.attachCustomKeyEventHandler(event => {
      if (event.metaKey) return false;
      event.stopPropagation(); return true;
    });
    const observer = new ResizeObserver(() => { if (host.current?.offsetHeight) fitter.fit(); }); observer.observe(host.current!);
    return () => { disposed = true; terminal.current = null; observer.disconnect(); unsub(); input.dispose(); binaryInput.dispose(); resize.dispose(); term.dispose(); };
  }, [tab.sessionId]);
  useEffect(() => { if (visible) { fit.current?.fit(); terminal.current?.focus(); } }, [visible]);
  return <div className="terminal-tab" hidden={!visible}>
    {exit !== null && <div role="status">Shell exited ({exit}). <button onClick={restart}>Restart terminal</button></div>}
    <div className="terminal-emulator" ref={host} />
  </div>;
}
