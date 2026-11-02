// @vitest-environment jsdom
// The frame broker (plan M2): one RPC for every sandboxed plugin frame. Who a frame is comes from
// the frame (`event.source`), never from the message; a frame calls only its own plugin and runs only
// its own commands; a message from a frame nobody registered, from a page with an origin, or that names
// a plugin is refused.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameBroker, registerPluginFrame, type PluginFrameHost } from "../../src/renderer/frame-broker";

function frame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: unknown[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  return { element, posted };
}

function send(from: HTMLIFrameElement | Window | null, data: unknown, origin = "null") {
  const source = from instanceof HTMLIFrameElement ? from.contentWindow : from;
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as MessageEventSource | null }));
}

function host(): PluginFrameHost & { calls: unknown[][]; commands: unknown[][] } {
  const calls: unknown[][] = [];
  const commands: unknown[][] = [];
  return {
    calls, commands,
    call: async (plugin, method, params) => { calls.push([plugin, method, params]); return `${plugin}:${method}`; },
    command: async (plugin, id) => { commands.push([plugin, id]); return null; },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const brokers: FrameBroker[] = [];
function broker(options?: ConstructorParameters<typeof FrameBroker>[1]) {
  const made = new FrameBroker(window, options);
  brokers.push(made);
  return made;
}

afterEach(() => {
  for (const made of brokers.splice(0)) made.dispose();
  document.body.innerHTML = "";
});

describe("the frame broker", () => {
  it("a frame's call goes to its own plugin, and only it gets the answer", async () => {
    const frames = broker();
    const rpc = host();
    const charts = frame();
    const notes = frame();
    registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts" });
    registerPluginFrame(frames, rpc, { frame: notes.element, plugin: "notes" });
    send(notes.element, { ccb: "call", id: 7, method: "count", params: { n: 2 } });
    await settle();
    expect(rpc.calls).toEqual([["notes", "count", { n: 2 }]]);
    expect(notes.posted).toEqual([{ ccb: "reply", id: 7, ok: true, value: "notes:count" }]);
    expect(charts.posted).toEqual([]);
  });

  it("a message that names another plugin is refused, not obeyed", async () => {
    const frames = broker();
    const rpc = host();
    const charts = frame();
    registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts" });
    send(charts.element, { ccb: "call", id: 1, method: "secret", params: null, plugin: "bank" });
    await settle();
    expect(rpc.calls).toEqual([]);
    expect(frames.refusals.map((refusal) => refusal.reason)).toEqual(["a message that is not a valid ccb call (call)"]);
  });

  it("a frame nobody registered, or one with an origin of its own, is not heard", async () => {
    const frames = broker();
    const rpc = host();
    const charts = frame();
    const stranger = frame();
    registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts" });
    send(stranger.element, { ccb: "call", id: 1, method: "count" });
    send(charts.element, { ccb: "call", id: 2, method: "count" }, "https://evil.example");
    await settle();
    expect(rpc.calls).toEqual([]);
    expect(frames.refusals.map((refusal) => refusal.reason)).toEqual([
      "a message from a frame that is not a registered frame",
      "a frame with origin https://evil.example (expected an opaque, sandboxed origin)",
    ]);
  });

  it("strangers can be left to someone else (the app page's chat frame)", () => {
    const frames = broker({ ignore: () => true });
    send(frame().element, { ccb: "call", id: 1, method: "count" });
    send(window, { ccb: "call", id: 1, method: "count" });
    expect(frames.refusals).toEqual([]);
  });

  it("a frame runs only its own plugin's commands", async () => {
    const frames = broker();
    const rpc = host();
    const charts = frame();
    registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts" });
    send(charts.element, { ccb: "command", id: "charts.refresh" });
    send(charts.element, { ccb: "command", id: "bank.transfer" });
    await settle();
    expect(rpc.commands).toEqual([["charts", "charts.refresh"]]);
    expect(frames.refusals.map((refusal) => refusal.reason)).toEqual(['a command of another plugin ("bank.transfer")']);
  });

  it("notices and failures go to the page; a refused call is answered", async () => {
    const frames = broker();
    const onNotice = vi.fn();
    const onError = vi.fn();
    const rpc: PluginFrameHost = { call: async () => { throw new Error('Plugin "charts" does not handle "nope".'); }, command: async () => null };
    const charts = frame();
    registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts", onNotice, onError });
    send(charts.element, { ccb: "notify", text: "Saved" });
    send(charts.element, { ccb: "error", message: "boom" });
    send(charts.element, { ccb: "call", id: 3, method: "nope" });
    await settle();
    expect(onNotice).toHaveBeenCalledWith("Saved");
    expect(onError).toHaveBeenCalledWith("boom");
    expect(charts.posted).toEqual([{ ccb: "reply", id: 3, ok: false, value: 'Plugin "charts" does not handle "nope".' }]);
  });

  it("paces each frame: 20 at once, then it is told to wait", async () => {
    const frames = broker();
    const rpc = host();
    const charts = frame();
    registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts" });
    for (let id = 1; id <= 21; id++) send(charts.element, { ccb: "call", id, method: "count" });
    await settle();
    expect(rpc.calls).toHaveLength(20);
    expect(charts.posted).toContainEqual({ ccb: "reply", id: 21, ok: false, value: "Too many calls; wait a moment." });
  });

  it("a frame taken away is not heard any more", async () => {
    const frames = broker();
    const rpc = host();
    const charts = frame();
    const unregister = registerPluginFrame(frames, rpc, { frame: charts.element, plugin: "charts" });
    unregister();
    send(charts.element, { ccb: "call", id: 1, method: "count" });
    await settle();
    expect(rpc.calls).toEqual([]);
  });
});
