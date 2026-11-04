// The web AIs' pages (1.x's WebTab and WebSession in WebSiteViews.swift): each site in a
// WebContentsView of its own, in its own persistent session (`persist:web-<site>`), sandboxed, with
// no Node, no preload and so no way to Botling: the page gets nothing from the app and can send it
// nothing. Main watches each page from an isolated world (the page's scripts cannot see it, nor it
// theirs), runs the plugin's page reader there once the page goes quiet, and hands the core what it
// read. The core keeps the list and the files; this file only shows pages and reads them.
import { BrowserWindow, WebContentsView, app, session as electronSession, type Session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { WebSiteView, WebStateView } from "../contract";
import type { CoreClient } from "./core-client";

/** The page reader's own world (1.x: `ccb-web-reader`). */
const WORLD = 1_001;
/** Quiet this long after the page last changed counts as settled (an answer finished). */
const SETTLE_MS = 1_500;
/** While it changes, it is read at most this often (a question just sent shows at once). */
const CHANGED_MS = 1_000;
/** How often a page is looked at. */
const POLL_MS = 400;
/** A page left behind is looked at this often; it closes once quiet with nothing waiting. */
const CHECK_MS = Number(process.env.BOTLING_WEB_CHECK_MS ?? 15_000);
const QUIET_MS = Number(process.env.BOTLING_WEB_QUIET_MS ?? 20_000);
const LONGEST_BEHIND_MS = 15 * 60_000;
/** Pages opened at once only to read a waiting row again. */
const READING_AGAIN_AT_MOST = 2;
/** The page as the first page of a site (the core's `FIRST_PAGE`). */
const FIRST_PAGE = "3E3B0000-0000-4000-8000-0000000000F1";
/** Biggest reading handed to the core. */
const READING_LIMIT = 9_000_000;

/**
 * Watches the page's own DOM from the reader's world: a counter that moves on each change and when it
 * last moved. Installed once per document; run again, it only answers.
 */
const OBSERVER = `(() => {
  if (!window.__ccbWeb) {
    const state = window.__ccbWeb = { token: Math.random().toString(36).slice(2), seq: 0, last: Date.now() };
    const changed = () => { state.seq++; state.last = Date.now(); };
    const start = () => { new MutationObserver(changed).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); changed(); };
    if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start);
  }
  const state = window.__ccbWeb;
  return { key: state.token + ":" + state.seq, quiet: Date.now() - state.last };
})()`;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
const isWeb = (url: string) => /^https?:\/\//i.test(url);

export function keepsInside(site: WebSiteView, url: string): boolean {
  const host = hostOf(url);
  return !!host && (host === site.host || site.insideDomains.some((domain) => host === domain || host.endsWith("." + domain)));
}

interface Deps {
  core: CoreClient;
  note: (entry: string) => void;
  /** Opens a page outside the app (the user's browser). */
  openExternal: (url: string) => void;
  /** A session the app opened (its cookies are flushed at quit). */
  opened: (session: Session) => void;
}

/** One page of a site: a view that reads its conversation as it changes and hands it over once it settles. */
class WebTab {
  readonly view: WebContentsView;
  readonly openedAt = Date.now();
  /** When the page last settled, for closing one left behind. */
  changedAt = Date.now();
  loaded = false;
  private reading = false;
  private readAgain: boolean | null = null;
  private lastKey = "";
  private settledKey = "";
  private lastChangedRead = 0;
  private polling = false;
  private timer: NodeJS.Timeout;
  private closed = false;

  constructor(readonly id: string, readonly siteId: string, private pages: WebPages, session: Session) {
    this.view = new WebContentsView({
      webPreferences: {
        session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
        webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: true,
        // A page out of sight (behind the one in front, or while a bot is shown) keeps running, so an answer still comes and is read.
        backgroundThrottling: false,
        // No preload: a website has no Botling API at all.
      },
    });
    this.view.setBackgroundColor("#0E0E10");
    const contents = this.view.webContents;
    // Sign-in and the site's own pop-ups stay inside; other sites open in the browser.
    contents.setWindowOpenHandler(({ url }) => {
      const site = this.site;
      if (site && isWeb(url) && keepsInside(site, url)) void contents.loadURL(url);
      else if (isWeb(url)) pages.external(url, site?.name ?? siteId);
      else pages.deps.note(`blocked a pop-up to ${url} from a web AI page`);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => {
      const site = this.site;
      if (!site || !isWeb(event.url)) return;
      if (!keepsInside(site, event.url)) {
        event.preventDefault();
        pages.external(event.url, site.name);
      }
    });
    const changed = () => this.addressChanged();
    contents.on("did-navigate", changed);
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) changed(); });
    contents.on("page-title-updated", changed);
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  get site(): WebSiteView | undefined { return this.pages.site(this.siteId); }
  get contents(): WebContents { return this.view.webContents; }

  load(url: string) {
    this.loaded = true;
    void this.contents.loadURL(url).catch(() => { /* shown in the page */ });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.pages.detach(this);
    if (!this.contents.isDestroyed()) this.contents.close();
    void this.pages.deps.core.request({ type: "web.closed", page: this.id });
  }

  addressChanged() {
    if (this.contents.isDestroyed()) return;
    const url = this.contents.getURL();
    if (!isWeb(url)) return;
    void this.pages.deps.core.request({ type: "web.page", site: this.siteId, page: this.id, url, title: this.contents.getTitle().slice(0, 2_000) || null });
  }

  /** Looks at the page: changed (a question just sent?) or quiet long enough to read and save. */
  private async poll() {
    if (this.polling || this.closed || this.contents.isDestroyed() || !this.loaded) return;
    if (!isWeb(this.contents.getURL())) return;
    this.polling = true;
    try {
      const answer = await withTimeout(this.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: OBSERVER }]).catch(() => null), 3_000) as { key?: unknown; quiet?: unknown } | null;
      if (!answer || typeof answer.key !== "string" || typeof answer.quiet !== "number") return;
      const now = Date.now();
      if (answer.key !== this.lastKey) {
        this.lastKey = answer.key;
        // While it changes, only for a question just sent (skipped while the row this page follows already waits).
        if (now - this.lastChangedRead >= CHANGED_MS && answer.quiet < SETTLE_MS && !this.pages.awaiting(this)) {
          this.lastChangedRead = now;
          void this.read(false);
        }
      }
      if (answer.quiet >= SETTLE_MS && answer.key !== this.settledKey) {
        this.settledKey = answer.key;
        this.changedAt = now;
        void this.read(true);
      }
    } finally {
      this.polling = false;
    }
  }

  /** Reads the page with the plugin's page reader, in the reader's world. */
  async read(settled: boolean) {
    if (this.closed || this.contents.isDestroyed()) return;
    const url = this.contents.getURL();
    const site = this.site;
    if (!site || hostOf(url) !== site.host) {
      if (isWeb(url)) this.addressChanged();
      return;
    }
    if (this.reading) {
      this.readAgain = (this.readAgain ?? false) || settled;
      return;
    }
    this.reading = true;
    try {
      const reader = await this.pages.deps.core.call({ type: "web.reader", site: this.siteId }).catch(() => null);
      let json: string | null;
      if (!reader?.code) {
        if (!settled) return;
        json = JSON.stringify({ error: `No page reader for ${site.name} was found.` });
      } else {
        const value = await withTimeout(this.contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(async () => { ${reader.code} })()` }])
          .catch((error: unknown) => JSON.stringify({ error: `The page reader failed: ${String((error as Error)?.message ?? error)}` })), 10_000);
        json = typeof value === "string" ? value : JSON.stringify({ error: value === null ? "The page reader took too long." : "The page reader gave back nothing it understood." });
      }
      if (json.length > READING_LIMIT) json = JSON.stringify({ error: "The page's text is too long to save." });
      // The page may have moved on while it was read.
      if (this.contents.isDestroyed() || this.contents.getURL() !== url) return;
      await this.pages.deps.core.request({ type: "web.read", site: this.siteId, page: this.id, url, title: this.contents.getTitle().slice(0, 2_000) || null, json, settled });
    } finally {
      this.reading = false;
      const again = this.readAgain;
      this.readAgain = null;
      if (again !== null) void this.read(again);
    }
  }
}

/** One site's pages and their sign-in, kept for the whole run (`WebSession`). */
class WebSiteSession {
  front: WebTab;
  behind: WebTab[] = [];
  /** Rows read again this run, so one whose answer never comes is not opened over and over. */
  private readAgainRows = new Set<string>();
  private checking: NodeJS.Timeout | null = null;
  /** The request last handed (so the same one is not loaded twice while the core's answer travels). */
  handledRequest = "";

  constructor(readonly siteId: string, private pages: WebPages, readonly session: Session) {
    this.front = new WebTab(FIRST_PAGE, siteId, pages, session);
  }

  private get site() { return this.pages.site(this.siteId)!; }

  /** Loads what was asked for (a row, "New question"); on first show, the open conversation. */
  loadIfNeeded() {
    const site = this.site;
    const requested = site.requested;
    if (requested) {
      const key = JSON.stringify(requested);
      if (key === this.handledRequest) return;
      this.handledRequest = key;
      void this.pages.deps.core.request({ type: "web.handled", site: this.siteId });
      const followed = (tab: WebTab) => site.pages.find((entry) => entry.page === tab.id)?.row ?? null;
      const row = requested.row;
      if (row && followed(this.front) === row) {
        // Already in front.
      } else if (row && this.behind.some((tab) => followed(tab) === row)) {
        const tab = this.behind.find((candidate) => followed(candidate) === row)!;
        this.behind = this.behind.filter((candidate) => candidate !== tab);
        this.leaveFront();
        this.put(tab);
      } else if (!this.front.loaded) {
        this.front.load(requested.url);
      } else {
        this.leaveFront();
        const tab = new WebTab(randomUUID().toUpperCase(), this.siteId, this.pages, this.session);
        this.put(tab);
        tab.load(requested.url);
      }
    } else if (!this.front.loaded) {
      const open = site.open ? site.conversations.find((row) => row.id === site.open) : undefined;
      this.front.load(open && open.url.includes(site.host) && !open.id.startsWith("new-") ? open.url : site.startURL);
    }
    this.readAgain();
  }

  private put(tab: WebTab) {
    this.front = tab;
    void this.pages.deps.core.request({ type: "web.front", site: this.siteId, page: tab.id });
    this.pages.refresh();
  }

  /** The page in front goes behind: a question on it may have just been sent, so it is kept until quiet with nothing waiting. */
  private leaveFront() {
    this.behind.push(this.front);
    this.pages.detach(this.front);
    this.scheduleCheck();
  }

  /** Reads rows still waiting for an answer from their own address, on pages behind. */
  readAgain() {
    const site = this.site;
    const followed = (tab: WebTab) => site.pages.find((entry) => entry.page === tab.id)?.row ?? null;
    const reading = this.behind.filter((tab) => { const row = followed(tab); return row !== null && this.readAgainRows.has(row); }).length;
    for (const row of site.toReadAgain.slice(0, Math.max(0, READING_AGAIN_AT_MOST - reading))) {
      if (this.readAgainRows.has(row.id)) continue;
      this.readAgainRows.add(row.id);
      const tab = new WebTab(randomUUID().toUpperCase(), this.siteId, this.pages, this.session);
      this.behind.push(tab);
      tab.load(row.url);
    }
    if (this.behind.length) this.scheduleCheck();
  }

  private scheduleCheck() {
    if (this.checking) return;
    this.checking = setTimeout(() => {
      this.checking = null;
      this.closeFinished();
      if (this.behind.length) this.scheduleCheck();
    }, CHECK_MS);
  }

  /** Closes pages behind whose question was answered and saved (and that went quiet), and any kept too long. */
  private closeFinished() {
    const now = Date.now();
    this.behind = this.behind.filter((tab) => {
      const done = (!this.pages.awaiting(tab) && now - tab.changedAt >= QUIET_MS) || now - tab.openedAt >= LONGEST_BEHIND_MS;
      if (done) tab.close();
      return !done;
    });
  }

  all(): WebTab[] { return [this.front, ...this.behind]; }

  close() {
    if (this.checking) clearTimeout(this.checking);
    for (const tab of this.all()) tab.close();
  }
}

/** Every site's pages, and which one the window shows where. */
export class WebPages {
  private state: WebStateView | null = null;
  private sessions = new Map<string, WebSiteSession>();
  /** The window that shows a site, which site, and where. */
  private shown: { window: BrowserWindow; siteId: string; bounds: Electron.Rectangle } | null = null;
  private attached: { window: BrowserWindow; view: WebContentsView } | null = null;
  private stateAsked: Promise<void> | null = null;

  constructor(readonly deps: Deps) {}

  site(id: string): WebSiteView | undefined { return this.state?.sites.find((site) => site.id === id); }

  /** Whether the row a page follows still waits for its answer. */
  awaiting(tab: WebTab): boolean {
    const site = this.site(tab.siteId);
    const row = site?.pages.find((entry) => entry.page === tab.id)?.row;
    return !!row && !!site?.conversations.find((candidate) => candidate.id === row)?.awaiting;
  }

  /** The core's view of the web AIs changed (`web.updated`). */
  update(state: WebStateView) {
    const first = this.state === null;
    this.state = state;
    for (const site of state.sites) {
      const existing = this.sessions.get(site.id);
      if (!site.requested && existing) existing.handledRequest = "";
      // A request (a row clicked, "New question") loads at once; after a start, rows still waiting are read again behind.
      if (site.requested && (existing || this.shown?.siteId === site.id)) this.session(site.id).loadIfNeeded();
      else if (first && site.toReadAgain.length && process.env.BOTLING_WEB_NO_READ_AGAIN !== "1") this.session(site.id).readAgain();
    }
    this.refresh();
  }

  /** Asks the core for the state once (main starts before any web.updated). */
  ensureState(): Promise<void> {
    if (this.state) return Promise.resolve();
    this.stateAsked ??= this.deps.core.call({ type: "web.state" }).then((state) => { if (!this.state) this.update(state); }, () => { this.stateAsked = null; });
    return this.stateAsked;
  }

  private session(siteId: string): WebSiteSession {
    let found = this.sessions.get(siteId);
    if (!found) {
      const session = electronSession.fromPartition(`persist:web-${siteId}`);
      this.harden(session);
      this.deps.opened(session);
      found = new WebSiteSession(siteId, this, session);
      this.sessions.set(siteId, found);
    }
    return found;
  }

  private hardened = new WeakSet<Session>();
  private harden(session: Session) {
    if (this.hardened.has(session)) return;
    this.hardened.add(session);
    // Copying an answer (a site's copy button) is the one thing a page may ask for; nothing else (camera, notifications, files…).
    session.setPermissionRequestHandler((contents, permission, callback) => {
      const allowed = permission === "clipboard-sanitized-write";
      if (!allowed) this.deps.note(`denied permission ${permission} for ${contents?.getURL() ?? "?"}`);
      callback(allowed);
    });
    session.setPermissionCheckHandler((_contents, permission) => permission === "clipboard-sanitized-write");
    session.on("will-download", (event) => { event.preventDefault(); this.deps.note("blocked a download from a web AI page"); });
    // Sign-in pages refuse a browser that names itself Electron: the app's agent without Electron's and the app's own tokens.
    session.setUserAgent(app.userAgentFallback.replace(/\s(?:Electron|botling-desktop|Botling)\/\S+/g, ""));
  }

  external(url: string, siteName: string) {
    this.deps.note(`opened outside the app from ${siteName}: ${url}`);
    this.deps.openExternal(url);
  }

  /** Where the app page shows a site now (null: none). */
  async place(window: BrowserWindow, siteId: string | null, bounds: Electron.Rectangle | null): Promise<boolean> {
    if (!siteId || !bounds || bounds.width < 1 || bounds.height < 1) {
      this.shown = null;
      this.refresh();
      return false;
    }
    await this.ensureState();
    if (!this.site(siteId)) throw Object.assign(new Error("No such web site."), { code: "not_found" });
    this.shown = { window, siteId, bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } };
    this.session(siteId).loadIfNeeded();
    this.refresh();
    return true;
  }

  /** Puts the shown site's front page in its window (and takes any other out). */
  refresh() {
    const shown = this.shown && !this.shown.window.isDestroyed() ? this.shown : null;
    const view = shown ? this.sessions.get(shown.siteId)?.front.view ?? null : null;
    if (this.attached && (this.attached.view !== view || this.attached.window !== shown?.window)) {
      if (!this.attached.window.isDestroyed()) this.attached.window.contentView.removeChildView(this.attached.view);
      this.attached = null;
    }
    if (!shown || !view) return;
    if (!this.attached) {
      shown.window.contentView.addChildView(view);
      this.attached = { window: shown.window, view };
    }
    view.setBounds(shown.bounds);
  }

  /** A page goes out of the window (put behind, or closed). */
  detach(tab: WebTab) {
    if (this.attached?.view === tab.view) {
      if (!this.attached.window.isDestroyed()) this.attached.window.contentView.removeChildView(tab.view);
      this.attached = null;
    }
  }

  /** The core started again (a new epoch): it knows no pages, so each says again which it is and where. */
  coreRestarted() {
    for (const session of this.sessions.values()) {
      if (session.front.id !== FIRST_PAGE) void this.deps.core.request({ type: "web.front", site: session.siteId, page: session.front.id });
      for (const tab of session.all()) tab.addressChanged();
    }
  }

  /** The web contents of every open page (for tests and the security checks). */
  contents(): { siteId: string; page: string; contents: WebContents }[] {
    return [...this.sessions.values()].flatMap((session) => session.all().map((tab) => ({ siteId: session.siteId, page: tab.id, contents: tab.contents })));
  }

  /** The site's page in front (for tests). */
  frontContents(siteId: string): WebContents | null {
    return this.sessions.get(siteId)?.front.contents ?? null;
  }

  /** Whether these web contents are one of the web AIs' pages. */
  owns(contents: WebContents): boolean {
    return this.contents().some((entry) => entry.contents === contents);
  }

  closeAll() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
