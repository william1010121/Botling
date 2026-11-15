// `PluginFeed.refresh` against a fresh load (M7-02c F1): over seeded random plugin lists whose plugins share slots in chains (a plugin
// with a settings row shares `view/mainTab` with one that shares `menu/…` with a third, in any list order), a refresh of any slots, and
// the settings owner going away and coming back, every slot holds exactly the rows a fresh load of the same view holds, in its order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Kernel, ROOT_SLOTS, canonicalSlot } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../src/contract";
import { FEED_MENU_SLOTS, FEED_SLOTS, FEED_VIEWS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { PluginFeed } from "../../src/renderer/shell/plugin-feed";
import { desktop, envCount } from "../helpers";

const SETTINGS = ":settings";
const startSettings = (kernel: Kernel) => {
  kernel.install({ name: SETTINGS, provides: { slots: PLUGIN_OWNED_SLOTS } });
  void kernel.load(SETTINGS, (plugin) => { for (const slot of PLUGIN_OWNED_SLOTS) kernel.provideSlot(plugin, slot); });
};
function setup(settings: boolean) {
  const kernel = new Kernel({ slotName: canonicalSlot });
  const slots = [...ROOT_SLOTS, ...FEED_SLOTS];
  kernel.install({ name: ":shell", provides: { slots } });
  void kernel.load(":shell", (plugin) => { for (const slot of slots) kernel.provideSlot(plugin, slot); });
  if (settings) startSettings(kernel);
  return { kernel, feed: new PluginFeed(kernel) };
}
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
const POOL = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
// Few slots, so plugins share them densely: the two settings slots, two views and two menus.
const KEYS = ["settingsSections", "quickSettings", "mainTabs", "rightPanelSections"] as const;
const MENUS = FEED_MENU_SLOTS.slice(0, 2).map((slot) => slot.slice("menu/".length));
const allSlots = (): string[] => [...FEED_VIEWS.map(([, slot]) => slot), ...FEED_MENU_SLOTS];

function randomView(next: () => number): PluginsView {
  const order = [...POOL].sort(() => next() - 0.5).filter(() => next() < 0.85);
  const base = (JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView).plugins[0]!;
  const view: Record<string, unknown> = { plugins: order.map((name) => ({ ...base, name, enabled: true, failure: null })), broken: [], host: { running: true, problem: null }, secretsProblem: null };
  // Rows are listed in an order of their own (not the list's), so a fresh load's order is not the arrays'.
  const shuffled = () => [...order].sort(() => next() - 0.5);
  for (const key of KEYS) view[key] = shuffled().filter(() => next() < 0.45).map((plugin) => ({ plugin, id: `${plugin}.${key}`, title: key }));
  view.menus = shuffled().flatMap((plugin) => MENUS.filter(() => next() < 0.35).map((menu) => ({ menu, command: `${plugin}.${menu}`, plugin, title: menu })));
  return view as unknown as PluginsView;
}

describe("refresh keeps every slot as a fresh load gives it", () => {
  it(`over seeded random lists, refreshes and settings cycles (${envCount("PLUGIN_REFRESH_RUNS", 300)} runs)`, async () => {
    const runs = envCount("PLUGIN_REFRESH_RUNS", 300);
    for (let seed = 1; seed <= runs; seed += 1) {
      const next = seeded(seed);
      const view = randomView(next);
      const fresh = setup(true).feed;
      fresh.reconcile(view);
      const early = next() < 0.5;
      const { feed, kernel } = setup(early);
      feed.reconcile(view);
      if (!early) { startSettings(kernel); feed.refresh(PLUGIN_OWNED_SLOTS); }
      const check = (where: string) => { for (const slot of allSlots()) expect(feed.rows(slot), `seed ${seed} ${where} ${slot}`).toEqual(fresh.rows(slot)); };
      check("start");
      for (let step = 0; step < 4; step += 1) {
        if (next() < 0.5) {
          feed.refresh(allSlots().filter(() => next() < 0.3));
        } else {
          await kernel.requestUnload(SETTINGS);
          feed.refresh(PLUGIN_OWNED_SLOTS);
          await kernel.load(SETTINGS);
          feed.refresh(PLUGIN_OWNED_SLOTS);
        }
        check(`step ${step}`);
      }
    }
  });
});
