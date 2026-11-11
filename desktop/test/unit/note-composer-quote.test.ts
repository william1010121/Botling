// @vitest-environment jsdom
// The Note's "ask about this block" (`ccb.composer.insertQuote`, botling.note 1.17.1): the frame asks the page to put a
// block into its own bot's input box. Only the bot the frame was opened for; any other answers { inserted: false }.
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type BotView } from "../../src/contract";
import { Client } from "../../src/renderer/client";
import { FrameBroker, registerPluginFrame } from "../../src/renderer/frame-broker";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import { panelPage } from "../../src/renderer/panel-page";
import { askChatToQuote, chatQuoteAnswered, setComposerQuoter } from "../../src/renderer/composer-quote";
import { parseFrameRequest } from "../../../Web/src/frame-protocol";
import { until } from "../helpers";

const BOT = "6A0B0000-0000-4000-8000-000000000030";
const OTHER = "6A0B0000-0000-4000-8000-000000000031";
const BOTS = [{ id: BOT, role: "manager", name: "Site" }, { id: OTHER, role: "manager", name: "Other" }] as BotView[];

function setup(bot?: string) {
  const client = new Client({ protocol: PROTOCOL_VERSION, subscribe() { return () => {}; }, post() {} });
  const element = document.createElement("iframe");
  document.body.append(element);
  const posted: any[] = [];
  element.contentWindow!.postMessage = ((message: unknown) => { posted.push(message); }) as Window["postMessage"];
  const broker = new FrameBroker(window, { name: "quote test broker" });
  registerPluginFrame(broker, pluginFrameHost({ client, components: () => ({}), bots: () => BOTS, ask: (_v, _a, done) => done(false) }), { frame: element, plugin: "botling.note", ...(bot ? { bot } : {}) });
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: element.contentWindow as MessageEventSource }));
  return { posted, send, broker };
}

let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; document.body.innerHTML = ""; });

describe("ccb.composer.insertQuote", () => {
  it("is a frame request of its own shape", () => {
    expect(parseFrameRequest({ ccb: "composerQuote", id: 1, text: "a block", botId: BOT, focus: true })).toEqual({ ccb: "composerQuote", id: 1, text: "a block", botId: BOT, focus: true });
    expect(parseFrameRequest({ ccb: "composerQuote", id: 1, text: "", botId: BOT, focus: true })).toBeNull();
    expect(parseFrameRequest({ ccb: "composerQuote", id: 1, text: "x", botId: BOT, focus: "yes" })).toBeNull();
    expect(parseFrameRequest({ ccb: "composerQuote", id: 1, text: "x", botId: BOT, focus: false, plugin: "x" })).toBeNull();
    expect(parseFrameRequest({ ccb: "composerQuote", id: 1, text: "x".repeat(200_001), botId: BOT, focus: false })).toBeNull();
  });

  it("puts the text into the frame's own bot's input box and answers { inserted: true }", async () => {
    const calls: unknown[][] = [];
    stop = setComposerQuoter(async (botId, text, focus) => { calls.push([botId, text, focus]); return true; });
    const { send, posted } = setup(BOT);
    send({ ccb: "composerQuote", id: 7, text: "> a block", botId: BOT, focus: true });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 7, ok: true, value: { inserted: true } }]);
    expect(calls).toEqual([[BOT, "> a block", true]]);
  });

  it("never writes into another bot's box, nor from a frame opened for no bot", async () => {
    const calls: unknown[] = [];
    stop = setComposerQuoter(async (...args) => { calls.push(args); return true; });
    const mine = setup(BOT);
    mine.send({ ccb: "composerQuote", id: 1, text: "x", botId: OTHER, focus: false });
    await until(() => mine.posted.length === 1);
    expect(mine.posted).toEqual([{ ccb: "reply", id: 1, ok: true, value: { inserted: false } }]);
    document.body.innerHTML = "";
    const none = setup();
    none.send({ ccb: "composerQuote", id: 2, text: "x", botId: BOT, focus: false });
    await until(() => none.posted.length === 1);
    expect(none.posted).toEqual([{ ccb: "reply", id: 2, ok: true, value: { inserted: false } }]);
    expect(calls).toEqual([]);
  });

  it("answers { inserted: false } when no input box can take it", async () => {
    const { send, posted } = setup(BOT);
    send({ ccb: "composerQuote", id: 3, text: "x", botId: BOT, focus: true });
    await until(() => posted.length === 1);
    expect(posted).toEqual([{ ccb: "reply", id: 3, ok: true, value: { inserted: false } }]);
    stop = setComposerQuoter(async () => false);
    send({ ccb: "composerQuote", id: 4, text: "x", botId: BOT, focus: true });
    await until(() => posted.length === 2);
    expect(posted[1]).toEqual({ ccb: "reply", id: 4, ok: true, value: { inserted: false } });
  });

  it("the panel page's ccb.composer has insertQuote, defaulting to the frame's bot", () => {
    const html = panelPage("botling.note", "botling.note.tab", "export function activate() {}", {}, undefined, { botId: BOT });
    expect(html).toContain('return ask({ ccb: "composerQuote", text: words, botId, focus: !!opts?.focus })');
    expect(html).toContain("words.length > 200000");
    expect(html).toContain("CONTEXT.botId");
  });
});

describe("the chat page's answer (askChatToQuote)", () => {
  it("asks the chat page once and resolves with its answer; no answer in time is not inserted", async () => {
    const posts: any[] = [];
    const first = askChatToQuote((message) => posts.push(message), BOT, "a block", true);
    expect(posts).toEqual([{ botling: "composerQuote", requestID: expect.any(Number), botID: BOT, text: "a block", focus: true }]);
    chatQuoteAnswered(posts[0].requestID + 1000, true);
    chatQuoteAnswered(posts[0].requestID, true);
    await expect(first).resolves.toBe(true);
    const second = askChatToQuote((message) => posts.push(message), BOT, "x", false);
    chatQuoteAnswered(posts[1].requestID, "yes");
    await expect(second).resolves.toBe(false);
    await expect(askChatToQuote(() => {}, BOT, "x", false, 10)).resolves.toBe(false);
  });
});
