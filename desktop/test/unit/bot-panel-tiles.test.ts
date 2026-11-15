// @vitest-environment jsdom
// Board tiles as `botling.bot-panel`'s slots (M7-03b): `panel/tile/board`, `panel/tile/whiteboard` and `panel/tile/pin` (2.x ids
// `tile/board`, `tile/whiteboard`, `tile/pin`: the kernel's canonical id is still the 2.x one, so the tests ask by either name).
//
// Nothing in the shell drew `tile` contributions before this card (they were rows of the main process's contribution list only: the Board's
// pins and the whiteboard are drawn inside plugin frames), so there is no shell DOM to record. What is checked instead:
//   - the alias rows, the slot names the shell and the plugin agree on, and the core's tile surfaces equal the renderer's;
//   - `PluginsView.tiles` (contract) and the pure `tileView` that makes it (core/plugins/views.ts; nothing when there is no tile);
//   - the feed puts each tile into the slot of each surface it names, only for a plugin that is listed, on and not failed;
//   - `tilesFor(surface)` reads them back: only while bot-panel is up and not unavailable, only registrations of the plugin the row names;
//   - the hook redraws a probe list when the slots change;
//   - D64, scripted (kernel-step-1 check 3's shape): unloading bot-panel while a tile's plugin is still unloading waits.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel, canonicalSlot, slotName, type KernelEvent } from "../../../Web/src/plugin-kernel";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { PluginsView } from "../../src/contract";
import { TILE_SURFACES as CORE_TILE_SURFACES, type Contribution } from "../../src/core/plugins/contributions";
import { tileView } from "../../src/core/plugins/views";
import { BOT_PANEL_PLUGIN, TILE_SLOTS, TILE_SURFACES, type TileView } from "../../src/renderer/panel-names";
import { tilesFor, useTiles } from "../../src/renderer/panel-slot";
import { notifySlots, rendererKernel } from "../../src/renderer/renderer-kernel";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { PluginFeed } from "../../src/renderer/shell/plugin-feed";
import { deferred, flush } from "../kernel-driver";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = manifest.plugins.find((entry) => entry.name === BOT_PANEL_PLUGIN)!;

// ---------------------------------------------------------------- fixtures
const TODO: TileView = { plugin: "acme.cards", id: "acme.cards.todo", title: "Todo", sizes: ["2x2"], surfaces: ["board", "whiteboard", "pin"] };
const DISK: TileView = { plugin: "acme.disk", id: "acme.disk.free", title: "Disk", sizes: ["1x1"], surfaces: ["whiteboard", "board"] };
const ONLY: TileView = { plugin: "acme.pin", id: "acme.pin.only", title: "Pin only", sizes: ["1x1", "2x1"], surfaces: ["pin"] };
const TILES = [TODO, DISK, ONLY];
const entry = (name: string, over: Record<string, unknown> = {}) => ({ name, version: "1.0.0", enabled: true, failure: null, ...over });
/** The part of a PluginsView the feed reads: the plugin list and the tiles. */
const viewOf = (tiles: TileView[], plugins = TILES.map((tile) => entry(tile.plugin))) => ({ plugins, tiles }) as unknown as PluginsView;

const events: KernelEvent[] = [];
const lines = () => events.map((event) => `${event.action} ${event.plugin}`);
const hosts: InPageHost[] = [];
/** A private kernel, its feed, and a host that runs only bot-panel on them (the renderer's own kernel is not touched). */
function world() {
  events.length = 0;
  const kernel = new Kernel({ slotName: canonicalSlot, log: (event) => events.push(event) });
  const feed = new PluginFeed(kernel);
  const host = new InPageHost({ kernel, feed, manifest: { ...manifest, plugins: [shipped] }, notify: () => {} });
  hosts.push(host);
  return { kernel, feed, host, tiles: (surface: (typeof TILE_SURFACES)[number]) => tilesFor(surface, kernel, host).map((tile) => tile.id) };
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  document.body.innerHTML = "";
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

// ---------------------------------------------------------------- the names
describe("the tile slots' names", () => {
  it("each surface has a 2.x id `tile/<surface>` and the new name `panel/tile/<surface>`, one alias table", () => {
    for (const surface of TILE_SURFACES) {
      expect(TILE_SLOTS[surface]).toBe(`panel/tile/${surface}`);
      expect(canonicalSlot(`panel/tile/${surface}`)).toBe(`tile/${surface}`);
      expect(slotName(`tile/${surface}`)).toBe(`panel/tile/${surface}`);
    }
    // The main process's single `tile` slot (the contribution list) is not one of them and keeps its name.
    expect(canonicalSlot("tile")).toBe("tile");
    expect(slotName("tile")).toBe("tile");
  });

  it("the renderer's surfaces are the core's TILE_SURFACES, and the contract takes exactly those", () => {
    expect([...TILE_SURFACES]).toEqual([...CORE_TILE_SURFACES]);
    const rows = PluginsView.shape.tiles;
    expect(rows.safeParse([TODO]).success).toBe(true);
    for (const surface of CORE_TILE_SURFACES) expect(rows.safeParse([{ ...TODO, surfaces: [surface] }]).success, surface).toBe(true);
    expect(rows.safeParse([{ ...TODO, surfaces: ["chat"] }]).success).toBe(false);
    expect(rows.safeParse([{ ...TODO, extra: 1 }]).success).toBe(false);
  });

  it("the three slots are bot-panel's: in PLUGIN_OWNED_SLOTS and so not :shell's", () => {
    for (const surface of TILE_SURFACES) {
      expect(PLUGIN_OWNED_SLOTS).toContain(`tile/${surface}`);
      expect(FEED_SLOTS).not.toContain(`tile/${surface}`);
    }
  });
});

// ---------------------------------------------------------------- the view's rows (main process)
describe("PluginsView.tiles, made from the contribution list", () => {
  const tile = (over: Record<string, unknown>) => ({ kind: "tile", plugin: "acme.cards", id: "acme.cards.todo", title: "Todo", sizes: ["2x2"], surfaces: ["board", "pin"], ...over }) as unknown as Contribution;
  const card = { kind: "card", plugin: "acme.cards", id: "acme.cards.todo", title: "Todo" } as unknown as Contribution;

  it("is one row per tile with its sizes and surfaces, without the component's folder", () => {
    const component = { name: "todo", dir: "components/todo" };
    expect(tileView([card, tile({ component })])).toEqual({ tiles: [{ plugin: "acme.cards", id: "acme.cards.todo", title: "Todo", sizes: ["2x2"], surfaces: ["board", "pin"] }] });
  });

  it("is nothing at all (not an empty array) when there is no tile, so a view without tiles is byte-identical to before", () => {
    expect(tileView([])).toEqual({});
    expect(tileView([card])).toEqual({});
    expect("tiles" in tileView([card])).toBe(false);
  });

  it("keeps within the contract: an id over 100 characters is left out, at most 200 rows, titles cut at 200", () => {
    expect(tileView([tile({ id: "x".repeat(101) })])).toEqual({});
    const many = Array.from({ length: 250 }, (_, index) => tile({ id: `acme.cards.t${index}`, title: "T".repeat(300) }));
    const rows = tileView(many).tiles!;
    expect(rows).toHaveLength(200);
    expect(rows[0]!.title).toHaveLength(200);
    expect(PluginsView.shape.tiles.safeParse(rows).success).toBe(true);
  });

  it("names each surface once (a manifest may repeat one, and the contract keeps three), and cuts sizes at 10 of 20 characters (M7-03b review)", () => {
    const [row] = tileView([tile({ surfaces: ["board", "board", "pin", "whiteboard"], sizes: Array.from({ length: 12 }, (_, index) => `${index + 1}x${"1".repeat(25)}`) })]).tiles!;
    expect(row!.surfaces).toEqual(["board", "pin", "whiteboard"]);
    expect(row!.sizes).toHaveLength(10);
    expect(row!.sizes.every((size) => size.length === 20)).toBe(true);
    expect(PluginsView.shape.tiles.safeParse([row]).success).toBe(true);
  });

  it("the contract refuses more than 200 rows, 11 sizes, a size of 21 characters and 4 surfaces (M7-03b review)", () => {
    const rows = PluginsView.shape.tiles;
    expect(rows.safeParse(Array.from({ length: 200 }, () => TODO)).success).toBe(true);
    expect(rows.safeParse(Array.from({ length: 201 }, () => TODO)).success).toBe(false);
    expect(rows.safeParse([{ ...TODO, sizes: Array.from({ length: 11 }, () => "1x1") }]).success).toBe(false);
    expect(rows.safeParse([{ ...TODO, sizes: ["x".repeat(21)] }]).success).toBe(false);
    expect(rows.safeParse([{ ...TODO, surfaces: ["board", "pin", "whiteboard", "board"] }]).success).toBe(false);
  });
});

// ---------------------------------------------------------------- the feed and the slots
describe("tiles in the slots of the surfaces they name", () => {
  it("each surface holds the tiles that name it, in the view's order, under either name of the slot", async () => {
    const { feed, host, tiles, kernel } = world();
    await host.start();
    feed.reconcile(viewOf(TILES));
    expect(tiles("board")).toEqual([TODO.id, DISK.id]);
    expect(tiles("whiteboard")).toEqual([TODO.id, DISK.id]);
    expect(tiles("pin")).toEqual([TODO.id, ONLY.id]);
    for (const surface of TILE_SURFACES) {
      expect(kernel.slotOwner(TILE_SLOTS[surface]), surface).toBe(BOT_PANEL_PLUGIN);
      expect(kernel.slotOwner(`tile/${surface}`), surface).toBe(BOT_PANEL_PLUGIN);
      expect(feed.rows(TILE_SLOTS[surface]).map((row) => (row as TileView).id)).toEqual(tiles(surface));
      expect(feed.rows(`tile/${surface}`)).toEqual(tilesFor(surface, kernel, host));
    }
  });

  it("the tiles reach their rows whole (sizes, title, surfaces), the plugin's own data", async () => {
    const { feed, host, kernel } = world();
    await host.start();
    feed.reconcile(viewOf([ONLY]));
    expect(tilesFor("pin", kernel, host)).toEqual([ONLY]);
  });

  it("tiles that came before the plugin appear when it loads, go when it unloads, and are back when it loads again", async () => {
    const { feed, host, tiles } = world();
    feed.reconcile(viewOf(TILES));
    expect(tiles("board")).toEqual([]);
    await host.start();
    expect(tiles("board")).toEqual([TODO.id, DISK.id]);
    await host.stop();
    expect([tiles("board"), tiles("whiteboard"), tiles("pin")]).toEqual([[], [], []]);
    await host.start();
    expect(tiles("board")).toEqual([TODO.id, DISK.id]);
    expect(tiles("pin")).toEqual([TODO.id, ONLY.id]);
  });

  it("a tile of a plugin that is turned off disappears from every slot; the others stay; turned on again, it is back", async () => {
    const { feed, host, tiles } = world();
    await host.start();
    feed.reconcile(viewOf(TILES));
    const off = (name: string) => viewOf(TILES.filter((tile) => tile.plugin !== name), TILES.map((tile) => entry(tile.plugin, tile.plugin === name ? { enabled: false } : {})));
    feed.reconcile(off("acme.disk"));
    expect([tiles("board"), tiles("whiteboard"), tiles("pin")]).toEqual([[TODO.id], [TODO.id], [TODO.id, ONLY.id]]);
    feed.reconcile(viewOf(TILES));
    expect(tiles("board")).toEqual([TODO.id, DISK.id]);
  });

  it("a tile row of a plugin that is off, failed or not listed never enters a slot, even when the row is still in the view", async () => {
    const { feed, host, tiles } = world();
    await host.start();
    const plugins = [entry(TODO.plugin, { enabled: false }), entry(DISK.plugin, { failure: "did not load" })]; // ONLY.plugin is not listed
    feed.reconcile(viewOf(TILES, plugins));
    expect([tiles("board"), tiles("whiteboard"), tiles("pin")]).toEqual([[], [], []]);
    expect(feed.loaded()).not.toContain(TODO.plugin);
    expect(feed.loaded()).not.toContain(ONLY.plugin);
  });

  it("a surface the contract does not know is ignored, the tile's other surfaces stay; a repeated surface is one row", async () => {
    const { feed, host, tiles } = world();
    await host.start();
    feed.reconcile(viewOf([{ ...TODO, surfaces: ["board", "chat", "board", "constructor", "__proto__"] as never }]));
    expect(tiles("board")).toEqual([TODO.id]);
    expect([tiles("whiteboard"), tiles("pin")]).toEqual([[], []]);
  });

  it("a hostile plugin name or a missing field gives no tile and does not stop the others", async () => {
    const { feed, host, tiles } = world();
    await host.start();
    // `__proto__` and `:shell` are listed and on but are not names a plugin can have; `constructor` is a valid name but is not listed.
    const hostile = ["__proto__", ":shell", "constructor", "../x", ""].map((plugin) => ({ ...TODO, plugin, id: `${plugin}.t` }));
    const broken = { plugin: DISK.plugin, id: DISK.id, title: DISK.title } as unknown as TileView;
    feed.reconcile(viewOf([...hostile, broken, ONLY], [...TILES.map((tile) => entry(tile.plugin)), ...["__proto__", ":shell"].map((name) => entry(name))]));
    expect(tiles("pin")).toEqual([ONLY.id]);
    expect([tiles("board"), tiles("whiteboard")]).toEqual([[], []]);
  });

  it("only a registration of the plugin the row names counts: a stranger's entry in the slot is not a tile", async () => {
    const { feed, host, tiles, kernel } = world();
    await host.start();
    feed.reconcile(viewOf([ONLY]));
    // A plugin that is not the one the row names puts that row into the slot (the kernel lets any plugin contribute to a slot).
    kernel.install({ name: "acme.evil", contributes: { slots: ["tile/pin"] } });
    await kernel.load("acme.evil", (plugin) => { kernel.contribute(plugin, "tile/pin", { kind: "feed", row: TODO }); kernel.contribute(plugin, "tile/pin", { kind: "tile", row: { ...TODO, plugin: "acme.evil" } }); kernel.contribute(plugin, "tile/pin", "not an entry"); });
    expect(kernel.entries("tile/pin")).toHaveLength(4);
    expect(tiles("pin")).toEqual([ONLY.id]);
  });

  it("the slot's owner is not a tile source either: bot-panel's own entry naming itself is not a tile (M7-03b review)", async () => {
    const { feed, host, tiles, kernel } = world();
    await host.start();
    feed.reconcile(viewOf([ONLY]));
    expect(kernel.contribute(BOT_PANEL_PLUGIN, "tile/pin", { kind: "feed", row: { ...ONLY, plugin: BOT_PANEL_PLUGIN, id: "botling.bot-panel.x" } })).not.toBeNull();
    expect(kernel.entries("tile/pin")).toHaveLength(2);
    expect(tiles("pin")).toEqual([ONLY.id]);
  });

  it("a row counts only in the slot of a surface it names: the plugin's own row in another surface's slot is not a tile there", async () => {
    const { host, tiles, kernel } = world();
    await host.start();
    // `acme.pin` is a plugin of its own here (no feed): it puts its pin-only row into the board slot and the pin slot.
    kernel.install({ name: ONLY.plugin, contributes: { slots: ["tile/board", "tile/pin"] } });
    await kernel.load(ONLY.plugin, (plugin) => { kernel.contribute(plugin, "tile/board", { kind: "feed", row: ONLY }); kernel.contribute(plugin, "tile/pin", { kind: "feed", row: ONLY }); });
    expect(kernel.entries("tile/board")).toHaveLength(1);
    expect(tiles("board")).toEqual([]);
    expect(tiles("pin")).toEqual([ONLY.id]);
  });
});

// ---------------------------------------------------------------- fail closed
describe("when the panel plugin is not there", () => {
  it("the host says it is unavailable (refused): no tile, though the kernel still holds registrations", async () => {
    const { feed, host, kernel } = world();
    await host.start();
    feed.reconcile(viewOf(TILES));
    expect(tilesFor("board", kernel, host)).toHaveLength(2);
    expect(tilesFor("board", kernel, { unavailable: () => true })).toEqual([]);
    const refused = world();
    await refused.host.start([{ name: BOT_PANEL_PLUGIN, codeHash: "0".repeat(64) }]);
    refused.feed.reconcile(viewOf(TILES));
    expect(refused.host.unavailable(BOT_PANEL_PLUGIN)).toBe(true);
    expect(refused.tiles("board")).toEqual([]);
  });

  it("the plugin is unloading (its dependent's slow undo still running): no tile, in any surface", async () => {
    const { feed, host, kernel, tiles } = world();
    await host.start();
    feed.reconcile(viewOf(TILES));
    const slow = deferred();
    kernel.register(TODO.plugin, "item", "slow", () => slow.promise);
    void kernel.requestUnload(BOT_PANEL_PLUGIN);
    await flush();
    expect(kernel.state(BOT_PANEL_PLUGIN)).toBe("unloading");
    expect(kernel.entries("tile/board")).toEqual([]);
    expect([tiles("board"), tiles("whiteboard"), tiles("pin")]).toEqual([[], [], []]);
    slow.resolve();
    await flush();
  });
});

// ---------------------------------------------------------------- D64
describe("D64, scripted: unloading bot-panel while a tile's plugin is still unloading", () => {
  it("waits: bot-panel runs no undo until the tile's plugin (a dependent with a slow async undo) is absent, and no tile outlives the owner", async () => {
    const { feed, host, kernel, tiles } = world();
    await host.start();
    feed.reconcile(viewOf([TODO]));
    expect(tiles("board")).toEqual([TODO.id]);
    const slow = deferred();
    kernel.register(TODO.plugin, "item", "slow", () => slow.promise);

    const stopping = host.stop();
    await flush();
    // Both are unloading; the owner's own undos wait for the dependent's slow one.
    expect([kernel.state(TODO.plugin), kernel.state(BOT_PANEL_PLUGIN)]).toEqual(["unloading", "unloading"]);
    expect(lines().filter((line) => line.startsWith(`RunUndo ${BOT_PANEL_PLUGIN}`))).toEqual([]);
    expect(lines()).not.toContain(`BeginUnload ${BOT_PANEL_PLUGIN}`);
    expect(tiles("board")).toEqual([]);

    slow.resolve();
    await stopping;
    const log = lines();
    const tileGone = log.indexOf(`FinishUnload ${TODO.plugin}`);
    expect(tileGone).toBeGreaterThan(-1);
    expect(log.indexOf(`BeginUnload ${BOT_PANEL_PLUGIN}`)).toBeGreaterThan(tileGone);
    expect(log.findIndex((line) => line.startsWith(`RunUndo ${BOT_PANEL_PLUGIN}`))).toBeGreaterThan(tileGone);
    expect(kernel.holdsNothingOf(BOT_PANEL_PLUGIN)).toBe(true);
    for (const surface of TILE_SURFACES) expect(kernel.entries(`tile/${surface}`), surface).toEqual([]);
    // The feed keeps the plugin for the next time the owner is up (the view did not change).
    await host.start();
    expect(tiles("board")).toEqual([TODO.id]);
  });
});

// ---------------------------------------------------------------- the hook
describe("useTiles", () => {
  it("draws a probe list from the slot, again when the tiles or the plugin change", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const feed = new PluginFeed(rendererKernel);
    const host = new InPageHost({ feed, manifest: { ...manifest, plugins: [shipped] } });
    hosts.push(host);
    // One host object for every render, as the app's (inPageHost): a redraw must come from the slots' version, not from a new host (M7-03b review).
    const gate = { unavailable: (name: string) => host.unavailable(name) };
    const probe = ({ surface }: { surface: (typeof TILE_SURFACES)[number] }) => createElement("ul", { "data-surface": surface }, useTiles(surface, gate).map((tile) => createElement("li", { key: tile.id }, tile.title)));
    const holder = document.createElement("div");
    document.body.append(holder);
    const root = createRoot(holder);
    const html = () => holder.innerHTML;
    try {
      await act(async () => root.render(createElement("div", null, TILE_SURFACES.map((surface) => createElement(probe, { key: surface, surface })))));
      expect(html()).toBe('<div><ul data-surface="board"></ul><ul data-surface="whiteboard"></ul><ul data-surface="pin"></ul></div>');
      await act(async () => { await host.start(); feed.reconcile(viewOf(TILES)); notifySlots(); });
      expect(html()).toBe('<div><ul data-surface="board"><li>Todo</li><li>Disk</li></ul><ul data-surface="whiteboard"><li>Todo</li><li>Disk</li></ul><ul data-surface="pin"><li>Todo</li><li>Pin only</li></ul></div>');
      await act(async () => { feed.reconcile(viewOf([TODO])); notifySlots(); });
      expect(html()).toBe('<div><ul data-surface="board"><li>Todo</li></ul><ul data-surface="whiteboard"><li>Todo</li></ul><ul data-surface="pin"><li>Todo</li></ul></div>');
      await act(async () => { await host.stop(); });
      expect(html()).toBe('<div><ul data-surface="board"></ul><ul data-surface="whiteboard"></ul><ul data-surface="pin"></ul></div>');
    } finally {
      await act(async () => root.unmount());
      feed.reconcile(null);
    }
  });
});
