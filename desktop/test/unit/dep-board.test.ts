// The plugin dependency board's data (core/plugins/dep-board.ts, behind the `plugins.deps` request and botling.deps): plugins in,
// nodes / arrows / missing providers / slot fills out. The pure function first, then the registry read (kernel fields of built-in
// plugins only, enabled plugins' slots), then the plugins that ship with the app.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktop, tempDir } from "../helpers";
import { APP_PROVIDERS, buildDepBoard, FAILED, readDepBoard, type DepInput } from "../../src/core/plugins/dep-board";
import { readKernelFields } from "../../src/core/plugins/manifest";
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

  it("hands out names, versions, states and declarations only: no setting, secret, install source, folder or error message (any plugin may ask)", async () => {
    const dir = tempDir("dep-board-private");
    const library = join(dir, "plugins");
    make(library, "third.party", null);
    make(library, "broke.one", null);
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore(), null);
    registry.rescan(true);
    registry.set("third.party", "endpoint", "SETTING-VALUE-zz9");
    await registry.setSecret("third.party", "token", "SECRET-VALUE-zz9");
    registry.noteInstalled("third.party", "https://example.invalid/SOURCE-zz9.git");
    registry.markFailed("broke.one", `Error: TOKEN-zz9 at ${join(library, "broke.one", "dist", "host.mjs")}:1:1`);
    const board = readDepBoard(registry, registry.contributions());
    const text = JSON.stringify(board);
    for (const leak of ["SETTING-VALUE", "SECRET-VALUE", "SOURCE-zz9", "example.invalid", "TOKEN-zz9", dir, "host.mjs"]) expect(text, leak).not.toContain(leak);
    expect(board.plugins.find((plugin) => plugin.name === "broke.one")).toMatchObject({ enabled: false, failure: FAILED });
    expect(Object.keys(board).sort()).toEqual(["edges", "featureAreas", "missing", "plugins", "slots"]);
    for (const plugin of board.plugins) {
      expect(Object.keys(plugin).sort(), plugin.name).toEqual(["app", "builtIn", "declared", "enabled", "failure", "features", "fills", "name", "provides", "requires", "title", "uses", "version"]);
      expect(Object.keys(plugin.provides).sort(), plugin.name).toEqual(["services", "slots"]);
    }
  });

  it("a plugin folder whose package.json cannot be read declares nothing and does not stop the board", () => {
    const registry = { plugins: [{ manifest: { name: "gone", version: "1.0.0" }, folder: join(tempDir("dep-board-gone"), "missing"), builtIn: true, enabled: true, failure: null }] } as unknown as PluginRegistry;
    const board = readDepBoard(registry, []);
    expect(board.plugins.map((plugin) => [plugin.name, plugin.declared])).toEqual([["botling.chat", true], ["gone", false]]);
  });
});

describe("the plugins that ship with the app", () => {
  const SOURCES = join(desktop, "builtin-plugins");
  const shipped = () => readdirSync(SOURCES).filter((name) => !name.includes(".md") && !name.startsWith(".")).sort();
  const manifest = (name: string) => JSON.parse(readFileSync(join(SOURCES, name, "package.json"), "utf8")) as Record<string, unknown>;

  it("every built-in plugin declares a kernel block, read without a problem (an empty one when it depends on and offers nothing)", () => {
    const names = shipped();
    expect(names.length).toBeGreaterThanOrEqual(17);
    for (const name of names) {
      const { fields, problems } = readKernelFields(manifest(name), true);
      expect(problems, name).toEqual([]);
      expect(fields, `${name} has no kernel block`).not.toBeNull();
      // Nothing the kernel could refuse a plugin for: no hard requirement is declared by any built-in plugin.
      expect(fields!.requires.services, name).toEqual([]);
    }
  });

  /** What each declared service is, in the code: who calls it (`users`) and who offers it, so a declaration is never a guess. */
  const EVIDENCE: Record<string, { provider: string; providerFile?: string; providerText?: string; users: { plugin: string; file: string; text: string }[] }> = {
    // The chat page's service (renderer/plugins/chat): the Note quotes a block into the input box with it.
    "composer.insertQuote": { provider: "botling.chat", users: [{ plugin: "botling.note", file: "src/ui-cards.js", text: "comp.insertQuote(" }] },
    // The component studio's chips ask `draw.pinButton`, which fills the head of a built component with the buttons other plugins registered; the Pins add theirs.
    "studio.specButton": {
      provider: "botling.component-studio", providerFile: "src/chips.ts", providerText: "draw.pinButton(",
      users: [{ plugin: "botling.board", file: "src/web.ts", text: "ccb.studio.specButton(" }],
    },
  };

  it("each declared service is real: a plugin that uses it calls it in its code, and its provider offers it (the app's own ones are the list in dep-board.ts)", () => {
    const used = new Map<string, Set<string>>();
    const offered = new Map<string, Set<string>>();
    for (const name of shipped()) {
      const fields = readKernelFields(manifest(name), true).fields!;
      for (const service of [...fields.requires.services, ...fields.uses.services]) used.set(service, (used.get(service) ?? new Set()).add(name));
      for (const service of fields.provides.services) offered.set(service, (offered.get(service) ?? new Set()).add(name));
    }
    const declared = new Set([...used.keys(), ...offered.keys()]);
    // A new declaration has to bring its evidence here: no service is declared without one.
    expect([...declared].sort()).toEqual(Object.keys(EVIDENCE).sort());
    for (const [service, evidence] of Object.entries(EVIDENCE)) {
      expect([...(used.get(service) ?? [])].sort(), service).toEqual(evidence.users.map((user) => user.plugin).sort());
      for (const user of evidence.users) expect(readFileSync(join(SOURCES, user.plugin, user.file), "utf8"), `${user.plugin} calls ${service}`).toContain(user.text);
      const app = APP_PROVIDERS.find((provider) => provider.name === evidence.provider);
      if (app) { expect(app.services, service).toContain(service); expect(offered.has(service), `${service} is the app's, no plugin offers it`).toBe(false); continue; }
      expect([...(offered.get(service) ?? [])], service).toEqual([evidence.provider]);
      expect(readFileSync(join(SOURCES, evidence.provider, evidence.providerFile!), "utf8"), `${evidence.provider} offers ${service}`).toContain(evidence.providerText!);
    }
  });

  it("the real built-in set: the Note uses the chat's quote and the Pins use the studio's spec button (dashed arrows), and no required provider is missing", async () => {
    const { buildBuiltinPlugins } = await import(join(desktop, "build-builtin-plugins.mjs"));
    const built = await buildBuiltinPlugins({ outdir: join(tempDir("dep-board-builtin"), "builtin-plugins") });
    const dir = tempDir("dep-board-shipped");
    const registry = new PluginRegistry(join(dir, "plugins"), join(dir, "plugins.json"), new MemorySecretStore(), built);
    registry.rescan(true);
    const board = readDepBoard(registry, registry.contributions());
    expect(board.edges).toEqual([
      { from: "botling.board", to: "botling.component-studio", service: "studio.specButton", kind: "uses", live: true },
      { from: "botling.note", to: "botling.chat", service: INSERT_QUOTE, kind: "uses", live: true },
    ]);
    expect(board.missing).toEqual([]);
    // The second layer, the parts of the app the plugins call, as the registry hands it out: the busiest areas first by plugin count
    // (the page sorts the same way). A change in what a built-in plugin calls changes this, and app-features.test.ts says which call moved.
    const areas = board.featureAreas.map((area) => [area.id, area.plugins.length]);
    expect(areas.filter(([, count]) => (count as number) >= 2).sort((x, y) => (y[1] as number) - (x[1] as number) || String(x[0]).localeCompare(String(y[0])))).toEqual([
      ["ccb.messages", 6], ["api.bots", 5], ["api.chat", 4], ["api.replyTags", 4], ["api.settings", 4], ["ccb.composer", 3], ["ccb.decorations", 3], ["api.workspace", 2], ["ccb.page", 2],
    ]);
    expect(areas).toHaveLength(24);
    expect(board.featureAreas.flatMap((area) => area.features)).toHaveLength(67);
    expect(board.featureAreas.find((area) => area.id === "api.usage")).toMatchObject({ plugins: ["botling.usage"], features: [{ id: "api.usage.view", member: "view", plugins: ["botling.usage"] }] });
    expect(board.plugins.find((plugin) => plugin.name === "botling.note")).toMatchObject({ uses: ["composer.insertQuote"], features: ["api.notes.outline", "api.notes.read", "api.notes.write"] });
    expect(board.plugins.filter((plugin) => !plugin.app && plugin.features.length === 0).map((plugin) => plugin.name)).toEqual(["botling.cards", "botling.design", "botling.orchestration", "botling.report"]);
    expect(board.plugins.find((plugin) => plugin.name === "botling.chat")!.features).toEqual([]);
    // Every plugin that ships reads as declared (the board shows "Declares nothing" only for installed ones), on, and none is failed.
    const real = board.plugins.filter((plugin) => !plugin.app);
    expect(real.length).toBeGreaterThanOrEqual(17);
    expect(real.filter((plugin) => !plugin.declared).map((plugin) => plugin.name)).toEqual([]);
    expect(real.filter((plugin) => plugin.failure !== null).map((plugin) => plugin.name)).toEqual([]);
    expect(board.plugins.find((plugin) => plugin.name === "botling.deps")).toMatchObject({ builtIn: true, enabled: true, fills: ["settings/section"] });
    expect(board.slots.find((row) => row.slot === "settings/section")!.fills).toContain("botling.deps");
  }, 60_000);
});
