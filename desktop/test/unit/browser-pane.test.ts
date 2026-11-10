// The in-app browser pane, phase 1 (2026-11-10): main's tab manager (one page per tab, each bot its own tabs, at most
// 8, only the shown bot's active page on screen), the wire main accepts from the app page, how a chat link opens
// (a plain click in the pane, ⌘-click in the default browser), and when the floating toolbar shows and hides.
import { describe, expect, it } from "vitest";
import { BrowserTabs, type TabPage } from "../../src/main/browser-tabs";
import { clickOpensOutside, isWebUrl, parseBrowserUp, urlFromInput, type BrowserBotState, type BrowserRect } from "../../src/browser-wire";
import { linkOpenWay } from "../../src/main/report-preview";
import { ToolbarVisibility, type ToolbarTimers } from "../../src/renderer/browser-toolbar";

class FakePage implements TabPage {
  loads: string[] = [];
  bounds: BrowserRect | null = null;
  visible = false;
  destroyed = false;
  back() {} forward() {} stop() {} focus() {}
  reloads = 0;
  constructor(public botId: string, public tabId: string) {}
  load(url: string) { this.loads.push(url); }
  reload() { this.reloads++; }
  canGoBack() { return this.loads.length > 1; }
  canGoForward() { return false; }
  show(bounds: BrowserRect) { this.bounds = bounds; this.visible = true; }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; }
}

function setup(max?: number) {
  const pages = new Map<string, FakePage>();
  const changes: { state: BrowserBotState; reveal: boolean }[] = [];
  const events: string[] = [];
  const tabs = new BrowserTabs({
    create: (botId, tabId) => { const page = new FakePage(botId, tabId); pages.set(tabId, page); return page; },
    onChange: (state, reveal) => changes.push({ state, reveal }),
    onPage: (event, tab) => events.push(`${event}:${tab.id}`),
    ...(max ? { max } : {}),
  });
  return { tabs, pages, changes, events, last: () => changes.at(-1)! };
}
const BOUNDS = { x: 600, y: 90, width: 500, height: 700 };

describe("BrowserTabs (main's tab manager)", () => {
  it("opens a link in a new tab of that bot, loads it and asks the app page to show the pane", () => {
    const { tabs, pages, last, events } = setup();
    const id = tabs.open("bot-a", "https://example.com/");
    expect(pages.get(id)!.loads).toEqual(["https://example.com/"]);
    expect(last()).toMatchObject({ reveal: true, state: { botId: "bot-a", active: id, tabs: [{ id, url: "https://example.com/", loading: true }] } });
    expect(events).toEqual([`created:${id}`]);
  });

  it("selects the tab already on a URL instead of opening it twice", () => {
    const { tabs, pages } = setup();
    const first = tabs.open("bot-a", "https://a.test/");
    tabs.open("bot-a", "https://b.test/");
    expect(tabs.open("bot-a", "https://a.test/")).toBe(first);
    expect(pages.size).toBe(2);
    expect(tabs.state("bot-a").active).toBe(first);
  });

  it("keeps each bot's tabs apart and shows only the shown bot's active page", () => {
    const { tabs, pages } = setup();
    const a = tabs.open("bot-a", "https://a.test/");
    const b = tabs.open("bot-b", "https://b.test/");
    expect(tabs.state("bot-a").tabs.map((tab) => tab.id)).toEqual([a]);
    expect(tabs.state("bot-b").tabs.map((tab) => tab.id)).toEqual([b]);
    tabs.layout("bot-a", BOUNDS);
    expect(pages.get(a)).toMatchObject({ visible: true, bounds: BOUNDS });
    expect(pages.get(b)!.visible).toBe(false);
    tabs.layout("bot-b", BOUNDS);
    expect(pages.get(a)!.visible).toBe(false);
    expect(pages.get(b)!.visible).toBe(true);
    tabs.layout(null, null);
    expect(pages.get(b)!.visible).toBe(false);
    expect(tabs.visible()).toBeNull();
  });

  it("switches the page on screen when another tab is selected or opened", () => {
    const { tabs, pages } = setup();
    const first = tabs.open("bot-a", "https://a.test/");
    tabs.layout("bot-a", BOUNDS);
    const second = tabs.open("bot-a", "https://b.test/");
    expect(pages.get(first)!.visible).toBe(false);
    expect(pages.get(second)!.visible).toBe(true);
    tabs.select("bot-a", first);
    expect(pages.get(first)!.visible).toBe(true);
    expect(pages.get(second)!.visible).toBe(false);
  });

  it("has at most 8 tabs per bot: the 9th link reuses the least recently used tab", () => {
    const { tabs, pages } = setup();
    const ids = Array.from({ length: 8 }, (_, i) => tabs.open("bot-a", `https://site${i}.test/`));
    tabs.select("bot-a", ids[0]!);
    const ninth = tabs.open("bot-a", "https://nine.test/");
    expect(ninth).toBe(ids[1]);
    expect(tabs.state("bot-a").tabs).toHaveLength(8);
    expect(pages.size).toBe(8);
    expect(pages.get(ids[1]!)!.loads.at(-1)).toBe("https://nine.test/");
    // Another bot still gets its own 8.
    tabs.open("bot-b", "https://b.test/");
    expect(tabs.state("bot-b").tabs).toHaveLength(1);
  });

  it("closing the active tab activates its right neighbour (else the left) and destroys its page", () => {
    const { tabs, pages, events } = setup();
    const [a, b, c] = ["https://a.test/", "https://b.test/", "https://c.test/"].map((url) => tabs.open("bot-a", url));
    tabs.layout("bot-a", BOUNDS);
    tabs.select("bot-a", b!);
    tabs.close("bot-a", b!);
    expect(pages.get(b!)!.destroyed).toBe(true);
    expect(events).toContain(`destroyed:${b}`);
    expect(tabs.state("bot-a").active).toBe(c);
    expect(pages.get(c!)!.visible).toBe(true);
    tabs.close("bot-a", c!);
    expect(tabs.state("bot-a").active).toBe(a);
    tabs.close("bot-a", a!);
    expect(tabs.state("bot-a")).toEqual({ botId: "bot-a", tabs: [], active: null });
  });

  it("closeBot (bot removed, Close browser) destroys every page of that bot only", () => {
    const { tabs, pages, last } = setup();
    const a1 = tabs.open("bot-a", "https://a.test/");
    const a2 = tabs.open("bot-a", "https://a2.test/");
    const b = tabs.open("bot-b", "https://b.test/");
    tabs.closeBot("bot-a");
    expect(pages.get(a1)!.destroyed && pages.get(a2)!.destroyed).toBe(true);
    expect(pages.get(b)!.destroyed).toBe(false);
    expect(last().state).toEqual({ botId: "bot-a", tabs: [], active: null });
  });

  it("takes what a page reports, and loads a crashed page again when it is selected", () => {
    const { tabs, pages } = setup();
    const id = tabs.open("bot-a", "https://a.test/");
    tabs.update("bot-a", id, { title: "A site", loading: false });
    expect(tabs.state("bot-a").tabs[0]).toMatchObject({ title: "A site", loading: false });
    tabs.update("bot-a", id, { crashed: true });
    tabs.select("bot-a", id);
    expect(pages.get(id)!.loads).toEqual(["https://a.test/", "https://a.test/"]);
    expect(tabs.state("bot-a").tabs[0]!.crashed).toBeUndefined();
  });

  it("navigate goes in the active tab, or opens one when the bot has none", () => {
    const { tabs, pages } = setup();
    tabs.navigate("bot-a", "https://first.test/");
    const id = tabs.state("bot-a").active!;
    tabs.navigate("bot-a", "https://second.test/");
    expect(tabs.state("bot-a").tabs).toHaveLength(1);
    expect(pages.get(id)!.loads).toEqual(["https://first.test/", "https://second.test/"]);
  });

  it("gives later phases each tab's page (pageOf) without exposing the list", () => {
    const { tabs, pages } = setup();
    const id = tabs.open("bot-a", "https://a.test/");
    expect(tabs.pageOf("bot-a", id)).toBe(pages.get(id));
    expect(tabs.pageOf("bot-b", id)).toBeNull();
  });
});

describe("the browser wire", () => {
  it("accepts only well-formed messages", () => {
    expect(parseBrowserUp({ type: "layout", botId: "b1", bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ type: "layout", botId: "b1", bounds: { x: 1, y: 2, width: 3, height: 4 } });
    expect(parseBrowserUp({ type: "layout", botId: null, bounds: null })).toEqual({ type: "layout", botId: null, bounds: null });
    expect(parseBrowserUp({ type: "layout", botId: "b1", bounds: { x: 1, y: 2, width: 3 } })).toBeNull();
    expect(parseBrowserUp({ type: "layout", botId: "b1", bounds: { x: 1, y: 2, width: 3, height: Infinity } })).toBeNull();
    expect(parseBrowserUp({ type: "select", botId: "b1", tabId: "../x" })).toBeNull();
    expect(parseBrowserUp({ type: "select", botId: "b 1", tabId: "t1" })).toBeNull();
    expect(parseBrowserUp({ type: "navigate", botId: "b1", input: "" })).toBeNull();
    expect(parseBrowserUp({ type: "eval", botId: "b1", code: "x" })).toBeNull();
    expect(parseBrowserUp("hello")).toBeNull();
    expect(parseBrowserUp({ type: "menu", botId: "b1", x: 10, y: 20 })).toEqual({ type: "menu", botId: "b1", x: 10, y: 20 });
  });

  it("opens only web pages, and turns the URL bar's text into one", () => {
    expect(isWebUrl("https://example.com/a")).toBe(true);
    expect(isWebUrl("http://localhost:3000")).toBe(true);
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "botling-card://page/x", "data:text/html,x", "mailto:a@b.c", "https://"]) expect(isWebUrl(bad)).toBe(false);
    expect(urlFromInput("example.com/pricing")).toBe("https://example.com/pricing");
    expect(urlFromInput("localhost:5173")).toBe("http://localhost:5173/");
    expect(urlFromInput("  https://a.test/x?y=1 ")).toBe("https://a.test/x?y=1");
    expect(urlFromInput("electron web contents view")).toBe("https://www.google.com/search?q=electron%20web%20contents%20view");
    expect(urlFromInput("javascript:alert(1)")).toBeNull();
    expect(urlFromInput("file:///etc/hosts")).toBeNull();
    expect(urlFromInput("   ")).toBeNull();
  });
});

describe("how a chat link opens", () => {
  const link = (url: string, more: Partial<Parameters<typeof linkOpenWay>[0]> = {}) => linkOpenWay({ url, source: "user", preview: false, reveal: false, pane: true, ...more });
  it("a plain click on a web link opens it in the pane; ⌘-click (external) in the default browser", () => {
    expect(link("https://example.com/")).toBe("pane");
    expect(link("http://localhost:3000/")).toBe("pane");
    expect(link("https://example.com/", { external: true })).toBe("open");
    expect(link("https://example.com/", { source: "component" })).toBe("pane");
  });
  it("other links keep their way: mailto and files outside, Markdown in the preview, no pane window outside", () => {
    expect(link("mailto:a@b.c")).toBe("open");
    expect(link("/Users/me/notes/plan.md")).toBe("markdown");
    expect(link("/Users/me/report.pdf")).toBe("open");
    expect(link("https://example.com/", { pane: false })).toBe("open");
    expect(link("https://example.com/report.html", { source: "component", preview: true })).toBe("preview");
  });
  it("⌘ is the Mac's key, Ctrl elsewhere", () => {
    expect(clickOpensOutside({ metaKey: true, ctrlKey: false }, "darwin")).toBe(true);
    expect(clickOpensOutside({ metaKey: false, ctrlKey: true }, "darwin")).toBe(false);
    expect(clickOpensOutside({ metaKey: false, ctrlKey: true }, "win32")).toBe(true);
    expect(clickOpensOutside({ metaKey: true, ctrlKey: false }, "linux")).toBe(false);
    expect(clickOpensOutside(null, "darwin")).toBe(false);
  });
});

describe("the floating toolbar", () => {
  function clock() {
    let now = 0;
    const pending = new Map<number, { at: number; run: () => void }>();
    let next = 0;
    const timers: ToolbarTimers = {
      set: (run, ms) => { const id = ++next; pending.set(id, { at: now + ms, run }); return id; },
      clear: (id) => { pending.delete(id as number); },
    };
    const advance = (ms: number) => {
      now += ms;
      for (const [id, timer] of [...pending]) if (timer.at <= now) { pending.delete(id); timer.run(); }
    };
    return { timers, advance };
  }
  function toolbar() {
    const { timers, advance } = clock();
    const seen: boolean[] = [];
    const bar = new ToolbarVisibility((visible) => seen.push(visible), timers);
    return { bar, advance, seen };
  }

  it("is hidden until the pointer reaches the top edge, and goes 1 s after it leaves", () => {
    const { bar, advance, seen } = toolbar();
    expect(bar.visible).toBe(false);
    bar.enter();
    expect(bar.visible).toBe(true);
    bar.leave();
    advance(999);
    expect(bar.visible).toBe(true);
    advance(1);
    expect(bar.visible).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("coming back within the second keeps it out", () => {
    const { bar, advance } = toolbar();
    bar.enter(); bar.leave();
    advance(600);
    bar.enter();
    advance(2000);
    expect(bar.visible).toBe(true);
  });

  it("the page's own top edge brings it out for a second", () => {
    const { bar, advance } = toolbar();
    bar.edge();
    expect(bar.visible).toBe(true);
    advance(1000);
    expect(bar.visible).toBe(false);
  });

  it("stays while the URL bar has the focus (⌘L) or the site-tools sheet is open", () => {
    const { bar, advance } = toolbar();
    bar.focusUrl(true);
    advance(5000);
    expect(bar.visible).toBe(true);
    bar.focusUrl(false);
    advance(1000);
    expect(bar.visible).toBe(false);
    bar.sheet(true);
    bar.enter(); bar.leave();
    advance(5000);
    expect(bar.visible).toBe(true);
    bar.sheet(false);
    advance(1000);
    expect(bar.visible).toBe(false);
  });
});
