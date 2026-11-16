// @vitest-environment jsdom
// The page part (src/web.ts) loaded by the chat page's own PluginHost, as Botling loads it: the strip in the page's top slot, the cards in the
// main input box's "@" list, the bubble of a message written into a card, and the 釘選 button on messages.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../../../../Web/src/bridge";
import { setLanguage } from "../../../../Web/src/i18n";
import { Composer } from "../../../../Web/src/composer";
import { messageElement } from "../../../../Web/src/messages";
import { PluginHost, type PluginSpec } from "../../../../Web/src/plugins";
import type { ChatState, MessageView } from "../../../../Web/src/types";
import manifest from "../package.json";
import * as M from "../src/model";
import { PLUGIN, activate, bookOf } from "../src/web";

const spec: PluginSpec = { name: manifest.name, version: manifest.version, source: "", styles: [], settings: {}, commands: [] };
let host: PluginHost;
let composer: Composer;
let slots: { pinArea: HTMLElement; topArea: HTMLElement; overlay: HTMLElement };

const card = (id: string, over: Partial<M.PinView> = {}): M.PinView => ({
  id, title: "Deploy", handle: "Deploy", origin: "user", state: "run", status: "building", source: "user", unread: false, thread: [],
  updates: [{ at: 1, state: "run", status: "building", source: "user" }], createdAt: 1, updatedAt: 1, ...over,
});
const stateOf = (view: M.BookView | null, botID = "B1"): ChatState =>
  ({ botID, botName: botID, messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components: {}, ...(view ? { pluginData: { [PLUGIN]: view } } : {}) }) as unknown as ChatState;
const view = (...pins: M.PinView[]): M.BookView => ({ v: 1, pins });
const message = (extra: Partial<MessageView> = {}): MessageView =>
  ({ id: "m1", role: "user", text: "Hello", stamp: null, avatar: null, choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false, reactionEnabled: false, ...extra }) as MessageView;
const calls = () => sent.filter((action) => action.type === "hostCall") as unknown as { plugin: string; method: string; params: Record<string, unknown>; callID: number }[];
const type = (text: string) => { composer.setText(text); composer.view.dispatch({ selection: { anchor: text.length } }); };
const names = () => [...document.querySelectorAll(".mention-list .mention-name")].map((node) => node.textContent);

beforeEach(async () => {
  document.body.innerHTML = "";
  sent.length = 0;
  slots = { pinArea: document.createElement("div"), topArea: document.createElement("div"), overlay: document.createElement("div") };
  const composerSlot = document.createElement("div");
  document.body.append(slots.topArea, slots.pinArea, composerSlot, slots.overlay);
  composer = new Composer(composerSlot);
  host = new PluginHost({
    composer: {
      element: composer.root, view: composer.view, getText: () => composer.text, insert: (text) => composer.insert(text), addExtension: (extension) => composer.addExtension(extension),
      showPopover: (content) => composer.showPopover(content), mentionSource: (source) => composer.addMentionSource(source), chips: { add: (chip) => composer.addChip(chip), list: () => composer.chipsHere() },
    },
    redraw: () => {},
    slots,
  });
  await host.sync([spec], async () => activate as never);
});
afterEach(() => { composer.view.destroy(); document.body.innerHTML = ""; setLanguage("en"); });

describe("what the chat page's state says", () => {
  it("reads the cards the program part published for this chat, and nothing that is not a list of cards", () => {
    expect(bookOf(stateOf(view(card("p-0001"))))!.pins).toHaveLength(1);
    expect(bookOf(stateOf(null))).toBeNull();
    expect(bookOf({ pluginData: { [PLUGIN]: { pins: "x" } } } as unknown as ChatState)).toBeNull();
    expect(bookOf({ pluginData: { [PLUGIN]: "x" } } as unknown as ChatState)).toBeNull();
    expect(bookOf({ pluginData: null } as unknown as ChatState)).toBeNull();
  });

  it("draws the strip in the page's top slot, and an empty chat takes no room", () => {
    host.chatState(stateOf(view()));
    expect(slots.topArea.querySelector<HTMLElement>(".pt-strip")!.hidden).toBe(true);
    host.chatState(stateOf(view(card("p-0001"), card("p-0002", { title: "Docs", handle: "Docs" }))));
    expect([...slots.topArea.querySelectorAll(".pt-row .pt-title")].map((node) => node.textContent)).toEqual(["Deploy", "Docs"]);
    expect(slots.pinArea.children).toHaveLength(0);
  });

  it("asks the program part for a chat's cards when the page has none for it, once in 3 seconds", () => {
    vi.useFakeTimers();
    try {
      host.chatState(stateOf(null));
      host.chatState(stateOf(null));
      expect(calls().map((call) => [call.plugin, call.method, call.params])).toEqual([[PLUGIN, "view", { botId: "B1" }]]);
      host.chatState(stateOf(null, "B2"));
      expect(calls()).toHaveLength(2);
      vi.advanceTimersByTime(3_000);
      host.chatState(stateOf(null));
      expect(calls()).toHaveLength(3);
      host.chatState(stateOf(view(card("p-0001"))));
      host.chatState(stateOf(null));
      expect(calls()).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });

  it("draws another chat's cards, not the last chat's", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    host.chatState(stateOf(view(card("p-0001", { title: "Other bot's", handle: "Other" })), "B2"));
    expect([...slots.topArea.querySelectorAll(".pt-title")].map((node) => node.textContent)).toEqual(["Other bot's"]);
  });
});

describe("@ in the main input box", () => {
  it("lists the cards of this chat, and Return writes '@handle ' into the box", () => {
    host.chatState(stateOf(view(card("p-0001", { handle: "Deploy", state: "wait", status: "要重跑嗎？" }))));
    type("@de");
    expect(names()).toEqual(["@Deploy"]);
    expect(document.querySelector(".mention-list .mention-hint")!.textContent).toBe("Waiting for you · 要重跑嗎？");
    composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(composer.text).toBe("@Deploy ");
  });

  it("offers nothing in a chat with no cards, and no row for a name that is not a card's", () => {
    host.chatState(stateOf(view()));
    type("@de");
    expect(names()).toEqual([]);
    host.chatState(stateOf(view(card("p-0001"))));
    type("@xyz");
    expect(names()).toEqual([]);
  });
});

describe("a message written into a card", () => {
  it("shows '@title words' in your bubble, not the header the bot got, and leaves any other text alone", () => {
    const asked = M.askText({ id: "p-0001", title: "Deploy" } as M.Pin, "是否可以\n繼續？");
    const row = messageElement(message({ text: asked }), {});
    expect(row.querySelector(".user-bubble")!.textContent).toBe("@Deploy 是否可以繼續？");
    expect(row.querySelector(".user-bubble")!.innerHTML).toBe("@Deploy 是否可以<br>繼續？");
    expect(messageElement(message({ text: "〔Pin p-0001 · Deploy〕\nno footer" }), {}).querySelector(".user-bubble")!.textContent).toBe("〔Pin p-0001 · Deploy〕no footer");
    expect(messageElement(message({ text: "plain" }), {}).querySelector(".user-bubble")!.textContent).toBe("plain");
  });
});

describe("釘選 on a message", () => {
  it("is a button on your message and on a bot's reply, once each, not on one with no words or on a message written into a card", () => {
    host.chatState(stateOf(view()));
    const mine = messageElement(message(), {});
    const reply = messageElement(message({ id: "m2", role: "bot", text: "Done." }), {});
    expect(mine.querySelectorAll(".pt-pin-msg")).toHaveLength(1);
    expect(reply.querySelectorAll(".pt-pin-msg")).toHaveLength(1);
    expect(reply.querySelector(".pt-pin-msg")!.getAttribute("aria-label")).toBe("Pin");
    expect(messageElement(message({ id: "m3", text: "  " }), {}).querySelector(".pt-pin-msg")).toBeNull();
    expect(messageElement(message({ id: "m4", text: M.askText({ id: "p-0001", title: "T" } as M.Pin, "x") }), {}).querySelector(".pt-pin-msg")).toBeNull();
  });

  it("asks the program part to pin that message for this chat's bot, and opens the card it made", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    const reply = messageElement(message({ id: "m2", role: "bot", text: "## Plan\nsteps" }), {});
    document.body.append(reply);
    reply.querySelector<HTMLButtonElement>(".pt-pin-msg")!.click();
    const [call] = calls();
    expect([call!.plugin, call!.method, call!.params]).toEqual([PLUGIN, "pinMessage", { botId: "B1", messageId: "m2", text: "## Plan\nsteps" }]);
    host.hostReply(call!.callID, true, { id: "p-0001" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slots.overlay.querySelector(".pt-panel")).not.toBeNull();
  });

  it("does nothing more when the program part refuses (a full strip), and does not throw", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    const mine = messageElement(message(), {});
    mine.querySelector<HTMLButtonElement>(".pt-pin-msg")!.click();
    host.hostReply(calls()[0]!.callID, false, "最多釘 8 張");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slots.overlay.querySelector(".pt-panel")).toBeNull();
  });
});

describe("the card's own input box", () => {
  it("sends '@handle words' as an ordinary message of the chat's bot", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    const input = slots.overlay.querySelector<HTMLInputElement>(".pt-input")!;
    input.value = "先停一下";
    slots.overlay.querySelector<HTMLFormElement>(".pt-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(sent.filter((action) => action.type === "send")).toEqual([{ type: "send", text: "@Deploy 先停一下" }]);
  });

  it("speaks the page's language, and changes with it", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    const input = () => slots.overlay.querySelector<HTMLInputElement>(".pt-input")!;
    expect(input().placeholder).toBe("Say something to “Deploy”…");
    setLanguage("zh-Hant");
    host.chatState(stateOf(view(card("p-0001"))));
    expect(input().placeholder).toBe("對「Deploy」說…");
  });
});

describe("unloading the plugin", () => {
  it("takes the strip, the panel, the @ rows, the bubble and the button away", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    expect(slots.overlay.querySelector(".pt-panel")).not.toBeNull();
    await host.sync([], async () => (() => {}) as never);
    expect(slots.topArea.querySelector(".pt-strip")).toBeNull();
    expect(slots.overlay.querySelector(".pt-panel")).toBeNull();
    type("@de");
    expect(names()).toEqual([]);
    expect(messageElement(message(), {}).querySelector(".pt-pin-msg")).toBeNull();
    expect(messageElement(message({ text: M.askText({ id: "p-0001", title: "Deploy" } as M.Pin, "x") }), {}).querySelector(".user-bubble")!.textContent).toContain("〔Pin");
  });
});
