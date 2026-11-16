// @vitest-environment jsdom
// What the page draws (src/ui.ts) in jsdom with fakes: the strip, the panel a row opens, the keys, the done-card auto-unpin with 釘回,
// the send guard and the "@" rows. Nothing here opens a window or takes the real focus.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinView } from "../src/model";
import { PinUi, barsOf, tagKey } from "../src/ui";
import { wordsFor } from "../src/words";

let clock = 5_000_000;
let ui: PinUi;
let top: HTMLElement;
let overlay: HTMLElement;
const failing = new Set<string>();
const call = vi.fn(async (method: string, _params: Record<string, unknown>) => {
  if (failing.has(method)) throw new Error(`${method} failed`);
  return {};
});
const send = vi.fn();
let motion = true;

const pin = (id: string, over: Partial<PinView> = {}): PinView => ({
  id, title: `Title ${id}`, handle: `Handle-${id}`, origin: "bot", state: "run", status: `status of ${id}`, source: "bot", unread: false, thread: [], updates: [{ at: clock, state: "run", status: "first", source: "bot" }],
  createdAt: clock, updatedAt: clock, ...over,
});
const view = (...pins: PinView[]) => ({ v: 1 as const, pins });
const rows = () => [...top.querySelectorAll<HTMLElement>(".pt-row")];
const panel = () => overlay.querySelector<HTMLElement>(".pt-panel");
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const submit = (text: string) => {
  const input = overlay.querySelector<HTMLInputElement>(".pt-input")!;
  input.value = text;
  overlay.querySelector<HTMLFormElement>(".pt-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  top = document.createElement("div");
  overlay = document.createElement("div");
  document.body.append(top, overlay);
  clock = 5_000_000;
  motion = true;
  failing.clear();
  call.mockClear();
  send.mockClear();
  ui = new PinUi(top, overlay, { call, send, words: wordsFor(() => "zh-Hant"), now: () => clock, reduceMotion: () => motion });
});
afterEach(() => { ui.dispose(); vi.useRealTimers(); });

describe("the strip", () => {
  it("takes no room with no cards, and draws one row per card in the order it is given, with the count and the key hint", () => {
    expect(top.querySelector<HTMLElement>(".pt-strip")!.hidden).toBe(true);
    ui.update("B1", view(pin("p-0001", { state: "wait" }), pin("p-0002"), pin("p-0003", { state: "done" })));
    expect(top.querySelector<HTMLElement>(".pt-strip")!.hidden).toBe(false);
    expect(rows().map((row) => row.dataset.pin)).toEqual(["p-0001", "p-0002", "p-0003"]);
    expect(rows().map((row) => row.className.match(/pt-(wait|run|done)/)![1])).toEqual(["wait", "run", "done"]);
    expect(top.querySelector(".pt-head-label")!.textContent).toBe("釘選 3");
    expect(top.querySelector(".pt-head-keys")!.textContent).toBe("⌘1–3");
    expect(top.querySelector(".pt-head")!.classList.contains("has-wait")).toBe(true);
  });

  it("says ⌘1 for one card, offers ⌘ keys to the first three rows only, and has no wait mark when nothing waits", () => {
    ui.update("B1", view(pin("p-0001")));
    expect(top.querySelector(".pt-head-keys")!.textContent).toBe("⌘1");
    expect(top.querySelector(".pt-head")!.classList.contains("has-wait")).toBe(false);
    ui.update("B1", view(pin("p-0001"), pin("p-0002"), pin("p-0003"), pin("p-0004"), pin("p-0005")));
    expect(rows().map((row) => row.querySelector(".pt-kc")?.textContent ?? null)).toEqual(["⌘1", "⌘2", "⌘3", null, null]);
    expect(top.querySelector(".pt-head-keys")!.textContent).toBe("⌘1–3");
  });

  it("gives each row its title, short status, who says so, a dot of its state, and a label a screen reader can use", () => {
    ui.update("B1", view(pin("p-0001", { state: "wait", title: "等你確認", status: "要重跑嗎？", source: "user" })));
    const row = rows()[0]!;
    expect(row.querySelector(".pt-title")!.textContent).toBe("等你確認");
    expect(row.querySelector(".pt-short")!.textContent).toBe("要重跑嗎？");
    expect(row.querySelector(".pt-tag")!.textContent).toBe("你釘的");
    expect(row.querySelector(".pt-dot")!.classList.contains("pt-dot-wait")).toBe(true);
    expect(row.getAttribute("aria-label")).toBe("打開 等你確認 · 等你 · 要重跑嗎？");
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks what you have not read, and not on the card that is open", () => {
    ui.update("B1", view(pin("p-0001", { unread: true }), pin("p-0002")));
    expect(rows().map((row) => !!row.querySelector(".pt-unread"))).toEqual([true, false]);
    ui.open("p-0001");
    expect(rows()[0]!.querySelector(".pt-unread")).toBeNull();
  });

  it("shows the bars of a step on the row's second line, at most 12", () => {
    ui.update("B1", view(pin("p-0001", { step: { done: 2, total: 4 } }), pin("p-0002", { step: { done: 3, total: 40 } })));
    expect(rows()[0]!.querySelectorAll(".pt-l2 .pt-bar")).toHaveLength(4);
    expect(rows()[0]!.querySelectorAll(".pt-l2 .pt-bar.on-run")).toHaveLength(2);
    expect(rows()[1]!.querySelectorAll(".pt-l2 .pt-bar")).toHaveLength(12);
    expect(barsOf(pin("x"))).toBeNull();
    expect(tagKey(pin("x", { source: "app" }))).toBe("tag.app");
    expect(tagKey(pin("x", { source: "user" }))).toBe("tag.user");
    expect(tagKey(pin("x"))).toBe("tag.bot");
  });

  it("keeps the keyboard focus on a row across a redraw, and draws what is not a list as no cards", () => {
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    rows()[1]!.focus();
    expect(document.activeElement).toBe(rows()[1]);
    ui.update("B1", view(pin("p-0001"), pin("p-0002", { status: "changed" })));
    expect(document.activeElement).toBe(rows()[1]);
    ui.update("B1", { v: 1, pins: "nope" } as never);
    expect(rows()).toEqual([]);
    ui.update("B1", null);
    expect(top.querySelector<HTMLElement>(".pt-strip")!.hidden).toBe(true);
  });

  it("puts every word of a bot in as text: a title or status with markup draws no element", () => {
    const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';
    ui.update("B1", view(pin("p-0001", { title: evil, status: evil, prev: `<b>${evil}</b>`, thread: [{ rid: "r1", q: evil, a: evil, qAt: clock, postedAt: clock, seenAt: clock, aAt: clock, via: "at" }], step: { done: 1, total: 2 } })));
    ui.open("p-0001");
    for (const root of [top, overlay]) { expect(root.querySelector("img")).toBeNull(); expect(root.querySelector("script")).toBeNull(); }
    expect(rows()[0]!.querySelector(".pt-title")!.textContent).toBe(evil);
    expect(panel()!.querySelector(".pt-pbefore s")!.textContent).toBe(`<b>${evil}</b>`);
    expect(panel()!.querySelector(".pt-pbefore b")).toBeNull();
    expect(panel()!.querySelectorAll(".pt-bubble")[0]!.textContent).toBe(evil);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("the panel", () => {
  const rich = () => pin("p-0001", {
    title: "Deploy", handle: "Deploy", source: "user", status: "跑第 3 輪", prev: "跑第 2 輪", step: { done: 2, total: 4 }, state: "run",
    thread: [
      { rid: "r1", q: "進度？", a: "快好了", qAt: clock, postedAt: clock, seenAt: clock, aAt: clock, via: "at" },
      { rid: "r2", q: "再確認一次", a: null, qAt: clock, postedAt: null, seenAt: null, aAt: null, via: "at" },
      { rid: "r3", q: "還有嗎", a: null, qAt: clock, postedAt: clock, seenAt: clock, aAt: null, via: "at" },
    ],
    updates: [{ at: clock, state: "run", status: "開始", source: "bot" }, { at: clock, state: "run", status: "跑第 2 輪", source: "bot" }, { at: clock, state: "run", status: "跑第 3 輪", source: "bot" }],
  });

  it("opens from a row click with the title, who says so, the status rewritten in place with 原本, the bars and 剩 N 步, and an input addressed to the card", () => {
    ui.update("B1", view(rich()));
    rows()[0]!.click();
    const p = panel()!;
    expect(p).not.toBeNull();
    expect(p.getAttribute("role")).toBe("dialog");
    expect(p.querySelector(".pt-ptitle")!.textContent).toBe("Deploy");
    expect(p.querySelector(".pt-ptag")!.textContent).toBe("你釘的");
    expect(p.querySelector(".pt-pstatus")!.textContent).toBe("跑第 3 輪");
    expect(p.querySelector(".pt-pbefore")!.textContent).toBe("原本：跑第 2 輪");
    expect(p.querySelector(".pt-pbefore s")!.textContent).toBe("跑第 2 輪");
    expect(p.querySelectorAll(".pt-bars-l .pt-bar")).toHaveLength(4);
    expect(p.querySelector(".pt-left")!.textContent).toBe("剩 2 步");
    expect(p.querySelector<HTMLInputElement>(".pt-input")!.placeholder).toBe("對「Deploy」說…");
    expect(document.body.classList.contains("pt-panel-open")).toBe(true);
    expect(rows()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(p.querySelector(".pt-input"));
    expect(call).toHaveBeenCalledWith("seen", { botId: "B1", id: "p-0001" });
  });

  it("says 剩 1 步 for one step, and shows no bars and no 原本 for a card without steps or an earlier status", () => {
    ui.update("B1", view(pin("p-0001", { step: { done: 3, total: 4 } }), pin("p-0002")));
    ui.open("p-0001");
    expect(panel()!.querySelector(".pt-left")!.textContent).toBe("剩 1 步");
    ui.open("p-0002");
    expect(panel()!.querySelector(".pt-left")).toBeNull();
    expect(panel()!.querySelector<HTMLElement>(".pt-pbefore")!.hidden).toBe(true);
  });

  it("draws the thread with receipts: 已送出 until the bot has seen it, 已看到 after, and the bot's answer under the question", () => {
    ui.update("B1", view(rich()));
    ui.open("p-0001");
    const bubbles = [...panel()!.querySelectorAll(".pt-msg")].map((msg) => [msg.classList.contains("pt-me") ? "me" : "bot", msg.querySelector(".pt-bubble")!.textContent]);
    expect(bubbles).toEqual([["me", "進度？"], ["bot", "快好了"], ["me", "再確認一次"], ["me", "還有嗎"]]);
    const receipts = [...panel()!.querySelectorAll(".pt-me .pt-receipt")];
    expect(receipts.map((node) => node.textContent!.split(" · ")[1])).toEqual(["bot 已看到", "已送出", "bot 已看到"]);
    expect(receipts.map((node) => node.classList.contains("seen"))).toEqual([true, false, true]);
  });

  it("draws an answer the bot gave by itself (a turn with no words of yours) as the bot's bubble alone (review)", () => {
    ui.update("B1", view(pin("p-0001", { thread: [{ rid: "a1", q: "", a: "順便說一下", qAt: clock, postedAt: null, seenAt: null, aAt: clock, via: "at" }] })));
    ui.open("p-0001");
    const bubbles = [...panel()!.querySelectorAll(".pt-msg")].map((msg) => [msg.classList.contains("pt-me") ? "me" : "bot", msg.querySelector(".pt-bubble")!.textContent]);
    expect(bubbles).toEqual([["bot", "順便說一下"]]);
  });

  it("says so when the thread is empty", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    expect(panel()!.querySelector(".pt-empty")!.textContent).toContain("還沒有對話");
  });

  it("folds the updates after the first into 'N 則更新 · last', and opens them on a click", () => {
    ui.update("B1", view(rich(), pin("p-0002")));
    ui.open("p-0001");
    const toggle = panel()!.querySelector<HTMLButtonElement>(".pt-updates-toggle")!;
    expect(toggle.textContent).toBe("2 則更新 · 跑第 3 輪");
    expect(panel()!.querySelectorAll(".pt-updates-list li")).toHaveLength(0);
    toggle.click();
    expect(panel()!.querySelectorAll(".pt-updates-list li")).toHaveLength(2);
    expect(panel()!.querySelector(".pt-updates-toggle")!.getAttribute("aria-expanded")).toBe("true");
    ui.open("p-0002");
    expect(panel()!.querySelector<HTMLElement>(".pt-updates")!.hidden).toBe(true);
  });

  it("rewrites the open panel in place when the bot changes the card, without closing it", () => {
    ui.update("B1", view(pin("p-0001", { status: "one" })));
    ui.open("p-0001");
    const same = panel();
    ui.update("B1", view(pin("p-0001", { status: "two", prev: "one", state: "wait" })));
    expect(panel()).toBe(same);
    expect(panel()!.querySelector(".pt-pstatus")!.textContent).toBe("two");
    expect(panel()!.querySelector(".pt-pbefore")!.textContent).toBe("原本：one");
    expect(panel()!.querySelector(".pt-dot")!.classList.contains("pt-dot-wait")).toBe(true);
  });

  it("switches from one card to another, and a click on its own row closes it", () => {
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    rows()[0]!.click();
    rows()[1]!.click();
    expect(overlay.querySelectorAll(".pt-panel")).toHaveLength(1);
    expect(panel()!.dataset.pin).toBe("p-0002");
    rows()[1]!.click();
    expect(panel()).toBeNull();
    expect(document.body.classList.contains("pt-panel-open")).toBe(false);
  });

  it("closes when the card is gone, and when the chat is another bot's", () => {
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    ui.open("p-0001");
    ui.update("B1", view(pin("p-0002")));
    expect(panel()).toBeNull();
    ui.open("p-0002");
    ui.update("B2", view(pin("p-0002", { title: "Another bot's" })));
    expect(panel()).toBeNull();
    expect(ui.isOpen()).toBe(false);
    expect(document.body.classList.contains("pt-panel-open")).toBe(false);
  });

  it("leaves with a slide when motion is wanted (the panel is out of the way at once and gone after 140 ms), and at once when reduced motion is asked", () => {
    vi.useFakeTimers();
    motion = false;
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    ui.close();
    expect(panel()!.classList.contains("x")).toBe(true);
    expect(panel()!.hasAttribute("inert")).toBe(true);
    vi.advanceTimersByTime(140);
    expect(panel()).toBeNull();
    motion = true;
    ui.open("p-0001");
    ui.close();
    expect(panel()).toBeNull();
  });
});

describe("keys and clicks outside", () => {
  it("Esc closes the panel and gives the row the focus back; with no panel it does nothing", () => {
    ui.update("B1", view(pin("p-0001")));
    const nothing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(nothing);
    expect(nothing.defaultPrevented).toBe(false);
    ui.open("p-0001");
    key({ key: "Escape" });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("⌘1–⌘3 open the cards, the same key closes it, and a fourth card or another modifier does nothing", () => {
    ui.update("B1", view(pin("p-0001"), pin("p-0002"), pin("p-0003"), pin("p-0004")));
    key({ key: "2", metaKey: true });
    expect(panel()!.dataset.pin).toBe("p-0002");
    key({ key: "2", metaKey: true });
    expect(panel()).toBeNull();
    key({ key: "4", metaKey: true });
    key({ key: "1", metaKey: true, shiftKey: true });
    key({ key: "1", ctrlKey: true });
    key({ key: "1" });
    key({ key: "9", metaKey: true });
    expect(panel()).toBeNull();
    key({ key: "3", metaKey: true });
    expect(panel()!.dataset.pin).toBe("p-0003");
  });

  it("does not read a key pressed while an IME composes (Esc or a number to pick a candidate)", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    key({ key: "Escape", isComposing: true });
    expect(panel()).not.toBeNull();
    key({ key: "Escape", keyCode: 229 });
    expect(panel()).not.toBeNull();
  });

  it("a press outside the panel and the strip closes it; a press in either does not", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    const press = (target: Element) => target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    press(panel()!.querySelector(".pt-pstatus")!);
    press(rows()[0]!);
    expect(panel()).not.toBeNull();
    press(document.body);
    expect(panel()).toBeNull();
    press(document.body);
  });

  it("stops listening when it is disposed, and takes its strip and panel away", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    ui.dispose();
    expect(top.querySelector(".pt-strip")).toBeNull();
    expect(panel()).toBeNull();
    expect(document.body.classList.contains("pt-panel-open")).toBe(false);
    const after = new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe("taking a card down and putting it back", () => {
  it("a done card you opened and closed is unpinned for you, with the line 看過了 and 釘回; a card that is not done is not", async () => {
    ui.update("B1", view(pin("p-0001", { state: "done", title: "Build" }), pin("p-0002")));
    ui.open("p-0001");
    key({ key: "Escape" });
    await flush();
    expect(call).toHaveBeenCalledWith("unpin", { botId: "B1", id: "p-0001", by: "seen" });
    expect(top.querySelector(".pt-toast-text")!.textContent).toBe("「Build」…看過了，已取消釘選");
    expect(top.querySelector(".pt-toast-act")!.textContent).toBe("釘回");
    call.mockClear();
    ui.open("p-0002");
    key({ key: "Escape" });
    await flush();
    expect(call.mock.calls.map(([method]) => method)).toEqual(["seen"]);
  });

  it("釘回 asks the program part to repin, and opens the card again", async () => {
    ui.update("B1", view(pin("p-0001", { state: "done" })));
    ui.open("p-0001");
    key({ key: "Escape" });
    await flush();
    top.querySelector<HTMLButtonElement>(".pt-toast-act")!.click();
    await flush();
    expect(call).toHaveBeenCalledWith("repin", { botId: "B1", id: "p-0001" });
    expect(ui.isOpen("p-0001")).toBe(true);
    expect(top.querySelector(".pt-toast-text")).toBeNull();
  });

  it("the unpin button of the panel takes the card down for you, closes the panel, and offers 釘回", async () => {
    ui.update("B1", view(pin("p-0001", { title: "Plan" })));
    ui.open("p-0001");
    panel()!.querySelector<HTMLButtonElement>('.pt-ib[aria-label="取消釘選"]')!.click();
    await flush();
    expect(call).toHaveBeenCalledWith("unpin", { botId: "B1", id: "p-0001" });
    expect(panel()).toBeNull();
    expect(top.querySelector(".pt-toast-text")!.textContent).toBe("你取消釘選「Plan」");
    expect(top.querySelector(".pt-toast-act")).not.toBeNull();
  });

  it("the toast goes after 8 seconds", async () => {
    vi.useFakeTimers();
    ui.update("B1", view(pin("p-0001")));
    ui.unpin("p-0001");
    await vi.advanceTimersByTimeAsync(0);
    expect(top.querySelector(".pt-toast-text")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(top.querySelector(".pt-toast-text")).toBeNull();
  });

  it("says so when the program part cannot do it, and keeps the card in the strip", async () => {
    failing.add("unpin");
    ui.update("B1", view(pin("p-0001")));
    ui.unpin("p-0001");
    await flush();
    expect(top.querySelector(".pt-toast-text")!.textContent).toBe("沒做成：unpin failed");
    expect(rows()).toHaveLength(1);
    failing.clear();
    failing.add("repin");
    ui.update("B1", view(pin("p-0002", { state: "done" })));
    ui.open("p-0002");
    key({ key: "Escape" });
    await flush();
    top.querySelector<HTMLButtonElement>(".pt-toast-act")!.click();
    await flush();
    expect(top.querySelector(".pt-toast-text")!.textContent).toBe("沒做成：repin failed");
  });
});

describe("the panel's own input", () => {
  beforeEach(() => { ui.update("B1", view(pin("p-0001", { handle: "Deploy" }))); ui.open("p-0001"); });

  it("sends '@handle words' the way a typed message goes, and empties the box; empty words send nothing", () => {
    submit("   ");
    expect(send).not.toHaveBeenCalled();
    submit("  先停一下  ");
    expect(send).toHaveBeenCalledWith("@Deploy 先停一下");
    expect(overlay.querySelector<HTMLInputElement>(".pt-input")!.value).toBe("");
  });

  it("sends a double tap once and says 剛送過了, and lets the next one through when the thread has the line, or after 4 seconds", () => {
    submit("go");
    submit("go");
    submit("again");
    expect(send).toHaveBeenCalledTimes(1);
    expect(overlay.querySelector(".pt-hint")!.textContent).toBe("剛送過了");
    const turn = { rid: "r1", q: "go", a: null, qAt: clock, postedAt: null, seenAt: null, aAt: null, via: "at" as const };
    ui.update("B1", view(pin("p-0001", { handle: "Deploy", thread: [turn] })));
    submit("second");
    expect(send).toHaveBeenCalledTimes(2);
    submit("third");
    expect(send).toHaveBeenCalledTimes(2);
    clock += 4_000;
    submit("third");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("holds a send per card: another card's box is not blocked", () => {
    ui.update("B1", view(pin("p-0001", { handle: "Deploy" }), pin("p-0002", { handle: "Other" })));
    submit("one");
    ui.open("p-0002");
    submit("two");
    expect(send.mock.calls.map(([text]) => text)).toEqual(["@Deploy one", "@Other two"]);
  });

  it("forgets a held send when the chat is another bot's", () => {
    submit("one");
    ui.update("B2", view(pin("p-0001", { handle: "Deploy" })));
    ui.open("p-0001");
    submit("one");
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("the @ rows of the main input box", () => {
  it("offers this chat's cards by handle or id, with their state and status, and what to insert", () => {
    ui.update("B1", view(pin("p-0001", { handle: "Deploy", state: "wait", status: "要重跑嗎？" }), pin("p-0002", { handle: "Docs" })));
    expect(ui.mentions("d")).toEqual([
      { name: "Deploy", about: "等你 · 要重跑嗎？", insert: "@Deploy " },
      { name: "Docs", about: "進行中 · status of p-0002", insert: "@Docs " },
    ]);
    expect(ui.mentions("dep").map((row) => row.name)).toEqual(["Deploy"]);
    expect(ui.mentions("p-0002").map((row) => row.name)).toEqual(["Docs"]);
    expect(ui.mentions("zzz")).toEqual([]);
  });

  it("offers at most 8, and nothing in a chat with no cards", () => {
    expect(ui.mentions("")).toEqual([]);
    ui.update("B1", view(...Array.from({ length: 8 }, (_, n) => pin(`p-000${n + 1}`, { handle: `card${n}` }))));
    expect(ui.mentions("")).toHaveLength(8);
  });
});
