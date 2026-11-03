// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import { messageElement } from "../../../../Web/src/messages";
import { PluginHost, type PluginSpec } from "../../../../Web/src/plugins";
import { setWindowVisible } from "../../../../Web/src/visible";
import type { ChatState, ComponentInfo, DisplayView, MessageView, PinView } from "../../../../Web/src/types";
import manifest from "../package.json";
import { activate } from "../src/web";
import { reportVisiblePins } from "../src/visible";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

// The plugin as the chat page loads it: a PluginHost lends the page's slots and kit, and the Board's pieces appear and go with it.
const spec: PluginSpec = { name: manifest.name, version: manifest.version, source: "", styles: [], settings: {}, commands: [], builtIn: true };
const components: Record<string, ComponentInfo> = { cpu: { template: "<pre></pre>", version: 1, working: false, updated: false, hasPrevious: false } };
const pin: PinView = {
  id: "P1", name: "cpu", headline: "10%", chip: { text: "10%", tone: "neutral" }, size: "2x2", refresh: "manual", minutes: 15,
  display: { name: "cpu", data: "{}" },
};
const state = (extra: Partial<ChatState> = {}): ChatState => ({
  botID: "b1", botName: "Bot", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [],
  components, pins: [pin], pinChoices: [], board: false, ...extra,
});
const message = (display: DisplayView): MessageView => ({
  id: "m1", role: "bot", text: "", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, displays: [display],
  attachments: null, replyTo: null, replyPreview: null, openable: false,
});

let host: PluginHost;
let redraws = 0;

beforeEach(async () => {
  sent.length = 0;
  redraws = 0;
  document.body.className = "";
  document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
  host = new PluginHost({
    composer: {} as never,
    redraw: () => { redraws++; },
    slots: { pinArea: document.getElementById("pin-area")!, board: document.getElementById("board")!, overlay: document.body },
  });
  await host.sync([spec], async () => activate);
});
afterEach(() => { host.unload(manifest.name); setWindowVisible(true); });

describe("who may use the page's own parts", () => {
  it("a plugin that does not ship with Botling gets neither ccb.page nor the message bars: it fails and is unloaded", async () => {
    host.unload(manifest.name);
    const used: string[] = [];
    for (const use of [(ccb: Parameters<typeof activate>[0]) => ccb.page, (ccb: Parameters<typeof activate>[0]) => ccb.messages.cardBar(() => null), (ccb: Parameters<typeof activate>[0]) => ccb.messages.specButton(() => null)]) {
      sent.length = 0;
      await host.sync([{ ...spec, name: "outside", builtIn: undefined }], async () => (ccb) => { use(ccb); used.push("ran"); });
      expect(sent.some((action) => action.type === "pluginError" && String((action as { message?: string }).message).includes("ship with Botling")), String(use)).toBe(true);
      expect(host.isLoaded("outside")).toBe(false);
    }
    expect(used).toEqual([]);
  });
});

describe("botling.board loaded into the chat page", () => {
  it("draws the pins of each state in the slots the page gave it", () => {
    host.chatState(state());
    expect(document.querySelectorAll("#pin-area .pin-chip:not(.add)")).toHaveLength(1);
    host.chatState(state({ board: true }));
    expect(document.body.classList.contains("board")).toBe(true);
    expect(document.querySelectorAll("#board .board-card")).toHaveLength(1);
  });

  it("is given the state the page last drew when it loads after it", async () => {
    host.unload(manifest.name);
    host.chatState(state());
    expect(document.querySelectorAll(".pin-chip:not(.add)")).toHaveLength(0);
    await host.sync([spec], async () => activate);
    expect(document.querySelectorAll("#pin-area .pin-chip:not(.add)")).toHaveLength(1);
  });

  it("puts its bar on a component in a reply, only in a chat that can pin", () => {
    expect(messageElement(message({ name: "cpu", data: "{}", pinned: false }), components).querySelector(".pin-holder > .pin-bar")).not.toBeNull();
    expect(messageElement(message({ name: "cpu", data: "{}" }), components).querySelector(".pin-bar")).toBeNull();
  });

  it("tells the app which pins are seen when the window is hidden", () => {
    host.chatState(state());
    document.querySelector<HTMLElement>(".pin-chip:not(.add)")!.getBoundingClientRect = () => ({ top: 10, bottom: 40, left: 0, right: 80, width: 80, height: 30, x: 0, y: 10, toJSON() {} }) as DOMRect;
    reportVisiblePins();
    expect(sent).toContainEqual({ type: "pinsVisible", ids: ["P1"] });
    sent.length = 0;
    setWindowVisible(false);
    expect(sent).toContainEqual({ type: "pinsVisible", ids: [] });
  });

  it("leaves nothing behind when it unloads: no chips, no Board, no bar, no floating layer", () => {
    host.chatState(state({ board: true, floating: [{ botID: "b1", botName: "Bot", pin: { ...pin, float: { corner: "topRight", collapsed: false } } }] }));
    expect(document.querySelector(".float-layer")).not.toBeNull();
    host.unload(manifest.name);
    expect(document.querySelector("#pin-area")!.children).toHaveLength(0);
    expect(document.querySelector("#board")!.children).toHaveLength(0);
    expect(document.querySelector(".float-layer")).toBeNull();
    expect(document.body.classList.contains("board")).toBe(false);
    expect(messageElement(message({ name: "cpu", data: "{}", pinned: false }), components).querySelector(".pin-bar")).toBeNull();
    expect(redraws).toBeGreaterThan(0);
  });
});
