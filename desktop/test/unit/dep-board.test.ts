// The plugin dependency board's data (core/plugins/dep-board.ts, behind the `plugins.deps` request and botling.deps): plugins in,
// nodes / arrows / missing providers / slot fills out. The pure function first, then the registry read (kernel fields of built-in
// plugins only, enabled plugins' slots), then the plugins that ship with the app.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktop, tempDir } from "../helpers";
import { APP_PROVIDERS, buildDepBoard, readDepBoard, type DepInput } from "../../src/core/plugins/dep-board";
import { PluginRegistry } from "../../src/core/plugins/registry";
import { MemorySecretStore } from "../../src/core/plugins/secrets";
import { CHAT_SLOTS, INSERT_QUOTE } from "../../src/renderer/chat-names";

const input = (name: string, more: Partial<DepInput> = {}): DepInput => ({
  name, title: name, version: "1.0.0", enabled: true, builtIn: true, failure: null, declared: true,
  provides: { services: [], slots: [] }, requires: [], uses: [], contributedSlots: [], ...more,
});

describe("buildDepBoard", () => {
  it("an arrow from each plugin to the plugin that provides what it requires (solid) or uses (dashed), sorted, with the slots they fill", () => {
    const board = buildDepBoard([
      input("b.client", { requires: ["store.read"], uses: ["log.write"], contributedSlots: ["view/mainTab", "menu/composer/plus"] }),
      input("a.store", { provides: { services: ["store.read", "log.write"], slots: [] } }),
      input("c.logger", { provides: { services: ["log.write"], slots: ["status/bar"] } }),
    ]);
    expect(board.edges).toEqual([
      { from: "b.client", to: "a.store", service: "store.read", kind: "requires", live: true },
      { from: "b.client", to: "a.store", service: "log.write", kind: "uses", live: true },
      { from: "b.client", to: "c.logger", service: "log.write", kind: "uses", live: true },
    ]);
    expect(board.missing).toEqual([]);
    expect(board.plugins.map((plugin) => plugin.name)).toEqual(["a.store", "b.client", "c.logger"]);
    expect(board.plugins.find((plugin) => plugin.name === "b.client")).toMatchObject({ requires: ["store.read"], uses: ["log.write"], fills: ["composer/plus", "main/tab"], enabled: true, version: "1.0.0" });
    const slot = (name: string) => board.slots.find((row) => row.slot === name);
    expect(slot("main/tab")).toEqual({ slot: "main/tab", group: "view", fills: ["b.client"] });
    expect(slot("composer/plus")).toMatchObject({ group: "menu", fills: ["b.client"] });
    // A slot a plugin names in `provides.slots` is filled by it too; one the core does not list still shows.
    expect(slot("status/bar")).toEqual({ slot: "status/bar", group: "other", fills: ["c.logger"] });
    // A slot nobody fills is on the list, empty.
    expect(board.slots.filter((row) => row.fills.length === 0).length).toBeGreaterThan(5);
  });

  it("a required service nobody provides is a missing provider; an optional one is not", () => {
    const board = buildDepBoard([input("needs.it", { requires: ["ghost.service"], uses: ["maybe.service"] })]);
    expect(board.missing).toEqual([{ plugin: "needs.it", service: "ghost.service", offProviders: [] }]);
    expect(board.edges).toEqual([]);
  });

  it("a provider that is off does not satisfy a requirement (it is named), and its arrow is not live; a plugin that is off lacks nothing", () => {
    const off = input("p.off", { enabled: false, provides: { services: ["svc"], slots: [] }, contributedSlots: ["view/mainTab"] });
    const board = buildDepBoard([off, input("needs", { requires: ["svc"] }), input("idle", { enabled: false, requires: ["other"] })]);
    expect(board.missing).toEqual([{ plugin: "needs", service: "svc", offProviders: ["p.off"] }]);
    expect(board.edges).toEqual([{ from: "needs", to: "p.off", service: "svc", kind: "requires", live: false }]);
    // An off plugin fills no slot, and the board still lists it with its state.
    expect(board.plugins.find((plugin) => plugin.name === "p.off")).toMatchObject({ enabled: false, fills: [] });
    expect(board.slots.find((row) => row.slot === "main/tab")!.fills).toEqual([]);
  });

  it("a plugin does not depend on itself", () => {
    const board = buildDepBoard([input("self", { provides: { services: ["s"], slots: [] }, requires: ["s"] })]);
    expect(board.edges).toEqual([]);
    expect(board.missing).toEqual([{ plugin: "self", service: "s", offProviders: [] }]);
  });

  it("service and slot names that are object keys are names like any other", () => {
    const board = buildDepBoard([
      input("a", { provides: { services: ["constructor", "__proto__"], slots: ["toString"] } }),
      input("b", { requires: ["constructor", "__proto__", "hasOwnProperty"] }),
    ]);
    expect(board.edges.map((edge) => edge.service)).toEqual(["__proto__", "constructor"]);
    expect(board.missing).toEqual([{ plugin: "b", service: "hasOwnProperty", offProviders: [] }]);
    expect(board.slots.find((row) => row.slot === "toString")).toEqual({ slot: "toString", group: "other", fills: ["a"] });
  });

  it("reads nothing it was not given: no plugins, an empty board with the core's slots", () => {
    const board = buildDepBoard([]);
    expect(board).toMatchObject({ plugins: [], edges: [], missing: [] });
    expect(board.slots.length).toBeGreaterThan(20);
    expect(board.slots.every((row) => row.fills.length === 0)).toBe(true);
  });

  it("the app's own page comes first and is marked", () => {
    const board = buildDepBoard([input("zz"), input("botling.chat", { app: true })]);
    expect(board.plugins.map((plugin) => [plugin.name, plugin.app])).toEqual([["botling.chat", true], ["zz", false]]);
  });
});

describe("the app's own providers", () => {
  it("are what the chat plugin's names file says: its service and its slots", () => {
    const chat = APP_PROVIDERS.find((provider) => provider.name === "botling.chat")!;
    expect(chat.services).toEqual([INSERT_QUOTE]);
    expect([...chat.slots].sort()).toEqual([...CHAT_SLOTS].sort());
  });
});

describe("readDepBoard", () => {
  /** A plugin folder as the library holds one, with kernel fields when `kernel` is given. */
  function make(root: string, name: string, kernel: Record<string, unknown> | null, views: { id: string; title: string; where: string }[] = []) {
    const folder = join(root, name);
    mkdirSync(join(folder, "dist"), { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({
      name, version: "2.0.0", engines: { ccb: "^2.0.0" },
      ccb: { host: "dist/host.mjs", ...(kernel ? { kernel: 1, ...kernel } : {}), ...(views.length ? { contributes: { views } } : {}) },
    }));
    writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
  }

  it("reads kernel fields of built-in plugins only, the slots of the enabled ones' views, and leaves a third-party manifest's fields out", () => {
    const dir = tempDir("dep-board");
    const builtIns = join(dir, "builtin");
    const library = join(dir, "plugins");
    make(builtIns, "botling.store", { provides: { services: ["store.read"], slots: [] } }, [{ id: "botling.store.tab", title: "Store", where: "mainTab" }]);
    make(builtIns, "botling.client", { requires: { services: ["store.read", "absent.service"] }, uses: { services: ["composer.insertQuote"] } });
    make(library, "third.party", { requires: { services: ["store.read"] }, provides: { services: ["x"], slots: [] } });
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), builtIns);
    registry.rescan(true);
    const board = readDepBoard(registry, registry.contributions());
    const node = (name: string) => board.plugins.find((plugin) => plugin.name === name)!;

    expect(node("botling.store")).toMatchObject({ builtIn: true, enabled: true, declared: true, version: "2.0.0", provides: { services: ["store.read"], slots: [] }, fills: ["main/tab"] });
    expect(node("botling.client")).toMatchObject({ requires: ["absent.service", "store.read"], uses: ["composer.insertQuote"] });
    // Not read for a plugin the user installed: it shows with its state and nothing declared.
    expect(node("third.party")).toMatchObject({ builtIn: false, declared: false, enabled: true, provides: { services: [] }, requires: [] });
    expect(board.edges).toEqual([
      { from: "botling.client", to: "botling.store", service: "store.read", kind: "requires", live: true },
      { from: "botling.client", to: "botling.chat", service: "composer.insertQuote", kind: "uses", live: true },
    ]);
    expect(board.missing).toEqual([{ plugin: "botling.client", service: "absent.service", offProviders: [] }]);

    // Turned off: the plugin's slots empty, its dependents' requirement becomes a missing provider that names it.
    registry.setEnabled("botling.store", false);
    const after = readDepBoard(registry, registry.contributions());
    expect(after.plugins.find((plugin) => plugin.name === "botling.store")).toMatchObject({ enabled: false, fills: [] });
    expect(after.missing).toEqual([
      { plugin: "botling.client", service: "absent.service", offProviders: [] },
      { plugin: "botling.client", service: "store.read", offProviders: ["botling.store"] },
    ]);
    expect(after.edges.find((edge) => edge.service === "store.read")).toMatchObject({ live: false });
  });

  it("a plugin folder whose package.json cannot be read declares nothing and does not stop the board", () => {
    const registry = { plugins: [{ manifest: { name: "gone", version: "1.0.0" }, folder: join(tempDir("dep-board-gone"), "missing"), builtIn: true, enabled: true, failure: null }] } as unknown as PluginRegistry;
    const board = readDepBoard(registry, []);
    expect(board.plugins.map((plugin) => [plugin.name, plugin.declared])).toEqual([["botling.chat", true], ["gone", false]]);
  });
});

describe("the plugins that ship with the app", () => {
  it("the Note may use the chat's quote service (an arrow, nothing missing), and the board itself fills its Settings page", async () => {
    const { buildBuiltinPlugins } = await import(join(desktop, "build-builtin-plugins.mjs"));
    const built = await buildBuiltinPlugins({ outdir: join(tempDir("dep-board-builtin"), "builtin-plugins") });
    const dir = tempDir("dep-board-shipped");
    const registry = new PluginRegistry(join(dir, "plugins"), join(dir, "plugins.json"), new MemorySecretStore(), built);
    registry.rescan(true);
    const board = readDepBoard(registry, registry.contributions());
    expect(board.edges).toEqual([{ from: "botling.note", to: "botling.chat", service: INSERT_QUOTE, kind: "uses", live: true }]);
    expect(board.missing).toEqual([]);
    expect(board.plugins.find((plugin) => plugin.name === "botling.deps")).toMatchObject({ builtIn: true, enabled: true, fills: ["settings/section"] });
    expect(board.slots.find((row) => row.slot === "settings/section")!.fills).toContain("botling.deps");
    expect(board.plugins.filter((plugin) => !plugin.app).length).toBeGreaterThanOrEqual(16);
  }, 60_000);
});
