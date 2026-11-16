// The "plugins → app features" layer of the dependency board (core/plugins/app-features.ts): what the scan of a bundle reads, what the
// catalog of the app's surface holds, and that the list declared for each built-in plugin is what its built bundles really call.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktop, tempDir } from "../helpers";
import {
  areaOf, BUILTIN_FEATURES, declaredFeatures, FEATURE_AREAS, HOST_SURFACE, scanFeatures, WEB_SURFACE,
} from "../../src/core/plugins/app-features";
import { buildDepBoard, type DepInput } from "../../src/core/plugins/dep-board";
import { readKernelFields } from "../../src/core/plugins/manifest";

describe("scanFeatures", () => {
  it("reads `.area.member` property chains of the host surface, whatever the object is called, sorted and once each", () => {
    const text = "api.usage.view(); host.cards.library(b); this.host.cards.shown(b); api.usage.view(); await api.bots.list();";
    expect(scanFeatures(text, "host")).toEqual(["api.bots.list", "api.cards.library", "api.cards.shown", "api.usage.view"]);
  });

  it("reads overlapping chains, and the minified web part's one-letter objects", () => {
    expect(scanFeatures("t.messages.cardBar(x),t.page.onState(y);e.composer.chips.list()", "web")).toEqual(["ccb.composer.chips", "ccb.messages.cardBar", "ccb.page.onState"]);
  });

  it("is a closed list: another object's field that has the same name, a member that is not the app's, or the other side's surface, is not a feature", () => {
    const noise = "spec.bots.filter(a); state.messages.find(b); t.messages.length; link.decorations.underline; this.sessions.get(k); doc.content.join('')";
    expect(scanFeatures(noise, "host")).toEqual([]);
    expect(scanFeatures(noise, "web")).toEqual([]);
    expect(scanFeatures("api.chat.messages(); api.usage.view()", "web")).toEqual([]);
    expect(scanFeatures("ccb.messages.render(x)", "host")).toEqual([]);
    // A longer member name that only starts like a listed one is another name.
    expect(scanFeatures("api.bots.listAll(); api.bots.list2()", "host")).toEqual([]);
  });

  it("sees the one call a bundler hides behind a short name (`s = draw; s.pinButton(chip)`), on the web side only", () => {
    expect(scanFeatures("let d=s.pinButton(p);", "web")).toEqual(["ccb.draw.pinButton"]);
    expect(scanFeatures("let d=s.pinButton(p);", "host")).toEqual([]);
  });

  it("plumbing of the plugin itself is not an app feature, and neither is a kernel service", () => {
    const plumbing = "api.storage.get(k); api.events.on('x'); api.commands.register('a'); api.ui.expose('m'); api.ui.emit('e'); api.ui.notify('t'); api.ui.setStatus('i');"
      + " api.settings.get('k'); api.settings.update('k'); api.settings.onChange('k'); ccb.call('m'); ccb.panels.register('p'); ccb.commands.register('c'); ccb.composer.insertQuote('q')";
    expect(scanFeatures(plumbing, "host")).toEqual([]);
    expect(scanFeatures(plumbing, "web")).toEqual([]);
  });

  it("never throws, and a text with nothing in it has nothing", () => {
    expect(scanFeatures("", "host")).toEqual([]);
    expect(scanFeatures("\u0000.a.b..c.", "web")).toEqual([]);
  });
});

describe("the catalog of the app's surface", () => {
  it("has each area once, each member once, and ids that say their side", () => {
    expect(new Set(FEATURE_AREAS.map((entry) => entry.id)).size).toBe(FEATURE_AREAS.length);
    for (const entry of FEATURE_AREAS) {
      expect(entry.id, entry.id).toMatch(entry.side === "host" ? /^api\.[A-Za-z]+$/ : /^ccb\.[A-Za-z]+$/);
      expect(new Set(entry.members).size, entry.id).toBe(entry.members.length);
      expect(entry.title.length, entry.id).toBeGreaterThan(2);
      expect(areaOf(`${entry.id}.${entry.members[0]}`)).toBe(entry.id);
    }
    expect(HOST_SURFACE.size + WEB_SURFACE.size).toBe(FEATURE_AREAS.length);
  });

  it("names only what the sources really have: each area and member is declared in Web/host/src/api*.ts (api.*) or Web/src/plugins.ts (ccb.*)", () => {
    const root = join(desktop, "..");
    const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
    const host = ["api.ts", "api-types.ts", "api-types-botling.ts"].map((file) => read("Web", "host", "src", file)).join("\n");
    const web = read("Web", "src", "plugins.ts");
    const declares = (text: string, name: string) => new RegExp(`\\b${name}\\??\\s*[:(<]`).test(text);
    for (const entry of FEATURE_AREAS) {
      const text = entry.side === "host" ? host : web;
      expect(declares(text, entry.id.slice(4)), `${entry.id} is in the sources`).toBe(true);
      for (const member of entry.members) expect(declares(text, member), `${entry.id}.${member} is in the sources`).toBe(true);
    }
  });

  it("leaves out the plugin's own plumbing and the kernel service of the chat's input box", () => {
    const areas = new Set(FEATURE_AREAS.map((entry) => entry.id));
    for (const plumbing of ["api.storage", "api.events", "api.commands", "api.subscriptions", "api.plugin", "ccb.panels", "ccb.commands", "ccb.call", "ccb.host"]) expect(areas.has(plumbing), plumbing).toBe(false);
    expect(HOST_SURFACE.get("settings")).toEqual(["app"]);
    for (const member of ["expose", "emit", "notify", "setStatus"]) expect(HOST_SURFACE.get("ui"), member).not.toContain(member);
    expect(WEB_SURFACE.get("composer")).not.toContain("insertQuote");
  });
});

describe("what is declared for each plugin", () => {
  it("never claims what the catalog does not hold, lists what a plugin calls once and sorted, and looks a name up as data", () => {
    const surface = (id: string) => (id.startsWith("api.") ? HOST_SURFACE : WEB_SURFACE);
    for (const [name, ids] of Object.entries(BUILTIN_FEATURES)) {
      expect([...ids].sort(), name).toEqual([...ids]);
      expect(new Set(ids).size, name).toBe(ids.length);
      for (const id of ids) expect(surface(id).get(areaOf(id).slice(4))?.includes(id.slice(areaOf(id).length + 1)), `${name}: ${id}`).toBe(true);
    }
    expect(declaredFeatures("botling.usage")).toEqual(["api.usage.view"]);
    expect(declaredFeatures("constructor")).toEqual([]);
    expect(declaredFeatures("__proto__")).toEqual([]);
    expect(declaredFeatures("not.there")).toEqual([]);
  });

  const SOURCES = join(desktop, "builtin-plugins");
  const shipped = () => readdirSync(SOURCES).filter((name) => !name.includes(".md") && !name.startsWith(".")).sort();

  it("lists every built-in plugin (an empty list when it calls nothing of the app) and nothing else", () => {
    expect(Object.keys(BUILTIN_FEATURES).sort()).toEqual(shipped());
  });

  it("keeps the kernel services apart: no feature is a `uses` / `requires` of any manifest, and the Note's `uses` is still only the chat's quote", () => {
    const features = new Set(Object.values(BUILTIN_FEATURES).flat());
    for (const name of shipped()) {
      const manifest = JSON.parse(readFileSync(join(SOURCES, name, "package.json"), "utf8")) as Record<string, unknown>;
      const fields = readKernelFields(manifest, true).fields!;
      for (const service of [...fields.uses.services, ...fields.requires.services, ...fields.provides.services]) expect(features.has(service), `${name}: ${service}`).toBe(false);
    }
    const note = readKernelFields(JSON.parse(readFileSync(join(SOURCES, "botling.note", "package.json"), "utf8")), true).fields!;
    expect(note.uses.services).toEqual(["composer.insertQuote"]);
    expect(note.requires.services).toEqual([]);
  });

  it("is what the built bundles really call: the program part (`ccb.host`) read against `api.*`, the web part (`ccb.web`) against `ccb.*`, plugin by plugin", async () => {
    const { buildBuiltinPlugins } = await import(join(desktop, "build-builtin-plugins.mjs"));
    const built = await buildBuiltinPlugins({ outdir: join(tempDir("app-features-built"), "builtin-plugins") }) as string;
    const scanned: Record<string, string[]> = {};
    for (const name of shipped()) {
      const manifest = JSON.parse(readFileSync(join(built, name, "package.json"), "utf8")) as { ccb?: { host?: string; web?: string }; botling?: { host?: string; web?: string } };
      const entry = manifest.botling ?? manifest.ccb ?? {};
      scanned[name] = [
        ...(entry.host ? scanFeatures(readFileSync(join(built, name, entry.host), "utf8"), "host") : []),
        ...(entry.web ? scanFeatures(readFileSync(join(built, name, entry.web), "utf8"), "web") : []),
      ].sort();
    }
    // One plugin at a time, so a failure names the plugin and the call that moved.
    for (const name of shipped()) expect(scanned[name], name).toEqual([...BUILTIN_FEATURES[name]!]);
  }, 60_000);
});

describe("the board's second layer", () => {
  const plugin = (name: string, features: string[], more: Partial<DepInput> = {}): DepInput => ({
    name, title: name.toUpperCase(), version: "1.0.0", enabled: true, builtIn: true, failure: null, declared: true,
    provides: { services: [], slots: [] }, requires: [], uses: [], contributedSlots: [], features, ...more,
  });

  it("lists, for each area of the app that a plugin calls, the calls and who makes them, in the catalog's order, and leaves out areas nobody calls", () => {
    const board = buildDepBoard([
      plugin("b", ["api.usage.view", "ccb.composer.insert", "api.bots.list"]),
      plugin("a", ["api.bots.list", "api.bots.send"]),
      plugin("c", []),
    ]);
    expect(board.plugins.map((node) => [node.name, node.features])).toEqual([["a", ["api.bots.list", "api.bots.send"]], ["b", ["api.bots.list", "api.usage.view", "ccb.composer.insert"]], ["c", []]]);
    expect(board.featureAreas.map((area) => [area.id, area.side, area.plugins])).toEqual([
      ["api.bots", "host", ["a", "b"]], ["api.usage", "host", ["b"]], ["ccb.composer", "web", ["b"]],
    ]);
    expect(board.featureAreas[0]).toEqual({
      id: "api.bots", side: "host", title: "Bots", plugins: ["a", "b"],
      features: [{ id: "api.bots.list", member: "list", plugins: ["a", "b"] }, { id: "api.bots.send", member: "send", plugins: ["a"] }],
    });
  });

  it("shows a call in an area the catalog does not list (nothing a plugin declared is hidden), and a plugin that is off still counts", () => {
    const board = buildDepBoard([plugin("a", ["api.mystery.go"], { enabled: false }), plugin("b", ["ccb.newpart.x"])]);
    expect(board.featureAreas).toEqual([
      { id: "api.mystery", side: "host", title: "api.mystery", plugins: ["a"], features: [{ id: "api.mystery.go", member: "go", plugins: ["a"] }] },
      { id: "ccb.newpart", side: "web", title: "ccb.newpart", plugins: ["b"], features: [{ id: "ccb.newpart.x", member: "x", plugins: ["b"] }] },
    ]);
    expect(board.plugins.find((node) => node.name === "a")).toMatchObject({ enabled: false, features: ["api.mystery.go"] });
  });

  it("is empty for a plugin that declares nothing, and is not part of kernel `uses`", () => {
    const board = buildDepBoard([plugin("a", ["api.usage.view"], { uses: ["x.y"] }), plugin("n", [], { features: undefined })]);
    expect(board.plugins.find((node) => node.name === "n")!.features).toEqual([]);
    expect(board.plugins.find((node) => node.name === "a")!.uses).toEqual(["x.y"]);
    expect(board.edges).toEqual([]);
    expect(buildDepBoard([]).featureAreas).toEqual([]);
  });

  it("a feature or plugin named like an object key is a name like any other", () => {
    const board = buildDepBoard([plugin("constructor", ["api.bots.list"]), plugin("__proto__", ["api.bots.list"])]);
    expect(board.featureAreas[0]!.plugins).toEqual(["__proto__", "constructor"]);
  });
});
