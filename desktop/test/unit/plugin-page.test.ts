// The Plugins page (src/renderer/Plugins.tsx, PluginStore.tsx): Installed / Store / Dependencies, drawn statically (no window,
// no requests: effects do not run in renderToStaticMarkup). Each catalog state and install outcome has its words; Installed is a
// list (what waits for the user's Allow first) and the chosen plugin's detail, with Update / Remove where they apply (no Revert);
// the entry counts what waits for Allow and what has an update.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginsButton, PluginsPanel } from "../../src/renderer/Plugins";
import { StoreList } from "../../src/renderer/PluginStore";
import type { Client } from "../../src/renderer/client";
import type { PluginStoreEntryView, PluginStoreView, PluginView, PluginsView } from "../../src/contract";
import { en } from "../../../Web/src/locales/en";
import { zhHant } from "../../../Web/src/locales/zh-Hant";

const client = {} as Client;
const COMMIT = "a".repeat(40);

function entry(name: string, state: PluginStoreEntryView["state"], more: Partial<PluginStoreEntryView> = {}): PluginStoreEntryView {
  return {
    name, title: name.toUpperCase(), description: `What ${name} does.`, version: "1.2.0", license: "MIT", permissions: ["files"], parts: ["web"], minAppVersion: "2.0.0",
    size: 346_703, files: 4, commit: COMMIT, page: `https://github.com/william1010121/botling-plugins/tree/${COMMIT}/${name}`, state, installedVersion: null, status: null, ...more,
  };
}
function store(entries: PluginStoreEntryView[], more: Partial<PluginStoreView> = {}): PluginStoreView {
  return {
    url: "https://raw.githubusercontent.com/william1010121/botling-plugins/main/index.json", official: true, fetchedAt: Date.UTC(2026, 10, 14, 9, 0), fromCache: false,
    error: null, offline: false, loading: false, appVersion: "2.7.0", entries, updates: entries.filter((one) => one.state === "update").length, ...more,
  };
}
function plugin(name: string, more: Partial<PluginView> = {}): PluginView {
  return { name, title: name.toUpperCase(), version: "1.0.0", description: null, enabled: true, failure: null, installedFrom: null, permissions: [], parts: [], settings: [], commands: [], panels: [], ...more };
}
const plugins = (list: PluginView[]): PluginsView => ({ plugins: list, broken: [], host: { running: true, problem: null }, secretsProblem: null });
const list = (view: PluginStoreView, lang: "en" | "zh-Hant" | null = null) =>
  renderToStaticMarkup(createElement(StoreList, { client, store: view, setStore() {}, lang, onProblem() {}, onShowCard() {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Store", () => {
  it("shows each catalog plugin with what it does, its license, permissions, minimum app version and an action for its state", () => {
    const html = list(store([
      entry("fresh", "available"),
      entry("older", "update", { installedVersion: "1.0.0" }),
      entry("have", "installed", { installedVersion: "1.2.0" }),
      entry("shipped", "builtIn", { installedVersion: "1.2.0" }),
      entry("mine", "devCopy", { installedVersion: "0.9.0" }),
      entry("future", "tooOld", { minAppVersion: "9.0.0" }),
      entry("later", "unreleased", { commit: "", page: null }),
    ]));
    const words = text(html);
    expect(html).toMatch(/data-plugin="fresh" data-state="available"[\s\S]*?<button[^>]*>Install<\/button>/);
    expect(words).toContain("What fresh does.");
    expect(words).toContain("License MIT · Botling 2.0.0+ · 347 KB");
    expect(words).toContain("It will: read and write files on your computer");
    expect(html).toMatch(/data-plugin="older"[\s\S]*?1\.0\.0 → 1\.2\.0[\s\S]*?>Update to 1\.2\.0<\/button>/);
    expect(html).toMatch(/data-plugin="have"[\s\S]*?plugin-store-state">Installed</);
    expect(html).toMatch(/data-plugin="shipped"[\s\S]*?>Built into Botling</);
    expect(html).toMatch(/data-plugin="mine"[\s\S]*?>Your library has its own copy</);
    expect(html).toMatch(/data-plugin="future"[\s\S]*?plugins-problem plugin-store-state">Needs Botling 9\.0\.0 or newer</);
    expect(html).toMatch(/data-plugin="later"[\s\S]*?>Not released yet</);
    // Only available and update have a button (besides "Check again").
    expect((html.match(/<button/g) ?? []).length).toBe(3);
    expect(words).toContain("asks you on a card before anything is installed");
  });

  it("says how an install goes: checking, waiting on the card, installed, declined, refused (a hash mismatch)", () => {
    const html = list(store([
      entry("a", "available", { status: { kind: "checking", message: null } }),
      entry("b", "available", { status: { kind: "asking", message: null } }),
      entry("c", "installed", { status: { kind: "installed", message: null } }),
      entry("d", "available", { status: { kind: "declined", message: null } }),
      entry("e", "available", { status: { kind: "failed", message: 'The downloaded "E" does not match the index (its files hash to 0123456789ab…, the index says fedcba987654…). It was not installed.' } }),
    ]));
    expect(html).toMatch(/data-plugin="a"[\s\S]*?<button[^>]*disabled=""[^>]*>Checking…<\/button>/);
    expect(html).toMatch(/data-plugin="b"[\s\S]*?disabled=""[\s\S]*?Confirm on the card in the main bot&#x27;s chat\.[\s\S]*?>Show the card<\/button>/);
    expect(html).toMatch(/data-plugin="c"[\s\S]*?plugins-result" role="status">Installed\.</);
    expect(html).toMatch(/data-plugin="d"[\s\S]*?Not installed: you chose Don&#x27;t install\./);
    expect(html).toMatch(/data-plugin="e"[\s\S]*?plugins-problem" role="status">The downloaded &quot;E&quot; does not match the index/);
  });

  it("offline shows the cached list and when it is from; a failed fetch says why; never loaded and offline says so", () => {
    const at = Date.UTC(2026, 10, 13, 8, 0);
    const cached = text(list(store([entry("fresh", "available")], { offline: true, fromCache: true, fetchedAt: at, error: "Can't reach raw.githubusercontent.com: fetch failed" })));
    expect(cached).toContain(`Offline: showing the list from ${new Date(at).toLocaleString()}.`);
    expect(cached).toContain("FRESH");
    const failed = text(list(store([entry("fresh", "available")], { fromCache: true, fetchedAt: at, error: "raw.githubusercontent.com answered 404." })));
    expect(failed).toContain(`Couldn't load the plugin list: raw.githubusercontent.com answered 404. Showing the list from ${new Date(at).toLocaleString()}.`);
    const never = text(list(store([], { offline: true, fetchedAt: null, error: "Can't reach raw.githubusercontent.com: fetch failed" })));
    expect(never).toContain("Offline, and the plugin list was never loaded.");
    expect(never).toContain("From botling-plugins · not checked yet");
    expect(never).not.toContain("The catalog has no plugins yet.");
    const testing = text(list(store([], { official: false, url: "http://127.0.0.1:8123/index.json" })));
    expect(testing).toContain("Testing catalog: http://127.0.0.1:8123/index.json");
    expect(text(list(store([], { loading: true, fetchedAt: null })))).toContain("Loading the plugin list…");
  });

  it("speaks Traditional Chinese when the app does, and both languages have every word", () => {
    const words = text(list(store([entry("fresh", "available"), entry("future", "tooOld", { minAppVersion: "9.0.0" })]), "zh-Hant"));
    expect(words).toContain("安裝");
    expect(words).toContain("需要 Botling 9.0.0 以上");
    expect(words).toContain("它會：讀寫你電腦上的檔案");
    const keys = Object.keys(en).filter((key) => key.startsWith("plugins."));
    expect(keys.length).toBeGreaterThan(60);
    for (const key of keys) expect(zhHant[key as keyof typeof zhHant], key).toBeTruthy();
  });
});

const HASH = "4d9bac0566d3ca220a837eba6d48c6496eb75257a36853c7775d662c52634cc8";
const asks = { codeHash: HASH, tier: "write" as const, reads: [], requests: ["chat.send" as const] };

describe("Installed", () => {
  const got = plugin("got", { installedFrom: `https://github.com/william1010121/botling-plugins/tree/${COMMIT}/got`, removable: true, revertTo: "0.9.0" });
  const mine = plugin("mine", { version: "0.9.0" });
  const shipped = plugin("shipped", { builtIn: true, ignoredLibraryVersion: "0.5.0", installedFrom: null });
  const waiting = plugin("wait", { title: "Waiter", grant: "none", asks, permissions: ["files"] });
  const catalog = store([entry("got", "update", { installedVersion: "1.0.0" }), entry("mine", "devCopy", { installedVersion: "0.9.0" })]);
  const draw = (list: PluginView[], tab: "installed" | "explore" | "deps" = "installed", lang: "en" | "zh-Hant" | null = null) =>
    renderToStaticMarkup(createElement(PluginsPanel, { client, plugins: plugins(list), onPanel() {}, onClose() {}, embedded: true, lang, initialTab: tab, initialStore: catalog }));
  const row = (html: string, name: string) => new RegExp(`<li [^>]*data-plugin="${name}"[\\s\\S]*?</li>`).exec(html)?.[0] ?? "";

  it("has Installed, Store and Dependencies as tabs (no Updates tab), with the update count on Installed", () => {
    const html = draw([got, mine, shipped]);
    expect(html).toMatch(/class="mw-tabs plugins-tabs" role="tablist"/);
    expect(html).toMatch(/data-tab="installed" aria-selected="true" class="on">Installed<span class="badge" [^>]*>1</);
    expect(html).toMatch(/data-tab="explore" aria-selected="false" class="">Store</);
    expect(html).toMatch(/data-tab="deps" aria-selected="false" class="">Dependencies</);
    expect(html).not.toContain('data-tab="updates"');
    expect(draw([got], "explore")).toContain('data-list="all"');
  });

  it("puts what waits for Allow first: an orange group, a count, a banner, and Allow on its row", () => {
    const html = draw([got, mine, shipped, waiting]);
    const order = ["allow", "update", "mine", "builtIn"].map((group) => html.indexOf(`data-group="${group}"`));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/data-testid="allow-banner"[\s\S]*?1 plugin is waiting for your Allow: <b>Waiter<\/b>/);
    expect(html).toMatch(/data-tab="installed"[^>]*>Installed<span class="badge waiting" aria-label="1 plugin needs your Allow">1</);
    expect(row(html, "wait")).toMatch(/needs-allow[\s\S]*?Waiting for your Allow[\s\S]*?<button type="button" class="plugin-allow-open">Allow<\/button>/);
    // Nothing waits: no banner, no group, no Allow anywhere.
    const calm = draw([got, mine, shipped]);
    for (const gone of ['data-testid="allow-banner"', 'data-group="allow"', "plugin-allow-open", "plugin-allow-box"]) expect(calm).not.toContain(gone);
  });

  it("opens on the plugin that waits for Allow, with the Allow box at the top of its detail", () => {
    const html = draw([got, mine, shipped, waiting]);
    const detail = html.slice(html.indexOf('class="plugin-detail"'));
    expect(detail).toContain('data-detail="wait"');
    expect(detail.indexOf("plugin-allow-box")).toBeGreaterThan(0);
    expect(detail.indexOf("plugin-allow-box")).toBeLessThan(detail.indexOf("plugin-section"));
    expect(detail).toMatch(/plugin-allow-box[\s\S]*?<button type="button" class="plugin-allow-open big">Allow<\/button>/);
    // The card is not drawn until Allow is tapped.
    expect(html).not.toContain("plugin-install-card");
  });

  it("offers Update and Remove in the detail (no Revert, even where the core still holds an older copy)", () => {
    const html = draw([got, mine, shipped]);
    expect(html).toContain('data-detail="got"');
    const detail = html.slice(html.indexOf('class="plugin-detail"'));
    expect(detail).toContain('class="plugin-update">Update to 1.2.0</button>');
    expect(detail).toContain('class="plugin-remove">Remove</button>');
    expect(html).not.toMatch(/plugin-revert|Revert|revert/);
    expect(row(html, "got")).toContain('class="plugin-update">Update</button>');
    expect(row(html, "mine")).not.toContain("plugin-update");
  });

  it("keeps the ignored-older-copy line for a built-in plugin, and marks the library's own copy", () => {
    const one = draw([shipped]);
    expect(one).toContain("Your plugin library&#x27;s copy (0.5.0) is older and is ignored");
    expect(one).not.toMatch(/plugin-update|plugin-remove|plugin-allow/);
    const own = draw([mine]);
    expect(own).toContain("Your plugin library&#x27;s own copy (the published 1.2.0 is not installed over it)");
    expect(own).not.toMatch(/plugin-update|plugin-remove|plugin-allow/);
  });

  it("the Dependencies tab holds the board (its frame), or says the board is off", () => {
    const deps = plugin("botling.deps", { title: "Plugin dependencies", builtIn: true });
    expect(draw([deps], "deps")).toMatch(/class="plugins-deps"><div class="plugin-slot" data-plugin="botling.deps" data-view="botling.deps.board"/);
    const off = draw([{ ...deps, enabled: false }], "deps");
    expect(off).toContain("The dependency board is not available");
    expect(off).not.toContain("plugin-slot");
    expect(text(draw([], "deps", "zh-Hant"))).not.toContain("The dependency board");
  });

  it("speaks Traditional Chinese for the new words", () => {
    const words = text(draw([got, waiting], "installed", "zh-Hant"));
    expect(words).toContain("等你按「允許」");
    expect(words).toContain("允許");
    expect(words).not.toContain("Waiting for your Allow");
  });

  it("the Plugins entry counts what waits for Allow (orange) and, apart, how many updates there are", () => {
    const html = renderToStaticMarkup(createElement(PluginsButton, { client, plugins: plugins([got, mine, waiting]), initialStore: catalog }));
    expect(html).toMatch(/class="badge waiting plugins-allow-badge" title="1 plugin needs your Allow" aria-label="1 plugin needs your Allow">1</);
    expect(html).toMatch(/class="badge plugins-updates-badge" title="1 update" aria-label="1 update">1</);
    const calm = renderToStaticMarkup(createElement(PluginsButton, { client, plugins: plugins([got, mine]), initialStore: store([]) }));
    expect(calm).not.toContain("plugins-allow-badge");
    expect(calm).not.toContain("plugins-updates-badge");
    // A built-in plugin, or one without asks, never waits for Allow.
    const none = renderToStaticMarkup(createElement(PluginsButton, { client, plugins: plugins([{ ...waiting, builtIn: true }, { ...waiting, name: "x", asks: undefined }]), initialStore: store([]) }));
    expect(none).not.toContain("plugins-allow-badge");
  });
});
