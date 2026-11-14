// The Plugins page (src/renderer/Plugins.tsx, PluginStore.tsx): Installed / Explore / Updates, drawn statically (no window,
// no requests: effects do not run in renderToStaticMarkup). Each catalog state and install outcome has its words; Installed
// offers Update / Revert / Remove where they apply and says when the library holds its own copy; the entry counts updates.
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
const list = (view: PluginStoreView, only: "all" | "updates" = "all", lang: "en" | "zh-Hant" | null = null) =>
  renderToStaticMarkup(createElement(StoreList, { client, store: view, setStore() {}, lang, only, onProblem() {}, onShowCard() {} }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("Explore", () => {
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

  it("Updates lists only plugins with a newer version, or says everything is up to date", () => {
    const html = list(store([entry("fresh", "available"), entry("older", "update", { installedVersion: "1.0.0" }), entry("have", "installed")]), "updates");
    expect(html).toContain('data-plugin="older"');
    expect(html).not.toContain('data-plugin="fresh"');
    expect(html).not.toContain('data-plugin="have"');
    expect(text(list(store([entry("have", "installed")]), "updates"))).toContain("Everything is up to date.");
  });

  it("speaks Traditional Chinese when the app does, and both languages have every word", () => {
    const words = text(list(store([entry("fresh", "available"), entry("future", "tooOld", { minAppVersion: "9.0.0" })]), "all", "zh-Hant"));
    expect(words).toContain("安裝");
    expect(words).toContain("需要 Botling 9.0.0 以上");
    expect(words).toContain("它會：讀寫你電腦上的檔案");
    const keys = Object.keys(en).filter((key) => key.startsWith("plugins."));
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) expect(zhHant[key as keyof typeof zhHant], key).toBeTruthy();
  });
});

describe("Installed", () => {
  const view = plugins([
    plugin("shipped", { builtIn: true, ignoredLibraryVersion: "0.5.0", installedFrom: null }),
    plugin("got", { installedFrom: `https://github.com/william1010121/botling-plugins/tree/${COMMIT}/got`, removable: true, revertTo: "0.9.0" }),
    plugin("mine", { version: "0.9.0" }),
  ]);
  const catalog = store([entry("got", "update", { installedVersion: "1.0.0" }), entry("mine", "devCopy", { installedVersion: "0.9.0" })]);
  const draw = (tab: "installed" | "explore" | "updates" = "installed") => renderToStaticMarkup(createElement(PluginsPanel, { client, plugins: view, onPanel() {}, onClose() {}, embedded: true, initialStore: catalog, initialTab: tab }));

  it("has the three parts as tabs, with the update count on Updates", () => {
    const html = draw();
    expect(html).toMatch(/class="mw-tabs plugins-tabs" role="tablist"/);
    expect(html).toMatch(/data-tab="installed" aria-selected="true" class="on">Installed</);
    expect(html).toMatch(/data-tab="explore" aria-selected="false" class="">Explore</);
    expect(html).toMatch(/data-tab="updates" aria-selected="false" class="">Updates \(1\)</);
    expect(draw("explore")).toContain('data-list="all"');
    expect(draw("updates")).toContain('data-list="updates"');
  });

  it("offers Update, Revert and Remove where they apply, keeps the ignored-older-copy line, and marks the library's own copy", () => {
    const html = draw();
    const got = html.slice(html.indexOf('data-plugin="got"'), html.indexOf('data-plugin="mine"'));
    expect(got).toContain('class="plugin-update">Update to 1.2.0</button>');
    expect(got).toContain('class="plugin-revert">Revert to 0.9.0</button>');
    expect(got).toContain('class="plugin-remove">Remove</button>');
    const shipped = html.slice(html.indexOf('data-plugin="shipped"'), html.indexOf('data-plugin="got"'));
    expect(shipped).toContain("Your plugin library&#x27;s copy (0.5.0) is older and is ignored");
    expect(shipped).not.toMatch(/plugin-update|plugin-revert|plugin-remove/);
    const mine = html.slice(html.indexOf('data-plugin="mine"'));
    expect(mine).toContain("Your plugin library&#x27;s own copy (the published 1.2.0 is not installed over it)");
    expect(mine).not.toMatch(/plugin-update|plugin-revert|plugin-remove/);
  });

  it("the Plugins entry shows how many updates there are", () => {
    const html = renderToStaticMarkup(createElement(PluginsButton, { client, plugins: view, initialStore: catalog }));
    expect(html).toMatch(/class="badge plugins-updates-badge" title="1 update" aria-label="1 update">1</);
    expect(renderToStaticMarkup(createElement(PluginsButton, { client, plugins: view, initialStore: store([]) }))).not.toContain("plugins-updates-badge");
  });
});
