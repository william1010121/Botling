// Web AIs in the app page (1.x's WebRailSection, WebSiteColumn and WebPanel): the left column's "Web"
// section (each site and its conversations you have not settled), the site in the chat column (a
// strip saying whether the page was saved for the main bot, and the real site under it: main lays
// its own view over the box this page keeps for it), and the right panel (this question, "Ask Main
// bot about this", every question, "New question"). The page itself is never in this document.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WebConversationView, WebSiteView, WebStateView, WebStatusView } from "../contract";
import type { Client } from "./client";

/** A site's face: a rounded tile in its colour with its initial (no company logo). */
export function WebFace({ site, size = 32 }: { site: WebSiteView; size?: number }) {
  return (
    <span className="web-face" aria-hidden="true" style={{ width: size, height: size, borderRadius: size * 0.28, background: site.accent, fontSize: size * 0.5 }}>
      {site.name.slice(0, 1)}
    </span>
  );
}

/** Rows listed under a site: not settled, those still waiting first (`listed`). */
export function listed(site: WebSiteView): WebConversationView[] {
  const rows = site.conversations.filter((row) => !row.settled);
  return [...rows.filter((row) => row.awaiting), ...rows.filter((row) => !row.awaiting)];
}

const LISTED_AT_MOST = 5;

/** The left column's "Web" section. */
export function WebRail({ web, shown, onOpen, onSettle }: {
  web: WebStateView;
  /** The site shown in the chat column, if one is. */
  shown: string | null;
  onOpen: (site: string, conversationId?: string) => void;
  onSettle: (site: string, conversationId: string) => void;
}) {
  return (
    <div className="web-rail" role="group" aria-label="Web">
      <div className="web-rail-title">Web</div>
      {web.sites.map((site) => (
        <SiteRows key={site.id} site={site} shown={shown === site.id} onOpen={onOpen} onSettle={onSettle} />
      ))}
    </div>
  );
}

function SiteRows({ site, shown, onOpen, onSettle }: { site: WebSiteView; shown: boolean; onOpen: (site: string, conversationId?: string) => void; onSettle: (site: string, conversationId: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = listed(site);
  const more = Math.max(0, rows.length - LISTED_AT_MOST);
  const count = site.conversations.length;
  return (
    <>
      <button
        type="button" className={`web-site-row${shown && site.open === null ? " selected" : ""}`} data-site={site.id}
        aria-label={`${site.name}, web, ${count} conversation${count === 1 ? "" : "s"}`}
        title={`${site.name} in the app: a new question; conversations are saved as text the main bot can search`}
        onClick={() => onOpen(site.id)}
      >
        <WebFace site={site} />
        <span className="web-site-name">{site.name}</span>
        <span className="bot-gap" />
        {count > 0 && <span className="web-count">{count}</span>}
      </button>
      {(all ? rows : rows.slice(0, LISTED_AT_MOST)).map((row) => (
        <ConversationRow key={row.id} site={site} row={row} open={shown && site.open === row.id} onOpen={() => onOpen(site.id, row.id)} onSettle={() => onSettle(site.id, row.id)} />
      ))}
      {more > 0 && <button type="button" className="web-more" onClick={() => setAll(!all)}>{all ? "Show less" : `Show ${more} more`}</button>}
    </>
  );
}

/** One question's row, like a subagent's: a live dot while it waits for its answer; ✓ settles it (to "Questions" in the right panel). */
function ConversationRow({ site, row, open, onOpen, onSettle }: { site: WebSiteView; row: WebConversationView; open: boolean; onOpen: () => void; onSettle: () => void }) {
  return (
    <div className={`web-row${open ? " selected" : ""}${row.awaiting ? " awaiting" : ""}`} data-conversation={row.id}>
      <button type="button" className="web-row-open" title={row.question ?? row.url}
        aria-label={`${site.name} conversation: ${row.title || site.name}${row.awaiting ? ", waiting for its answer" : ""}`} onClick={onOpen}>
        <span className="web-row-arrow" aria-hidden="true">↳</span>
        <span className="web-row-title">{row.title || site.name}</span>
      </button>
      {row.awaiting && <span className="bot-dot working" aria-hidden="true" />}
      <button type="button" className="web-settle" aria-label={`Settle ${row.title || site.name}`}
        title={row.awaiting ? "Settle: move to Questions in the right panel (its answer is still saved)" : "Settle: move to Questions in the right panel"} onClick={onSettle}>✓</button>
    </div>
  );
}

/** "● Saved for Main bot · 6 messages", or why not (`WebStatusLine`). */
export function WebStatus({ status, site }: { status: WebStatusView; site: WebSiteView }) {
  switch (status.kind) {
    case "saved": return <span className="web-status saved" data-status="saved"><span className="web-status-dot" aria-hidden="true" />Saved for Main bot · {status.messages} messages</span>;
    case "unreadable": return (
      <span className="web-status unreadable" data-status="unreadable" title={`Nothing was saved. ${status.reason} The page reader is in the plugin ccb-web-extractors; ask Maintainer to fix it.`}>
        ⚠ Couldn't read this page
      </span>
    );
    case "waiting": return <span className="web-status" data-status="waiting" title="Listed already; its answer is saved when it comes, even if you open something else">⌛ Waiting for {site.name}'s answer…</span>;
    case "newQuestion": return <span className="web-status" data-status="newQuestion">A new question is saved once it has an answer</span>;
    default: return <span className="web-status" data-status="reading">Reading…</span>;
  }
}

/** True while something of the app page sits where the site would be drawn (Settings, the plugin panels). */
function useCovered(): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const look = () => setCovered(!!document.querySelector(".settings-backdrop, .plugins-panel, .plugin-panel"));
    look();
    const observer = new MutationObserver(look);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return covered;
}

/** The chat column for a site: its strip, and the box main shows the site in. */
export function WebPane({ client, site, onError }: { client: Client; site: WebSiteView; onError: (failure: unknown) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const covered = useCovered();
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let last = "";
    const place = () => {
      const rect = element.getBoundingClientRect();
      const bounds = covered || rect.width < 1 ? null : { x: Math.max(0, rect.left), y: Math.max(0, rect.top), width: rect.width, height: rect.height };
      const key = JSON.stringify([site.id, bounds]);
      if (key === last) return;
      last = key;
      void client.request({ type: "web.place", site: bounds ? site.id : null, bounds }).catch(onError);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      void client.request({ type: "web.place", site: null, bounds: null }).catch(() => {});
    };
  }, [client, site.id, covered, onError]);
  const open = site.open ? site.conversations.find((row) => row.id === site.open) : undefined;
  let address = open?.url ?? site.startURL;
  try {
    const url = new URL(address);
    address = url.host + (url.pathname.length > 24 ? url.pathname.slice(0, 23) + "…" : url.pathname);
  } catch { /* as it is */ }
  return (
    <div className="web-pane">
      <div className="web-card">
        <div className="web-strip">
          <span className="web-address">{address}</span>
          <span className="bot-gap" />
          <WebStatus status={site.status} site={site} />
        </div>
        <div className="web-page" ref={box} data-site={site.id}>
          <span className="web-page-note">{site.host} shows here, signed in as you.</span>
        </div>
      </div>
    </div>
  );
}

/** The right panel for a site (`WebPanel`). */
export function WebPanel({ site, onOpen, onNew, onAsk }: {
  site: WebSiteView;
  onOpen: (conversationId: string) => void;
  onNew: () => void;
  onAsk: (conversationId: string) => void;
}) {
  const open = site.open ? site.conversations.find((row) => row.id === site.open) : undefined;
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head">
        <WebFace site={site} size={28} />
        <span className="detail-name">{site.name}</span>
      </div>
      <section className="detail-section">
        <h3>This question</h3>
        {open ? (
          <>
            <div className="now-card web-question">
              <div className="web-question-title">{open.title || site.name}</div>
              {open.savedAt && <div className="web-question-meta">{open.messages} messages · saved {new Date(open.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>}
              {open.file ? <div className="web-question-file" title={open.file}>{open.file}</div> : <WebStatus status={site.status} site={site} />}
            </div>
            <button type="button" className="web-ask" disabled={!open.file} title="Sends the main bot a message naming the saved file, so it can read it" onClick={() => onAsk(open.id)}>
              Ask Main bot about this
            </button>
          </>
        ) : (
          <p className="web-hint">Ask {site.name} something: it is listed as soon as you send it, and saved once it has an answer.</p>
        )}
      </section>
      <section className="detail-section">
        <h3>Questions</h3>
        {site.conversations.length > 0 && (
          <ul className="web-questions">
            {site.conversations.map((row) => (
              <li key={row.id}>
                <button type="button" className={`web-question-row${row.id === site.open ? " selected" : ""}`} data-conversation={row.id}
                  title={row.settled ? "Opens it, and lists it in the left column again" : "Opens it"} onClick={() => onOpen(row.id)}>
                  <span className="web-row-title">{row.title || site.name}</span>
                  {row.awaiting ? <span className="bot-dot working" aria-hidden="true" /> : <span className="web-when">{when(row.updatedAt)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="web-new" title={`Opens ${site.startURL} fresh; a question you send there is a row at once`} onClick={onNew}>+ New question</button>
      </section>
    </aside>
  );
}

/** "15:42" today, else the month and day. */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
