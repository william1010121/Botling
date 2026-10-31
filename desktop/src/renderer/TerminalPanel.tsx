import { useEffect, useRef, useState } from 'react';
import { terminalToggleAction } from './terminal-toggle';
import { createPortal } from 'react-dom';
import { ShellOverlay } from './ShellOverlay';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { TerminalBridge, TerminalState, TerminalEvent } from '../contract/terminal';
const bridge = () => (window as unknown as { botling?: { terminal?: TerminalBridge } }).botling?.terminal;

/** Mounted for the lifetime of the shell page; hiding never destroys a PTY or emulator. */
export function TerminalPanels({ botId, botIds, onHide, toggleHost, shortcutLabel = '⌘J' }: { botId?: string; botIds: string[]; onHide?: () => void; toggleHost?: HTMLElement | null; shortcutLabel?: string }) {
  const [opened, setOpened] = useState<string[]>([]);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  // What each mounted panel reports up: how many shells it has (once started) and how to open one.
  const shells = useRef<Record<string, number | undefined>>({});
  const openers = useRef<Record<string, () => void>>({});
  const toggle = () => {
    const action = terminalToggleAction({ botExists: !!botId && botIds.includes(botId), visible: !!botId && !!visible[botId], shells: botId ? shells.current[botId] : undefined });
    if (!botId || action === 'none') return;
    if (action === 'hide') requestAnimationFrame(() => onHide?.());
    setOpened(ids => ids.includes(botId) ? ids : [...ids, botId]);
    setVisible(value => ({ ...value, [botId]: action !== 'hide' }));
    // An empty panel gets a shell, as with +. A panel not yet mounted opens its first shell as it starts.
    if (action === 'open' || action === 'show-and-open') openers.current[botId]?.();
  };
  const latestToggle = useRef(toggle); latestToggle.current = toggle;
  useEffect(() => bridge()?.onToggle(() => latestToggle.current()), []);
  if (!bridge()) return null;
  return <>
    {toggleHost && createPortal(<button className="terminal-toggle" disabled={!botId || !botIds.includes(botId)} aria-expanded={!!botId && !!visible[botId]} onClick={toggle} title={`Toggle terminal (${shortcutLabel})`}>Terminal</button>, toggleHost)}
    {opened.filter(id => botIds.includes(id)).map(id => <TerminalPanel key={id} botId={id} report={count => { shells.current[id] = count; }} register={open => { if (open) openers.current[id] = open; else delete openers.current[id]; }} visible={id === botId && !!visible[id]} hide={() => { setVisible(v => ({ ...v, [id]: false })); requestAnimationFrame(() => onHide?.()); }} />)}
  </>;
}
function TerminalPanel({ botId, visible, hide, report, register }: { botId: string; visible: boolean; hide: () => void; report: (count: number | undefined) => void; register: (open: (() => void) | null) => void }) {
  const [height, setHeight] = useState(300);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  useEffect(() => {
    const update = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const panel = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const resize = (next: number) => setHeight(Math.max(Math.min(120, window.innerHeight * .7), Math.min(window.innerHeight * .7, next)));
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
  const busyNow = useRef(true);
  const add = async () => {
    busyNow.current = true;
    setBusy(true); setError('');
    try {
      const tab = await api.request({ type: 'open', botId, ...(shell ? { shell } : {}) }) as TerminalState;
      setTabs(t => [...t, tab]); setActive(tab.sessionId);
    } catch (e) { fail(e); } finally { busyNow.current = false; setBusy(false); }
  };
  const addNow = useRef(add); addNow.current = add;
  useEffect(() => { register(() => { if (!busyNow.current) void addNow.current(); }); return () => { register(null); report(undefined); }; }, []);
  useEffect(() => { if (!busy) report(tabs.length); }, [busy, tabs.length]);
  useEffect(() => {
    if (initialized.current) return; initialized.current = true;
    void (async () => {
      try {
        const available = await api.request({ type: 'shells' }) as { shells: string[]; defaultShell: string };
        setShells(available.shells); setShell(available.defaultShell);
        const existing = await api.request({ type: 'list', botId }) as TerminalState[];
        if (existing.length) { setTabs(existing); setActive(existing[0].sessionId); busyNow.current = false; setBusy(false); }
        else await add();
      } catch (e) { fail(e); busyNow.current = false; setBusy(false); }
    })();
  }, []);
  const close = async (tab: TerminalState) => {
    closing.current.add(tab.sessionId);
    try { await api.request({ type: 'close', botId, sessionId: tab.sessionId });
      setTabs(t => t.filter(x => x.sessionId !== tab.sessionId));
      if (active === tab.sessionId) setActive(tabs.find(x => x.sessionId !== tab.sessionId)?.sessionId || '');
    } catch (e) { closing.current.delete(tab.sessionId); fail(e); }
  };
  /** A shell that exited on its own just closes its tab; no error, no hint. The last tab also hides the panel. */
  const exited = (tab: TerminalState) => {
    if (closing.current.has(tab.sessionId)) return;
    closing.current.add(tab.sessionId);
    void api.request({ type: 'close', botId, sessionId: tab.sessionId }).catch(() => {});
    setTabs(t => {
      const rest = t.filter(x => x.sessionId !== tab.sessionId);
      setActive(a => a === tab.sessionId ? rest[0]?.sessionId || '' : a);
      if (!rest.length) queueMicrotask(hide);
      return rest;
    });
  };
  const restart = async (tab: TerminalState) => {
    closing.current.add(tab.sessionId);
    try {
      const next = await api.request({ type: 'restart', botId, sessionId: tab.sessionId, shell }) as TerminalState;
      setTabs(t => t.map(x => x.sessionId === tab.sessionId ? next : x)); setActive(next.sessionId);
    } catch (e) { closing.current.delete(tab.sessionId); fail(e); }
  };
  return <section ref={panel} className="terminal-panel" style={{ height }} hidden={!visible} aria-label="Bot terminal">
    {dragging && <ShellOverlay revealImmediately><div className="terminal-drag-shield" /></ShellOverlay>}
    <div className="terminal-divider" role="separator" aria-label="Resize terminal panel" aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={Math.min(120, Math.round(viewportHeight * .7))} aria-valuemax={Math.round(viewportHeight * .7)} aria-valuenow={Math.round(Math.min(height, viewportHeight * .7))}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        setDragging(true);
        drag.current = { y: event.clientY, height: panel.current!.getBoundingClientRect().height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { if (drag.current) resize(drag.current.height + drag.current.y - event.clientY); }}
      onPointerUp={event => { drag.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onKeyDown={event => {
        const current = panel.current!.getBoundingClientRect().height;
        if (event.key === 'ArrowUp') resize(current + 20);
        else if (event.key === 'ArrowDown') resize(current - 20);
        else if (event.key === 'Home') resize(120);
        else if (event.key === 'End') resize(window.innerHeight * .7);
        else return;
        event.preventDefault(); event.stopPropagation();
      }} />
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
    {tabs.map(tab => <TerminalTab key={tab.sessionId} tab={tab} visible={visible && active === tab.sessionId} onError={e => { if (!closing.current.has(tab.sessionId)) fail(e); }} onExit={() => exited(tab)} />)}
    {!tabs.length && <div className="terminal-empty">Use + to open a shell in this bot’s project.</div>}
  </section>;
}
function TerminalTab({ tab, visible, onError, onExit }: { tab: TerminalState; visible: boolean; onError: (e: unknown) => void; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit); onExitRef.current = onExit;
  useEffect(() => { if (tab.exitCode !== null) onExitRef.current(); }, []);
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
      } else onExitRef.current();
    };
    const unsub = api.subscribe(event => {
      if (event.botId !== tab.botId || event.sessionId !== tab.sessionId) return;
      if (!attached) pending.push(event); else accept(event);
    });
    void api.request({ type: 'attach', botId: tab.botId, sessionId: tab.sessionId }).then(value => {
      if (disposed) return;
      const state = value as TerminalState; offset = state.offset; if (state.exitCode !== null) { onExitRef.current(); return; }
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
    <div className="terminal-emulator" ref={host} />
  </div>;
}
