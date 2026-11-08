// Navigation v5, sub bots: drawn left of Chat | Board | Review. A project bot shows "Sub bots · N ▾" (the only one's
// name when it has one, nothing when it has none); inside a sub bot the same place is the way back,
// "‹ botling / Release ▾". The menu lists the sub bots by section (sub-bot-nav.ts); ↑↓ ↵ Esc work in it.
import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
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

/** Pins: the order (ids), the ⌘⇧N labels, pin/unpin and drag within Pinned. */
interface Pins { pinned: readonly string[]; keys: readonly string[]; onPin: (botId: string) => void; onMove: (botId: string, to: number) => void }

function MenuRow({ row, current, onOpen, pins, pinnedAt = -1 }: { row: SubBotRow; current: boolean; onOpen: (botId: string) => void; pins?: Pins | null; pinnedAt?: number }) {
  const [over, setOver] = useState(false);
  const pinned = pins ? pins.pinned.includes(row.id) : false;
  // A pinned row's corner shows its ⌘⇧N (the first nine); the others their state word or time.
  const key = pinnedAt >= 0 ? pins?.keys[pinnedAt] : undefined;
  const corner = current ? <span className="sbn-check" aria-hidden="true">✓</span>
    : row.badge && row.badge.kind !== "time" ? <Badge badge={row.badge} />
    : key ? <span className="sbn-time sbn-key">{key}</span>
    : row.badge && <Badge badge={row.badge} />;
  const button = (
    <button type="button" role="menuitem" className={`sbn-row${current ? " current" : ""}`} data-sub-bot={row.id} aria-current={current ? "page" : undefined}
      aria-label={[row.name, row.purpose, row.status, dotWords[row.dot], pinned ? "pinned" : null].filter(Boolean).join(", ")} onClick={() => onOpen(row.id)}>
      {pinnedAt >= 0 && <span className="sbn-handle" aria-hidden="true">⋮⋮</span>}
      <SubBotFace row={row} />
      <span className="sbn-text">
        <span className="sbn-line1"><b>{row.name}</b>{corner}</span>
        {row.purpose && <span className="sbn-purpose">{row.purpose}</span>}
        {row.status && <span className="sbn-status">{row.dot === "working" && <span className="sbn-spin" aria-hidden="true" />}{row.status}</span>}
      </span>
    </button>
  );
  if (!pins) return button;
  // Only the Pinned section drags (its ⋮⋮ handle shows on hover); the rest are ordered by state.
  const drag = pinnedAt >= 0 ? {
    draggable: true,
    onDragStart: (event: DragEvent) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-botling-sub-bot", row.id); },
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes("application/x-botling-sub-bot")) { event.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault(); setOver(false);
      const dragged = event.dataTransfer.getData("application/x-botling-sub-bot");
      if (dragged && dragged !== row.id) pins.onMove(dragged, pins.pinned.indexOf(row.id));
    },
  } : {};
  return (
    <div className={`sbn-item${over ? " drop" : ""}`} data-pinned={pinnedAt >= 0 ? "true" : undefined} {...drag}>
      {button}
      <button type="button" className={`sbn-pin${pinned ? " on" : ""}`} aria-label={`${pinned ? "Unpin" : "Pin"} ${row.name}`} title={pinned ? "Unpin" : "Pin to the top (⌘⇧1–9)"}
        onClick={() => pins.onPin(row.id)}>{pinned ? "★" : "☆ Pin"}</button>
    </div>
  );
}

/** "+ New sub bot…": a name and what it is for; the project bot opens it (as when you ask it in the chat). */
function NewSubBotForm({ onNew, onDone }: { onNew: (name: string, purpose: string) => Promise<void>; onDone: () => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !purpose.trim() || busy) return;
    setBusy(true); setFailed(null);
    onNew(name.trim(), purpose.trim()).then(onDone, (failure: unknown) => { setBusy(false); setFailed(String((failure as Error)?.message ?? failure)); });
  };
  return (
    <form className="sbn-new" onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDone(); } }}>
      <div className="sbn-head">New sub bot</div>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Name" aria-label="Sub bot name" maxLength={60} />
      <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="What it is for (its first task)" aria-label="What it is for" rows={2} maxLength={2000} />
      {failed && <div className="sbn-error" role="alert">{failed}</div>}
      <div className="sbn-new-actions">
        <span className="sbn-time">The project bot opens it.</span>
        <button type="button" className="new-bot-cancel" onClick={onDone}>Cancel</button>
        <button type="submit" className="new-bot-create" disabled={busy || !name.trim() || !purpose.trim()}>{busy ? "Asking…" : "Create"}</button>
      </div>
    </form>
  );
}

/** The menu below the button: optional search (12+), sections, a footer of keys. `parent`: the breadcrumb's menu, its project bot first. */
export function SubBotPicker({ rows, currentId = null, parent = null, backKey = "", onOpen, onClose, pinned, pinKeys = [], onPin, onMovePin, onNew, onArchive, startNew = false }: {
  rows: SubBotRow[]; currentId?: string | null; parent?: BotView | null; backKey?: string;
  onOpen: (botId: string) => void; onClose: (refocus: boolean) => void;
  /** Pinned sub bot ids in order, and the ⌘⇧1–9 labels (Pinned section, ☆ Pin, drag). */
  pinned?: readonly string[]; pinKeys?: readonly string[]; onPin?: (botId: string) => void; onMovePin?: (botId: string, to: number) => void;
  /** "+ New sub bot…" in the footer (absent: not offered); `startNew` opens with its form. */
  onNew?: (name: string, purpose: string) => Promise<void>; startNew?: boolean;
  /** The breadcrumb's "Archive <sub bot>…" (the close-sub-bot dialog). */
  onArchive?: (botId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [making, setMaking] = useState(startNew);
  const pins: Pins | null = pinned && onPin && onMovePin ? { pinned, keys: pinKeys, onPin, onMove: onMovePin } : null;
  const box = useRef<HTMLDivElement>(null);
  const searching = rows.length >= SUB_BOT_SEARCH_FROM;
  const shown = searching ? filterSubBotRows(rows, query) : rows;
  // The breadcrumb's menu keeps the bots list's order (the one shown ticked); the button's menu groups by state.
  const sections = parent ? [{ title: "Sub bots", rows: shown }] : searching && query.trim() ? [{ title: "Matches", rows: shown }] : subBotSections(shown, pinned);
  const current = currentId ? rows.find((row) => row.id === currentId) ?? null : null;
  useEffect(() => {
    if (making) return;
    const first = box.current?.querySelector<HTMLElement>(searching ? ".sbn-search input" : "[role=menuitem]");
    first?.focus();
  }, [making]);
  useEffect(() => {
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
    // Typing in the New sub bot form: arrows move the caret, not the menu.
    if ((event.target as Element).closest?.(".sbn-new")) return;
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
            {section.rows.map((row, index) => <MenuRow key={row.id} row={row} current={row.id === currentId} onOpen={onOpen} pins={parent ? null : pins}
              pinnedAt={section.title === "Pinned" ? index : -1} />)}
          </div>
        ))}
        {searching && query.trim() && shown.length === 0 && (
          <div className="sbn-empty">No sub bot matches “{query.trim()}”<span>Search looks at names and purposes.</span></div>
        )}
      </div>
      {making && onNew && <NewSubBotForm onNew={onNew} onDone={() => (startNew ? onClose(true) : setMaking(false))} />}
      <div className="sbn-foot">
        {onNew && !making && <button type="button" className="sbn-act" onClick={() => setMaking(true)}>+ New sub bot…</button>}
        {onArchive && current && <button type="button" className="sbn-act sbn-archive" onClick={() => onArchive(current.id)}>Archive {current.name}…</button>}
        <span className="sbn-keys"><kbd>↑↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd></span>
      </div>
    </div>
  );
}

/**
 * The header's left side. `open`/`onOpenChange`: the menu (⌘⇧S toggles it from App). `flash`: the button's 600 ms blue ring
 * after coming back from a sub bot; `forward`: the faint "⌘] Release" hint beside it then.
 */
export function SubBotNav({ nav, open, onOpenChange, onOpen, flash = false, forward = null, keys, pinned, pinKeys, onPin, onMovePin, onNew, canAdd = false, onArchive }: {
  nav: HeaderNav; open: boolean; onOpenChange: (open: boolean) => void; onOpen: (botId: string) => void;
  flash?: boolean; forward?: { name: string } | null;
  keys: { menu: string; back: string; forward: string };
  pinned?: readonly string[]; pinKeys?: readonly string[]; onPin?: (botId: string) => void; onMovePin?: (botId: string, to: number) => void;
  /** "+ New sub bot…"; `canAdd`: this bot can have sub bots, so with none yet a faint "+ Sub bot" shows on hover. */
  onNew?: (name: string, purpose: string) => Promise<void>; canAdd?: boolean;
  onArchive?: (botId: string) => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) anchor.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  };
  const menuExtras = { pinned, pinKeys, onPin, onMovePin, onNew };
  if (nav.kind === "none") {
    if (!onNew || !canAdd) return null;
    // None yet: the place stays empty (the header as before) until hovered or ⌘⇧S, then "+ Sub bot".
    return (
      <span ref={anchor} className="sbn-anchor sbn-empty-slot">
        <button type="button" className={`sbn-button sbn-add${open ? " on" : ""}`} aria-haspopup="menu" aria-expanded={open} title={`New sub bot (${keys.menu})`}
          onClick={() => onOpenChange(!open)}>+ Sub bot</button>
        {open && <ShellOverlay><SubBotPicker rows={[]} onOpen={() => {}} onClose={close} onNew={onNew} startNew /></ShellOverlay>}
      </span>
    );
  }
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
        {open && <ShellOverlay><SubBotPicker rows={nav.rows} currentId={nav.current.id} parent={nav.parent} backKey={keys.back} onOpen={choose} onClose={close}
          onNew={onNew} onArchive={onArchive ? (botId) => { onOpenChange(false); onArchive(botId); } : undefined} /></ShellOverlay>}
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
      {open && <ShellOverlay><SubBotPicker rows={nav.rows} onOpen={choose} onClose={close} {...menuExtras} /></ShellOverlay>}
    </span>
  );
}
