// @vitest-environment jsdom
// What the page draws (src/ui.ts) in jsdom with fakes: the list of cards (A 細清單), the row that opens in place into the card, the card's
// 過程 log, 「還有 N 件」, the 「回覆到」 chip, the keys, a press on the chat's empty space, the done-card auto-unpin with 釘回 and the "@" rows.
// Nothing here opens a window or takes the real focus.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PinView } from "../src/model";
import { MAX_ROWS, PinUi, barsOf, tagKey } from "../src/ui";
import { wordsFor } from "../src/words";

let clock = 5_000_000;
let ui: PinUi;
let top: HTMLElement;
const failing = new Set<string>();
const call = vi.fn(async (method: string, _params: Record<string, unknown>) => {
  if (failing.has(method)) throw new Error(`${method} failed`);
  return {};
});
const openChat = vi.fn();
const chip = vi.fn();
const focusComposer = vi.fn();

const pin = (id: string, over: Partial<PinView> = {}): PinView => ({
  id, title: `Title ${id}`, handle: `Handle-${id}`, origin: "bot", state: "run", status: `status of ${id}`, source: "bot", unread: false, thread: [], updates: [{ at: clock, state: "run", status: "first", source: "bot" }],
  createdAt: clock, updatedAt: clock, ...over,
});
const view = (...pins: PinView[]) => ({ v: 1 as const, pins });
const many = (n: number, over: (index: number) => Partial<PinView> = () => ({})) => Array.from({ length: n }, (_, index) => pin(`p-${String(index + 1).padStart(4, "0")}`, over(index)));
const rows = () => [...top.querySelectorAll<HTMLElement>(".pt-row")];
const panel = () => top.querySelector<HTMLElement>(".pt-card");
const more = () => top.querySelector<HTMLButtonElement>(".pt-more")!;
/** What the strip shows, top to bottom: a row is its card's id, the open card is "[id]", the 「還有 N 件」 row is its text. */
const order = (): string[] => {
  const out: string[] = [];
  for (const node of Array.from(top.querySelector(".pt-rows")!.children) as HTMLElement[]) {
    if (node.classList.contains("pt-above") || node.classList.contains("pt-below")) out.push(...Array.from(node.children).map((row) => (row as HTMLElement).dataset.pin!));
    else if (node.classList.contains("pt-card")) out.push(`[${node.dataset.pin}]`);
    else if (!node.hidden) out.push(node.textContent!);
  }
  return out;
};
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
const key = (init: KeyboardEventInit, target: EventTarget = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
/** A pointer press as a mouse makes it (primary button); `pointerType` makes it a touch or a pen. */
const press = (target: Element, init: MouseEventInit & { pointerType?: string } = {}) => {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ...init });
  if (init.pointerType) Object.defineProperty(event, "pointerType", { value: init.pointerType });
  target.dispatchEvent(event);
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  top = document.createElement("div");
  document.body.append(top);
  clock = 5_000_000;
  failing.clear();
  call.mockClear();
  openChat.mockClear();
  chip.mockClear();
  focusComposer.mockClear();
  ui = new PinUi(top, { call, openChat, words: wordsFor(() => "zh-Hant"), now: () => clock, chip, focusComposer });
});
afterEach(() => { ui.dispose(); vi.useRealTimers(); });

describe("the list", () => {
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

  it("has no pill row, no 問這件事 entry and no question buttons", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    expect(top.textContent).not.toContain("問這件事");
    expect(top.querySelector(".pt-pills, .pt-ask, .pt-faq, .pt-pill-row")).toBeNull();
    expect(top.querySelectorAll("input, textarea, form")).toHaveLength(0);
  });

  it("says ⌘1 for one card, and has no wait mark when nothing waits", () => {
    ui.update("B1", view(pin("p-0001")));
    expect(top.querySelector(".pt-head-keys")!.textContent).toBe("⌘1");
    expect(top.querySelector(".pt-head")!.classList.contains("has-wait")).toBe(false);
    ui.update("B1", view(...many(5)));
    expect(top.querySelector(".pt-head-keys")!.textContent).toBe("⌘1–3");
  });

  it("gives each row its dot, title, short status, when it changed, a chevron and a label a screen reader can use", () => {
    ui.update("B1", view(pin("p-0001", { state: "wait", title: "等你確認", status: "要重跑嗎？", source: "user" })));
    const row = rows()[0]!;
    expect(row.querySelector(".pt-title")!.textContent).toBe("等你確認");
    expect(row.querySelector(".pt-short")!.textContent).toBe("要重跑嗎？");
    expect(row.querySelector(".pt-meta")!.textContent).toBe(new Date(clock).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));
    expect(row.querySelector("svg")).not.toBeNull();
    expect(row.querySelector(".pt-dot")!.classList.contains("pt-dot-wait")).toBe(true);
    expect(row.getAttribute("aria-label")).toBe("打開 等你確認 · 等你 · 要重跑嗎？");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".pt-tag, .pt-kc, .pt-l2")).toBeNull();
  });

  it("says 剛更新 on a row that has not been read, and not on the card that is open", () => {
    ui.update("B1", view(pin("p-0001", { unread: true }), pin("p-0002")));
    expect(rows().map((row) => row.querySelector(".pt-meta")!.classList.contains("fresh"))).toEqual([true, false]);
    expect(rows()[0]!.querySelector(".pt-meta")!.textContent).toContain("剛更新");
    ui.open("p-0001");
    expect(rows().map((row) => row.dataset.pin)).toEqual(["p-0002"]);
    expect(panel()!.querySelector<HTMLElement>(".pt-pill")!.hidden).toBe(false);
    ui.open("p-0002");
    expect(panel()!.querySelector<HTMLElement>(".pt-pill")!.hidden).toBe(true);
  });

  it("shows the bars of a step in the open card only, at most 12", () => {
    ui.update("B1", view(pin("p-0001", { step: { done: 2, total: 4 } }), pin("p-0002", { step: { done: 3, total: 40 } })));
    expect(top.querySelectorAll(".pt-row .pt-bar")).toHaveLength(0);
    ui.open("p-0001");
    expect(panel()!.querySelectorAll(".pt-bars-l .pt-bar")).toHaveLength(4);
    expect(panel()!.querySelectorAll(".pt-bar.on-run")).toHaveLength(2);
    ui.open("p-0002");
    expect(panel()!.querySelectorAll(".pt-bars-l .pt-bar")).toHaveLength(12);
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
    ui.update("B1", view(pin("p-0001", { title: evil, status: evil, prev: `<b>${evil}</b>`, thread: [{ rid: "r1", q: evil, a: evil, qAt: clock, postedAt: clock, seenAt: clock, aAt: clock, via: "at" }], step: { done: 1, total: 2 } }), pin("p-0002", { title: evil })));
    expect(rows()[0]!.querySelector(".pt-title")!.textContent).toBe(evil);
    ui.open("p-0001");
    expect(top.querySelector("img")).toBeNull();
    expect(top.querySelector("script")).toBeNull();
    expect(panel()!.querySelector(".pt-ptitle")!.textContent).toBe(evil);
    expect(panel()!.querySelector(".pt-pbefore s")!.textContent).toBe(`<b>${evil}</b>`);
    expect(panel()!.querySelector(".pt-pbefore b")).toBeNull();
    expect(panel()!.querySelectorAll(".pt-bubble")[0]!.textContent).toBe(evil);
    expect(chip).toHaveBeenLastCalledWith({ id: "p-0001", title: evil });
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });
});

describe("more than four cards: the first rows and 「還有 N 件」", () => {
  it("shows at most four rows and one 「還有 N 件」 row for the rest, in the order given", () => {
    ui.update("B1", view(...many(4)));
    expect(more().hidden).toBe(true);
    expect(rows()).toHaveLength(4);
    ui.update("B1", view(...many(7)));
    expect(MAX_ROWS).toBe(4);
    expect(rows().map((row) => row.dataset.pin)).toEqual(["p-0001", "p-0002", "p-0003", "p-0004"]);
    expect(more().hidden).toBe(false);
    expect(more().textContent).toBe("還有 3 件");
    expect(more().getAttribute("aria-expanded")).toBe("false");
    expect(order()).toEqual(["p-0001", "p-0002", "p-0003", "p-0004", "還有 3 件"]);
  });

  it("a tap on it shows the rest (the list in the same order), and the same row folds them again", () => {
    ui.update("B1", view(...many(6)));
    more().click();
    expect(rows().map((row) => row.dataset.pin)).toEqual(["p-0001", "p-0002", "p-0003", "p-0004", "p-0005", "p-0006"]);
    expect(more().textContent).toBe("只看前 4 件");
    expect(more().getAttribute("aria-expanded")).toBe("true");
    more().click();
    expect(rows()).toHaveLength(4);
    expect(more().textContent).toBe("還有 2 件");
  });

  it("a card that waits is among the first rows (waiting cards come first), so a hidden card never hides a question", () => {
    ui.update("B1", view(...many(6, (index) => (index < 2 ? { state: "wait" as const } : { state: "run" as const }))));
    expect(rows().filter((row) => row.classList.contains("pt-wait"))).toHaveLength(2);
  });

  it("opening a card that is behind the fold (a digest row, the 釘選 button, ⌘ key) shows every row, the card in its own place", () => {
    ui.update("B1", view(...many(6)));
    ui.open("p-0006");
    expect(order()).toEqual(["p-0001", "p-0002", "p-0003", "p-0004", "p-0005", "[p-0006]", "只看前 4 件"]);
  });

  it("opening the fifth card (the first one behind the fold, index 4) shows every row", () => {
    ui.update("B1", view(...many(6)));
    ui.open("p-0005");
    expect(order()).toEqual(["p-0001", "p-0002", "p-0003", "p-0004", "[p-0005]", "p-0006", "只看前 4 件"]);
    ui.close();
    ui.update("B2", view(...many(6)));
    ui.open("p-0004");
    // index 3 is still in the first four: the fold stays
    expect(order()).toEqual(["p-0001", "p-0002", "p-0003", "[p-0004]", "還有 2 件"]);
  });

  it("an open card in the first rows counts as one of the four, in its own place, with the others around it", () => {
    ui.update("B1", view(...many(6)));
    ui.open("p-0002");
    expect(order()).toEqual(["p-0001", "[p-0002]", "p-0003", "p-0004", "還有 2 件"]);
  });

  it("with the count back to four or fewer, the row goes away; another chat starts folded", () => {
    ui.update("B1", view(...many(6)));
    more().click();
    ui.update("B1", view(...many(3)));
    expect(more().hidden).toBe(true);
    ui.update("B1", view(...many(6)));
    expect(rows()).toHaveLength(6);
    ui.update("B2", view(...many(6)));
    expect(rows()).toHaveLength(4);
  });
});

describe("the card (a row opened in place)", () => {
  const rich = () => pin("p-0001", {
    title: "Deploy", handle: "Deploy", source: "user", status: "跑第 3 輪", prev: "跑第 2 輪", step: { done: 2, total: 4 }, state: "run",
    thread: [
      { rid: "r1", q: "進度？", a: "快好了", qAt: clock, postedAt: clock, seenAt: clock, aAt: clock, via: "at" },
      { rid: "r2", q: "再確認一次", a: null, qAt: clock, postedAt: null, seenAt: null, aAt: null, via: "at" },
      { rid: "r3", q: "還有嗎", a: null, qAt: clock, postedAt: clock, seenAt: clock, aAt: null, via: "at" },
    ],
    updates: [{ at: clock, state: "run", status: "開始", source: "bot" }, { at: clock, state: "run", status: "跑第 2 輪", source: "bot" }, { at: clock, state: "run", status: "跑第 3 輪", source: "bot" }],
  });

  it("opens from a row click in place of that row: title, who says so, the status rewritten with 原本, the bars and 剩 N 步, no input of its own", () => {
    ui.update("B1", view(pin("p-0000"), rich(), pin("p-0002")));
    rows()[1]!.click();
    const p = panel()!;
    expect(order()).toEqual(["p-0000", "[p-0001]", "p-0002"]);
    expect(p.querySelector(".pt-ptitle")!.textContent).toBe("Deploy");
    expect(p.querySelector(".pt-ptag")!.textContent).toBe("你釘的");
    expect(p.querySelector(".pt-pstatus")!.textContent).toBe("跑第 3 輪");
    expect(p.querySelector(".pt-pbefore")!.textContent).toBe("原本：跑第 2 輪");
    expect(p.querySelector(".pt-pbefore s")!.textContent).toBe("跑第 2 輪");
    expect(p.querySelectorAll(".pt-bars-l .pt-bar")).toHaveLength(4);
    expect(p.querySelector(".pt-left")!.textContent).toBe("剩 2 步");
    expect(p.querySelector(".pt-cat")!.textContent).toMatch(/更新$/);
    expect(p.querySelector("input, textarea, form")).toBeNull();
    expect(call).toHaveBeenCalledWith("seen", { botId: "B1", id: "p-0001" });
  });

  it("opening it asks the chat's input box for the chip 「回覆到 <card>」 and the caret; leaving takes the chip away", () => {
    ui.update("B1", view(pin("p-0001", { title: "Deploy" })));
    expect(chip).not.toHaveBeenCalled();
    ui.open("p-0001");
    expect(chip).toHaveBeenCalledTimes(1);
    expect(chip).toHaveBeenLastCalledWith({ id: "p-0001", title: "Deploy" });
    expect(focusComposer).toHaveBeenCalledTimes(1);
    // the strip redrawing for news does not put the chip again
    ui.update("B1", view(pin("p-0001", { title: "Deploy", status: "news" })));
    expect(chip).toHaveBeenCalledTimes(1);
    // the card's title changed: the chip says so
    ui.update("B1", view(pin("p-0001", { title: "Deploy 2" })));
    expect(chip).toHaveBeenLastCalledWith({ id: "p-0001", title: "Deploy 2" });
    ui.close();
    expect(chip).toHaveBeenLastCalledWith(null);
    expect(chip).toHaveBeenCalledTimes(3);
  });

  it("another card moves the chip to it; the card going away, or another chat, takes it away", () => {
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    ui.open("p-0001");
    ui.open("p-0002");
    expect(chip).toHaveBeenLastCalledWith({ id: "p-0002", title: "Title p-0002" });
    ui.update("B1", view(pin("p-0001")));
    expect(chip).toHaveBeenLastCalledWith(null);
    ui.open("p-0001");
    ui.update("B2", view(pin("p-0001")));
    expect(chip).toHaveBeenLastCalledWith(null);
    expect(ui.isOpen()).toBe(false);
  });

  it("says 剩 1 步 for one step, and shows no bars and no 原本 for a card without steps or an earlier status", () => {
    ui.update("B1", view(pin("p-0001", { step: { done: 3, total: 4 } }), pin("p-0002")));
    ui.open("p-0001");
    expect(panel()!.querySelector(".pt-left")!.textContent).toBe("剩 1 步");
    ui.open("p-0002");
    expect(panel()!.querySelector(".pt-left")).toBeNull();
    expect(panel()!.querySelector<HTMLElement>(".pt-pbefore")!.hidden).toBe(true);
    expect(panel()!.querySelector<HTMLElement>(".pt-pnote")!.hidden).toBe(true);
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

  it("says so when the thread is empty, and where to write", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    expect(panel()!.querySelector(".pt-empty")!.textContent).toContain("下面的輸入框");
  });

  it("keeps the rest in a folded 「過程 · N 則更新」 (worker news lands here), the newest line on the same row, and opens them on a click", () => {
    ui.update("B1", view(rich(), pin("p-0002")));
    ui.open("p-0001");
    const toggle = panel()!.querySelector<HTMLButtonElement>(".pt-updates-toggle")!;
    expect(toggle.querySelector("span")!.textContent).toBe("過程 · 2 則更新");
    expect(toggle.querySelector(".pt-updates-last")!.textContent).toBe("跑第 3 輪");
    expect(panel()!.querySelectorAll(".pt-updates-list li")).toHaveLength(0);
    toggle.click();
    expect(panel()!.querySelectorAll(".pt-updates-list li")).toHaveLength(2);
    expect(panel()!.querySelector(".pt-updates-toggle")!.getAttribute("aria-expanded")).toBe("true");
    ui.open("p-0002");
    expect(panel()!.querySelector<HTMLElement>(".pt-updates")!.hidden).toBe(true);
  });

  it("rewrites the open card in place when the bot changes it, without closing it or moving it", () => {
    ui.update("B1", view(pin("p-0001", { status: "one" })));
    ui.open("p-0001");
    const same = panel();
    ui.update("B1", view(pin("p-0001", { status: "two", prev: "one", state: "wait" })));
    expect(panel()).toBe(same);
    expect(panel()!.querySelector(".pt-pstatus")!.textContent).toBe("two");
    expect(panel()!.querySelector(".pt-pbefore")!.textContent).toBe("原本：one");
    expect(panel()!.querySelector(".pt-dot")!.classList.contains("pt-dot-wait")).toBe(true);
  });

  it("switches from one card to another, and the chevron (or its key) closes it back into a row", () => {
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    rows()[0]!.click();
    rows()[0]!.click();
    expect(top.querySelectorAll(".pt-card")).toHaveLength(1);
    expect(panel()!.dataset.pin).toBe("p-0002");
    expect(order()).toEqual(["p-0001", "[p-0002]"]);
    panel()!.querySelector<HTMLButtonElement>(".pt-collapse")!.click();
    expect(panel()).toBeNull();
    expect(order()).toEqual(["p-0001", "p-0002"]);
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
  });

  it("is in the top slot above the chat (the chat scrolls below it), not a floating panel", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    expect(top.contains(panel())).toBe(true);
    expect(document.querySelector(".pt-panel")).toBeNull();
    expect(document.body.classList.contains("pt-panel-open")).toBe(false);
  });
});

describe("keys, and a press on the chat's empty space", () => {
  /** The chat page's own skeleton: a scroller, the list, a message row with a bubble and a button, a stamp. */
  const chat = () => {
    const scroller = document.createElement("main");
    scroller.id = "scroller";
    scroller.innerHTML = '<div id="messages"><div class="stamped"><div class="stamp">today</div></div><div class="row bot" data-id="m1"><span class="avatar">b</span><div class="bubble"><p>hello <a href="#">link</a></p></div><button class="reply-button">r</button></div></div>';
    document.body.append(scroller);
    return scroller;
  };
  const stub = () => { ui.update("B1", view(pin("p-0001"), pin("p-0002"))); ui.open("p-0001"); };

  it("a press on the chat's blank space (the list, a message row's own space, a stamp line) folds the card back into a row, and the chip goes", () => {
    const scroller = chat();
    for (const target of [scroller, scroller.querySelector("#messages")!, scroller.querySelector(".row")!, scroller.querySelector(".stamped")!]) {
      stub();
      expect(panel()).not.toBeNull();
      press(target);
      expect(panel()).toBeNull();
      expect(order()).toEqual(["p-0001", "p-0002"]);
      expect(chip).toHaveBeenLastCalledWith(null);
    }
  });

  it("a press on what is in the chat (a bubble, its words, a link, a button of a message) or outside the chat (the input box, the page, the card, the rows) leaves the card open", () => {
    const scroller = chat();
    const outside = document.createElement("textarea");
    document.body.append(outside);
    stub();
    for (const target of [scroller.querySelector(".bubble")!, scroller.querySelector("p")!, scroller.querySelector("a")!, scroller.querySelector(".reply-button")!, scroller.querySelector(".stamp")!, scroller.querySelector(".avatar")!, outside, document.body, panel()!.querySelector(".pt-pstatus")!, rows()[0]!]) {
      press(target);
      expect(panel()).not.toBeNull();
    }
    expect(ui.isOpen("p-0001")).toBe(true);
  });

  it("only the listed blank targets fold it: a press on any other thing in the chat (a stamp's words, an avatar) does not", () => {
    const scroller = chat();
    stub();
    for (const target of [scroller.querySelector(".stamp")!, scroller.querySelector(".avatar")!]) {
      press(target);
      expect(panel()).not.toBeNull();
    }
  });

  it("only a plain primary-button press folds it: a right-click or a middle press on the blank space does not", () => {
    const scroller = chat();
    stub();
    press(scroller, { button: 2 });
    press(scroller, { button: 1 });
    expect(panel()).not.toBeNull();
    press(scroller, { button: 0 });
    expect(panel()).toBeNull();
  });

  it("a press on the scroller's own scrollbar (right of or below its content) is a drag of the thumb and does not fold; a press on its content does", () => {
    const scroller = chat();
    Object.defineProperty(scroller, "clientWidth", { value: 500 });
    Object.defineProperty(scroller, "clientHeight", { value: 400 });
    stub();
    press(scroller, { clientX: 505, clientY: 100 });
    press(scroller, { clientX: 100, clientY: 405 });
    expect(panel()).not.toBeNull();
    press(scroller, { clientX: 100, clientY: 100 });
    expect(panel()).toBeNull();
  });

  it("a touch does not fold it on contact (that may be a scroll), only on its tap (click); a mouse click alone is not a tap", () => {
    const scroller = chat();
    stub();
    press(scroller, { pointerType: "touch" });
    expect(panel()).not.toBeNull();
    scroller.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel()).toBeNull();
    stub();
    press(scroller.querySelector(".bubble")!, { pointerType: "touch" });
    scroller.querySelector(".bubble")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel()).not.toBeNull();
    press(scroller.querySelector(".bubble")!, { pointerType: "mouse" });
    scroller.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(panel()).not.toBeNull();
  });

  it("a press on the blank space with no card open does nothing (and takes no call)", () => {
    const scroller = chat();
    ui.update("B1", view(pin("p-0001")));
    call.mockClear();
    press(scroller);
    expect(call).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it("closing that way unpins a done card like any other close, with 釘回", async () => {
    const scroller = chat();
    ui.update("B1", view(pin("p-0001", { state: "done" })));
    ui.open("p-0001");
    press(scroller);
    await flush();
    expect(call).toHaveBeenCalledWith("unpin", { botId: "B1", id: "p-0001", by: "seen" });
  });

  it("Esc closes the card and gives the row the focus back; with no card it does nothing", () => {
    ui.update("B1", view(pin("p-0001")));
    const nothing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(nothing);
    expect(nothing.defaultPrevented).toBe(false);
    ui.open("p-0001");
    key({ key: "Escape" });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rows()[0]);
  });

  it("Esc that something else took first (the input box's @ list or the model menu calls preventDefault) leaves the card open; the next Esc folds it", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    const box = document.createElement("div");
    box.setAttribute("contenteditable", "true");
    document.body.append(box);
    const take = (event: Event) => event.preventDefault();
    box.addEventListener("keydown", take);
    key({ key: "Escape" }, box);
    expect(panel()).not.toBeNull();
    expect(chip).not.toHaveBeenLastCalledWith(null);
    box.removeEventListener("keydown", take);
    key({ key: "Escape" }, box);
    expect(panel()).toBeNull();
  });

  it("Esc from the input box folds the card but leaves the caret in the box (it does not move to the row); Esc elsewhere puts the row in focus", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    key({ key: "Escape" }, box);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it("Esc is not swallowed: it still reaches the page's other listeners", () => {
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    key({ key: "Escape" });
    document.removeEventListener("keydown", seen);
    expect(seen).toHaveBeenCalledTimes(1);
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

  it("stops listening when it is disposed, takes its list and card away and the chip with them", () => {
    const scroller = chat();
    ui.update("B1", view(pin("p-0001")));
    ui.open("p-0001");
    ui.dispose();
    expect(top.querySelector(".pt-strip")).toBeNull();
    expect(panel()).toBeNull();
    expect(chip).toHaveBeenLastCalledWith(null);
    const after = new KeyboardEvent("keydown", { key: "1", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    call.mockClear();
    press(scroller);
    expect(call).not.toHaveBeenCalled();
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
    expect(chip).toHaveBeenLastCalledWith(null);
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

// ---- Phase 2 ----

describe("where a line the bot moved went (the trace in the chat)", () => {
  const data = (over: Partial<import("../src/model").TraceData> = {}): import("../src/model").TraceData => ({ kind: "moved", rid: "r1", pin: "p-0001", title: "Title p-0001", q: "部署好了嗎", by: "bot", ...over });
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    ui.update("B1", view(pin("p-0001"), pin("p-0002", { title: "Docs", state: "wait" }), pin("p-0003", { title: "Old", state: "done" })));
  });
  const acts = () => [...root.querySelectorAll<HTMLButtonElement>(".pt-mv-act")];

  it("is one line: where it went, 移回聊天 and 改到…; the title opens the card", () => {
    ui.trace(root, data());
    expect(root.querySelector(".pt-mv-open")!.textContent).toBe("“部署好了嗎” → 放進「Title p-0001」的卡片");
    expect(acts().map((button) => button.textContent)).toEqual(["移回聊天", "改到…"]);
    root.querySelector<HTMLButtonElement>(".pt-mv-open")!.click();
    expect(panel()).not.toBeNull();
    expect(ui.isOpen("p-0001")).toBe(true);
  });

  it("says 你改到… when the user chose the card", () => {
    ui.trace(root, data({ by: "user" }));
    expect(root.querySelector(".pt-mv-open")!.textContent).toBe("“部署好了嗎” → 你改到「Title p-0001」的卡片");
  });

  it("移回聊天 asks the program part once, however often it is tapped before the answer, and can be asked again after", async () => {
    ui.trace(root, data());
    acts()[0]!.click();
    acts()[0]!.click();
    expect(call.mock.calls.filter(([method]) => method === "moveBack")).toEqual([["moveBack", { botId: "B1", rid: "r1" }]]);
    await flush();
    acts()[0]!.click();
    expect(call.mock.calls.filter(([method]) => method === "moveBack")).toHaveLength(2);
  });

  it("改到… lists the other cards of the chat (not this one), and a pick asks the program part to move it there", async () => {
    ui.trace(root, data());
    acts()[1]!.click();
    expect(acts()[1]!.getAttribute("aria-expanded")).toBe("true");
    const choices = [...root.querySelectorAll<HTMLButtonElement>(".pt-mv-alt")];
    expect(choices.map((choice) => choice.textContent)).toEqual(["Docs", "Old"]);
    choices[0]!.click();
    choices[0]!.click();
    expect(call.mock.calls.filter(([method]) => method === "moveTo")).toEqual([["moveTo", { botId: "B1", rid: "r1", to: "p-0002" }]]);
    await flush();
  });

  it("a second tap on 改到… closes the list", () => {
    ui.trace(root, data());
    acts()[1]!.click();
    acts()[1]!.click();
    expect(root.querySelector(".pt-mv-alts")).toBeNull();
  });

  it("once moved back, it says so and keeps the bot's answer under the line, as text", () => {
    ui.trace(root, data({ kind: "back", a: "還沒好 <img src=x onerror=\"window.pwned=1\">" }));
    expect(root.querySelector(".pt-mv-text")!.textContent).toBe("已移回聊天");
    expect(root.querySelector(".pt-mv-ans")!.textContent).toBe("bot：還沒好 <img src=x onerror=\"window.pwned=1\">");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".pt-mv-act")).toBeNull();
    ui.trace(root, data({ kind: "back" }));
    expect(root.querySelector(".pt-mv-ans")).toBeNull();
  });

  it("puts the user's words and a card's title in as text", () => {
    ui.trace(root, data({ q: "<b>x</b>", title: "<i>t</i>" }));
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("i")).toBeNull();
    expect(root.querySelector(".pt-mv-open")!.textContent).toContain("<b>x</b>");
  });

  it("a failed move shows why in the strip's line instead of failing silently", async () => {
    failing.add("moveBack");
    ui.trace(root, data());
    acts()[0]!.click();
    await flush();
    expect(top.querySelector(".pt-toast-text")!.textContent).toContain("moveBack failed");
  });
});

describe("a line the bot put into a card, in the card's thread", () => {
  const turn = (over: Partial<import("../src/model").Turn> = {}) => ({ rid: "r1", q: "部署好了嗎", a: "還沒好", qAt: clock, postedAt: clock, seenAt: clock, aAt: clock, via: "auto" as const, msgId: "u1", ...over });

  it("says the bot put it here (or that you moved it here) instead of the sent / seen receipt, and has a 移回聊天 for it", async () => {
    ui.update("B1", view(pin("p-0001", { thread: [turn(), turn({ rid: "r2", redirected: true }), { ...turn({ rid: "r3" }), via: "at" }] })));
    ui.open("p-0001");
    const receipts = [...panel()!.querySelectorAll(".pt-receipt")].map((node) => node.textContent!.split(" · ")[1]);
    expect(receipts.filter((_, index) => index % 2 === 0)).toEqual(["bot 判斷放進這裡", "你改到這裡", "bot 已看到"]);
    const backs = [...panel()!.querySelectorAll<HTMLButtonElement>(".pt-mv-act")];
    expect(backs).toHaveLength(2);
    backs[0]!.click();
    expect(call.mock.calls.filter(([method]) => method === "moveBack")).toEqual([["moveBack", { botId: "B1", rid: "r1" }]]);
    await flush();
  });
});

describe("what a worker said, in the card's thread and as a trace in the chat", () => {
  const report = (over: Partial<import("../src/model").Turn> = {}) => ({ rid: "w1", q: "", a: "完整報告\n第二行", qAt: clock, postedAt: null, seenAt: null, aAt: clock, via: "worker" as const, worker: "t-1", wkind: "final" as const, ...over });

  it("shows the whole report as the worker's own words (labelled by what it is), and a 移回聊天 only once the bot's reply was folded", async () => {
    ui.update("B1", view(pin("p-0001", { thread: [report(), report({ rid: "w2", wkind: "question", a: "用 A 還是 B？" }), report({ rid: "w3", wkind: "failed", a: "壞了", msgId: "m1" })] })));
    ui.open("p-0001");
    const bubbles = [...panel()!.querySelectorAll<HTMLElement>(".pt-worker")];
    expect(bubbles.map((node) => node.querySelector(".pt-bubble")!.textContent)).toEqual(["完整報告\n第二行", "用 A 還是 B？", "壞了"]);
    expect(bubbles.map((node) => node.querySelector(".pt-receipt")!.textContent!.split(" · ")[0])).toEqual(["worker 回報", "worker 提問", "worker 沒做完"]);
    expect(bubbles.map((node) => node.querySelectorAll(".pt-mv-act").length)).toEqual([0, 0, 1]);
    bubbles[2]!.querySelector<HTMLButtonElement>(".pt-mv-act")!.click();
    expect(call.mock.calls.filter(([method]) => method === "moveBack")).toEqual([["moveBack", { botId: "B1", rid: "w3" }]]);
    await flush();
  });

  it("the trace of a worker's report says where the full words are, and offers only 移回聊天 (no other card to move it to)", () => {
    const root = document.createElement("div");
    document.body.append(root);
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    ui.trace(root, { kind: "moved", rid: "w1", pin: "p-0001", title: "Title p-0001", q: "完整報告", by: "bot", worker: true });
    expect(root.querySelector(".pt-mv-open")!.textContent).toBe("worker 回報「完整報告」→ 完整內容在「Title p-0001」的卡片");
    expect([...root.querySelectorAll(".pt-mv-act")].map((node) => node.textContent)).toEqual(["移回聊天"]);
  });
});

describe("a card that may be outdated, and a card the app put away", () => {
  it("a stale card says 可能已過時 on its row and in its open card; one that is not does not", () => {
    ui.update("B1", view(pin("p-0001", { stale: true }), pin("p-0002")));
    expect(rows().map((row) => row.querySelector(".pt-stale")?.textContent ?? null)).toEqual(["可能已過時", null]);
    ui.open("p-0001");
    expect(panel()!.querySelector<HTMLElement>(".pt-stale")!.hidden).toBe(false);
    ui.update("B1", view(pin("p-0001"), pin("p-0002")));
    expect(panel()!.querySelector<HTMLElement>(".pt-stale")!.hidden).toBe(true);
  });

  it("a card put away by itself in the last day is offered back with 釘回 (also when it was the only card); a malformed or old entry is not drawn", async () => {
    const hidden = () => top.querySelector<HTMLElement>(".pt-strip")!.hidden;
    const lines = () => [...top.querySelectorAll<HTMLElement>(".pt-closed-line")];
    const closed = [
      { id: "p-0007", title: "做完的卡", at: clock - 3_600_000 },
      { id: "p-0008", title: "太舊", at: clock - 25 * 3_600_000 },
      { id: "../x", title: "壞 id", at: clock },
      { id: "p-0009", title: 5, at: clock },
      null,
    ] as unknown as { id: string; title: string; at: number }[];
    ui.update("B1", { ...view(), closed });
    expect(hidden()).toBe(false);
    expect(lines().map((line) => line.querySelector(".pt-toast-text")!.textContent)).toEqual(["「做完的卡」完成超過 1 小時，已自動收起"]);
    lines()[0]!.querySelector<HTMLButtonElement>("button")!.click();
    lines()[0]!.querySelector<HTMLButtonElement>("button")!.click(); // a double tap asks once
    expect(call.mock.calls.filter(([method]) => method === "repin")).toEqual([["repin", { botId: "B1", id: "p-0007" }]]);
    await flush();
    ui.update("B1", view(pin("p-0007", { state: "done" })));
    expect(lines()).toHaveLength(0);
    ui.update("B1", view());
    expect(hidden()).toBe(true);
  });
});

describe("what the app only suggests, and a merge put away", () => {
  const hidden = () => top.querySelector<HTMLElement>(".pt-strip")!.hidden;
  const lines = () => [...top.querySelectorAll<HTMLElement>(".pt-suggest-line")];
  const buttons = (line: HTMLElement) => [...line.querySelectorAll<HTMLButtonElement>("button")];

  it("a suggestion is a line with two buttons (also with no card on the strip); a malformed one is not drawn, and only two show", () => {
    const suggest = [
      { id: "s1", kind: "new", text: "整理舊報告" }, { id: "s2", kind: "merge", text: "同一件", title: "Deploy", title2: "Docs" },
      { id: "../x", kind: "new", text: "壞 id" }, { id: "s3", kind: "other", text: "x" }, { id: "s4", kind: "new", text: 5 }, null,
    ] as unknown as { id: string; kind: "new"; text: string }[];
    ui.update("B1", { ...view(), suggest });
    expect(hidden()).toBe(false);
    expect(lines().map((line) => line.querySelector(".pt-toast-text")!.textContent)).toEqual(["要把「整理舊報告」做成新卡片嗎？", "「Deploy」和「Docs」好像是同一件事，要合併嗎？"]);
    expect(lines().map((line) => buttons(line).map((button) => button.textContent))).toEqual([["建立卡片", "不用"], ["合併", "不用"]]);
    ui.update("B1", view());
    expect(hidden()).toBe(true);
  });

  it("a tap asks the program part once (a double tap too), a new card opens, and 不用 only dismisses", async () => {
    call.mockClear();
    call.mockImplementation(async (method: string) => (method === "acceptSuggest" ? { id: "p-0005" } : {}));
    try {
      ui.update("B1", { ...view(pin("p-0005")), suggest: [{ id: "s1", kind: "new", text: "整理舊報告" }, { id: "s2", kind: "merge", text: "同一件", title: "A", title2: "B" }] });
      const [make, no] = buttons(lines()[0]!);
      make!.click();
      make!.click();
      expect(call.mock.calls.filter(([method]) => method === "acceptSuggest")).toEqual([["acceptSuggest", { botId: "B1", id: "s1" }]]);
      await flush();
      expect(panel()?.dataset.pin).toBe("p-0005");
      buttons(lines()[1]!)[1]!.click();
      expect(call.mock.calls.at(-1)).toEqual(["dismissSuggest", { botId: "B1", id: "s2" }]);
      expect(no).toBeTruthy();
    } finally {
      call.mockImplementation(async (method: string) => { if (failing.has(method)) throw new Error(`${method} failed`); return {}; });
    }
  });

  it("a card merged into another is offered back (釘回) with where it went", () => {
    ui.update("B1", { ...view(pin("p-0001")), closed: [{ id: "p-0002", title: "Docs", at: clock - 1_000, into: "Deploy" }] });
    expect([...top.querySelectorAll(".pt-closed-line .pt-toast-text")].map((node) => node.textContent)).toEqual(["「Docs」已併入「Deploy」"]);
  });
});

describe("「你不在時」: the digest above the strip", () => {
  const H = 3_600_000;
  beforeEach(() => { clock = 20_000_000; });
  const digestAway = (over: Record<string, unknown> = {}) => ({
    from: clock - 3 * H, to: clock, collapsed: false, counts: { wait: 1, run: 1, done: 2 }, othersMore: 0,
    rows: [
      { id: "p-0001", title: "Deploy", state: "wait", status: "要你確認", source: "bot", at: clock - H, waitingSince: clock - 20 * 60_000 },
      { id: "p-0002", title: "Build", state: "run", status: "跑第 2 步", source: "bot", at: clock - 2 * H },
      { id: "p-0003", title: "Docs", state: "done", status: "寫好了", source: "user", at: clock - 2 * H },
      { id: "p-0004", title: "Lint", state: "done", status: "乾淨", source: "app", at: clock - 2 * H },
    ],
    others: [{ botId: "B2", name: "DAFAWU", text: "選一個版本", more: 1, messageId: "q9" }, { botId: "B3", name: "agent", text: "確認預算", more: 0 }],
    ...over,
  });
  const show = (away: unknown = digestAway()) => ui.update("B1", { ...view(...["p-0001", "p-0002", "p-0003", "p-0004"].map((id) => pin(id))), away } as never);
  const digest = () => top.querySelector<HTMLElement>(".pt-digest")!;

  it("draws the title with the gap, the three counters, a row per card (waiting first and orange, with how long it waits) and a line per other bot", () => {
    show();
    expect(digest().hidden).toBe(false);
    expect(digest().querySelector(".pt-d-title")!.textContent).toBe("你不在的 3 小時");
    expect([...digest().querySelectorAll(".pt-tile")].map((tile) => [tile.className.replace("pt-tile ", ""), tile.textContent])).toEqual([["pt-tile-wait", "1等你"], ["pt-tile-run", "1進行中"], ["pt-tile-done", "2做完"]]);
    const rows = [...digest().querySelectorAll<HTMLElement>(".pt-drow")];
    expect(rows.map((row) => row.dataset.pin)).toEqual(["p-0001", "p-0002", "p-0003", "p-0004"]);
    expect(rows[0]!.className).toContain("pt-drow-wait");
    expect(rows[0]!.querySelector(".pt-dtag-wait")!.textContent).toBe("等你 20 分鐘");
    expect(rows[0]!.textContent).toContain("Deploy：要你確認");
    const others = [...digest().querySelectorAll<HTMLElement>(".pt-orow")];
    expect(others.map((row) => row.textContent)).toEqual(["DAFAWU選一個版本另有 1 件", "agent確認預算"]);
    expect(digest().querySelector(".pt-d-label")!.textContent).toBe("別的 bot 也在等你 · 2");
  });

  it("a card row opens that card's panel; a row of another bot goes to that bot's chat (with the question's id when there is one)", () => {
    show();
    digest().querySelector<HTMLElement>('.pt-drow[data-pin="p-0002"]')!.click();
    expect(panel()!.querySelector(".pt-ptitle")!.textContent).toContain("Title p-0002");
    const others = [...digest().querySelectorAll<HTMLElement>(".pt-orow")];
    others[0]!.click();
    others[1]!.click();
    expect(openChat.mock.calls).toEqual([["B2", "q9"], ["B3", undefined]]);
    expect(call).not.toHaveBeenCalledWith("collapse", expect.anything());
  });

  it("看完了 asks the program part to fold it, once however often it is tapped, and again after 2 seconds", () => {
    vi.useFakeTimers();
    show();
    const close = digest().querySelector<HTMLButtonElement>(".pt-d-close")!;
    close.click();
    close.click();
    expect(call.mock.calls.filter(([method]) => method === "collapse")).toEqual([["collapse", { botId: "B1", collapsed: true }]]);
    vi.advanceTimersByTime(2_100);
    close.click();
    expect(call.mock.calls.filter(([method]) => method === "collapse")).toHaveLength(2);
  });

  it("folded, it is one chip with what was there; a tap on the chip asks to open it again", () => {
    show(digestAway({ collapsed: true }));
    expect(digest().querySelector(".pt-d-card")).toBeNull();
    const chip = digest().querySelector<HTMLButtonElement>(".pt-digest-chip")!;
    expect(chip.textContent).toBe("你不在時：1 等你 · 1 進行中 · 2 做完");
    chip.click();
    expect(call).toHaveBeenCalledWith("collapse", { botId: "B1", collapsed: false });
  });

  it("with only other bots' lines there are no tiles, and the chip says how many bots wait", () => {
    show(digestAway({ rows: [], counts: { wait: 0, run: 0, done: 0 } }));
    expect(digest().querySelector(".pt-d-tiles")).toBeNull();
    expect(digest().querySelectorAll(".pt-orow")).toHaveLength(2);
    show(digestAway({ rows: [], counts: { wait: 0, run: 0, done: 0 }, collapsed: true }));
    expect(digest().querySelector(".pt-digest-chip")!.textContent).toBe("你不在時：2 個 bot 在等你");
  });

  it("says how many more bots wait when the lines are cut", () => {
    show(digestAway({ othersMore: 3 }));
    expect(digest().querySelector(".pt-d-more")!.textContent).toBe("還有 3 個 bot");
  });

  it("is gone with no digest, and when it goes (the next message) the strip stays", () => {
    show();
    ui.update("B1", view(pin("p-0001")));
    expect(digest().hidden).toBe(true);
    expect(digest().children).toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });

  it("puts a bot's words in as text, and drops a digest that is not of the shape (draws nothing odd)", () => {
    show(digestAway({ others: [{ botId: "B2", name: "<i>x</i>", text: "<b>hi</b>", more: 0 }] }));
    expect(digest().querySelector(".pt-orow i")).toBeNull();
    expect(digest().querySelector(".pt-otext")!.textContent).toBe("<b>hi</b>");
    show({ from: "x", to: 3, rows: "no" });
    expect(digest().hidden).toBe(true);
    show([1, 2]);
    expect(digest().hidden).toBe(true);
  });

  it("a failed fold says why in the strip's line", async () => {
    failing.add("collapse");
    show();
    digest().querySelector<HTMLButtonElement>(".pt-d-close")!.click();
    await flush();
    expect(top.querySelector(".pt-toast-text")!.textContent).toContain("collapse failed");
  });

  it("is taken away with the ui", () => {
    show();
    ui.dispose();
    expect(top.querySelector(".pt-digest")).toBeNull();
  });
});
