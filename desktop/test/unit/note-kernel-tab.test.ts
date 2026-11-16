// @vitest-environment jsdom
// The Note tab through the kernel (M7-04b). The Note is a kernel plugin: the manifest's `kernel` fields (`uses.services:
// ["composer.insertQuote"]) are its declaration in the renderer's kernel, its `mainTab` view is its contribution to `main/tab`,
// and a frame's `ccb.composer.insertQuote` is bound from that declaration (shell/frame-declarations.ts, frame-services.ts), not by
// the Note's name in plugin-frame-host.ts. A provider swap of the service re-binds without reloading the Note's frame.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type BotView, type PluginsView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { setComposerQuoter } from "../../src/renderer/composer-quote";
import { CHAT_SURFACE, INSERT_QUOTE, rendererKernel } from "../../src/renderer/renderer-kernel";
import { FRAME_MANIFESTS, frameDeclaration, parseFrameDeclaration } from "../../src/renderer/shell/frame-declarations";
import { pluginFeed, reconcileView } from "../../src/renderer/shell/plugin-feed";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { desktop, until } from "../helpers";

const NOTE = "botling.note";
const BOT = "6A0B0000-0000-4000-8000-000000000041";
const BOTS = [{ id: BOT, role: "manager", name: "Site" }] as BotView[];
const noteManifest = () => JSON.parse(readFileSync(join(desktop, "builtin-plugins", NOTE, "package.json"), "utf8")) as unknown;

type Listed = { builtIn?: boolean; name?: string };
/** A plugin list with the Note on, its tab in `mainTabs`, as the core sends it. */
function view({ builtIn = true, name = NOTE }: Listed = {}): PluginsView {
  return {
    plugins: [{ name, title: "Note", version: "1.19.1", description: null, enabled: true, failure: null, installedFrom: null, ...(builtIn ? { builtIn: true } : {}) }],
    mainTabs: [{ plugin: name, id: `${name}.tab`, title: "Note", icon: "note.text", forRole: "any" }],
  } as unknown as PluginsView;
}

function frame(plugin = NOTE) {
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe() { return () => {}; }, post() {} });
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: any[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  const broker = new FrameBroker(window, { name: "note kernel tab broker" });
  registerPluginFrame(broker, pluginFrameHost({ client, components: () => ({}), bots: () => BOTS, ask: (_v, _a, done) => done(false) }), { frame: element, plugin, bot: BOT });
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: element.contentWindow as MessageEventSource }));
  const quote = async (id: number, text = "> a block") => {
    send({ ccb: "composerQuote", id, text, botId: BOT, focus: false });
    await until(() => posted.some((message) => message.id === id));
    return posted.find((message) => message.id === id);
  };
  return { element, posted, quote };
}

/** The chat plugin, which owns `main/tab` since M7-07a (the build ships more plugins; this host runs only that one). */
const chatManifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const hosts: InPageHost[] = [];
const chatHost = () => {
  const made = new InPageHost({ manifest: { plugins: chatManifest.plugins.filter((entry) => entry.name === CHAT_PLUGIN) }, log: () => undefined });
  hosts.push(made);
  return made;
};

const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  FRAME_MANIFESTS.delete("botling.mute");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the Note's declaration", () => {
  it("is read from the manifest's kernel fields (the real package.json), nothing but the uses is taken", () => {
    expect(parseFrameDeclaration(noteManifest())).toEqual({ uses: [INSERT_QUOTE] });
    expect(frameDeclaration(NOTE)).toEqual({ uses: [INSERT_QUOTE] });
  });

  it("a manifest without the kernel field, with another version, or with odd entries declares nothing or only the good names", () => {
    expect(parseFrameDeclaration({ name: "x.y", ccb: { uses: { services: ["composer.insertQuote"] } } })).toBeNull();
    expect(parseFrameDeclaration({ name: "x.y", ccb: { kernel: 2, uses: { services: ["composer.insertQuote"] } } })).toBeNull();
    expect(parseFrameDeclaration({ name: "x.y", ccb: { kernel: 1 } })).toEqual({ uses: [] });
    expect(parseFrameDeclaration({ name: "x.y", botling: { kernel: 1, uses: { services: ["a.b", 7, "../x", "a.b", "", null] } } })).toEqual({ uses: ["a.b"] });
    expect(parseFrameDeclaration({ name: "x.y", ccb: { kernel: 1, uses: "nope" } })).toEqual({ uses: [] });
    // As the core's reader (manifest.ts readKernelFields): a `botling` field wins over `ccb`.
    expect(parseFrameDeclaration({ name: "x.y", botling: { kernel: 1, uses: { services: ["a.b"] } }, ccb: { kernel: 1, uses: { services: ["c.d"] } } })).toEqual({ uses: ["a.b"] });
    expect(parseFrameDeclaration(null)).toBeNull();
    expect(parseFrameDeclaration("text")).toBeNull();
  });

  it("the kernel holds it for the built-in Note once the page's plugin list says the Note is on, and drops it with the plugin", () => {
    reconcileView(view());
    expect(rendererKernel.state(NOTE)).toBe("active");
    expect(rendererKernel.declaration(NOTE)?.uses?.services).toEqual([INSERT_QUOTE]);
    expect(pluginFeed.declares(NOTE)).toBe(true);
    reconcileView(null);
    expect(rendererKernel.state(NOTE)).toBe("absent");
    expect(rendererKernel.declaration(NOTE)).toBeUndefined();
    expect(pluginFeed.declares(NOTE)).toBe(false);
  });

  it("is not taken for a copy that does not ship with Botling (no builtIn in the list): no uses, no declaration of the plugin's own", () => {
    reconcileView(view({ builtIn: false }));
    expect(rendererKernel.state(NOTE)).toBe("active");
    expect(rendererKernel.declaration(NOTE)?.uses?.services).toEqual([]);
    expect(pluginFeed.declares(NOTE)).toBe(false);
  });

  it("a library copy taking over the built-in's name drops the declaration (and quotes as a 2.x plugin); the built-in back takes it again", async () => {
    stops.push(setComposerQuoter(async () => true));
    reconcileView(view());
    expect(pluginFeed.declares(NOTE)).toBe(true);
    reconcileView(view({ builtIn: false }));
    expect(rendererKernel.state(NOTE)).toBe("active");
    expect(pluginFeed.declares(NOTE)).toBe(false);
    expect(rendererKernel.declaration(NOTE)?.uses?.services).toEqual([]);
    const { quote } = frame();
    expect(await quote(9)).toEqual({ ccb: "reply", id: 9, ok: true, value: { inserted: true } });
    reconcileView(view());
    expect(pluginFeed.declares(NOTE)).toBe(true);
    expect(rendererKernel.declaration(NOTE)?.uses?.services).toEqual([INSERT_QUOTE]);
  });

  it("the tab is the Note's contribution to main/tab, kept as the page's row (2.x id view/mainTab, new name main/tab); botling.chat owns the slot, so it is taken once that plugin is up and not before", async () => {
    reconcileView(view());
    const mine = (slot: string) => rendererKernel.entries<{ kind: string; row: { plugin: string; id: string } }>(slot).filter(({ plugin }) => plugin === NOTE);
    // No owner: the kernel refuses the contribution (the Note stays loaded).
    expect(mine("main/tab")).toEqual([]);
    expect(rendererKernel.state(NOTE)).toBe("active");
    await chatHost().start();
    await vi.waitFor(() => { expect(mine("main/tab").map(({ entry }) => entry.row.id)).toEqual(["botling.note.tab"]); });
    expect(mine("view/mainTab")).toHaveLength(1);
    expect(rendererKernel.allContributions().filter(({ plugin }) => plugin === NOTE).map(({ slot }) => slot)).toEqual(["view/mainTab"]);
  });

  it("a change of the manifest's uses reloads the Note's instance (the fingerprint holds it); an unchanged list touches nothing", () => {
    reconcileView(view());
    const generation = rendererKernel.generation(NOTE);
    reconcileView(view());
    expect(rendererKernel.generation(NOTE)).toBe(generation);
    FRAME_MANIFESTS.set(NOTE, { name: NOTE, ccb: { kernel: 1 } });
    try {
      reconcileView(view());
      expect(rendererKernel.generation(NOTE)).toBe(generation + 1);
      expect(rendererKernel.declaration(NOTE)?.uses?.services).toEqual([]);
    } finally {
      FRAME_MANIFESTS.set(NOTE, noteManifest());
    }
  });
});

describe("a frame's ccb.composer.insertQuote, bound from the declaration", () => {
  it("the Note's quote reaches the chat surface's service, called for the Note", async () => {
    const call = vi.spyOn(rendererKernel, "call");
    const calls: unknown[][] = [];
    stops.push(setComposerQuoter(async (...args) => { calls.push(args); return true; }));
    reconcileView(view());
    const { quote } = frame();
    expect(await quote(1)).toEqual({ ccb: "reply", id: 1, ok: true, value: { inserted: true } });
    expect(call).toHaveBeenCalledWith(NOTE, INSERT_QUOTE, BOT, "> a block", false);
    expect(calls).toEqual([[BOT, "> a block", false]]);
  });

  it("with :chat unloaded the quote answers { inserted: false }, as before, and the Note stays loaded", async () => {
    const calls: unknown[] = [];
    setComposerQuoter(async (...args) => { calls.push(args); return true; })();
    reconcileView(view());
    const { quote } = frame();
    expect(await quote(2)).toEqual({ ccb: "reply", id: 2, ok: true, value: { inserted: false } });
    expect(calls).toEqual([]);
    expect(rendererKernel.state(NOTE)).toBe("active");
  });

  it("a plugin whose manifest declares kernel fields but not this service is refused: { inserted: false }, the quoter is not called", async () => {
    FRAME_MANIFESTS.set("botling.mute", { name: "botling.mute", ccb: { kernel: 1, uses: { services: ["other.service"] } } });
    const calls: unknown[] = [];
    stops.push(setComposerQuoter(async (...args) => { calls.push(args); return true; }));
    reconcileView(view({ name: "botling.mute" }));
    expect(pluginFeed.declares("botling.mute")).toBe(true);
    const { quote } = frame("botling.mute");
    expect(await quote(3)).toEqual({ ccb: "reply", id: 3, ok: true, value: { inserted: false } });
    expect(calls).toEqual([]);
  });

  it("the binding is the declaration the kernel holds, not the bundled manifest: a manifest changed without a reconcile grants nothing", async () => {
    FRAME_MANIFESTS.set("botling.mute", { name: "botling.mute", ccb: { kernel: 1, uses: { services: [] } } });
    const calls: unknown[] = [];
    stops.push(setComposerQuoter(async (...args) => { calls.push(args); return true; }));
    reconcileView(view({ name: "botling.mute" }));
    FRAME_MANIFESTS.set("botling.mute", { name: "botling.mute", ccb: { kernel: 1, uses: { services: [INSERT_QUOTE] } } });
    const { quote } = frame("botling.mute");
    expect(await quote(8)).toEqual({ ccb: "reply", id: 8, ok: true, value: { inserted: false } });
    expect(calls).toEqual([]);
  });

  it("a plugin with no kernel fields (a 2.x plugin) keeps quoting as before", async () => {
    stops.push(setComposerQuoter(async () => true));
    reconcileView(view({ name: "acme.notes", builtIn: false }));
    const { quote } = frame("acme.notes");
    expect(await quote(4)).toEqual({ ccb: "reply", id: 4, ok: true, value: { inserted: true } });
  });

  it("a declared plugin whose instance is not active (unloaded under the feed) is refused until it is loaded again", async () => {
    const calls: unknown[] = [];
    stops.push(setComposerQuoter(async (...args) => { calls.push(args); return true; }));
    reconcileView(view());
    const { quote } = frame();
    await rendererKernel.requestUnload(NOTE);
    expect(rendererKernel.state(NOTE)).toBe("absent");
    expect(pluginFeed.declares(NOTE)).toBe(true);
    expect(await quote(5)).toEqual({ ccb: "reply", id: 5, ok: true, value: { inserted: false } });
    expect(calls).toEqual([]);
  });

  it("swapping :chat (unload, load) while the Note's frame stays mounted: the next quote is inserted, the frame and the Note are not reloaded", async () => {
    const used: string[] = [];
    const first = setComposerQuoter(async () => { used.push("first"); return true; });
    reconcileView(view());
    const { element, posted, quote } = frame();
    const generation = rendererKernel.generation(NOTE);
    expect(await quote(1)).toMatchObject({ ok: true, value: { inserted: true } });

    first();
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
    expect(await quote(2)).toMatchObject({ ok: true, value: { inserted: false } });

    stops.push(setComposerQuoter(async () => { used.push("second"); return true; }));
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBe(CHAT_SURFACE);
    expect(await quote(3)).toMatchObject({ ok: true, value: { inserted: true } });

    expect(used).toEqual(["first", "second"]);
    // The Note was never unloaded or loaded again, its frame is the same element, and the frame's counter ran on (ids 1, 2, 3).
    expect(rendererKernel.generation(NOTE)).toBe(generation);
    expect(rendererKernel.state(NOTE)).toBe("active");
    expect(document.body.contains(element)).toBe(true);
    expect(posted.map((message) => message.id)).toEqual([1, 2, 3]);
  });
});
