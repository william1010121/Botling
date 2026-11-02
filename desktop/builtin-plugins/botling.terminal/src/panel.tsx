// The Terminal panel of one bot, in its frame. The page around it lays the frame out (border, divider, height) and says when it is
// shown; this draws the tabs and the emulators. Hiding never destroys a shell or an emulator: the frame stays alive while hidden.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { terminalToggleAction } from './toggle';
import type { TerminalAnswer, TerminalBridge, TerminalEvent, TerminalRequest, TerminalState } from './request';

/** The part of the frame's `ccb` the panel uses. */
export interface PanelCcb {
  panels: { register(id: string, render: (root: HTMLElement) => (() => void) | void): () => void };
  call(method: string, params?: unknown): Promise<unknown>;
  on(name: string, handler: (data: any) => void): () => void;
  panel: { setVisible(visible: boolean): void };
  forwardKey(event: KeyboardEvent): void;
  context?: { botId?: string };
}

/** The terminal font, while it loads (web.ts sets it): a tab measures its cells and paints once it is there. */
let fontLoading: Promise<unknown> = Promise.resolve();
export const fontIsLoading = (loading: Promise<unknown>) => { fontLoading = loading.catch(() => {}); };

export const bridgeOf = (ccb: Pick<PanelCcb, 'call' | 'on'>): TerminalBridge => ({
  request: (request) => ccb.call('terminal', request) as Promise<TerminalAnswer>,
  subscribe: (listener) => ccb.on('terminal', listener),
});

/** The most one input request carries (the program part takes 64 KB). */
const INPUT_CHUNK = 60_000;

/**
 * Sends one tab's requests one after another, so they reach the shell in the order they were made, and merges what piles up while
 * one is on its way: keys typed meanwhile are one input, only the newest acknowledgement and window size are sent.
 */
export function lane(bridge: Pick<TerminalBridge, 'request'>, botId: string, sessionId: string, onError: (error: unknown) => void) {
  type Item = Extract<TerminalRequest, { type: 'input' | 'ack' | 'resize' }>;
  const queue: Item[] = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    try { while (queue.length) { const next = queue.shift()!; await bridge.request(next).catch(onError); } }
    finally { busy = false; }
  };
  return {
    input(data: string, binary = false) {
      while (data) {
        let cut = Math.min(INPUT_CHUNK, data.length);
        // Never between the halves of a character outside the BMP.
        if (cut < data.length && /[\uD800-\uDBFF]/.test(data[cut - 1]!)) cut -= 1;
        const piece = data.slice(0, cut); data = data.slice(cut);
        const last = queue[queue.length - 1];
        if (last?.type === 'input' && !!last.binary === binary && last.data.length + piece.length <= INPUT_CHUNK) last.data += piece;
        else queue.push({ type: 'input', botId, sessionId, data: piece, ...(binary ? { binary: true } : {}) });
      }
      void pump();
    },
    ack(offset: number) {
      const at = queue.findIndex(item => item.type === 'ack');
      if (at >= 0) (queue[at] as Extract<Item, { type: 'ack' }>).offset = offset; else queue.push({ type: 'ack', botId, sessionId, offset });
      void pump();
    },
    resize(cols: number, rows: number) {
      const at = queue.findIndex(item => item.type === 'resize');
      if (at >= 0) Object.assign(queue[at]!, { cols, rows }); else queue.push({ type: 'resize', botId, sessionId, cols, rows });
      void pump();
    },
  };
}

export function TerminalPanel({ ccb, botId }: { ccb: PanelCcb; botId: string }) {
  const bridge = useMemo(() => bridgeOf(ccb), [ccb]);
  const [visible, setVisible] = useState(false);
  const [tabs, setTabs] = useState<TerminalState[]>([]);
  const [active, setActive] = useState('');
  const [shells, setShells] = useState<string[]>([]);
  const [shell, setShell] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const initialized = useRef(false);
  const closing = useRef(new Set<string>());
  const fail = (e: unknown) => setError(String((e as Error)?.message ?? e));
  const busyNow = useRef(true);
  const hide = () => ccb.panel.setVisible(false);
  const add = async () => {
    busyNow.current = true;
    setBusy(true); setError('');
    try {
      const tab = await bridge.request({ type: 'open', botId, ...(shell ? { shell } : {}) }) as TerminalState;
      setTabs(t => [...t, tab]); setActive(tab.sessionId);
    } catch (e) { fail(e); } finally { busyNow.current = false; setBusy(false); }
  };
  const addNow = useRef(add); addNow.current = add;
  // How many shells the panel has once it started, for what the toggle key does (an empty panel opens a shell).
  const shellCount = useRef<number | undefined>(undefined);
  shellCount.current = busy ? undefined : tabs.length;
  useEffect(() => ccb.on('visible', (data: { visible?: boolean } | null) => setVisible(!!data?.visible)), []);
  useEffect(() => ccb.on('toggle', (data: { visible?: boolean } | null) => {
    const action = terminalToggleAction({ botExists: true, visible: !!data?.visible, shells: shellCount.current });
    if (action === 'none') return;
    ccb.panel.setVisible(action !== 'hide');
    // An empty panel gets a shell, as with +. A panel still starting opens its first shell itself.
    if (action === 'open' || action === 'show-and-open') { if (!busyNow.current) void addNow.current(); }
  }), []);
  useEffect(() => {
    if (initialized.current) return; initialized.current = true;
    void (async () => {
      try {
        const available = await bridge.request({ type: 'shells' }) as { shells: string[]; defaultShell: string };
        setShells(available.shells); setShell(available.defaultShell);
        const existing = await bridge.request({ type: 'list', botId }) as TerminalState[];
        if (existing.length) { setTabs(existing); setActive(existing[0].sessionId); busyNow.current = false; setBusy(false); }
        else await add();
      } catch (e) { fail(e); busyNow.current = false; setBusy(false); }
    })();
  }, []);
  const close = async (tab: TerminalState) => {
    closing.current.add(tab.sessionId);
    try { await bridge.request({ type: 'close', botId, sessionId: tab.sessionId });
      setTabs(t => t.filter(x => x.sessionId !== tab.sessionId));
      if (active === tab.sessionId) setActive(tabs.find(x => x.sessionId !== tab.sessionId)?.sessionId || '');
    } catch (e) { closing.current.delete(tab.sessionId); fail(e); }
  };
  /** A shell that exited on its own just closes its tab; no error, no hint. The last tab also hides the panel. */
  const exited = (tab: TerminalState) => {
    if (closing.current.has(tab.sessionId)) return;
    closing.current.add(tab.sessionId);
    void bridge.request({ type: 'close', botId, sessionId: tab.sessionId }).catch(() => {});
    setTabs(t => {
      const rest = t.filter(x => x.sessionId !== tab.sessionId);
      setActive(a => a === tab.sessionId ? rest[0]?.sessionId || '' : a);
      if (!rest.length) queueMicrotask(hide);
      return rest;
    });
  };
  return <section className="terminal-panel" aria-label="Bot terminal">
    <div className="terminal-toolbar">
      <div role="tablist" aria-label="Terminals">{tabs.map((tab, i) => <span key={tab.sessionId}>
        <button role="tab" aria-selected={active === tab.sessionId} onClick={() => setActive(tab.sessionId)}>{i + 1}: {tab.shell.split('/').pop()}</button>
        <button aria-label={`Close terminal ${i + 1}`} title="Close tab and stop its shell" onClick={() => void close(tab)}>×</button>
      </span>)}</div>
      <select aria-label="Shell for new terminal" value={shell} onChange={e => setShell((e.target as HTMLSelectElement).value)}>{shells.map(s => <option key={s}>{s}</option>)}</select>
      <button disabled={busy} onClick={() => void add()} aria-label="New terminal">+</button>
      <button onClick={hide} aria-label="Hide terminal panel">−</button>
    </div>
    {error && <div role="alert">{error}</div>}
    {tabs.map(tab => <TerminalTab key={tab.sessionId} ccb={ccb} bridge={bridge} tab={tab} visible={visible && active === tab.sessionId} onError={e => { if (!closing.current.has(tab.sessionId)) fail(e); }} onExit={() => exited(tab)} />)}
    {!tabs.length && <div className="terminal-empty">Use + to open a shell in this bot’s project.</div>}
  </section>;
}

function TerminalTab({ ccb, bridge, tab, visible, onError, onExit }: { ccb: PanelCcb; bridge: TerminalBridge; tab: TerminalState; visible: boolean; onError: (e: unknown) => void; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit); onExitRef.current = onExit;
  useEffect(() => { if (tab.exitCode !== null) onExitRef.current(); }, []);
  useEffect(() => {
    const term = new Terminal({ allowProposedApi: true, cursorBlink: true, fontSize: 13, fontFamily: '"Botling Terminal", "MesloLGS NF", "SFMono-Regular", Menlo, monospace', scrollback: 5000, theme: { background: '#111318', foreground: '#e5e7eb' } });
    const fitter = new FitAddon(); term.loadAddon(fitter); term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
    terminal.current = term; fit.current = fitter;
    term.open(host.current!);
    void fontLoading.then(() => document.fonts.load('13px "Botling Terminal"')).then(() => { if (terminal.current === term) { term.refresh(0, term.rows - 1); if (host.current?.offsetHeight) fitter.fit(); } });
    const send = lane(bridge, tab.botId, tab.sessionId, onError);
    let attached = false, disposed = false, offset = 0;
    const pending: TerminalEvent[] = [];
    const accept = (event: TerminalEvent) => {
      if (event.type === 'data') {
        if (event.offset <= offset) return;
        offset = event.offset;
        term.write(event.data, () => { if (!disposed) send.ack(event.offset); });
      } else onExitRef.current();
    };
    const unsub = bridge.subscribe(event => {
      if (event.botId !== tab.botId || event.sessionId !== tab.sessionId) return;
      if (!attached) pending.push(event); else accept(event);
    });
    void bridge.request({ type: 'attach', botId: tab.botId, sessionId: tab.sessionId }).then(value => {
      if (disposed) return;
      const state = value as TerminalState; offset = state.offset; if (state.exitCode !== null) { onExitRef.current(); return; }
      term.write(state.output, () => { if (!disposed) send.ack(state.offset); });
      attached = true; pending.forEach(accept); pending.length = 0;
    }).catch(onError);
    const input = term.onData(data => send.input(data));
    const binaryInput = term.onBinary(data => send.input(data, true));
    const resize = term.onResize(({ cols, rows }) => send.resize(cols, rows));
    // A key with the Command key held is the app's (its shortcuts, handed to the page); the rest, Ctrl+C among them, is the shell's.
    // Copy and paste are the native Edit menu's.
    term.attachCustomKeyEventHandler(event => {
      if (event.metaKey) { if (event.type === 'keydown') ccb.forwardKey(event); return false; }
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
