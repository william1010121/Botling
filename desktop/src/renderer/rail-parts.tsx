// The left column's parts (moved out of App.tsx; the code below is unchanged): a bot row, the folded strip of faces, its toggle,
// the sub bot title, the search helpers, focusing the composer and running a plugin command.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { statusText } from "../contract/bot-status";
import { isMaintainer, type BotView, type PluginsView, type SubagentRowView } from "../contract";
import { ownsCommand } from "../../../Web/src/frame-protocol";
import { Client } from "./client";
import { commandRoute } from "./plugin-commands";
import { faceURL } from "./avatars";
import { CHAT_TARGET, type ShellMessage } from "./chat-frame/protocol";
import { TOGGLE_BOTTOM_PANEL } from "./BottomPanels";
import { nativeEditor, postToChat } from "./editor-surface";
import { ShellOverlay } from "./ShellOverlay";
import { shortcutLabel } from "./shortcut-labels";
import { railOrder, railSplit } from "./rail-idle";
import { SubBotFace } from "./SubBotNav";
import { subBotRow } from "./sub-bot-nav";
import { StripPeek, subBotsOf } from "./Rail";
import { Icon } from "./icons";

export function BotRow({ bot, selected, inside, onSelect, look, waiting, counts, onMenu, pinned, onTogglePin, idle, peek, workers }: {
  bot: BotView; selected: boolean;
  /** Navigation v5: the sub bot of this project bot on screen ("› Release" on the row); sub bots are never rows of their own. */
  inside?: string; look: "original" | "cute"; waiting: boolean; onMenu?: (x: number, y: number) => void;
  /** The row was clicked: the row, and whether the keyboard pressed it (the status card then takes the focus). */
  onSelect: (from?: { el: HTMLElement; keyboard: boolean }) => void;
  /** The two numbers (rail-idle.ts botCounts): blue unread, orange what needs you (its sub bots' included). Absent: its own approvals and unread. */
  counts?: { unread: number; needsYou: number };
  /** Undefined for a row that cannot be pinned (the main bot, Maintainer). */
  pinned?: boolean; onTogglePin?: () => void;
  /** The corner button: a clock sends it to Idle, a back arrow (in Idle) brings it back. Undefined: it cannot go to Idle. */
  idle?: { away: boolean; onToggle: () => void };
  /** Its status card: the pointer came onto the row (corner buttons included) or left it; the keyboard focused the row. */
  peek?: { enter: (row: HTMLElement) => void; leave: () => void; focus: (row: HTMLElement) => void };
  /** Its worker list's count at the row's end (rail-workers.ts): a click folds or unfolds the list; folded, the unread number beside it. */
  workers?: { total: number; unread: number; folded: boolean; label: string; unreadTip: string; onToggle: () => void };
}) {
  const asleep = bot.phase === "asleep" && !bot.working;
  const unread = counts ? counts.unread : selected ? 0 : bot.unread;
  const needsYou = counts ? counts.needsYou : bot.approvals;
  const label = [bot.name, statusText(bot), needsYou ? `${needsYou} waiting on you` : waiting ? "waiting on you" : null, unread ? `${unread} unread` : null,
    inside ? `in ${inside}` : null, pinned ? "pinned" : null, idle?.away ? "in Idle" : null].filter(Boolean).join(", ");
  return (
    <div className={`bot-row-wrap${pinned !== undefined ? " pinnable" : ""}${idle ? " idleable" : ""}${workers ? " has-workers" : ""}`}
      // A touch has no hover: its tap opens the card instead (onSelect).
      onPointerEnter={peek ? (event) => { if (event.pointerType !== "touch") peek.enter(event.currentTarget.querySelector<HTMLElement>(".bot-row") ?? event.currentTarget); } : undefined}
      onPointerLeave={peek ? (event) => { if (event.pointerType !== "touch") peek.leave(); } : undefined}>
      <button className={`bot-row${selected ? " selected" : ""}${asleep ? " asleep" : ""}`} data-bot={bot.id} aria-current={selected ? "page" : undefined} aria-label={label}
        onClick={(event) => onSelect({ el: event.currentTarget, keyboard: event.detail === 0 })}
        onFocus={peek ? (event) => { if (focusVisible(event.currentTarget)) peek.focus(event.currentTarget); } : undefined}
        onBlur={peek ? (event) => { if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest(".rail-peek, .bot-row-wrap"))) peek.leave(); } : undefined}
        onContextMenu={onMenu ? (event) => { event.preventDefault(); onMenu(event.clientX, event.clientY); } : undefined}>
        <img className="bot-avatar" src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className={`bot-name${bot.role === "main" ? " main" : ""}`}>{bot.name}</span>
        <span className="bot-gap" />
        {inside && <span className="bot-inside">› {inside}</span>}
        {bot.working && <span className="bot-dot working" aria-hidden="true" />}
        {unread > 0 && <span className="bot-counts"><span className="badge" aria-hidden="true">{unread}</span></span>}
      </button>
      {idle && (
        // The clock at the row's top-right corner while the pointer is on it (the settle clock's icon); in Idle, the back arrow.
        <button type="button" className={`bot-idle${idle.away ? " away" : ""}`} onClick={idle.onToggle}
          title={idle.away ? "Back to the list" : "Send to Idle"} aria-label={idle.away ? `Bring ${bot.name} back from Idle` : `Send ${bot.name} to Idle`}>
          <Icon name={idle.away ? "uturn" : "clock"} size={12} />
        </button>
      )}
      {pinned !== undefined && onTogglePin && (
        // The pin glyph at the row's end while the pointer is on it (1.x's BotRow).
        <button type="button" className={`bot-pin${pinned ? " on" : ""}`} onClick={onTogglePin} title={pinned ? "Unpin" : "Pin to the top"} aria-label={pinned ? `Unpin ${bot.name}` : `Pin ${bot.name}`}>
          <Icon name={pinned ? "pinSlash" : "pin"} size={12} />
        </button>
      )}
      {workers && (
        <button type="button" className={`rail-wk-pill${workers.folded ? " folded" : ""}`} aria-expanded={!workers.folded} aria-label={workers.label} title={workers.label} onClick={workers.onToggle}>
          {workers.total}
          {workers.folded && workers.unread > 0 && <span className="rail-wk-count" title={workers.unreadTip}>{workers.unread}</span>}
          <span className={`rail-wk-chevron${workers.folded ? "" : " open"}`} aria-hidden="true"><Icon name="chevronLeft" size={9} /></span>
        </button>
      )}
    </div>
  );
}


/** Focus from the keyboard (not the focus a mouse click leaves on the row). */
function focusVisible(el: Element): boolean {
  try { return el.matches(":focus-visible"); } catch { return false; }
}

/** What a click on a subagent row opens: a sub bot's own chat (with the input box), or a subagent's read-only view. */
export function rowTarget(row: Pick<SubagentRowView, "id" | "subBot">): { kind: "bot"; botId: string } | { kind: "subagent"; id: string } {
  return row.subBot ? { kind: "bot", botId: row.subBot } : { kind: "subagent", id: row.id };
}

/** A sub bot's title: the project bot it belongs to (a button back to it), then its own name. */
export function SubBotTitle({ bot, parent, onOpenParent }: { bot: BotView; parent: BotView | null; onOpenParent: (botId: string) => void }) {
  // Navigation v5: its square face and name, then "sub bot of <project bot>" (the way back is the breadcrumb below too).
  return (
    <>
      <SubBotFace row={subBotRow(bot, { items: [], doing: {} }, 0)} dot={false} />
      <span className="chat-sub-bot" data-sub-bot={bot.id}>{bot.name}</span>
      {parent && <span className="chat-sub-of">sub bot of <button type="button" className="chat-parent" title={`Back to ${parent.name}`} onClick={() => onOpenParent(parent.id)}>{parent.name}</button></span>}
    </>
  );
}

/** `RailLayout.matches`: the name, or a project's folder name, contains the query, ignoring case and accents. */
export function railMatches(query: string, name: string, folder: string | null): boolean {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wanted = fold(query.trim());
  if (!wanted) return true;
  return fold(name).includes(wanted) || (folder !== null && fold(folder).includes(wanted));
}

/** The rows the search keeps, in the order the column shows them (the main bot, the pinned rows, the rest). */
export function searchHits(bots: BotView[], pinned: string[], query: string): BotView[] {
  return railOrder(bots, pinned).map((entry) => entry.bot)
    .filter((bot) => railMatches(query, bot.name, bot.role === "manager" ? bot.folder.split("/").filter(Boolean).pop() ?? null : null));
}

/** The cursor back in the chat's input box (after the search). */
export function focusComposer() {
  if (nativeEditor()) { postToChat({ botling: "focus" }); return; }
  const target = (document.getElementById("chat-frame") as HTMLIFrameElement | null)?.contentWindow;
  if (!target) return;
  target.focus();
  const message: ShellMessage = { botling: "focus" };
  target.postMessage(message, CHAT_TARGET);
}

/** The button that folds the left column into a strip of faces and opens it again (1.x's RailToggle, ⌃⌘S). */
export function RailToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button type="button" className={`rail-toggle${collapsed ? "" : " on"}`} onClick={onToggle} title={`${label} (${shortcutLabel("toggleSidebar")})`} aria-label={label} aria-pressed={!collapsed}>
      <Icon name="sidebarLeft" size={14} />
    </button>
  );
}

/** How long a face's tip or peek stays after the pointer or focus leaves it, so the pointer can cross into the peek. */
const PEEK_GRACE_MS = 200;

/**
 * The left column folded (1.x's RailStrip): faces only, the rows the open column keeps above its Idle group (railSplit;
 * the idle bots are left out), the pinned ones first, a blue dot on a face with unread messages; hover (or focus) a face for a peek
 * (StripPeek) with its name and status and, for a bot with sub bots, those sub bots, each opening its chat.
 * The chat is a native view above the shell, so an open peek covers it as one shell overlay across faces.
 */
export function RailStrip({ bots, pinned, idle = [], look, shown, waiting, onSelect, onMenu, onExpand, onAddProject, onNewBot, settingsControl }: {
  bots: BotView[]; pinned: string[]; idle?: string[]; look: "original" | "cute"; shown: string | null; waiting: (id: string) => boolean;
  onSelect: (id: string) => void; onMenu: (bot: BotView, x: number, y: number) => void; onExpand: () => void; onAddProject: () => void; onNewBot: () => void; settingsControl: ReactNode;
}) {
  const [tip, setTip] = useState<{ botId: string; top: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Focus put back on a face by Escape does not open its peek again.
  const quiet = useRef(false);
  const keep = useCallback(() => { if (closing.current) { clearTimeout(closing.current); closing.current = null; } }, []);
  const hide = useCallback((soon: boolean) => {
    keep();
    if (soon) closing.current = setTimeout(() => { closing.current = null; setTip(null); }, PEEK_GRACE_MS);
    else setTip(null);
  }, [keep]);
  useEffect(() => keep, [keep]);
  const order = railSplit(bots, pinned, idle).rows;
  const pinnedCount = order.filter(({ bot }) => pinned.includes(bot.id)).length;
  const faces = useRef(new Map<string, HTMLButtonElement>());
  return (
    <aside className="rail-strip" aria-label="Bots (folded)">
      <div className="rail-top drag"><RailToggle collapsed onToggle={onExpand} /></div>
      <nav className="strip-bots" aria-label="Bots">
        {order.map(({ bot }, index) => {
          const asleep = bot.phase === "asleep" && !bot.working;
          const unread = bot.unread > 0 && bot.id !== shown;
          const parts = [statusText(bot), waiting(bot.id) ? "waiting on you" : null, unread ? `${bot.unread > 99 ? "99+" : bot.unread} unread` : null].filter(Boolean);
          const subs = subBotsOf(bot, bots);
          const open = tip?.botId === bot.id;
          const show = (face: HTMLElement) => { keep(); setTip({ botId: bot.id, top: face.getBoundingClientRect().top }); };
          return (
            <div key={bot.id} className="strip-entry">
              {index === 1 && <div className="strip-rule" />}
              {pinnedCount > 0 && index === 1 + pinnedCount && <div className="strip-rule short" />}
              <button type="button" ref={(face) => { if (face) faces.current.set(bot.id, face); else faces.current.delete(bot.id); }} className={`strip-bot${bot.id === shown ? " selected" : ""}${asleep ? " asleep" : ""}${bot.working ? " working" : ""}${bot.connection ? " disconnected" : ""}`} data-bot={bot.id}
                aria-label={[bot.name, ...parts, subs.length ? `${subs.length} sub bot${subs.length === 1 ? "" : "s"}` : null].filter(Boolean).join(", ")}
                aria-expanded={subs.length ? open : undefined} onClick={() => onSelect(bot.id)}
                onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={() => hide(true)}
                onFocus={(event) => { if (!quiet.current) show(event.currentTarget); }}
                onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.parentElement?.contains(event.relatedTarget))) hide(true); }}
                onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); hide(false); } }}
                onContextMenu={bot.role !== "main" && !isMaintainer(bot) ? (event) => { event.preventDefault(); onMenu(bot, event.clientX, event.clientY); } : undefined}>
                <img src={faceURL(bot, look, { asleep, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
                {bot.connection && <span className="strip-disconnected" aria-hidden="true">!</span>}
                {unread && <span className="strip-unread" aria-hidden="true" />}
              </button>
              {open && tip && (
                <StripPeek bot={bot} subs={subs} detail={parts.join(" · ")} look={look} top={tip.top} shown={shown}
                  onOpen={(id) => { hide(false); onSelect(id); }} onEnter={keep} onLeave={() => hide(true)}
                  onDismiss={() => {
                    quiet.current = true;
                    faces.current.get(bot.id)?.focus();
                    quiet.current = false;
                    hide(false);
                  }} />
              )}
            </div>
          );
        })}
      </nav>
      <ShellOverlay active={tip !== null}>{null}</ShellOverlay>
      <div className="strip-add">
        <button type="button" className="strip-plus" title="Add a project or a bot" aria-label="Add a project or a bot" aria-expanded={adding} onClick={() => setAdding(!adding)}><Icon name="plus" size={13} /></button>
        {adding && (
          <ShellOverlay><div className="strip-add-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onAddProject(); }}>Add project…</button>
            <button type="button" role="menuitem" onClick={() => { setAdding(false); onNewBot(); }}>New bot…</button>
          </div></ShellOverlay>
        )}
      </div>
      {settingsControl}
    </aside>
  );
}

/**
 * A plugin command from a key, the / menu or a menu: in the plugin host (the app page asks, so the core runs any),
 * or in the chat page when a web part there registered it.
 */
export function runPluginCommand(client: Client, plugins: PluginsView | null | undefined, id: string, args: string[], onError: (failure: unknown) => void, caller?: { from: "frame"; name: string }) {
  if (caller?.from === "frame" && !ownsCommand(caller.name, id)) return;
  const route = commandRoute(plugins, id);
  // A bottom panel's toggle command is the page's own to run (it shows or hides the panel of the bot on screen), whichever way it
  // arrived: a key pressed in this page, or one the chat frame relays (where focus usually is).
  if (route === "bottomPanel") window.dispatchEvent(new CustomEvent(TOGGLE_BOTTOM_PANEL, { detail: id }));
  else if (route === "host") void client.request({ type: "plugins.command", id, ...(caller ?? {}), ...(args.length ? { args } : {}) }).catch(onError);
  else postToChat({ botling: "runCommand", id });
}
