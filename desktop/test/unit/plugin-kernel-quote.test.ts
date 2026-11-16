// @vitest-environment jsdom
// `composer.insertQuote` as a service of the renderer's plugin kernel (kernel step 1 step 7): `botling.chat` provides it (M7-07b; it was the
// `:chat` stand-in) and forwards it to the quoter App registers, the Note's frame calls it through the broker as a kernel call carrying the
// frame's plugin, and with the plugin away (or no quoter) the call finds nothing and answers as when no input box exists: { inserted: false }.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type BotView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { quoteIntoComposer, setComposerQuoter } from "../../src/renderer/composer-quote";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { INSERT_QUOTE, rendererKernel } from "../../src/renderer/renderer-kernel";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { desktop, until } from "../helpers";

// The build ships more plugins; this host runs only the chat plugin.
const chatManifest = { plugins: parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8"))).plugins.filter((entry) => entry.name === CHAT_PLUGIN) };
const hosts: InPageHost[] = [];
const chatHost = () => { const made = new InPageHost({ manifest: chatManifest, log: () => undefined }); hosts.push(made); return made; };

const BOT = "6A0B0000-0000-4000-8000-000000000040";
const BOTS = [{ id: BOT, role: "manager", name: "Site" }] as BotView[];

function frame() {
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe() { return () => {}; }, post() {} });
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: any[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  const broker = new FrameBroker(window, { name: "kernel quote broker" });
  registerPluginFrame(broker, pluginFrameHost({ client, components: () => ({}), bots: () => BOTS, ask: (_v, _a, done) => done(false) }), { frame: element, plugin: "botling.note", bot: BOT });
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: element.contentWindow as MessageEventSource }));
  return { posted, send };
}

const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const one of hosts.splice(0)) await one.stop();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("composer.insertQuote in the renderer's kernel", () => {
  it("the chat plugin provides it while it is up (a quoter or not), holds nothing once it is unloaded, and there is no `:chat` stand-in", async () => {
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
    expect(rendererKernel.declaration(":chat")).toBeUndefined();
    expect(rendererKernel.plugins()).not.toContain(":chat");
    const one = chatHost();
    await one.start();
    expect(rendererKernel.state(CHAT_PLUGIN)).toBe("active");
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBe(CHAT_PLUGIN);
    // A quoter coming and going changes nothing in the kernel: the plugin is the provider, the quoter is what it forwards to.
    const stop = setComposerQuoter(async () => true);
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBe(CHAT_PLUGIN);
    stop();
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBe(CHAT_PLUGIN);
    expect(rendererKernel.plugins()).not.toContain(":chat");
    await one.stop();
    expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent");
    expect(rendererKernel.holdsNothingOf(CHAT_PLUGIN)).toBe(true);
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
  });

  it("the frame's call goes through the kernel for the frame's plugin", async () => {
    await chatHost().start();
    const call = vi.spyOn(rendererKernel, "call");
    const calls: unknown[][] = [];
    stops.push(setComposerQuoter(async (...args) => { calls.push(args); return true; }));
    const { send, posted } = frame();
    send({ ccb: "composerQuote", id: 1, text: "> a block", botId: BOT, focus: false });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 1, ok: true, value: { inserted: true } }]);
    expect(call).toHaveBeenCalledWith("botling.note", INSERT_QUOTE, BOT, "> a block", false);
    expect(calls).toEqual([[BOT, "> a block", false]]);
  });

  it("with no quoter registered the call answers { inserted: false } and nothing is called", async () => {
    await chatHost().start();
    const calls: unknown[] = [];
    setComposerQuoter(async (...args) => { calls.push(args); return true; })();
    const { send, posted } = frame();
    send({ ccb: "composerQuote", id: 2, text: "x", botId: BOT, focus: true });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 2, ok: true, value: { inserted: false } }]);
    expect(calls).toEqual([]);
    await expect(quoteIntoComposer(BOT, "x", true)).resolves.toBe(false);
  });

  it("with the chat plugin away (refused: its hash is not in the manifest) the call finds no provider and answers { inserted: false }, the quoter is not called", async () => {
    const calls: unknown[] = [];
    stops.push(setComposerQuoter(async (...args) => { calls.push(args); return true; }));
    const refused = new InPageHost({ manifest: { plugins: [] }, log: () => undefined });
    hosts.push(refused);
    await refused.start([{ name: CHAT_PLUGIN, codeHash: chatManifest.plugins[0]!.codeHash }]);
    expect(refused.unavailable(CHAT_PLUGIN)).toBe(true);
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
    const { send, posted } = frame();
    send({ ccb: "composerQuote", id: 3, text: "x", botId: BOT, focus: false });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 3, ok: true, value: { inserted: false } }]);
    expect(calls).toEqual([]);
    await expect(quoteIntoComposer(BOT, "x", false)).resolves.toBe(false);
  });

  it("a newer quoter replaces the one before; the older one's unregister does not remove the newer", async () => {
    await chatHost().start();
    const used: string[] = [];
    const first = setComposerQuoter(async () => { used.push("first"); return true; });
    stops.push(setComposerQuoter(async () => { used.push("second"); return true; }));
    first();
    await expect(quoteIntoComposer(BOT, "x", false)).resolves.toBe(true);
    expect(used).toEqual(["second"]);
  });
});
