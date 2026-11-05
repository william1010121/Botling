// Panels under the chat that plugins bring (`bottomPanel` views; the Terminal is one). The page lays them out: one frame per bot
// the panel was opened for, kept alive while hidden (hiding never ends what the plugin runs), a divider to drag its height, and
// a button in the chat header to show or hide the one of the bot on screen. What is inside is the plugin's own: its frame asks to
// be shown or hidden (`ccb.panel.setVisible`) and hears when it is (event "visible") and when its toggle command ran (event
// "toggle", with whether it is shown now), so it can decide (an empty terminal opens a shell instead of hiding).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { frameEvent } from "../../../Web/src/frame-protocol";
import type { Client } from "./client";
import { BottomPanelFrame, type BuiltinRunner, type FrameServices } from "./Plugins";
import { ShellOverlay } from "./ShellOverlay";

import { bottomPanelToggledBy, type BottomPanel } from "./plugin-commands";

// Plain TypeScript in plugin-commands.ts, so the chat page's tests (Web, no JSX) can import the command routing.
export { bottomPanelToggledBy, type BottomPanel };

/** The page-wide signal that a bottom panel's toggle command ran (key, menu or palette): the command's id. */
export const TOGGLE_BOTTOM_PANEL = "botling:bottom-panel-toggle";

/** A panel that streams (a terminal's keys and acknowledgements) calls far more often than the 10 a second most frames get. */
const STREAMING_RATE = { burst: 400, perSecond: 400 };
const MIN_HEIGHT = 120;
const itemKey = (panel: BottomPanel, botId: string) => `${panel.plugin}/${panel.id}/${botId}`;

export function BottomPanels({ client, panels, botId, botIds, onHide, toggleHost, shortcutFor, onBuiltin, onKey, ...services }: {
  client: Client; panels: BottomPanel[]; botId?: string; botIds: string[]; onHide?: () => void; toggleHost?: HTMLElement | null;
  /** How the key of a panel's toggle command is written now (empty: none). */
  shortcutFor: (command: string | undefined) => string;
  onBuiltin: BuiltinRunner;
  /** A key a panel's frame did not use: the page's shortcuts get it, attributed to `plugin`. */
  onKey: (plugin: string, key: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }) => void;
} & FrameServices) {
  // The (panel, bot) pairs whose frames exist, and which of them are shown.
  const [opened, setOpened] = useState<string[]>([]);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const frames = useRef(new Map<string, { frame: HTMLIFrameElement | null; ready: boolean }>());
  const setShown = (key: string, shown: boolean) => {
    setVisible((now) => (!!now[key] === shown ? now : { ...now, [key]: shown }));
    if (!shown) requestAnimationFrame(() => onHide?.());
  };
  const toggle = (panel: BottomPanel) => {
    if (!botId || !botIds.includes(botId)) return;
    const key = itemKey(panel, botId);
    if (!opened.includes(key)) { setOpened((now) => [...now, key]); setVisible((now) => ({ ...now, [key]: true })); return; }
    const entry = frames.current.get(key);
    // Its frame decides (it knows whether it has anything to show); one not up yet is just shown or hidden.
    if (entry?.ready && entry.frame?.contentWindow) entry.frame.contentWindow.postMessage(frameEvent("toggle", { visible: !!visible[key] }), "*");
    else setShown(key, !visible[key]);
  };
  const latest = useRef(toggle);
  latest.current = toggle;
  const panelsNow = useRef(panels);
  panelsNow.current = panels;
  useEffect(() => {
    const onToggle = (event: Event) => {
      const panel = panelsNow.current.find((candidate) => candidate.toggle === (event as CustomEvent).detail);
      if (panel) latest.current(panel);
    };
    window.addEventListener(TOGGLE_BOTTOM_PANEL, onToggle);
    return () => window.removeEventListener(TOGGLE_BOTTOM_PANEL, onToggle);
  }, []);
  const mounted = panels.flatMap((panel) => opened.filter((key) => key.startsWith(`${panel.plugin}/${panel.id}/`) && botIds.includes(key.slice(`${panel.plugin}/${panel.id}/`.length))).map((key) => ({ panel, key, bot: key.slice(`${panel.plugin}/${panel.id}/`.length) })));
  return <>
    {toggleHost && panels.map((panel) => {
      const key = botId ? itemKey(panel, botId) : "";
      const label = shortcutFor(panel.toggle);
      return createPortal(
        <button key={`${panel.plugin}/${panel.id}`} className="bottom-toggle" disabled={!botId || !botIds.includes(botId)} aria-expanded={!!botId && !!visible[key]} onClick={() => toggle(panel)}
          title={`Toggle ${panel.title.toLowerCase()}${label ? ` (${label})` : ""}`}>{panel.title}</button>, toggleHost, `${panel.plugin}/${panel.id}`);
    })}
    {mounted.map(({ panel, key, bot }) => <BottomPanelItem key={key} client={client} panel={panel} botId={bot} shown={bot === botId && !!visible[key]} onBuiltin={onBuiltin} onKey={onKey}
      register={(entry) => { if (entry) frames.current.set(key, entry); else frames.current.delete(key); }}
      setShown={(next) => setShown(key, next)} {...services} />)}
  </>;
}

function BottomPanelItem({ client, panel, botId, shown, register, setShown, onBuiltin, onKey, ...services }: {
  client: Client; panel: BottomPanel; botId: string; shown: boolean; register: (entry: { frame: HTMLIFrameElement | null; ready: boolean } | null) => void;
  setShown: (shown: boolean) => void; onBuiltin: BuiltinRunner; onKey: Parameters<typeof BottomPanels>[0]["onKey"];
} & FrameServices) {
  const [height, setHeight] = useState(300);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);
  useEffect(() => {
    const update = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const section = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const entry = useRef({ frame: null as HTMLIFrameElement | null, ready: false });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const resize = (next: number) => setHeight(Math.max(Math.min(MIN_HEIGHT, window.innerHeight * .7), Math.min(window.innerHeight * .7, next)));
  // The frame hears whether it is shown, and when it is, it holds the keyboard (what is typed goes to its shell, not the chat).
  const tell = () => {
    const element = entry.current.frame;
    element?.contentWindow?.postMessage(frameEvent("visible", { visible: shownNow.current }), "*");
    if (shownNow.current) element?.focus();
  };
  const shownNow = useRef(shown);
  shownNow.current = shown;
  useEffect(() => { entry.current.frame = frame.current; register(entry.current); return () => register(null); }, []);
  useEffect(() => { entry.current.frame = frame.current; if (entry.current.ready) tell(); }, [shown]);
  return <section ref={section} className="bottom-panel" style={{ height }} hidden={!shown} aria-label={`Bot ${panel.title.toLowerCase()}`}>
    {dragging && <ShellOverlay revealImmediately><div className="bottom-drag-shield" /></ShellOverlay>}
    <div className="bottom-divider" role="separator" aria-label={`Resize ${panel.title.toLowerCase()} panel`} aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={Math.min(MIN_HEIGHT, Math.round(viewportHeight * .7))} aria-valuemax={Math.round(viewportHeight * .7)} aria-valuenow={Math.round(Math.min(height, viewportHeight * .7))}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        setDragging(true);
        drag.current = { y: event.clientY, height: section.current!.getBoundingClientRect().height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => { if (drag.current) resize(drag.current.height + drag.current.y - event.clientY); }}
      onPointerUp={(event) => { drag.current = null; setDragging(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
      onPointerCancel={() => { drag.current = null; setDragging(false); }}
      onKeyDown={(event) => {
        const current = section.current!.getBoundingClientRect().height;
        if (event.key === "ArrowUp") resize(current + 20);
        else if (event.key === "ArrowDown") resize(current - 20);
        else if (event.key === "Home") resize(MIN_HEIGHT);
        else if (event.key === "End") resize(window.innerHeight * .7);
        else return;
        event.preventDefault(); event.stopPropagation();
      }} />
    <BottomPanelFrame ref={(element) => { frame.current = element; entry.current.frame = element; }} client={client} plugin={panel.plugin} view={panel.id} title={panel.title} botId={botId} onBuiltin={onBuiltin}
      extras={{
        rate: STREAMING_RATE,
        onReady: () => { entry.current.ready = true; tell(); },
        onPanel: setShown,
        onKey: (key) => onKey(panel.plugin, key),
      }} {...services} />
  </section>;
}
