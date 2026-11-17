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

const spec: PluginSpec = { name: manifest.name, version: manifest.version, source: "", styles: [], settings: {}, commands: [], builtIn: true };
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
  composer.update(stateOf(null));
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
// The page keeps a plugin's message hooks in module lists: unload it, or the next test would also hear this one's.
afterEach(async () => { await host.sync([], async () => (() => {}) as never); composer.view.destroy(); document.body.innerHTML = ""; setLanguage("en"); });

describe("what the chat page's state says", () => {
  it("reads the cards the program part published for this chat, and nothing that is not a list of cards", () => {
    expect(bookOf(stateOf(view(card("p-0001"))))!.pins).toHaveLength(1);
    expect(bookOf(stateOf(null))).toBeNull();
    expect(bookOf({ pluginData: { [PLUGIN]: { pins: "x" } } } as unknown as ChatState)).toBeNull();
    expect(bookOf({ pluginData: { [PLUGIN]: "x" } } as unknown as ChatState)).toBeNull();
    expect(bookOf({ pluginData: null } as unknown as ChatState)).toBeNull();
  });

  it("carries the away digest along with the cards, and keeps nothing of it that is not a digest", () => {
    const away = { from: 1, to: 2, collapsed: false, counts: { wait: 0, run: 0, done: 0 }, rows: [], others: [], othersMore: 0 };
    expect(bookOf(stateOf({ ...view(card("p-0001")), away } as never))!.away).toEqual(away);
    expect(bookOf(stateOf(view(card("p-0001"))))!.away).toBeUndefined();
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
    expect(slots.topArea.querySelector(".pt-card")).not.toBeNull();
  });

  it("does nothing more when the program part refuses (a full strip), and does not throw", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    const mine = messageElement(message(), {});
    mine.querySelector<HTMLButtonElement>(".pt-pin-msg")!.click();
    host.hostReply(calls()[0]!.callID, false, "最多釘 8 張");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slots.topArea.querySelector(".pt-card")).toBeNull();
  });
});

describe("the chip in the main input box (the card has no box of its own)", () => {
  const chipText = () => composer.root.querySelector(".composer-chips .pt-chip")?.textContent ?? null;
  const sends = () => sent.filter((action) => action.type === "send").map((action) => (action as { text: string }).text);

  it("opening a card puts 「回覆到 <card>」 in the input box, what is typed goes into that card ('@id words'), and the chip stays after the send", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    expect(chipText()).toBeNull();
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    expect(chipText()).toBe("Reply toDeploy");
    expect(slots.topArea.querySelector("input, textarea, form")).toBeNull();
    type("先停一下");
    composer.submit();
    expect(sends()).toEqual(["@p-0001 先停一下"]);
    expect(chipText()).toBe("Reply toDeploy");
    // an empty box sends nothing
    composer.submit();
    expect(sends()).toHaveLength(1);
  });

  it("the ✕ of the chip, Esc, and a press on the chat's empty space each leave the card and take the chip away; then a message goes as typed", () => {
    const scroller = document.createElement("main");
    scroller.id = "scroller";
    document.body.append(scroller);
    host.chatState(stateOf(view(card("p-0001"))));
    const open = () => slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    open();
    composer.root.querySelector<HTMLButtonElement>(".pt-chip-x")!.click();
    expect(chipText()).toBeNull();
    expect(slots.topArea.querySelector(".pt-card")).toBeNull();
    open();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(chipText()).toBeNull();
    open();
    scroller.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(chipText()).toBeNull();
    expect(slots.topArea.querySelector(".pt-card")).toBeNull();
    type("hello");
    composer.submit();
    expect(sends()).toEqual(["hello"]);
  });

  it("switching from card A to card B leaves one chip (B's), and what is typed goes to B", () => {
    host.chatState(stateOf(view(card("p-0001"), card("p-0002", { title: "Docs", handle: "Docs" }))));
    const rowOf = (id: string) => slots.topArea.querySelector<HTMLButtonElement>(`.pt-row[data-pin="${id}"]`)!;
    rowOf("p-0001").click();
    rowOf("p-0002").click();
    expect([...composer.root.querySelectorAll(".pt-chip")].map((node) => node.textContent)).toEqual(["Reply toDocs"]);
    expect(composer.chipsHere()).toHaveLength(1);
    type("hello");
    composer.submit();
    expect(sends()).toEqual(["@p-0002 hello"]);
  });

  it("a message that starts with an @ keeps the card the user picked, not the chip's", () => {
    host.chatState(stateOf(view(card("p-0001"), card("p-0002", { title: "Docs", handle: "Docs" }))));
    slots.topArea.querySelector<HTMLButtonElement>('.pt-row[data-pin="p-0001"]')!.click();
    type("@Docs hello");
    composer.submit();
    expect(sends()).toEqual(["@Docs hello"]);
  });

  it("opening a card puts the caret in the input box (not on a phone)", () => {
    const focus = vi.spyOn(composer.view, "focus");
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    expect(focus).toHaveBeenCalledTimes(1);
    const media = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query === "(hover: none) and (pointer: coarse)", media: query })) as never;
    try {
      composer.root.querySelector<HTMLButtonElement>(".pt-chip-x")!.click();
      slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
      expect(focus).toHaveBeenCalledTimes(1);
    } finally { window.matchMedia = media; }
  });

  it("a plugin's chip whose prefix() throws does not break the send: the words go as typed", async () => {
    const bad: PluginSpec = { ...spec, name: "test.thrower" };
    await host.sync([spec, bad], async (item) => (item.name === bad.name
      ? ((ccb: Parameters<typeof activate>[0]) => { ccb.composer.chips.add({ standing: true, prefix: () => { throw new Error("no prefix"); }, serialize: () => "", render: () => document.createElement("span") }); }) as never
      : activate));
    expect(composer.chipsHere()).toHaveLength(1);
    type("hello");
    composer.submit();
    expect(sends()).toEqual(["hello"]);
    expect(sent.some((action) => action.type === "pluginError" && (action as unknown as { name: string }).name === "test.thrower")).toBe(true);
  });

  it("Esc closes the input box's @ list first and leaves the card and its chip; the next Esc folds the card", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    type("@");
    const list = document.querySelector<HTMLElement>(".mention-list")!;
    expect(list.hidden).toBe(false);
    const esc = () => composer.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    esc();
    expect(list.hidden).toBe(true);
    expect(slots.topArea.querySelector(".pt-card")).not.toBeNull();
    expect(chipText()).toBe("Reply toDeploy");
    esc();
    expect(slots.topArea.querySelector(".pt-card")).toBeNull();
    expect(chipText()).toBeNull();
  });

  it("another chat has no chip, and the chip speaks the page's language", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    host.chatState(stateOf(view(card("p-0001")), "B2"));
    expect(chipText()).toBeNull();
    setLanguage("zh-Hant");
    host.chatState(stateOf(view(card("p-0001")), "B2"));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    expect(chipText()).toBe("回覆到Deploy");
    expect(composer.root.querySelector(".pt-chip-x")!.getAttribute("aria-label")).toBe("離開這張卡（Esc）");
  });
});

describe("unloading the plugin", () => {
  it("takes the list, the card, the chip, the @ rows, the bubble and the button away", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-row")!.click();
    expect(slots.topArea.querySelector(".pt-card")).not.toBeNull();
    await host.sync([], async () => (() => {}) as never);
    expect(slots.topArea.querySelector(".pt-strip")).toBeNull();
    expect(slots.topArea.querySelector(".pt-card")).toBeNull();
    expect(composer.root.querySelector(".pt-chip")).toBeNull();
    type("@de");
    expect(names()).toEqual([]);
    expect(messageElement(message(), {}).querySelector(".pt-pin-msg")).toBeNull();
    expect(messageElement(message({ text: M.askText({ id: "p-0001", title: "Deploy" } as M.Pin, "x") }), {}).querySelector(".user-bubble")!.textContent).toContain("〔Pin");
  });
});

describe("the cards' note on a plain message", () => {
  it("is not the user's: the bubble shows their words only, and a message written into a card still shows '@title words'", () => {
    const withNote = M.withBriefing("部署好了嗎", `${M.BRIEF}\np-0001「Deploy」進行中 · building`);
    const row = messageElement(message({ text: withNote }), {});
    expect(row.querySelector(".user-bubble")!.textContent).toBe("部署好了嗎");
    expect(row.querySelector(".user-bubble")!.textContent).not.toContain("Pin");
    const asked = M.askText({ id: "p-0001", title: "Deploy" } as M.Pin, "好了嗎");
    expect(messageElement(message({ text: asked }), {}).querySelector(".user-bubble")!.textContent).toBe("@Deploy 好了嗎");
  });
});

describe("where a line the bot moved went", () => {
  const trace = (over: Record<string, unknown> = {}) => ({ plugin: PLUGIN, key: "mv-r1", fold: ["u1"], data: { kind: "moved", rid: "r1", pin: "p-0001", title: "Deploy", q: "部署好了嗎", by: "bot", ...over } });
  const draw = (...decorations: unknown[]) => {
    const list = document.createElement("div");
    const rows = new Map<string, HTMLElement>();
    for (const id of ["u0", "u1", "u2"]) { const row = document.createElement("div"); row.dataset.id = id; list.append(row); rows.set(id, row); }
    document.body.append(list);
    host.decorations.update({ ...stateOf(view(card("p-0001"), card("p-0002", { title: "Docs", handle: "Docs" }))), decorations } as never, (id) => rows.get(id) ?? null);
    return { list, rows };
  };

  it("draws one line in place of the user's line, and folds that line behind it", () => {
    host.chatState(stateOf(view(card("p-0001"), card("p-0002", { title: "Docs", handle: "Docs" }))));
    const { list, rows } = draw(trace());
    const line = list.querySelector<HTMLElement>(".decoration-extra .pt-mv")!;
    expect(line.textContent).toContain("Deploy");
    expect(rows.get("u1")!.classList.contains("decoration-folded")).toBe(true);
    expect(rows.get("u0")!.classList.contains("decoration-folded")).toBe(false);
    expect(list.children[1]!.classList.contains("decoration-extra")).toBe(true);
  });

  it("its buttons call the program part for this chat's bot: 移回聊天 and 改到…", async () => {
    host.chatState(stateOf(view(card("p-0001"), card("p-0002", { title: "Docs", handle: "Docs" }))));
    const { list } = draw(trace());
    const [back, other] = [...list.querySelectorAll<HTMLButtonElement>(".pt-mv-act")];
    back!.click();
    expect(calls().map((call) => [call.plugin, call.method, call.params])).toEqual([[PLUGIN, "moveBack", { botId: "B1", rid: "r1" }]]);
    host.hostReply(calls()[0]!.callID, true, { unchanged: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    other!.click();
    list.querySelector<HTMLButtonElement>(".pt-mv-alt")!.click();
    expect(calls().map((call) => call.method)).toEqual(["moveBack", "moveTo"]);
    expect(calls()[1]!.params).toEqual({ botId: "B1", rid: "r1", to: "p-0002" });
  });

  it("draws nothing for data that is not a trace, and the answer under the line once it is back in the chat", () => {
    host.chatState(stateOf(view(card("p-0001"))));
    const bad = draw({ plugin: PLUGIN, key: "x", fold: ["u1"], data: { kind: "other" } }, { plugin: PLUGIN, key: "y", fold: ["u2"] });
    expect(bad.list.querySelector(".pt-mv")).toBeNull();
    const back = draw({ plugin: PLUGIN, key: "mv-r1", after: "u1", data: { kind: "back", rid: "r1", pin: "p-0001", title: "Deploy", q: "x", by: "bot", a: "還沒好" } });
    expect(back.list.querySelector(".pt-mv-ans")!.textContent).toBe("bot：還沒好");
  });

  it("is taken away with the plugin", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    const { list } = draw(trace());
    expect(list.querySelector(".pt-mv")).not.toBeNull();
    await host.sync([], async () => (() => {}) as never);
    host.decorations.redraw();
    expect(list.querySelector(".pt-mv")).toBeNull();
  });
});

describe("「你不在時」 in the page", () => {
  const away = {
    from: 1_000, to: 4_000_000, collapsed: false, counts: { wait: 0, run: 0, done: 0 }, rows: [], othersMore: 0,
    others: [{ botId: "B2", name: "DAFAWU", text: "選一個版本", more: 0, messageId: "q9" }],
  };
  const touches = () => calls().filter((call) => call.method === "touch");
  const activity = (type: string) => window.dispatchEvent(new Event(type, { bubbles: true }));

  it("says the page is being used, once a minute at most, for the chat that is open, and not while the page is hidden", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(10_000_000);
      activity("pointermove");
      expect(touches()).toHaveLength(0);
      host.chatState(stateOf(view(card("p-0001"))));
      activity("pointermove");
      activity("keydown");
      activity("wheel");
      expect(touches().map((call) => [call.plugin, call.params])).toEqual([[PLUGIN, { botId: "B1" }]]);
      vi.setSystemTime(10_000_000 + 59_000);
      activity("pointerdown");
      expect(touches()).toHaveLength(1);
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      vi.setSystemTime(10_000_000 + 61_000);
      activity("focus");
      expect(touches()).toHaveLength(1);
      visibility.mockRestore();
      activity("focus");
      expect(touches()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("stops listening when the plugin is unloaded", async () => {
    host.chatState(stateOf(view(card("p-0001"))));
    await host.sync([], async () => (() => {}) as never);
    activity("pointerdown");
    expect(touches()).toHaveLength(0);
  });

  it("draws the digest above the strip, a click on another bot's line goes to that chat (the page's openChat), and a card's row opens the card", () => {
    host.chatState(stateOf({ ...view(card("p-0001")), away } as never));
    const line = slots.topArea.querySelector<HTMLElement>(".pt-digest .pt-orow")!;
    line.click();
    expect(sent.filter((action) => action.type === "openChat")).toEqual([{ type: "openChat", botID: "B2", messageID: "q9" }]);
    host.chatState(stateOf({ ...view(card("p-0001")), away: { ...away, rows: [{ id: "p-0001", title: "Deploy", state: "run", status: "building", source: "user", at: 5_000 }], counts: { wait: 0, run: 1, done: 0 } } } as never));
    slots.topArea.querySelector<HTMLElement>(".pt-drow")!.click();
    expect(slots.topArea.querySelector(".pt-card")).not.toBeNull();
  });

  it("看完了 asks the program part to fold it for this chat's bot", () => {
    host.chatState(stateOf({ ...view(card("p-0001")), away } as never));
    slots.topArea.querySelector<HTMLButtonElement>(".pt-d-close")!.click();
    expect(calls().filter((call) => call.method === "collapse").map((call) => call.params)).toEqual([{ botId: "B1", collapsed: true }]);
  });
});
