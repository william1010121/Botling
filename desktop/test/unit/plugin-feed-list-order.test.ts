// PluginFeed.rowsInListOrder (M7-02d): a slot's feed rows in the plugin list's order, each plugin's rows in the order it registered
// them, and only `kind: "feed"` entries. The fixture's plugins happen to be in alphabetical order, so these tests use a list whose order
// is neither alphabetical nor registration order (what the DOM tests of settings-slots-dom cannot tell apart from a sort by name).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Kernel, ROOT_SLOTS, canonicalSlot } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../src/contract";
import { FEED_SLOTS, FEED_VIEWS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { PluginFeed } from "../../src/renderer/shell/plugin-feed";
import { SECTION_SLOT } from "../../src/renderer/settings-names";
import { desktop } from "../helpers";

type Page = NonNullable<PluginsView["settingsSections"]>[number];
const page = (plugin: string, id: string): Page => ({ plugin, id, title: `${plugin} ${id}`, terms: "" });

/** A kernel like the renderer's (`:shell` owns the feed's slots, `:settings` the two settings slots) and a feed on it. */
function setup() {
  const kernel = new Kernel({ slotName: canonicalSlot });
  const slots = [...ROOT_SLOTS, ...FEED_SLOTS];
  kernel.install({ name: ":shell", provides: { slots } });
  void kernel.load(":shell", (plugin) => { for (const slot of slots) kernel.provideSlot(plugin, slot); });
  kernel.install({ name: ":settings", provides: { slots: PLUGIN_OWNED_SLOTS } });
  void kernel.load(":settings", (plugin) => { for (const slot of PLUGIN_OWNED_SLOTS) kernel.provideSlot(plugin, slot); });
  return { kernel, feed: new PluginFeed(kernel) };
}

const template = (JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView).plugins[0]!;

/** A list of `names` in that order (all on), with `rows` as its settings pages and no other row. */
function view(names: string[], rows: Page[]): PluginsView {
  const next: Record<string, unknown> = { plugins: names.map((name) => ({ ...template, name, enabled: true, failure: null })), menus: [] };
  for (const [key] of FEED_VIEWS) next[key] = [];
  next.settingsSections = rows;
  return next as unknown as PluginsView;
}

const ids = (rows: Page[]) => rows.map((row) => `${row.plugin}/${row.id}`);

// Not alphabetical: zeta, alpha, mid. `zeta` has two pages (their array order is kept), `mid` and `alpha` one each.
const LIST = ["zeta.plug", "alpha.plug", "mid.plug"];
const ROWS = [page("zeta.plug", "two"), page("zeta.plug", "one"), page("alpha.plug", "a"), page("mid.plug", "m")];
const IN_LIST_ORDER = ["zeta.plug/two", "zeta.plug/one", "alpha.plug/a", "mid.plug/m"];

describe("PluginFeed.rowsInListOrder", () => {
  it("gives the rows in the plugin list's order (not by name), each plugin's rows in its own order", () => {
    const { feed } = setup();
    feed.reconcile(view(LIST, ROWS));
    expect(ids(feed.rowsInListOrder<Page>(SECTION_SLOT))).toEqual(IN_LIST_ORDER);
  });

  it("keeps the list's order after a plugin is switched off and on, where `rows` has it last", () => {
    const { feed } = setup();
    const on = view(LIST, ROWS);
    feed.reconcile(on);
    feed.reconcile({ ...on, plugins: on.plugins.map((one) => (one.name === "zeta.plug" ? { ...one, enabled: false } : one)), settingsSections: ROWS.filter((row) => row.plugin !== "zeta.plug") });
    feed.reconcile(on);
    expect(ids(feed.rows<Page>(SECTION_SLOT)), "premise: the registration order moved zeta last").toEqual(["alpha.plug/a", "mid.plug/m", "zeta.plug/two", "zeta.plug/one"]);
    expect(ids(feed.rowsInListOrder<Page>(SECTION_SLOT))).toEqual(IN_LIST_ORDER);
  });

  it("leaves out an entry that is not a feed row, and puts a feed row of a plugin the list does not name last", () => {
    const { kernel, feed } = setup();
    feed.reconcile(view(LIST, ROWS));
    kernel.install({ name: "other.plug", contributes: { slots: [SECTION_SLOT] } });
    void kernel.load("other.plug", (plugin) => {
      kernel.contribute(plugin, SECTION_SLOT, { kind: "settings-page", group: "x", page: { id: "x", title: "x", terms: "" } });
      kernel.contribute(plugin, SECTION_SLOT, { kind: "feed", row: page("other.plug", "o") });
    });
    expect(kernel.entries(SECTION_SLOT).length, "premise: the kernel holds the foreign entries").toBe(ROWS.length + 2);
    expect(ids(feed.rowsInListOrder<Page>(SECTION_SLOT))).toEqual([...IN_LIST_ORDER, "other.plug/o"]);
  });
});
