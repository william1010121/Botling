// @vitest-environment jsdom
// Golden record of the frame broker's replies (kernel step 1, brief §4 step 1): one scripted message sequence from three
// plugin frames (frame-broker.ts `registerPluginFrame`, with the page's real plugin-frame-host.ts for `ccb.composer.insertQuote`
// and composer-quote.ts behind it), recorded before the kernel went under the broker and byte-identical at every later step.
// See test/kernel-goldens.ts for how a golden is changed on purpose.
import { afterEach, expect, it, vi } from "vitest";
import { golden } from "../kernel-goldens";
import { FrameBroker, registerPluginFrame, type PluginFrameHost } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { setComposerQuoter } from "../../src/renderer/composer-quote";
import type { Client } from "../../src/renderer/client";

function frame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: unknown[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  return { element, posted };
}

function send(from: HTMLIFrameElement | null, data: unknown, origin = "null") {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: (from?.contentWindow ?? null) as MessageEventSource | null }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const brokers: FrameBroker[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const made of brokers.splice(0)) made.dispose();
  document.body.innerHTML = "";
});

it("the frame broker answers a scripted sequence as recorded", async () => {
  // The broker paces by the clock (refusals carry its time too): a fixed clock makes the record exact.
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  const broker = new FrameBroker(window, { name: "golden broker", frame: "plugin frame" });
  brokers.push(broker);
  const log: unknown[] = [];
  // The page's own host for composer quotes and approvals; plain fakes for what goes to the core.
  const client = { request: async (command: { type: string }) => { log.push(["client", command]); throw new Error(`no core for ${command.type}`); } } as unknown as Client;
  const page = pluginFrameHost({ client, components: () => ({}), bots: () => [{ id: "B1", role: "main" } as never, { id: "B2", role: "bot" } as never], ask: (_view, _approve, done) => done(false) });
  const host: PluginFrameHost = {
    ...page,
    call: async (plugin, method, params) => { log.push(["call", plugin, method, params]); if (method === "fail") throw { error: { message: "it failed" } }; return `${plugin}:${method}`; },
    command: async (plugin, id, args) => { log.push(["command", plugin, id, args ?? null]); if (id.endsWith(".bad")) throw new Error("bad command"); return null; },
    builtin: (plugin, command) => { log.push(["builtin", plugin, command]); },
  };
  const note = frame();
  const zed = frame();
  const lone = frame();
  const stranger = frame();
  const events: unknown[] = [];
  registerPluginFrame(broker, host, { frame: note.element, plugin: "botling.note", bot: "B1", onReady: () => events.push(["ready", "note"]), onNotice: (text) => events.push(["notice", "note", text]) });
  const offZed = registerPluginFrame(broker, host, {
    frame: zed.element, plugin: "zed.tools",
    onNotice: (text) => events.push(["notice", "zed", text]), onError: (text) => events.push(["error", "zed", text]), onResize: (height) => events.push(["resize", height]),
    onPanel: (visible) => events.push(["panel", visible]), onKey: (key) => events.push(["key", key]),
  });
  // A page that answers only calls and commands (no builtins, tiles, cards or quotes).
  registerPluginFrame(broker, { call: host.call, command: host.command }, { frame: lone.element, plugin: "lone" });

  const steps: [ReturnType<typeof frame> | null, unknown, string?][] = [
    [note, { ccb: "ready" }],
    [note, { ccb: "call", id: 1, method: "count", params: { n: 2 } }],
    [note, { ccb: "call", id: 2, method: "fail", params: null }],
    [note, { ccb: "call", id: 3, method: "x", params: { plugin: "bank" }, plugin: "bank" }],
    [note, { ccb: "command", id: "botling.note.open", args: ["a"] }],
    [note, { ccb: "command", id: "zed.tools.run" }],
    [note, { ccb: "command", id: "botling.note.bad" }],
    [note, { ccb: "command", id: "botling.openChat", args: ["B1"] }],
    [note, { ccb: "command", id: "botling.openChat", args: [] }],
    [note, { ccb: "tile", id: 4, component: "missing", data: null, size: "2x1", botId: "B1" }],
    [note, { ccb: "approval", id: 5, botId: "B1", command: "ls", folder: "/x" }],
    // ccb.composer.insertQuote: no input box yet, then one, another bot's box, an unknown bot.
    [note, { ccb: "composerQuote", id: 6, botId: "B1", text: "> quoted", focus: true }],
    ["quoter"] as never,
    [note, { ccb: "composerQuote", id: 7, botId: "B1", text: "> quoted again", focus: false }],
    [note, { ccb: "composerQuote", id: 8, botId: "B2", text: "> not mine", focus: true }],
    [zed, { ccb: "composerQuote", id: 9, botId: "B1", text: "> no bot", focus: true }],
    [zed, { ccb: "notify", text: "hello" }],
    [zed, { ccb: "resize", height: 120 }],
    [zed, { ccb: "panel", visible: true }],
    [zed, { ccb: "key", key: "k", meta: true, ctrl: false, alt: false, shift: true }],
    [zed, { ccb: "error", message: "zed broke" }],
    [zed, { ccb: "nonsense" }],
    [zed, "not even an object"],
    [zed, { ccb: "call", id: 10, method: "count" }, "https://evil.example"],
    [stranger, { ccb: "call", id: 11, method: "count" }],
    [lone, { ccb: "command", id: "botling.openResult", args: ["B1", "r"] }],
    [lone, { ccb: "card", id: 12, component: "c", data: null, botId: "B1" }],
    ["unregister zed"] as never,
    [zed, { ccb: "call", id: 13, method: "count" }],
  ];
  let stopQuoter = () => {};
  for (const [from, data, origin] of steps) {
    if ((from as unknown) === "quoter") { stopQuoter = setComposerQuoter(async (botId, text, focus) => { log.push(["quote", botId, text, focus]); return true; }); continue; }
    if ((from as unknown) === "unregister zed") { offZed(); continue; }
    send(from?.element ?? null, data, origin);
    await settle();
  }
  // Pacing: 25 calls at once from the note frame, of which the first 20 go through.
  for (let id = 100; id < 125; id += 1) send(note.element, { ccb: "call", id, method: "burst" });
  await settle();
  stopQuoter();
  const record = {
    note: note.posted, zed: zed.posted, lone: lone.posted, stranger: stranger.posted, events, log,
    refusals: broker.refusals.map((refusal) => [refusal.reason, refusal.card]),
  };
  const [expected, actual] = golden("frame-broker", record);
  expect(actual).toBe(expected);
});
