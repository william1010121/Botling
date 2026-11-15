// The renderer's plugin list held as kernel registrations (M7-02b; shell/plugin-feed.ts). A private kernel with the shell's slots
// (the same lists renderer-kernel.ts gives `:shell`) is fed `PluginsView`s: the step-1 fixture (kernel-goldens/plugins-list.json, the
// 2.x list of 17 plugins with every view place and menu), views with a plugin turned off or changed, 200 seeded random view
// sequences, and hostile plugin names. The renderer's own kernel and the DOM are in renderer-plugin-feed-ui.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Kernel, ROOT_SLOTS, canonicalSlot, slotName, type KernelEvent } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../src/contract";
import { FEED_MENU_SLOTS, FEED_SLOTS, FEED_VIEWS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { PluginFeed, type FeedEntry } from "../../src/renderer/shell/plugin-feed";
import { desktop, envCount } from "../helpers";

const SHELL = ":shell";
const CHAT = ":chat";
/** Stands in for `botling.settings` (M7-02c): the plugin that owns the two settings slots now, not `:shell`. */
const SETTINGS = ":settings";

const startSettings = (kernel: Kernel) => {
  kernel.install({ name: SETTINGS, provides: { slots: PLUGIN_OWNED_SLOTS } });
  void kernel.load(SETTINGS, (plugin) => { for (const slot of PLUGIN_OWNED_SLOTS) kernel.provideSlot(plugin, slot); });
};

/** A kernel like the renderer's (`:shell` owns the root and the feed's slots, `:settings` the settings slots, `:chat` is up) and a feed on it. */
function setup({ settings = true } = {}) {
  const events: KernelEvent[] = [];
  const kernel = new Kernel({ slotName: canonicalSlot, log: (event) => events.push(event) });
  const slots = [...ROOT_SLOTS, ...FEED_SLOTS];
  kernel.install({ name: SHELL, provides: { slots } });
  void kernel.load(SHELL, (plugin) => { for (const slot of slots) kernel.provideSlot(plugin, slot); });
  if (settings) startSettings(kernel);
  kernel.install({ name: CHAT, provides: { services: ["composer.insertQuote"] } });
  void kernel.load(CHAT, (plugin) => { kernel.provide(plugin, "composer.insertQuote", () => undefined); });
  return { kernel, events, feed: new PluginFeed(kernel) };
}

const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;

type Menus = NonNullable<PluginsView["menus"]>;
/** `view` with `plugin` turned off: its list entry says so and its rows are gone (as the core's arrays are for a plugin that is off). */
function without(view: PluginsView, plugin: string): PluginsView {
  const next: Record<string, unknown> = { ...view, plugins: view.plugins.map((entry) => (entry.name === plugin ? { ...entry, enabled: false } : entry)) };
  for (const [key] of FEED_VIEWS) next[key] = (view[key] as { plugin: string }[] | undefined)?.filter((row) => row.plugin !== plugin);
  next.menus = view.menus?.filter((row) => row.plugin !== plugin);
  return next as unknown as PluginsView;
}

/** The rows a view holds for `slot`, from its arrays. */
function expectedRows(view: PluginsView, slot: string): unknown[] {
  const viewKey = FEED_VIEWS.find(([, place]) => canonicalSlot(place) === canonicalSlot(slot));
  if (viewKey) return view[viewKey[0]] ?? [];
  return (view.menus ?? []).filter((row) => canonicalSlot(`menu/${row.menu}`) === canonicalSlot(slot));
}

const allSlots = (): string[] => [...FEED_VIEWS.map(([, slot]) => slot), ...FEED_MENU_SLOTS];

describe("the plugin feed holds the plugin list in the kernel", () => {
  it("has each slot's rows equal the PluginsView array they mirror, same order, under either name of the slot", () => {
    const { feed, kernel } = setup();
    const view = fixture();
    feed.reconcile(view);
    for (const [key, slot] of FEED_VIEWS) {
      expect((view[key] ?? []).length, `${key} is in the fixture`).toBeGreaterThan(0);
      expect(feed.rows(slot), key).toEqual(view[key]);
      expect(feed.rows(slotName(slot)), `${key} by its new name`).toEqual(view[key]);
    }
    for (const slot of FEED_MENU_SLOTS) {
      expect(expectedRows(view, slot).length, `${slot} is in the fixture`).toBeGreaterThan(0);
      expect(feed.rows(slot), slot).toEqual(expectedRows(view, slot));
      expect(feed.rows(slotName(slot)), `${slot} by its new name`).toEqual(expectedRows(view, slot));
    }
    // One instance per enabled plugin, named as it is (and the shell's two).
    expect(kernel.plugins().filter((name) => !name.startsWith(":"))).toEqual(view.plugins.map((plugin) => plugin.name));
    expect(feed.loaded()).toEqual(view.plugins.map((plugin) => plugin.name));
    // A row is a registration of its own plugin: the kernel's entries name the plugin the row says.
    for (const slot of allSlots()) for (const { plugin, entry } of kernel.entries<FeedEntry<{ plugin: string }>>(slot)) expect(entry.row.plugin).toBe(plugin);
  });

  it("has a plugin turned off lose exactly its registrations, newest first, and nothing of another plugin", () => {
    const { feed, kernel, events } = setup();
    const view = fixture();
    feed.reconcile(view);
    const ids = (name: string) => kernel.registrations(name, "contribution").map((registration) => registration.id);
    const others = Object.fromEntries(view.plugins.filter((plugin) => plugin.name !== "zed.tools").map((plugin) => [plugin.name, ids(plugin.name)]));
    const registered = events.filter((event) => event.action === "Register" && event.plugin === "zed.tools").map((event) => event.registration);
    expect(registered).toHaveLength(15); // 8 view places and 7 menus
    const before = events.length;

    feed.reconcile(without(view, "zed.tools"));

    const steps = events.slice(before);
    expect(steps.every((event) => event.plugin === "zed.tools")).toBe(true);
    expect(steps.map((event) => event.action)).toEqual(["RequestUnload", "BeginUnload", ...registered.map(() => "RunUndo"), "FinishUnload"]);
    expect(steps.filter((event) => event.action === "RunUndo").map((event) => event.registration)).toEqual([...registered].reverse());
    for (const slot of allSlots()) expect(feed.rows(slot), slot).toEqual(expectedRows(without(view, "zed.tools"), slot));
    for (const [name, held] of Object.entries(others)) expect(ids(name), name).toEqual(held);
    expect(kernel.plugins()).not.toContain("zed.tools");
    expect(kernel.installed()).not.toContain("zed.tools");
    expect(feed.loaded()).not.toContain("zed.tools");
  });

  it("touches nothing for a view that is the same (also a copy of it), and reloads only the plugin whose fingerprint or rows changed", () => {
    const { feed, kernel, events } = setup();
    const view = fixture();
    feed.reconcile(view);
    let seen = events.length;
    const steps = () => { const taken = events.slice(seen); seen = events.length; return taken; };

    feed.reconcile(view);
    feed.reconcile(structuredClone(view));
    expect(steps()).toEqual([]);

    // A new fingerprint (the plugin's version) reloads that plugin only.
    const bumped = { ...view, plugins: view.plugins.map((plugin) => (plugin.name === "ccb-latex" ? { ...plugin, version: "9.9.9" } : plugin)) };
    feed.reconcile(bumped);
    const bump = steps();
    expect(new Set(bump.map((event) => event.plugin))).toEqual(new Set(["ccb-latex"]));
    expect(bump.map((event) => event.action)[0]).toBe("RequestUnload");
    expect(kernel.state("ccb-latex")).toBe("active");
    expect(feed.loaded()).toEqual(view.plugins.map((plugin) => plugin.name));

    // A changed row reloads that plugin only; the reloaded plugin's rows come after the others' (registration order).
    const retitled = structuredClone(bumped);
    retitled.settingsSections = retitled.settingsSections!.map((row) => (row.plugin === "botling.git" ? { ...row, title: "Git, changed" } : row));
    const zed = feed.rows<{ plugin: string }>("view/settings.section").find((row) => row.plugin === "zed.tools");
    feed.reconcile(retitled);
    expect(new Set(steps().map((event) => event.plugin))).toEqual(new Set(["botling.git"]));
    const sections = feed.rows<{ plugin: string; title: string }>("view/settings.section");
    expect(sections.map((row) => row.plugin)).toEqual(["botling.usage", "zed.tools", "botling.git"]);
    expect(sections.at(-1)!.title).toBe("Git, changed");
    expect(sections[1]).toEqual(zed);
  });

  it("holds a plugin with no rows as an instance, and a row of a plugin the list does not name", () => {
    const { feed } = setup();
    const view = fixture();
    expect(view.plugins.some((plugin) => plugin.name === "ccb-latex")).toBe(true);
    feed.reconcile({ ...view, plugins: view.plugins.filter((plugin) => plugin.name !== "botling.git") });
    expect(feed.loaded()).toContain("ccb-latex");
    // `botling.git` is not listed but has rows: still an instance (the arrays are what surfaces read).
    expect(feed.loaded()).toContain("botling.git");
    // (After the listed plugins': the instances load in the list's order, then the ones only the rows name.)
    expect(feed.rows("view/settings.section")).toEqual([...view.settingsSections!.filter((row) => row.plugin !== "botling.git"), ...view.settingsSections!.filter((row) => row.plugin === "botling.git")]);
  });

  it("uses the plugins.web answer's version in the fingerprint", () => {
    const { feed, events } = setup();
    const view = fixture();
    feed.reconcile(view, { specs: [{ name: "ccb-latex", version: "1" }] });
    const before = events.length;
    feed.reconcile(view, { specs: [{ name: "ccb-latex", version: "1" }] });
    expect(events.length).toBe(before);
    feed.reconcile(view, { specs: [{ name: "ccb-latex", version: "2" }] });
    expect(new Set(events.slice(before).map((event) => event.plugin))).toEqual(new Set(["ccb-latex"]));
  });

  it("leaves an instance it did not make alone: no install over it, no unload, no registrations in its name", () => {
    const { feed, kernel } = setup();
    kernel.install({ name: "botling.settings", contributes: { slots: ["view/settings.section"] } });
    void kernel.load("botling.settings", (plugin) => { kernel.contribute(plugin, "settings/section", { kind: "component", render: () => null }); });
    const mine = kernel.registrations("botling.settings", "contribution").map((registration) => registration.id);
    expect(mine).toHaveLength(1);
    const view = fixture();
    const listed = { ...view, plugins: [...view.plugins, { ...view.plugins[0]!, name: "botling.settings" }], settingsSections: [...view.settingsSections!, { plugin: "botling.settings", id: "x", title: "X", terms: "" }] };
    feed.reconcile(listed);
    expect(feed.loaded()).not.toContain("botling.settings");
    expect(kernel.registrations("botling.settings", "contribution").map((registration) => registration.id)).toEqual(mine);
    expect(kernel.entries("view/settings.section").filter(({ plugin }) => plugin === "botling.settings")).toHaveLength(1);
    // Gone from the view: the feed does not unload what it did not load.
    feed.reconcile(null);
    expect(kernel.state("botling.settings")).toBe("active");
    expect(feed.loaded()).toEqual([]);
  });

  it("skips names that are not plugin names, and holds a name like `constructor` as any other", () => {
    const { feed, kernel } = setup();
    const row = (plugin: string, id: string) => ({ plugin, id, title: id });
    const listed = (name: string) => ({ ...fixture().plugins[0]!, name });
    const view = {
      plugins: [":shell", ":chat", "__proto__", "toString", "constructor", "hasOwnProperty", "a b"].map(listed), broken: [], host: { running: true, problem: null }, secretsProblem: null,
      quickSettings: [":shell", ":chat", "__proto__", "toString", "constructor", "valueOf", "a/b"].map((name) => row(name, "q")),
    } as unknown as PluginsView;
    feed.reconcile(view);
    expect(feed.loaded()).toEqual(["constructor"]);
    expect(kernel.plugins().sort()).toEqual([CHAT, SETTINGS, SHELL, "constructor"].sort());
    expect(feed.rows<{ plugin: string }>("view/quickSettings")).toEqual([row("constructor", "q")]);
    expect(kernel.allContributions().map(({ plugin }) => plugin)).toEqual(["constructor"]);
    expect(kernel.state(SHELL)).toBe("active");
    feed.reconcile(null);
    expect(kernel.plugins().sort()).toEqual([CHAT, SETTINGS, SHELL]);
  });

  it("skips a menu row whose menu is not a menu slot", () => {
    const { feed, kernel, events } = setup();
    const view = { ...fixture(), menus: [{ menu: "no/such", command: "c", plugin: "zed.tools", title: "T" }, { menu: "chat/link", command: "c", plugin: "zed.tools", title: "T" }] } as unknown as PluginsView;
    feed.reconcile(view);
    expect(feed.rows("menu/chat/link")).toHaveLength(1);
    expect(kernel.allContributions().filter(({ entry }) => (entry as FeedEntry<{ menu?: string }>).row.menu === "no/such")).toEqual([]);
    // Dropped by the feed, not refused by the kernel: the plugin never declared the slot and no step was refused.
    expect(kernel.declaration("zed.tools")?.contributes?.slots).not.toContain("menu/no/such");
    expect(events.filter((event) => event.note?.startsWith("refused"))).toEqual([]);
  });

  it("registers again the rows a settings slot refused while its owner was away, when `refresh` says the owner is back, and touches no other plugin", () => {
    const { feed, kernel, events } = setup({ settings: false });
    const view = fixture();
    feed.reconcile(view);
    // No owner: the kernel refuses the contributions to the settings slots (the plugins' other rows are held as always).
    expect(feed.rows("view/settings.section")).toEqual([]);
    expect(feed.rows("view/quickSettings")).toEqual([]);
    // The main tabs are botling.chat's place now (M7-07a): refused here too, with no owner up.
    expect(feed.rows("view/mainTab")).toEqual([]);
    const settingsOwners = new Set([...(view.settingsSections ?? []), ...(view.quickSettings ?? [])].map((row) => row.plugin));
    const quiet = view.plugins.map((plugin) => plugin.name).filter((name) => !settingsOwners.has(name));
    expect(quiet.length).toBeGreaterThan(2);
    startSettings(kernel);
    // The kernel does not ask again by itself: nothing is registered until the feed is told.
    expect(feed.rows("view/settings.section")).toEqual([]);
    const before = events.length;
    feed.refresh(["settings/section", "settings/quick"]);
    expect(feed.rows("view/settings.section")).toEqual(view.settingsSections);
    expect(feed.rows("settings/quick")).toEqual(view.quickSettings);
    expect(new Set(events.slice(before).map((event) => event.plugin).filter((name) => quiet.includes(name)))).toEqual(new Set());
    // The stand-in owner holds main/tab too, but the feed was not told: the tabs come when it is.
    expect(feed.rows("view/mainTab")).toEqual([]);
    feed.refresh(["main/tab"]);
    expect(feed.rows("view/mainTab")).toEqual(view.mainTabs);
    // A slot nobody here contributes to: no step at all.
    const steady = events.length;
    feed.refresh(["app/rail"]);
    expect(events.length).toBe(steady);
  });

  it("keeps every slot's order as a fresh load gives it after `refresh` (a plugin with a settings row is reloaded; its other slots must not move)", () => {
    const { feed, kernel } = setup({ settings: false });
    const view = fixture();
    // botling.note comes before botling.whiteboard in `view/mainTab`; give it a settings row, so the refresh reloads it (and botling.git, botling.usage, zed.tools).
    view.settingsSections = [...view.settingsSections!, { ...view.settingsSections![0]!, plugin: "botling.note", id: "botling.note.settings", title: "Note" }];
    feed.reconcile(view);
    startSettings(kernel);
    // The late-started owner holds every PLUGIN_OWNED_SLOTS place now (the settings two, botling.chat's, M7-06a, and botling.bot-panel's, M7-03a): the feed is told all of them.
    feed.refresh(["settings/section", "settings/quick", ...PLUGIN_OWNED_SLOTS]);
    const fresh = setup().feed;
    fresh.reconcile(view);
    expect(fresh.rows("view/mainTab").map((row) => (row as { plugin: string }).plugin).slice(0, 2)).toEqual(["botling.note", "botling.whiteboard"]);
    for (const slot of allSlots()) expect(feed.rows(slot), slot).toEqual(fresh.rows(slot));
    expect(feed.loaded().sort()).toEqual(fresh.loaded().sort());
    // And a second refresh, and a refresh after a reconcile with a changed view, keep it too.
    feed.refresh(["settings/section"]);
    for (const slot of allSlots()) expect(feed.rows(slot), slot).toEqual(fresh.rows(slot));
  });

  it("holds the rows again when the shell goes away and comes back", async () => {
    const { feed, kernel } = setup();
    const view = fixture();
    feed.reconcile(view);
    await kernel.requestUnload(SHELL);
    // The plugins depend on the shell's slots: they go first.
    expect(kernel.state("zed.tools")).toBe("absent");
    // The tabs of plugins that have rows only in places another plugin owns stay (main/tab is botling.chat's, M7-07a; the stand-in owner is up).
    expect(feed.rows("view/mainTab").map((row) => (row as { plugin: string }).plugin)).toEqual(["botling.note", "botling.whiteboard"]);
    expect(() => feed.reconcile(view)).not.toThrow();
    await kernel.load(SHELL);
    // Registration order (P2), exactly: a plugin whose rows are all in slots another plugin owns (the settings slots) did not wait for the shell,
    // so it was registered first; every other plugin loaded when the shell came back, in the list's order. Within each of the two groups the
    // order is the list's. (A stable partition of the array, not "any order": a plugin's rows must still be in the array's order.)
    const owned = new Set(PLUGIN_OWNED_SLOTS.map(canonicalSlot));
    const plugin = (row: unknown) => (row as { plugin: string }).plugin;
    const early = (name: string) => allSlots().filter((slot) => expectedRows(view, slot).some((row) => plugin(row) === name)).every((slot) => owned.has(canonicalSlot(slot)));
    for (const slot of allSlots()) {
      const rows = expectedRows(view, slot);
      expect(feed.rows(slot), slot).toEqual([...rows.filter((row) => early(plugin(row))), ...rows.filter((row) => !early(plugin(row)))]);
    }
    expect(allSlots().some((slot) => expectedRows(view, slot).some((row) => early(plugin(row)))), "the fixture has a plugin whose rows are all in the settings slots").toBe(true);
    feed.reconcile(null);
    expect(kernel.plugins().filter((name) => !name.startsWith(":"))).toEqual([]);
  });
});

// A small seeded generator (mulberry32), so a failing sequence is reproduced by its number.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = ["alpha", "beta", "gamma", "constructor", "zed.tools", "a-b", "x1", "delta"];
const MENUS = FEED_MENU_SLOTS.map((slot) => slot.slice("menu/".length));

function randomView(next: () => number): PluginsView {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const on = POOL.filter(() => next() < 0.5);
  const base = fixture().plugins[0]!;
  const view: Record<string, unknown> = {
    plugins: on.map((name) => ({ ...base, name, version: `1.${Math.floor(next() * 2)}.0`, enabled: true, failure: null })),
    broken: [], host: { running: true, problem: null }, secretsProblem: null,
  };
  for (const [key] of FEED_VIEWS) {
    view[key] = on.flatMap((plugin) => Array.from({ length: Math.floor(next() * 3) }, (_, index) => ({ plugin, id: `${plugin}.${key}.${index}`, title: `t${Math.floor(next() * 2)}` })));
  }
  view.menus = on.flatMap((plugin) => Array.from({ length: Math.floor(next() * 3) }, (_, index) => ({ menu: pick(MENUS), command: `${plugin}.c${index}`, plugin, title: `m${Math.floor(next() * 2)}` })));
  return view as unknown as PluginsView;
}

describe("the plugin feed over seeded random view sequences", () => {
  it(`keeps each slot's rows equal to the view's (a plugin's own order kept), and holds only the shell and chat after an empty view (${envCount("PLUGIN_FEED_RUNS", 200)} runs)`, () => {
    const runs = envCount("PLUGIN_FEED_RUNS", 200);
    for (let seed = 1; seed <= runs; seed += 1) {
      const next = seeded(seed);
      const { feed, kernel } = setup();
      const length = 2 + Math.floor(next() * 6);
      for (let step = 0; step < length; step += 1) {
        const view = randomView(next);
        feed.reconcile(view);
        const where = `seed ${seed} step ${step}`;
        for (const slot of allSlots()) {
          const held = feed.rows<{ plugin: string }>(slot);
          const wanted = expectedRows(view, slot) as { plugin: string }[];
          // The same rows; a plugin that was reloaded comes after the others, so compare by plugin, each plugin's rows in order.
          expect(held.length, `${where} ${slot}`).toBe(wanted.length);
          for (const plugin of POOL) expect(held.filter((row) => row.plugin === plugin), `${where} ${slot} ${plugin}`).toEqual(wanted.filter((row) => row.plugin === plugin));
        }
        expect(feed.loaded().sort(), where).toEqual(view.plugins.map((plugin) => plugin.name).sort());
        expect(kernel.plugins().filter((name) => !name.startsWith(":")).sort(), where).toEqual(feed.loaded().sort());
      }
      feed.reconcile({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null });
      expect(kernel.plugins().sort(), `seed ${seed} after an empty view`).toEqual([CHAT, SETTINGS, SHELL]);
      expect(kernel.installed().sort(), `seed ${seed} declarations`).toEqual([CHAT, SETTINGS, SHELL]);
      expect(kernel.allContributions(), `seed ${seed} contributions`).toEqual([]);
    }
  });
});
