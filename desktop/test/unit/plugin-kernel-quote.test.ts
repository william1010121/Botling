// @vitest-environment jsdom
// `composer.insertQuote` as a service of the renderer's plugin kernel (kernel step 1 step 7): the chat surface provides
// it while App is up, the Note's frame calls it through the broker as a kernel call carrying the frame's plugin, and with
// the provider unloaded the call finds nothing and answers as when no input box exists: { inserted: false }.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type BotView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { quoteIntoComposer, setComposerQuoter } from "../../src/renderer/composer-quote";
import { CHAT_SURFACE, INSERT_QUOTE, rendererKernel } from "../../src/renderer/renderer-kernel";
import { until } from "../helpers";

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
afterEach(() => { for (const stop of stops.splice(0)) stop(); document.body.innerHTML = ""; vi.restoreAllMocks(); });

describe("composer.insertQuote in the renderer's kernel", () => {
  it("the chat surface provides it while its quoter is registered, and holds nothing once it is taken back", () => {
    expect(rendererKernel.state(CHAT_SURFACE)).toBe("absent");
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
    const stop = setComposerQuoter(async () => true);
    expect(rendererKernel.state(CHAT_SURFACE)).toBe("active");
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBe(CHAT_SURFACE);
    stop();
    expect(rendererKernel.state(CHAT_SURFACE)).toBe("absent");
    expect(rendererKernel.holdsNothingOf(CHAT_SURFACE)).toBe(true);
    expect(rendererKernel.providerOf(INSERT_QUOTE)).toBeNull();
  });

  it("the frame's call goes through the kernel for the frame's plugin", async () => {
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

  it("with the provider unloaded the call answers { inserted: false }, and its quoter is not called", async () => {
    const calls: unknown[] = [];
    const stop = setComposerQuoter(async (...args) => { calls.push(args); return true; });
    stop();
    const { send, posted } = frame();
    send({ ccb: "composerQuote", id: 2, text: "x", botId: BOT, focus: true });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 2, ok: true, value: { inserted: false } }]);
    expect(calls).toEqual([]);
    await expect(quoteIntoComposer(BOT, "x", true)).resolves.toBe(false);
  });

  it("a newer quoter replaces the one before; the older one's unregister does not remove the newer", async () => {
    const used: string[] = [];
    const first = setComposerQuoter(async () => { used.push("first"); return true; });
    const generation = rendererKernel.generation(CHAT_SURFACE);
    stops.push(setComposerQuoter(async () => { used.push("second"); return true; }));
    expect(rendererKernel.generation(CHAT_SURFACE)).toBe(generation + 1);
    first();
    expect(rendererKernel.state(CHAT_SURFACE)).toBe("active");
    await expect(quoteIntoComposer(BOT, "x", false)).resolves.toBe(true);
    expect(used).toEqual(["second"]);
  });
});
