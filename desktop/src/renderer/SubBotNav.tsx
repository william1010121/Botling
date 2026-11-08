// Navigation v5, sub bots: drawn left of Chat | Board | Review. A project bot shows "Sub bots · N ▾" (the only one's
// name when it has one, nothing when it has none); inside a sub bot the same place is the way back,
// "‹ botling / Release ▾". The menu lists the sub bots by section (sub-bot-nav.ts); ↑↓ ↵ Esc work in it.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { BotView } from "../contract";
import { ShellOverlay } from "./ShellOverlay";
import { filterSubBotRows, SUB_BOT_SEARCH_FROM, subBotSections, subBotsButton, type HeaderNav, type SubBotBadge, type SubBotRow } from "./sub-bot-nav";

/** A sub bot's square face with its status dot (`dot` false: the face alone). */
export function SubBotFace({ row, dot = true }: { row: Pick<SubBotRow, "initial" | "tint" | "dot">; dot?: boolean }) {
  return <span className="sbn-face" data-tint={row.tint} aria-hidden="true">{row.initial}{dot && <i className="sbn-dot" data-dot={row.dot} />}</span>;
}

function Badge({ badge }: { badge: SubBotBadge }) {
  return badge.kind === "time" ? <span className="sbn-time">{badge.text}</span> : <span className="sbn-pill" data-kind={badge.kind}>{badge.text}</span>;
}

const dotWords: Record<SubBotRow["dot"], string> = { working: "working", new: "new report", asks: "waits on you", error: "error", idle: "idle" };

function MenuRow({ row, current, onOpen }: { row: SubBotRow; current: boolean; onOpen: (botId: string) => void }) {
  return (
    <button type="button" role="menuitem" className={`sbn-row${current ? " current" : ""}`} data-sub-bot={row.id} aria-current={current ? "page" : undefined}
      aria-label={[row.name, row.purpose, row.status, dotWords[row.dot]].filter(Boolean).join(", ")} onClick={() => onOpen(row.id)}>
      <SubBotFace row={row} />
      <span className="sbn-text">
        <span className="sbn-line1"><b>{row.name}</b>{current ? <span className="sbn-check" aria-hidden="true">✓</span> : row.badge && <Badge badge={row.badge} />}</span>
        {row.purpose && <span className="sbn-purpose">{row.purpose}</span>}
        {row.status && <span className="sbn-status">{row.dot === "working" && <span className="sbn-spin" aria-hidden="true" />}{row.status}</span>}
      </span>
    </button>
  );
}

/** The menu below the button: optional search (12+), sections, a footer of keys. `parent`: the breadcrumb's menu, its project bot first. */
export function SubBotPicker({ rows, currentId = null, parent = null, backKey = "", onOpen, onClose }: {
  rows: SubBotRow[]; currentId?: string | null; parent?: BotView | null; backKey?: string;
  onOpen: (botId: string) => void; onClose: (refocus: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const searching = rows.length >= SUB_BOT_SEARCH_FROM;
  const shown = searching ? filterSubBotRows(rows, query) : rows;
  // The breadcrumb's menu keeps the bots list's order (the one shown ticked); the button's menu groups by state.
  const sections = parent ? [{ title: "Sub bots", rows: shown }] : searching && query.trim() ? [{ title: "Matches", rows: shown }] : subBotSections(shown);
  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>(searching ? ".sbn-search input" : "[role=menuitem]");
    first?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (box.current && target && !box.current.contains(target) && !target.closest?.(".sbn-anchor")) onClose(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]!.focus();
  };
  return (
    <div ref={box} className="sbn-menu" role="menu" aria-label={parent ? `${parent.name} and its sub bots` : "Sub bots"} onKeyDown={onKeyDown}>
      {searching && (
        <label className="sbn-search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sub bots" aria-label="Search sub bots"
            onKeyDown={(event) => { if (event.key === "Enter" && shown[0]) { event.preventDefault(); onOpen(shown[0].id); } }} />
          <span className="sbn-time">{query.trim() ? `${shown.length} of ${rows.length}` : rows.length}</span>
        </label>
      )}
      <div className="sbn-list">
        {parent && (
          <button type="button" role="menuitem" className="sbn-row" data-bot={parent.id} onClick={() => onOpen(parent.id)}>
            <span className="sbn-face parent" aria-hidden="true">{parent.name.trim().charAt(0).toLowerCase() || "?"}</span>
            <span className="sbn-text">
              <span className="sbn-line1"><b>{parent.name}</b>{backKey && <span className="sbn-time">{backKey}</span>}</span>
              <span className="sbn-purpose">Project bot</span>
            </span>
          </button>
        )}
        {sections.map((section) => (
          <div key={section.title} role="group" aria-label={section.title}>
            <div className="sbn-head">{section.title}</div>
            {section.rows.map((row) => <MenuRow key={row.id} row={row} current={row.id === currentId} onOpen={onOpen} />)}
          </div>
        ))}
        {searching && query.trim() && shown.length === 0 && (
          <div className="sbn-empty">No sub bot matches “{query.trim()}”<span>Search looks at names and purposes.</span></div>
        )}
      </div>
      <div className="sbn-foot"><span className="sbn-keys"><kbd>↑↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd></span></div>
    </div>
  );
}

/**
 * The header's left side. `open`/`onOpenChange`: the menu (⌘⇧S toggles it from App). `flash`: the button's 600 ms blue ring
 * after coming back from a sub bot; `forward`: the faint "⌘] Release" hint beside it then.
 */
export function SubBotNav({ nav, open, onOpenChange, onOpen, flash = false, forward = null, keys }: {
  nav: HeaderNav; open: boolean; onOpenChange: (open: boolean) => void; onOpen: (botId: string) => void;
  flash?: boolean; forward?: { name: string } | null;
  keys: { menu: string; back: string; forward: string };
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  if (nav.kind === "none") return null;
  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) anchor.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  };
  const choose = (botId: string) => { onOpenChange(false); onOpen(botId); };
  const toggle = () => onOpenChange(!open);
  if (nav.kind === "crumb") {
    return (
      <span ref={anchor} className="sbn-anchor sbn-crumb">
        <button type="button" className="sbn-back" title={`Back to ${nav.parent.name} (${keys.back})`} aria-label={`Back to ${nav.parent.name}`}
          onClick={() => onOpen(nav.parent.id)}>‹ <span className="sbn-word">{nav.parent.name}</span>{nav.parent.unread > 0 && <span className="sbn-unread" aria-label={`${nav.parent.unread} unread`} />}</button>
        <span className="sbn-sep" aria-hidden="true">/</span>
        <button type="button" className={`sbn-current${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} title={`Other sub bots (${keys.menu})`}
          aria-label={`${nav.current.name}, sub bot of ${nav.parent.name}`} onClick={toggle}>
          <SubBotFace row={nav.current} dot={false} /><span className="sbn-word">{nav.current.name}</span><span className="sbn-caret" aria-hidden="true">▾</span>
        </button>
        {open && <ShellOverlay><SubBotPicker rows={nav.rows} currentId={nav.current.id} parent={nav.parent} backKey={keys.back} onOpen={choose} onClose={close} /></ShellOverlay>}
      </span>
    );
  }
  const button = subBotsButton(nav.rows);
  if (button.kind === "none") return null;
  return (
    <span ref={anchor} className="sbn-anchor">
      {button.kind === "one" ? (
        <span className="sbn-split">
          <button type="button" className={`sbn-button sbn-split-name${flash ? " flash" : ""}`} title={`Open ${button.row.name}`} onClick={() => onOpen(button.row.id)}
            aria-label={`Open sub bot ${button.row.name}`}>
            <SubBotFace row={button.row} /><span className="sbn-word">{button.row.name}</span>
          </button>
          <button type="button" className={`sbn-button sbn-split-caret${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label="Sub bots menu"
            title={`Sub bots (${keys.menu})`} onClick={toggle}>▾</button>
        </span>
      ) : (
        <button type="button" className={`sbn-button${open ? " on" : ""}${flash ? " flash" : ""}`} aria-haspopup="menu" aria-expanded={open}
          title={`Sub bots (${keys.menu})`} aria-label={`Sub bots, ${button.count}${button.hint ? `, ${button.hint.text}` : ""}`} onClick={toggle}>
          {button.hint?.kind === "error" && <span className="sbn-alert" aria-hidden="true">!</span>}
          <span className="sbn-stack">{button.stack.map((row) => <SubBotFace key={row.id} row={row} dot={false} />)}</span>
          <span className="sbn-label"><span className="sbn-word">Sub bots · </span>{button.count}</span><span className="sbn-caret" aria-hidden="true">▾</span>
        </button>
      )}
      {button.hint && button.hint.kind !== "error" && <span className="sbn-pill" data-kind={button.hint.kind}>{button.hint.text}</span>}
      {forward && !open && <span className="sbn-time sbn-forward">{keys.forward} {forward.name}</span>}
      {open && <ShellOverlay><SubBotPicker rows={nav.rows} onOpen={choose} onClose={close} /></ShellOverlay>}
    </span>
  );
}
