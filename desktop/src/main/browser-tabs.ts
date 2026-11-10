// The in-app browser's tabs (phase 1): each bot has its own, at most BROWSER_MAX_TABS, each one page (one
// WebContentsView in the app, browser-host.ts; a stand-in in tests). Only the active tab of the bot the app page
// shows is on screen, where the app page says (`layout`); every other page is hidden but keeps running.
//
// Kept free of Electron so it can be tested; browser-host.ts gives it real pages. Later phases (a bot reading a
// page's network traffic) attach to a tab's page through `pageOf` / `onPage`: the manager owns the tab list only.
import { BROWSER_MAX_TABS, type BrowserBotState, type BrowserRect, type BrowserTabInfo } from "../browser-wire";

/** What a tab needs from its page. */
export interface TabPage {
  load(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /** On screen at these window bounds (DIPs). */
  show(bounds: BrowserRect): void;
  hide(): void;
  focus(): void;
  destroy(): void;
}

export interface Tab extends BrowserTabInfo { botId: string; page: TabPage; used: number }

export interface BrowserTabsOptions {
  /** A new page for a new tab (not yet loading anything). */
  create(botId: string, tabId: string): TabPage;
  /** A bot's tabs changed (`reveal`: a link opened for it). */
  onChange(state: BrowserBotState, reveal: boolean): void;
  /** A page was made or is about to go (for later phases that attach to it). */
  onPage?(event: "created" | "destroyed", tab: Tab): void;
  max?: number;
}

export class BrowserTabs {
  private readonly bots = new Map<string, { tabs: Tab[]; active: string | null }>();
  private counter = 0;
  private clock = 0;
  private shown: { botId: string; bounds: BrowserRect } | null = null;
  private onScreen: Tab | null = null;
  private readonly max: number;

  constructor(private readonly options: BrowserTabsOptions) {
    this.max = Math.max(1, options.max ?? BROWSER_MAX_TABS);
  }

  /**
   * Opens `url` for a bot: a tab already on that URL is selected; otherwise a new tab (or, with `newTab` false and a
   * tab open, the active tab goes there). With every tab used, the least recently used one is reused.
   */
  open(botId: string, url: string, { newTab = true, reveal = true }: { newTab?: boolean; reveal?: boolean } = {}): string {
    const bot = this.bot(botId);
    const same = bot.tabs.find((tab) => tab.url === url);
    if (same) { this.activate(botId, same.id); this.emit(botId, reveal); return same.id; }
    let tab: Tab | undefined;
    if (!newTab && bot.active) tab = bot.tabs.find((each) => each.id === bot.active);
    if (!tab && bot.tabs.length >= this.max) tab = [...bot.tabs].sort((a, b) => a.used - b.used)[0];
    if (!tab) {
      const id = `t${++this.counter}`;
      tab = { id, botId, url, title: "", favicon: null, loading: true, canGoBack: false, canGoForward: false, used: 0, page: this.options.create(botId, id) };
      bot.tabs.push(tab);
      this.options.onPage?.("created", tab);
    }
    Object.assign(tab, { url, title: "", favicon: null, loading: true, crashed: false });
    tab.page.load(url);
    this.activate(botId, tab.id);
    this.emit(botId, reveal);
    return tab.id;
  }

  select(botId: string, tabId: string): void {
    const tab = this.tab(botId, tabId);
    if (!tab) return;
    if (tab.crashed) { tab.crashed = false; tab.loading = true; tab.page.load(tab.url); }
    this.activate(botId, tabId);
    this.emit(botId, false);
  }

  close(botId: string, tabId: string): void {
    const bot = this.bots.get(botId);
    const index = bot?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
    if (!bot || index < 0) return;
    const [tab] = bot.tabs.splice(index, 1);
    if (bot.active === tabId) {
      // The neighbour on the right takes its place, else the one on the left.
      bot.active = (bot.tabs[index] ?? bot.tabs[index - 1])?.id ?? null;
      if (bot.active) this.tab(botId, bot.active)!.used = ++this.clock;
    }
    this.drop(tab!);
    this.place();
    this.emit(botId, false);
  }

  /** Every tab of a bot (the bot was removed, or "Close browser"). */
  closeBot(botId: string): void {
    const bot = this.bots.get(botId);
    if (!bot) return;
    this.bots.delete(botId);
    for (const tab of bot.tabs) this.drop(tab);
    this.place();
    this.options.onChange({ botId, tabs: [], active: null }, false);
  }

  /** Goes to `url` in a tab (the active one by default), or in a new tab when the bot has none. */
  navigate(botId: string, url: string, tabId?: string): void {
    const tab = this.tab(botId, tabId ?? this.bots.get(botId)?.active ?? "");
    if (!tab) { this.open(botId, url, { reveal: false }); return; }
    Object.assign(tab, { url, loading: true, crashed: false });
    tab.page.load(url);
    this.activate(botId, tab.id);
    this.emit(botId, false);
  }

  back(botId: string): void { this.active(botId)?.page.back(); }
  forward(botId: string): void { this.active(botId)?.page.forward(); }
  reload(botId: string): void {
    const tab = this.active(botId);
    if (!tab) return;
    if (tab.crashed) { this.select(botId, tab.id); return; }
    tab.page.reload();
  }
  stop(botId: string): void { this.active(botId)?.page.stop(); }
  focus(botId: string): void { if (this.onScreen?.botId === botId) this.onScreen.page.focus(); }

  /** Where the shown bot's active page goes (window DIPs); null hides every page. */
  layout(botId: string | null, bounds: BrowserRect | null): void {
    this.shown = botId && bounds ? { botId, bounds } : null;
    this.place();
  }

  /** What a page reported (its title, icon, address, loading, history). */
  update(botId: string, tabId: string, change: Partial<Omit<BrowserTabInfo, "id">>): void {
    const tab = this.tab(botId, tabId);
    if (!tab) return;
    const before = JSON.stringify(this.info(tab));
    Object.assign(tab, change, { canGoBack: tab.page.canGoBack(), canGoForward: tab.page.canGoForward() });
    if (JSON.stringify(this.info(tab)) !== before) this.emit(botId, false);
  }

  active(botId: string): Tab | null {
    const bot = this.bots.get(botId);
    return bot?.active ? this.tab(botId, bot.active) : null;
  }
  tab(botId: string, tabId: string): Tab | null {
    return this.bots.get(botId)?.tabs.find((tab) => tab.id === tabId) ?? null;
  }
  /** The page of a tab (for later phases: a debugger on its web contents). */
  pageOf(botId: string, tabId: string): TabPage | null { return this.tab(botId, tabId)?.page ?? null; }
  /** The tab on screen now, if any. */
  visible(): Tab | null { return this.onScreen; }
  state(botId: string): BrowserBotState {
    const bot = this.bots.get(botId);
    return { botId, tabs: bot?.tabs.map((tab) => this.info(tab)) ?? [], active: bot?.active ?? null };
  }
  botIds(): string[] { return [...this.bots.keys()]; }

  dispose(): void {
    for (const botId of [...this.bots.keys()]) {
      for (const tab of this.bots.get(botId)!.tabs) this.drop(tab);
    }
    this.bots.clear();
    this.onScreen = null;
  }

  private bot(botId: string) {
    let bot = this.bots.get(botId);
    if (!bot) { bot = { tabs: [], active: null }; this.bots.set(botId, bot); }
    return bot;
  }
  private activate(botId: string, tabId: string): void {
    const bot = this.bot(botId);
    bot.active = tabId;
    this.tab(botId, tabId)!.used = ++this.clock;
    this.place();
  }
  /** Shows the one page that belongs on screen and hides the one that was. */
  private place(): void {
    const next = this.shown ? this.active(this.shown.botId) : null;
    if (this.onScreen && this.onScreen !== next) this.onScreen.page.hide();
    if (next && this.shown) next.page.show(this.shown.bounds);
    this.onScreen = next;
  }
  private drop(tab: Tab): void {
    if (this.onScreen === tab) this.onScreen = null;
    this.options.onPage?.("destroyed", tab);
    tab.page.hide();
    tab.page.destroy();
  }
  private info(tab: Tab): BrowserTabInfo {
    return { id: tab.id, url: tab.url, title: tab.title, favicon: tab.favicon, loading: tab.loading, canGoBack: tab.canGoBack, canGoForward: tab.canGoForward, ...(tab.crashed ? { crashed: true } : {}) };
  }
  private emit(botId: string, reveal: boolean): void {
    this.options.onChange(this.state(botId), reveal);
  }
}
