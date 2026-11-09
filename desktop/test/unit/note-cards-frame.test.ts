// @vitest-environment jsdom
// The Note tab's live cards on the app page (jsdom): a plugin frame asks for a component drawn as in a chat reply
// (`ccb.card`) and for a picture of part of itself kept in the note (`ccb.snapshot`, "freeze to image"). The page
// clips the picture to the frame that asked; main takes it, never the frame.
import { afterEach, describe, expect, it } from "vitest";
import { Command, MAIN_COMMANDS, PROTOCOL_VERSION, RENDERER_COMMANDS, type BotView, type ComponentInfoView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost, TILE_DATA_MAX } from "../../src/renderer/plugin-frame-host";
import { panelPage } from "../../src/renderer/panel-page";
import { parseFrameRequest } from "../../../Web/src/frame-protocol";
import { until } from "../helpers";

const BOT = "6A0B0000-0000-4000-8000-000000000020";
const COMPONENTS: Record<string, ComponentInfoView> = {
  chart: { template: "<div id=chart-template></div>", version: 1, updated: false, sizes: ["2x2", "4x2"] } as ComponentInfoView,
  plain: { template: "<div id=plain-template></div>", version: 1, updated: false } as ComponentInfoView,
};
const BOTS = [{ id: BOT, role: "manager", name: "Site" }] as BotView[];

function fakeCore() {
  const sent: any[] = [];
  let receive: (value: unknown) => void = () => {};
  const answer = (cmd: any) => {
    switch (cmd.type) {
      case "card.page": return { ok: true, result: { url: `botling-card://page/${"b".repeat(36)}` } };
      case "plugins.tileImages": return { ok: true, result: { images: JSON.parse(cmd.data)?.image ? { [JSON.parse(cmd.data).image]: "botling-card://image/abc" } : {} } };
      case "plugins.noteSnapshot": return { ok: true, result: { ref: "note-assets/0123.png", url: "botling-card://image/def" } };
      default: return { ok: false, error: { code: "not_found", message: cmd.type } };
    }
  };
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe(listener) { receive = listener; return () => {}; }, post(envelope: any) {
    sent.push(envelope.cmd);
    queueMicrotask(() => receive({ v: PROTOCOL_VERSION, id: envelope.id, ...answer(envelope.cmd) }));
  } });
  return { client, sent };
}

function setup() {
  const core = fakeCore();
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: any[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  // Where the frame sits on the page (jsdom lays nothing out).
  element.getBoundingClientRect = () => ({ left: 100, top: 50, width: 600, height: 400, right: 700, bottom: 450, x: 100, y: 50, toJSON() {} }) as DOMRect;
  const broker = new FrameBroker(window, { name: "note test broker" });
  registerPluginFrame(broker, pluginFrameHost({ client: core.client, components: () => COMPONENTS, bots: () => BOTS, ask: (_v, _a, done) => done(false) }), { frame: element, plugin: "botling.note" });
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: element.contentWindow as MessageEventSource }));
  return { ...core, posted, send, broker };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("ccb.card: a component as in a chat reply, for the Note tab", () => {
  it("is drawn on a card page main serves, on the chat surface at its widest size, its pictures found by the core", async () => {
    const { send, posted, sent, broker } = setup();
    send({ ccb: "card", id: 1, component: "chart", data: { points: [1, 2], image: "plot.png" }, botId: BOT });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 1, ok: true, value: `botling-card://page/${"b".repeat(36)}` }]);
    expect(sent.map((cmd) => cmd.type)).toEqual(["plugins.tileImages", "card.page"]);
    expect(sent[0]).toEqual({ type: "plugins.tileImages", name: "botling.note", botId: BOT, data: '{"points":[1,2],"image":"plot.png"}' });
    for (const cmd of sent) expect(Command.safeParse(cmd).success).toBe(true);
    const html: string = sent[1].html;
    expect(sent[1]).not.toHaveProperty("panel");
    expect(html).toContain("<div id=chart-template></div>");
    expect(html).toContain("botling-card://image/abc");
    // As in a chat reply: as tall as its content (no data-fill), its widest size.
    expect(html).toContain('data-size="4x2" data-surface="chat">');
    send({ ccb: "card", id: 2, component: "plain", data: null, botId: BOT });
    send({ ccb: "card", id: 3, component: "nope", data: null, botId: BOT });
    send({ ccb: "card", id: 4, component: "plain", data: null, botId: "6A0B0000-0000-4000-8000-0000000000FF" });
    send({ ccb: "card", id: 5, component: "plain", data: "x".repeat(TILE_DATA_MAX), botId: BOT });
    send({ ccb: "card", id: 6, component: "plain", data: null, botId: BOT, extra: 1 });
    await until(() => posted.length === 5);
    expect(posted.slice(1).sort((a, b) => a.id - b.id)).toEqual([
      { ccb: "reply", id: 2, ok: true, value: expect.any(String) },
      { ccb: "reply", id: 3, ok: false, value: 'No component "nope" in the library.' },
      { ccb: "reply", id: 4, ok: false, value: "No such bot." },
      { ccb: "reply", id: 5, ok: false, value: "The card's data is too big." },
    ]);
    expect(sent[3].html).toContain('data-size="2x2" data-surface="chat">');
    expect(broker.refusals.map((refusal) => refusal.reason)).toEqual(["a message that is not a valid ccb call (card)"]);
  });
});

describe("ccb.snapshot: freeze a card to a picture in the note", () => {
  it("asks main for that part of the window, clipped to the frame that asked; main adds the picture, never the page", async () => {
    const { send, posted, sent } = setup();
    send({ ccb: "snapshot", id: 1, botId: BOT, rect: { x: 20, y: 30, width: 300, height: 120 } });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 1, ok: true, value: { ref: "note-assets/0123.png", url: "botling-card://image/def" } }]);
    expect(sent).toEqual([{ type: "plugins.noteSnapshot", name: "botling.note", botId: BOT, rect: { x: 120, y: 80, width: 300, height: 120 } }]);
    expect(Command.safeParse(sent[0]).success).toBe(true);
    // Past the frame's edges: only the frame's own part.
    send({ ccb: "snapshot", id: 2, botId: BOT, rect: { x: -50, y: 350, width: 2000, height: 500 } });
    await until(() => posted.length === 2);
    expect(sent[1].rect).toEqual({ x: 100, y: 400, width: 600, height: 50 });
    // Wholly outside: nothing is taken.
    send({ ccb: "snapshot", id: 3, botId: BOT, rect: { x: 700, y: 0, width: 50, height: 50 } });
    await until(() => posted.length === 3);
    expect(posted[2]).toEqual({ ccb: "reply", id: 3, ok: false, value: "That part of the frame is not on screen." });
    expect(sent).toHaveLength(2);
    // The command is main's: the renderer may send it, main takes the picture before the core sees it.
    expect(RENDERER_COMMANDS.has("plugins.noteSnapshot")).toBe(true);
    expect(MAIN_COMMANDS.has("plugins.noteSnapshot")).toBe(true);
  });

  it("only a well-formed rect is a request", () => {
    expect(parseFrameRequest({ ccb: "snapshot", id: 1, botId: BOT, rect: { x: 0, y: 0, width: 10, height: 10 } })).toEqual({ ccb: "snapshot", id: 1, botId: BOT, rect: { x: 0, y: 0, width: 10, height: 10 } });
    for (const rect of [null, [], { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 0, width: 10, height: 10, z: 1 }, { x: "0", y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10_001, height: 10 }]) {
      expect(parseFrameRequest({ ccb: "snapshot", id: 1, botId: BOT, rect })).toBeNull();
    }
  });

  it("the panel page's ccb has card and snapshot, as asks", () => {
    const html = panelPage("botling.note", "botling.note.tab", "export function activate() {}", {});
    expect(html).toContain('card: (spec) => ask({ ccb: "card"');
    expect(html).toContain('snapshot: (spec) => ask({ ccb: "snapshot"');
  });
});
