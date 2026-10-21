/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { PinArea } from "../src/pins";
import { parseInterval, refreshWords } from "../src/refresh";
import { chatSize, componentElement } from "../src/components";
import type { ChatState, ComponentInfo, DisplayView, MessageView, PinSize, PinView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  提交紀錄: { template: "<div>log</div>", version: 1, working: false, updated: false, hasPrevious: false },
  天氣卡片: { template: "<div>weather</div>", version: 1, working: false, updated: false, hasPrevious: false },
};

function message(displays: DisplayView[]): MessageView {
  return {
    id: "m1", role: "bot", text: "Here:", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
  };
}

function pin(overrides: Partial<PinView> = {}): PinView {
  return {
    id: "P1", name: "提交紀錄", headline: "f472a1c · Merge bot/sidebar-a · 20", chip: { text: "f472a1c · Mer…", tone: "neutral" }, size: "2x2", refresh: "shown", minutes: 15,
    display: { name: "提交紀錄", data: "[]", command: "python3 git-log-json.py 20", folder: "/p", status: "done", ranAt: "10:42" },
    ...overrides,
  };
}

function state(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "ClaudeCodeBot", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, pins: [], pinChoices: [], board: false, ...overrides,
  };
}

function setUp(): PinArea {
  document.body.innerHTML = `<main id="scroller"></main><section id="board"></section><div id="pin-area"></div><div id="composer-slot"></div>`;
  return new PinArea(document.getElementById("pin-area")!, document.getElementById("board")!);
}

const click = (element: Element | null | undefined) => (element as HTMLElement).click();

beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("pinning from the chat", () => {
  it("a component you can pin shows pin, refresh and more on hover", () => {
    const row = messageElement(message([{ name: "提交紀錄", data: "[]", command: "git log", folder: "/p", status: "done", pinned: false }]), components);
    const bar = row.querySelector(".pin-bar")!;
    expect(bar.querySelector("[aria-label='Pin to this bot']")).not.toBeNull();
    expect(bar.querySelector("[aria-label='Run the command again']")).not.toBeNull();
    expect(bar.querySelector("[aria-label='More']")).not.toBeNull();
    click(bar.querySelector("[aria-label='Run the command again']"));
    expect(sent).toEqual([{ type: "componentCommand", messageID: "m1", index: 0, command: "git log", folder: "/p", force: true }]);
  });

  it("no bar where nothing can be pinned, and a badge once pinned", () => {
    expect(messageElement(message([{ name: "提交紀錄", data: "[]" }]), components).querySelector(".pin-bar")).toBeNull();
    const row = messageElement(message([{ name: "天氣卡片", data: "{}", pinned: true }]), components);
    expect(row.querySelector(".pin-badge")?.textContent).toContain("Pinned");
    // A component without a command has nothing to run again.
    expect(row.querySelector("[aria-label='Run the command again']")).toBeNull();
  });

  it("pin asks how to refresh, shows the command, then offers Undo", () => {
    setUp().update(state());
    const row = messageElement(message([{ name: "提交紀錄", data: "[]", command: "git log -5", folder: "/p", status: "done", pinned: false }]), components);
    document.body.append(row);
    click(row.querySelector("[aria-label='Pin to this bot']"));
    const dialog = document.querySelector(".pin-dialog")!;
    expect(dialog.textContent).toContain("Pin to ClaudeCodeBot");
    expect(dialog.querySelector(".pin-dialog-command")?.textContent).toBe("git log -5");
    const every = dialog.querySelector<HTMLInputElement>("input[value='interval']")!;
    every.checked = true;
    dialog.querySelector<HTMLInputElement>(".pin-minutes")!.value = "5";
    click(dialog.querySelector(".pin-dialog .primary"));
    expect(document.querySelector(".pin-dialog")).toBeNull();
    const action = sent[0] as { type: string; id: string };
    expect(action).toMatchObject({ type: "pin", messageID: "m1", index: 0, refresh: "interval", minutes: 5 });
    expect(action.id).toMatch(/^[0-9A-F-]{36}$/i);
    const toast = document.querySelector(".pin-toast")!;
    expect(toast.textContent).toContain("Pinned 提交紀錄 to ClaudeCodeBot");
    click(toast.querySelector("button"));
    expect(sent[1]).toEqual({ type: "unpin", id: action.id });
  });

  it("a component without a command pins as it was drawn, without asking how to refresh", () => {
    setUp().update(state());
    const row = messageElement(message([{ name: "天氣卡片", data: "{}", pinned: false }]), components);
    document.body.append(row);
    click(row.querySelector("[aria-label='Pin to this bot']"));
    const dialog = document.querySelector(".pin-dialog")!;
    expect(dialog.querySelector("input[value='interval']")).toBeNull();
    expect(dialog.textContent).toContain("as it is drawn now");
    click(dialog.querySelector(".primary"));
    expect(sent[0]).toMatchObject({ type: "pin", messageID: "m1", index: 0, refresh: "manual" });
  });
});

describe("the chips above the input box", () => {
  it("one chip per pin with its line; clicking raises the full component", () => {
    const area = setUp();
    area.update(state({ pins: [pin(), pin({ id: "P2", name: "天氣卡片", headline: "台北 · 多雲", refresh: "manual", display: { name: "天氣卡片", data: "{}" } })] }));
    const chips = document.querySelectorAll<HTMLButtonElement>(".pin-chip:not(.add)");
    expect(chips).toHaveLength(2);
    // The name is in its tooltip; the chip shows an icon and a short status.
    expect(chips[0].title).toContain("提交紀錄");
    expect(chips[0].textContent).toContain("f472a1c");
    chips[0].click();
    const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
    expect(sheet.hidden).toBe(false);
    expect(sheet.getAttribute("aria-label")).toBe("提交紀錄");
    expect(sheet.querySelector("iframe.component-frame")).not.toBeNull();
    expect(sent).toEqual([{ type: "pinShown", ids: ["P1"] }]);
    // ↻ on the sheet runs it again.
    click(sheet.querySelector("[aria-label^='Refresh']"));
    expect(sent[1]).toEqual({ type: "pinCommand", id: "P1", command: "python3 git-log-json.py 20", folder: "/p", force: true });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sheet.hidden).toBe(true);
  });

  it("an opened pin is as tall as its content; its top edge drags the most it grows to", () => {
    const area = setUp();
    area.update(state({ pins: [pin()] }));
    click(document.querySelector(".pin-chip"));
    sent.length = 0;
    const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
    const frame = sheet.querySelector<HTMLIFrameElement>(".component-frame")!;
    // As tall as its content: no height of its own, the page not told to fill.
    expect(sheet.style.height).toBe("");
    expect(sheet.style.maxHeight).toBe("");
    expect(frame.srcdoc).not.toMatch(/<html[^>]*data-fill/);
    Object.defineProperty(sheet, "offsetHeight", { configurable: true, value: 300 });
    const pointer = (type: string, y: number) => new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true });
    sheet.querySelector<HTMLElement>(".pin-sheet-resize")!.dispatchEvent(pointer("pointerdown", 500));
    // It rises from the input box: up is taller. While dragged it is exactly that tall, to see it.
    window.dispatchEvent(pointer("pointermove", 400));
    expect(sheet.style.height).toBe("400px");
    expect(sheet.classList.contains("sized")).toBe(true);
    // Never shorter than 120px, never taller than the window leaves room for.
    window.dispatchEvent(pointer("pointermove", 2000));
    expect(sheet.style.height).toBe("120px");
    window.dispatchEvent(pointer("pointermove", -5000));
    expect(sheet.style.height).toBe(`${window.innerHeight - 140}px`);
    window.dispatchEvent(pointer("pointermove", 380));
    window.dispatchEvent(pointer("pointerup", 380));
    expect(sent).toEqual([{ type: "setPinHeight", id: "P1", height: 420 }]);
    // Let go, that is the most it grows to: a shorter component leaves no empty area under it.
    expect(sheet.style.height).toBe("");
    expect(sheet.style.maxHeight).toBe("420px");
    // Swift keeps it; the component is still drawn at its content's height, not filling.
    area.update(state({ pins: [pin({ panelHeight: 420 })] }));
    expect(sheet.style.maxHeight).toBe("420px");
    expect(sheet.style.height).toBe("");
    const kept = sheet.querySelector<HTMLIFrameElement>(".component-frame")!;
    expect(kept.srcdoc).not.toMatch(/<html[^>]*data-fill/);
    // Another limit keeps the same frame.
    area.update(state({ pins: [pin({ panelHeight: 360 })] }));
    expect(sheet.style.maxHeight).toBe("360px");
    expect(sheet.querySelector(".component-frame")).toBe(kept);
    // A double-click takes the limit away.
    sheet.querySelector<HTMLElement>(".pin-sheet-resize")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "setPinHeight", id: "P1", height: null });
    area.update(state({ pins: [pin({ panelHeight: null })] }));
    expect(sheet.style.maxHeight).toBe("");
    expect(sheet.classList.contains("sized")).toBe(false);
  });

  it("an opened pin has the floating card's header: icon, its own name, status, ↻ ⋯ and collapse", () => {
    const css = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const area = setUp();
      const named = { ...components, 提交紀錄: { ...components.提交紀錄, title: "提交紀錄卡" } };
      area.update(state({ components: named, pins: [pin()] }));
      click(document.querySelector(".pin-chip"));
      const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
      expect([...sheet.children].map((child) => child.className)).toEqual(["pin-sheet-resize resize-handle", "pin-sheet-head pin-head", "pin-sheet-body"]);
      const head = sheet.querySelector<HTMLElement>(".pin-head")!;
      // Its name from about.md; the folder's name in the tooltip.
      expect(head.querySelector(".pin-head-title")?.textContent).toBe("提交紀錄卡");
      expect(head.querySelector<HTMLElement>(".pin-head-title")?.title).toBe("提交紀錄");
      expect(sheet.getAttribute("aria-label")).toBe("提交紀錄卡");
      expect(head.querySelector(".pin-head-status")?.textContent).toBe("f472a1c · Mer…");
      expect(head.querySelector(".pin-chip-icon")).not.toBeNull();
      expect([...head.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Refresh (Updated 10:42)", "More", "Collapse"]);
      // The same header and card as a floating pin: one rule for both.
      expect(css).toMatch(/\.pin-sheet, \.float-card \{[^}]*border-radius: 16px/);
      expect(css).toMatch(/\.pin-sheet-body, \.float-body \{[^}]*overflow-y: auto/);
      // The component under it has no padding and draws no frame of its own.
      const body = sheet.querySelector<HTMLElement>(".pin-sheet-body")!;
      expect(getComputedStyle(body).padding).toMatch(/^(0px|)$/);
      const frame = sheet.querySelector<HTMLIFrameElement>(".component-frame")!;
      expect(frame.srcdoc).toContain('data-surface="pinned"');
      // A new status redraws the header, not the component.
      area.update(state({ components: named, pins: [pin({ chip: { text: "9a1b2c3", tone: "good" } })] }));
      expect(head.querySelector(".pin-head-status")?.textContent).toBe("9a1b2c3");
      expect(head.querySelector<HTMLElement>(".pin-head-status")?.dataset.tone).toBe("good");
      expect(sheet.querySelector(".component-frame")).toBe(frame);
      // Its name, when it ran and its command are in the more menu, with Report.
      click(head.querySelector("[aria-label='More']"));
      expect(document.querySelector(".pin-menu-heading")?.textContent).toBe("提交紀錄");
      expect([...document.querySelectorAll(".pin-menu-note")].map((n) => n.textContent)).toEqual(["Updated 10:42", "$ python3 git-log-json.py 20"]);
      expect([...document.querySelectorAll(".pin-menu button")].some((b) => b.textContent === "Report this component…")).toBe(true);
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // No report flag over the component (it covered the last row).
      expect(getComputedStyle(sheet.querySelector<HTMLElement>(".component-side")!).display).toBe("none");
      // Collapse puts it away.
      click(sheet.querySelector(".pin-head [aria-label='Collapse']"));
      expect(sheet.hidden).toBe(true);
    } finally {
      style.remove();
    }
  });

  it("no pins, no chips", () => {
    setUp().update(state());
    expect(document.querySelector<HTMLElement>(".pin-dock")!.hidden).toBe(true);
  });

  it("a pinned command not allowed yet asks on the sheet, with the command it showed", () => {
    const area = setUp();
    area.update(state({ pins: [pin({ headline: "Needs your OK", display: { name: "提交紀錄", data: "null", command: "git log", folder: "/p", status: "approve" } })] }));
    click(document.querySelector(".pin-chip"));
    click(document.querySelector(".pin-sheet .command-allow"));
    expect(sent.at(-1)).toEqual({ type: "pinCommand", id: "P1", command: "git log", folder: "/p", approve: true });
  });

  it("drag a chip onto another to reorder; right-click to unpin", () => {
    const area = setUp();
    area.update(state({ pins: [pin(), pin({ id: "P2", name: "天氣卡片" }), pin({ id: "P3", name: "x" })] }));
    const chips = document.querySelectorAll<HTMLElement>(".pin-chip:not(.add)");
    chips[2].dispatchEvent(new Event("dragstart", { bubbles: true }));
    chips[0].dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(sent).toEqual([{ type: "movePin", id: "P3", to: 0 }]);
    chips[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const unpin = [...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")].find((b) => b.textContent === "Unpin")!;
    unpin.click();
    expect(sent.at(-1)).toEqual({ type: "unpin", id: "P2" });
  });

  it("the + chip opens the picker of this bot's components", () => {
    const area = setUp();
    area.update(state({
      pins: [pin()],
      pinChoices: [
        { name: "提交紀錄", command: "git log", uses: 31, pinned: true },
        { name: "天氣卡片", command: null, uses: 7, pinned: false },
      ],
    }));
    click(document.querySelector(".pin-chip.add"));
    const rows = document.querySelectorAll<HTMLButtonElement>(".pin-picker-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Command");
    expect(rows[0].disabled).toBe(true);
    expect(rows[1].textContent).toContain("Snapshot");
    rows[1].click();
    expect(sent[0]).toMatchObject({ type: "pin", name: "天氣卡片", refresh: "manual" });
    expect(document.querySelector(".pin-picker")).toBeNull();
  });
});

describe("chips as small status icons", () => {
  const iconed: Record<string, ComponentInfo> = {
    ...components,
    提交紀錄: { ...components.提交紀錄, icon: "📜" },
    天氣卡片: { ...components.天氣卡片, icon: "cloud.sun.fill", iconImage: "data:image/png;base64,AAAA" },
  };

  it("each chip is the component's icon with a short status; the full name and line in the tooltip", () => {
    const area = setUp();
    area.update(state({ components: iconed, pins: [
      pin({ chip: { text: "719364f", tone: "neutral" } }),
      pin({ id: "P2", name: "天氣卡片", headline: "台北 · 多雲", chip: { text: "26°", tone: "good" }, display: { name: "天氣卡片", data: "{}" } }),
      pin({ id: "P3", name: "daily-chats-pie", headline: "ClaudeCodeBot · 3", chip: { text: "", tone: "bad" }, display: { name: "daily-chats-pie", data: "{}" } }),
    ] }));
    const chips = [...document.querySelectorAll<HTMLButtonElement>(".pin-chip:not(.add)")];
    expect(chips).toHaveLength(3);
    // No name on the chip itself.
    expect(document.querySelector(".pin-chip-name")).toBeNull();
    expect(chips.map((chip) => chip.querySelector(".pin-chip-status")?.textContent ?? null)).toEqual(["719364f", "26°", null]);
    expect(chips[0].title).toBe("提交紀錄 — f472a1c · Merge bot/sidebar-a · 20");
    expect(chips[0].getAttribute("aria-label")).toBe("提交紀錄: 719364f");
    // An emoji icon as text, an SF Symbol as its picture tinted by the chip, else a generic icon.
    expect(chips[0].querySelector(".pin-chip-icon")?.textContent).toBe("📜");
    const symbol = chips[1].querySelector<HTMLElement>(".pin-chip-icon .pin-chip-symbol")!;
    expect(symbol.style.maskImage || symbol.style.getPropertyValue("-webkit-mask-image")).toContain("data:image/png;base64,AAAA");
    expect(chips[2].querySelector(".pin-chip-icon svg")).not.toBeNull();
    // A tone other than neutral is a dot on the icon.
    expect(chips.map((chip) => chip.dataset.tone)).toEqual(["neutral", "good", "bad"]);
    expect(chips.map((chip) => !!chip.querySelector(".pin-chip-dot"))).toEqual([false, true, true]);
  });

  it("chips are compact: several fit on one row", () => {
    const css = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    const rule = css.match(/\.pin-chip \{[^}]*\}/)?.[0] ?? "";
    const px = (name: string) => Number(rule.match(new RegExp(`${name}: (\\d+)px`))?.[1]);
    expect(px("max-width")).toBeLessThanOrEqual(140);
    expect(px("height")).toBeLessThanOrEqual(28);
  });

  it("a pin without a chip status (an older app) falls back to its line", () => {
    const area = setUp();
    area.update(state({ pins: [pin({ chip: undefined })] }));
    expect(document.querySelector(".pin-chip-status")?.textContent).toBe("f472a1c · Merge bot/sidebar-a · 20");
  });

  it("a pinned component's ccb.setStatus sets its chip; a chat card's is ignored", () => {
    const area = setUp();
    area.update(state({ pins: [pin()] }));
    click(document.querySelector(".pin-chip"));
    sent.length = 0;
    const frame = document.querySelector<HTMLIFrameElement>(".pin-sheet .component-frame")!;
    expect(frame.srcdoc).toContain("setStatus(");
    const say = (data: unknown, source = frame.contentWindow) => window.dispatchEvent(new MessageEvent("message", { data, source }));
    say({ ccb: "status", text: "3 new", tone: "good" });
    say({ ccb: "status", text: 42, tone: null });
    say({ ccb: "status", clear: true });
    expect(sent).toEqual([
      { type: "pinStatus", id: "P1", text: "3 new", tone: "good" },
      { type: "pinStatus", id: "P1", text: "42", tone: null },
      { type: "pinStatus", id: "P1", text: null, tone: null },
    ]);
    // The sheet keeps its frame when only the chip's status changes.
    area.update(state({ pins: [pin({ chip: { text: "3 new", tone: "good" } })] }));
    expect(document.querySelector(".pin-sheet .component-frame")).toBe(frame);

    sent.length = 0;
    const row = messageElement(message([{ name: "提交紀錄", data: "[]" }]), components);
    document.body.append(row);
    say({ ccb: "status", text: "x" }, row.querySelector<HTMLIFrameElement>(".component-frame")!.contentWindow);
    expect(sent).toEqual([]);
  });

  it("a Board tile's ccb.setStatus sets its chip too, and keeps the tile's frame", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin()] }));
    sent.length = 0;
    const frame = document.querySelector<HTMLIFrameElement>(".board-card .component-frame")!;
    window.dispatchEvent(new MessageEvent("message", { data: { ccb: "status", text: "ok", tone: "good" }, source: frame.contentWindow }));
    expect(sent).toEqual([{ type: "pinStatus", id: "P1", text: "ok", tone: "good" }]);
    area.update(state({ board: true, pins: [pin({ chip: { text: "ok", tone: "good" } })] }));
    expect(document.querySelector(".board-card .component-frame")).toBe(frame);
  });
});

describe("the Board", () => {
  it("shows every pin as a card of its size in cells, and refreshes those shown", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin({ size: "4x2" }), pin({ id: "P2", name: "天氣卡片", size: "1x1", refresh: "manual", display: { name: "天氣卡片", data: "{}" } })] }));
    expect(document.body.classList.contains("board")).toBe(true);
    const cards = document.querySelectorAll<HTMLElement>(".board-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains("size-4x2")).toBe(true);
    expect([cards[0].style.gridColumn, cards[0].style.gridRow]).toEqual(["span 4", "span 2"]);
    expect([cards[1].style.gridColumn, cards[1].style.gridRow]).toEqual(["span 1", "span 1"]);
    expect(document.querySelector(".board-title")?.textContent).toBe("ClaudeCodeBot");
    expect(sent).toEqual([{ type: "pinShown", ids: null }]);
    // Drawn again with nothing changed: not asked again, and the card is the same element.
    area.update(state({ board: true, pins: [pin({ size: "4x2" }), pin({ id: "P2", name: "天氣卡片", size: "1x1", refresh: "manual", display: { name: "天氣卡片", data: "{}" } })] }));
    expect(sent).toHaveLength(1);
    expect(document.querySelectorAll(".board-card")[0]).toBe(cards[0]);
  });

  it("each card's menu resizes, reorders and unpins it; Refresh all runs every command", () => {
    const area = setUp();
    const sized = { ...components, 提交紀錄: { ...components.提交紀錄, sizes: ["1x1", "2x1", "2x2"] as PinSize[] } };
    area.update(state({ board: true, components: sized, pins: [pin({ size: "2x2" }), pin({ id: "P2", name: "天氣卡片", size: "4x2" })] }));
    sent.length = 0;
    const menuOf = (index: number) => {
      click(document.querySelectorAll(".board-card")[index].querySelector("[aria-label='More']"));
      return [...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")];
    };
    // Every size from 1×1 to 4×4, whatever its about.md's Sizes: line says (only marked as hints).
    const sizesIn = (items: HTMLButtonElement[]) => items.filter((b) => b.closest(".pin-size-grid")).map((b) => b.getAttribute("aria-label"));
    const every = ["Small 1×1", "Wide 2×1", "3×1", "4×1", "Tall 1×2", "Large 2×2", "3×2", "Extra wide 4×2", "1×3", "2×3", "3×3", "4×3", "1×4", "2×4", "3×4", "4×4"];
    expect(sizesIn(menuOf(0))).toEqual(every);
    expect([...document.querySelectorAll(".pin-size-grid button.hint")].map((b) => b.getAttribute("aria-label"))).toEqual(["Small 1×1", "Wide 2×1", "Large 2×2"]);
    expect(document.querySelector(".pin-size-grid button.checked")?.getAttribute("aria-label")).toBe("Large 2×2");
    // Pointing at a cell lights the cells it would span and says its size.
    const cell = (label: string) => [...document.querySelectorAll<HTMLButtonElement>(".pin-size-grid button")].find((b) => b.getAttribute("aria-label") === label)!;
    cell("3×4").dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.querySelectorAll(".pin-size-grid button.lit")).toHaveLength(12);
    expect(document.querySelector(".pin-size-caption")?.textContent).toBe("3×4");
    cell("4×3").click();
    expect(sent.at(-1)).toEqual({ type: "resizePin", id: "P1", size: "4x3" });
    expect(document.querySelector(".pin-menu")).toBeNull();
    // One whose about.md names no sizes may still be any size.
    expect(sizesIn(menuOf(1))).toEqual(every);
    expect(document.querySelectorAll(".pin-size-grid button.hint")).toHaveLength(0);
    expect(document.querySelector(".pin-size-grid button.checked")?.getAttribute("aria-label")).toBe("Extra wide 4×2");
    // The size button on the card offers the same.
    click(document.querySelectorAll(".board-card")[0].querySelector(".board-size"));
    expect([...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")].map((b) => b.getAttribute("aria-label"))).toEqual(every);
    menuOf(1).find((b) => b.textContent === "Move earlier")!.click();
    expect(sent.at(-1)).toEqual({ type: "movePin", id: "P2", to: 0 });
    menuOf(0).find((b) => b.getAttribute("aria-label") === "Every 15 min")!.click();
    expect(sent.at(-1)).toEqual({ type: "setPinRefresh", id: "P1", refresh: "interval", minutes: 15 });
    menuOf(1).find((b) => b.textContent === "Unpin")!.click();
    expect(sent.at(-1)).toEqual({ type: "unpin", id: "P2" });
    sent.length = 0;
    click(document.querySelector(".board-refresh-all"));
    expect(sent).toEqual([
      { type: "pinCommand", id: "P1", command: "python3 git-log-json.py 20", folder: "/p", force: true },
      { type: "pinCommand", id: "P2", command: "python3 git-log-json.py 20", folder: "/p", force: true },
    ]);
  });

  it("leaving the Board shows the chat again", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin()] }));
    area.update(state({ board: false, pins: [pin()] }));
    expect(document.body.classList.contains("board")).toBe(false);
  });

  it("a card's content fits the card: no wider minimum, no sideways scroll, long errors wrap", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    document.head.append(style);
    try {
      const area = setUp();
      area.update(state({ board: true, pins: [
        pin(),
        pin({ id: "P2", display: { name: "提交紀錄", data: "", command: "git log --oneline --decorate=short refs/heads/main", folder: "/p", status: "failed", error: "The command printed more than 512 KB, so it was stopped." } }),
      ] }));
      const [done, failed] = [...document.querySelectorAll<HTMLElement>(".board-card-body")];
      // The column can be 260px wide; a 280px minimum inside it overflowed the card sideways and
      // scrolled its start out of sight ("he command failed").
      for (const body of [done, failed]) {
        expect(getComputedStyle(body).overflowX).toBe("hidden");
        for (const element of body.querySelectorAll<HTMLElement>(".command-card, .component-frame")) {
          expect(["0", "0px"]).toContain(getComputedStyle(element).minWidth);
        }
      }
      expect(done.querySelector(".component-frame")).not.toBeNull();
      const detail = failed.querySelector<HTMLElement>(".command-error pre")!;
      expect(getComputedStyle(detail).whiteSpace).toBe("pre-wrap");
    } finally {
      style.remove();
    }
  });

  it("a tile is its component, like a widget: no header, controls float over it on hover", () => {
    const css = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const area = setUp();
      area.update(state({ board: true, pins: [
        pin(),
        pin({ id: "P2", display: { name: "提交紀錄", data: "", command: "git log", folder: "/p", status: "approve" } }),
      ] }));
      const [card, asking] = [...document.querySelectorAll<HTMLElement>(".board-card")];
      // No header row: the body, then the floating tools.
      expect(card.querySelector(".board-card-head, .board-card-title, .pin-when")).toBeNull();
      expect([...card.children].map((child) => child.className)).toEqual(["board-card-body", "board-card-tools", "board-move resize-handle", "board-resize-e resize-handle", "board-resize-s resize-handle", "board-resize resize-handle"]);
      // The component's frame fills the tile with no padding around it.
      const body = card.querySelector<HTMLElement>(".board-card-body")!;
      expect(getComputedStyle(body).padding).toMatch(/^(0px|)$/);
      const frame = card.querySelector<HTMLIFrameElement>(".component-frame")!;
      expect(frame.srcdoc).toContain('data-surface="board"');
      expect(frame.srcdoc).toContain('surface: "board"');
      // The tools are hidden until hovered or focused, and keyboard reachable buttons.
      const tools = card.querySelector<HTMLElement>(".board-card-tools")!;
      expect(getComputedStyle(tools).position).toBe("absolute");
      expect(getComputedStyle(tools).opacity).toBe("0");
      expect(css).toMatch(/\.board-card:hover > \.board-card-tools, \.board-card\.hovered > \.board-card-tools, \.board-card-tools:focus-within/);
      // The pointer over the component (inside its frame) shows them too.
      window.dispatchEvent(new MessageEvent("message", { data: { ccb: "hover", on: true }, source: frame.contentWindow }));
      expect(card.classList.contains("hovered")).toBe(true);
      window.dispatchEvent(new MessageEvent("message", { data: { ccb: "hover", on: false }, source: frame.contentWindow }));
      expect(card.classList.contains("hovered")).toBe(false);
      expect([...tools.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Size: Large 2×2", "Refresh (Updated 10:42)", "More"]);
      // When it ran is in the ⋯ menu, with its name and command.
      click(tools.querySelector("[aria-label='More']"));
      expect(document.querySelector(".pin-menu-heading")?.textContent).toBe("提交紀錄");
      expect([...document.querySelectorAll(".pin-menu-note")].map((n) => n.textContent)).toEqual(["Updated 10:42", "$ python3 git-log-json.py 20"]);
      expect(document.activeElement?.closest(".pin-menu")).not.toBeNull();
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector(".pin-menu")).toBeNull();
      // Allow and run is in sight without hovering, filling the tile.
      expect(asking.querySelector(".board-card-body .command-allow")).not.toBeNull();
      // The report flag sits over the corner instead of keeping a strip beside the component.
      expect(getComputedStyle(card.querySelector<HTMLElement>(".board-card-body .component-side")!).position).toBe("absolute");
    } finally {
      style.remove();
    }
  });

  it("lays the Board out in square cells from its width, like home-screen widgets", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    document.head.append(style);
    try {
      const area = setUp();
      const grid = () => document.querySelector<HTMLElement>(".board-grid")!;
      // Until measured: columns of at least 150px (the page's boardCell), rows 160px tall, gaps filled densely.
      const look = getComputedStyle(grid());
      expect(look.gridTemplateColumns).toBe("repeat(var(--board-cols, auto-fill), minmax(min(var(--board-cell-min), 100%), 1fr))");
      expect(document.documentElement.style.getPropertyValue("--board-cell-min")).toBe("150px");
      expect(document.documentElement.style.getPropertyValue("--board-gap")).toBe("14px");
      expect(look.gridAutoRows).toBe("var(--board-cell, 160px)");
      expect(look.gridAutoFlow).toBe("dense");
      let width = 1140;
      Object.defineProperty(grid(), "clientWidth", { configurable: true, get: () => width });
      const pins = [pin({ size: "4x2" }), pin({ id: "P2", size: "2x1" }), pin({ id: "P3", size: "1x2" }), pin({ id: "P4", size: "1x1" })];
      area.update(state({ board: true, pins }));
      // 1140px: seven columns of 150px (14px gaps), and rows as tall as a column is wide.
      expect(grid().style.getPropertyValue("--board-cols")).toBe("7");
      expect(grid().style.getPropertyValue("--board-cell")).toBe("150px");
      const spans = () => [...document.querySelectorAll<HTMLElement>(".board-card")].map((card) => `${card.style.gridColumn}/${card.style.gridRow}`);
      expect(spans()).toEqual(["span 4/span 2", "span 2/span 1", "span 1/span 2", "span 1/span 1"]);
      // The add tile is one cell.
      expect(document.querySelector<HTMLElement>(".board-add")!.style.gridColumn).toBe("");
      // A narrow Board has fewer columns; a card wider than that spans them all, never more.
      width = 330;
      area.update(state({ board: true, pins }));
      expect(grid().style.getPropertyValue("--board-cols")).toBe("2");
      expect(grid().style.getPropertyValue("--board-cell")).toBe("158px");
      expect(spans()[0]).toBe("span 2/span 2");
    } finally {
      style.remove();
    }
  });

  it("a resized card keeps its component and tells it the new size", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin({ size: "2x2" })] }));
    const frame = document.querySelector<HTMLIFrameElement>(".board-card .component-frame")!;
    expect(frame.srcdoc).toContain('<html data-size="2x2" data-surface="board" data-fill>');
    expect(frame.srcdoc).toContain('{"w":2,"h":2,"name":"large"}');
    const told: unknown[] = [];
    frame.contentWindow!.postMessage = ((data: unknown) => told.push(data)) as Window["postMessage"];
    area.update(state({ board: true, pins: [pin({ size: "2x1" })] }));
    expect(document.querySelector(".board-card .component-frame")).toBe(frame);
    expect(told).toEqual([{ ccbSize: { w: 2, h: 1, name: "wide" } }]);
    const card = document.querySelector<HTMLElement>(".board-card")!;
    expect(card.classList.contains("size-2x1")).toBe(true);
    expect(card.querySelector(".board-size")?.textContent).toBe("2×1");
  });

  it("dragging a tile's corner resizes it cell by cell, up to 4×4, and keeps the size", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin({ size: "2x2" })] }));
    sent.length = 0;
    const card = document.querySelector<HTMLElement>(".board-card")!;
    const handle = card.querySelector<HTMLElement>(".board-resize")!;
    expect(handle).not.toBeNull();
    const frame = card.querySelector<HTMLIFrameElement>(".component-frame")!;
    const told: unknown[] = [];
    frame.contentWindow!.postMessage = ((data: unknown) => told.push(data)) as Window["postMessage"];
    // Cells of 150px with 14px gaps (until the Board has measured): a 2×2 tile is 314px square.
    const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    handle.dispatchEvent(pointer("pointerdown", 0, 0));
    expect(card.classList.contains("resizing")).toBe(true);
    expect(document.body.classList.contains("pin-resizing")).toBe(true);
    // Two cells wider and one taller: 4×3, the tile and its component follow at once.
    window.dispatchEvent(pointer("pointermove", 2 * 164, 164));
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 4", "span 3"]);
    expect(card.querySelector(".board-size")?.textContent).toBe("4×3");
    expect(told).toEqual([{ ccbSize: { w: 4, h: 3, name: "xlarge" } }]);
    // Past 4×4 it stops there; smaller than a cell, 1×1.
    window.dispatchEvent(pointer("pointermove", 2000, 2000));
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 4", "span 4"]);
    window.dispatchEvent(pointer("pointermove", -2000, -2000));
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 1", "span 1"]);
    // Halfway into a cell snaps to the nearer.
    window.dispatchEvent(pointer("pointermove", 164 + 90, 60));
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 4", "span 2"]);
    expect(sent).toEqual([]);
    window.dispatchEvent(pointer("pointerup", 164 + 90, 60));
    expect(sent).toEqual([{ type: "resizePin", id: "P1", size: "4x2" }]);
    expect(card.classList.contains("resizing")).toBe(false);
    expect(document.body.classList.contains("pin-resizing")).toBe(false);
    // Kept at that size until Swift says so, then it is the card's size, same frame.
    expect(card.style.gridColumn).toBe("span 4");
    area.update(state({ board: true, pins: [pin({ size: "4x2" })] }));
    expect(document.querySelector(".board-card")).toBe(card);
    expect(card.querySelector(".component-frame")).toBe(frame);
    expect(card.dataset.preview).toBeUndefined();
    expect(card.classList.contains("size-4x2")).toBe(true);
    // A drag that ends where it began asks nothing.
    sent.length = 0;
    card.querySelector<HTMLElement>(".board-resize")!.dispatchEvent(pointer("pointerdown", 0, 0));
    window.dispatchEvent(pointer("pointermove", 20, 20));
    window.dispatchEvent(pointer("pointerup", 20, 20));
    expect(sent).toEqual([]);
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 4", "span 2"]);
  });

  it("a tile is moved by dragging it with the mouse, though its component's frame covers it", () => {
    const area = setUp();
    const pins = [pin({ id: "P1", size: "2x2" }), pin({ id: "P2", size: "1x1" }), pin({ id: "P3", size: "2x1" })];
    area.update(state({ board: true, pins }));
    sent.length = 0;
    const cards = () => [...document.querySelectorAll<HTMLElement>(".board-card")];
    const [first, second, third] = cards();
    const frames = first.querySelectorAll("iframe.component-frame");
    // Where each tile is on screen: three in a row, 200px apart (jsdom lays nothing out).
    const place = (card: HTMLElement, left: number) => {
      card.getBoundingClientRect = () => ({ left, top: 0, right: left + 150, bottom: 150, width: 150, height: 150, x: left, y: 0, toJSON() {} }) as DOMRect;
    };
    place(first, 0); place(second, 200); place(third, 400);
    const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    // The grip on its tools and a grab bar along its top edge are drag handles of its own, in the
    // page (not HTML drag and drop, whose drops land in the frames that cover the tiles).
    const bar = first.querySelector<HTMLElement>(".board-move")!;
    expect(bar).not.toBeNull();
    expect(first.querySelector<HTMLElement>(".board-grip")!.draggable).toBe(false);
    bar.dispatchEvent(pointer("pointerdown", 75, 5));
    expect(document.body.classList.contains("pin-resizing")).toBe(true);
    // A small wobble is a click, not a move.
    window.dispatchEvent(pointer("pointermove", 77, 6));
    expect(first.classList.contains("moving")).toBe(false);
    // It follows the pointer…
    window.dispatchEvent(pointer("pointermove", 175, 45));
    expect(first.classList.contains("moving")).toBe(true);
    expect(first.style.transform).toBe("translate(100px, 40px)");
    // …the others staying put, a line showing where it will go (past P3's middle: after it)…
    window.dispatchEvent(pointer("pointermove", 480, 45));
    expect(cards().map((c) => c.dataset.id)).toEqual(["P1", "P2", "P3"]);
    expect(document.querySelector(".board-drop-line")).not.toBeNull();
    expect(sent).toEqual([]);
    // …and letting go puts it there.
    window.dispatchEvent(pointer("pointerup", 480, 45));
    expect(cards().map((c) => c.dataset.id)).toEqual(["P2", "P3", "P1"]);
    expect(sent).toEqual([{ type: "movePin", id: "P1", to: 2 }]);
    expect(first.classList.contains("moving")).toBe(false);
    expect(first.style.transform).toBe("");
    expect(document.body.classList.contains("pin-resizing")).toBe(false);
    // Swift agrees: the same tiles, same frames, not loaded again.
    area.update(state({ board: true, pins: [pins[1], pins[2], pins[0]] }));
    expect(cards()).toEqual([second, third, first]);
    expect(first.querySelectorAll("iframe.component-frame")[0]).toBe(frames[0]);
    // Dragged by the grip and let go where it began: nothing asked.
    sent.length = 0;
    place(second, 0); place(third, 200); place(first, 400);
    first.querySelector<HTMLElement>(".board-grip")!.dispatchEvent(pointer("pointerdown", 410, 10));
    window.dispatchEvent(pointer("pointermove", 480, 60));
    window.dispatchEvent(pointer("pointerup", 480, 60));
    expect(sent).toEqual([]);
    expect(cards().map((c) => c.dataset.id)).toEqual(["P2", "P3", "P1"]);
  });

  it("a tile dropped on a gap or another tile's left half goes before it, shown by a line while dragging", () => {
    const area = setUp();
    const pins = [pin({ id: "A", size: "1x1" }), pin({ id: "B", size: "1x1" }), pin({ id: "C", size: "1x1" })];
    area.update(state({ board: true, pins }));
    const cards = () => [...document.querySelectorAll<HTMLElement>(".board-card")];
    const ids = () => cards().map((c) => c.dataset.id);
    // Three tiles in a row, 150px wide with a 14px gap (jsdom lays nothing out).
    const place = (card: HTMLElement, left: number) => {
      card.getBoundingClientRect = () => ({ left, top: 0, right: left + 150, bottom: 150, width: 150, height: 150, x: left, y: 0, toJSON() {} }) as DOMRect;
    };
    const lay = () => cards().forEach((card, i) => place(card, i * 164));
    lay();
    const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    const drag = (id: string, path: [number, number][]) => {
      const card = cards().find((c) => c.dataset.id === id)!;
      const r = card.getBoundingClientRect();
      card.querySelector<HTMLElement>(".board-move")!.dispatchEvent(pointer("pointerdown", r.left + 75, 5));
      for (const [x, y] of path) window.dispatchEvent(pointer("pointermove", x, y));
    };
    const line = () => document.querySelector<HTMLElement>(".board-drop-line");

    // C over A, then back over B's left half (overshooting first must not matter).
    sent.length = 0;
    drag("C", [[300, 60], [100, 60], [30, 60], [100, 60], [180, 60]]);
    // The others stay put while dragging; a line shows where it will go: between A and B.
    expect(ids()).toEqual(["A", "B", "C"]);
    expect(line()).not.toBeNull();
    expect(line()!.style.left).toBe(`${150 + 7 - 2}px`);
    window.dispatchEvent(pointer("pointerup", 180, 60));
    expect(sent).toEqual([{ type: "movePin", id: "C", to: 1 }]);
    expect(ids()).toEqual(["A", "C", "B"]);
    expect(line()).toBeNull();

    // In the gap between two tiles: between them too.
    area.update(state({ board: true, pins }));
    lay();
    sent.length = 0;
    drag("C", [[200, 60], [157, 60]]);
    window.dispatchEvent(pointer("pointerup", 157, 60));
    expect(sent).toEqual([{ type: "movePin", id: "C", to: 1 }]);

    // A tile's right half: after it.
    area.update(state({ board: true, pins }));
    lay();
    sent.length = 0;
    drag("A", [[250, 60], [290, 60]]);
    window.dispatchEvent(pointer("pointerup", 290, 60));
    expect(sent).toEqual([{ type: "movePin", id: "A", to: 1 }]);

    // The first tile's left half: first.
    area.update(state({ board: true, pins }));
    lay();
    sent.length = 0;
    drag("C", [[200, 60], [20, 60]]);
    expect(line()!.style.left).toBe(`${0 - 7 - 2}px`);
    window.dispatchEvent(pointer("pointerup", 20, 60));
    expect(sent).toEqual([{ type: "movePin", id: "C", to: 0 }]);
    expect(ids()).toEqual(["C", "A", "B"]);
  });

  it("a tile's right and bottom edges resize it too, one way each", () => {
    const area = setUp();
    area.update(state({ board: true, pins: [pin({ size: "2x2" })] }));
    sent.length = 0;
    const card = document.querySelector<HTMLElement>(".board-card")!;
    const pointer = (type: string, x: number, y: number) => new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
    const right = card.querySelector<HTMLElement>(".board-resize-e")!;
    const bottom = card.querySelector<HTMLElement>(".board-resize-s")!;
    expect([right, bottom].every(Boolean)).toBe(true);
    right.dispatchEvent(pointer("pointerdown", 0, 0));
    window.dispatchEvent(pointer("pointermove", 164, 400));
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 3", "span 2"]);
    window.dispatchEvent(pointer("pointerup", 164, 400));
    expect(sent).toEqual([{ type: "resizePin", id: "P1", size: "3x2" }]);
    area.update(state({ board: true, pins: [pin({ size: "3x2" })] }));
    sent.length = 0;
    bottom.dispatchEvent(pointer("pointerdown", 0, 0));
    window.dispatchEvent(pointer("pointermove", -400, -164));
    expect([card.style.gridColumn, card.style.gridRow]).toEqual(["span 3", "span 1"]);
    window.dispatchEvent(pointer("pointerup", -400, -164));
    expect(sent).toEqual([{ type: "resizePin", id: "P1", size: "3x1" }]);
  });

  it("a component in the chat is drawn at the widest size it has, 2×2 when it names none", () => {
    const at = (info: ComponentInfo) => componentElement("x", info, "{}", null)!.querySelector<HTMLIFrameElement>("iframe")!.srcdoc;
    const info = components.提交紀錄;
    // No Sizes: line: its one layout, 2×2.
    expect(at(info)).toContain('data-size="2x2" data-surface="chat"');
    expect(at({ ...info, sizes: ["1x1", "4x2", "2x2"] })).toContain('<html data-size="4x2" data-surface="chat">');
    expect(at({ ...info, sizes: ["1x1", "4x2", "2x2"] })).toContain('{"w":4,"h":2,"name":"xlarge"}');
    // The widest first; of two as wide, the taller.
    expect(chatSize({ ...info, sizes: ["1x1", "2x2", "1x2"] })).toBe("2x2");
    expect(chatSize({ ...info, sizes: ["2x2", "2x1"] })).toBe("2x2");
    expect(chatSize({ ...info, sizes: ["1x1", "2x1", "1x2"] })).toBe("2x1");
    expect(chatSize({ ...info, sizes: ["1x1", "1x2"] })).toBe("1x2");
  });

  it("an empty Board offers to add a component", () => {
    const area = setUp();
    area.update(state({ board: true, pinChoices: [{ name: "天氣卡片", command: null, uses: 1, pinned: false }] }));
    click(document.querySelector(".board-add"));
    expect(document.querySelector(".pin-picker")).not.toBeNull();
  });
});

describe("a bot-filled component made live on the Board", () => {
  it("the component made from a reply can be pinned, and says so once pinned", () => {
    setUp().update(state());
    const built = { id: "S1", name: "天氣卡片", status: "done" as const, suggested: false, open: false, component: "天氣卡片", display: { name: "天氣卡片", data: '{"t":21}', at: null } };
    const row = messageElement({ ...message([]), specs: [built] }, components);
    document.body.append(row);
    click(row.querySelector(".spec-built [aria-label='Pin to this bot']"));
    const dialog = document.querySelector(".pin-dialog")!;
    click(dialog.querySelector(".primary"));
    expect(sent[0]).toMatchObject({ type: "pin", spec: "S1", refresh: "manual" });
    expect((sent[0] as { messageID?: string }).messageID).toBeUndefined();
    // Pinned: a badge instead.
    setUp().update(state({ pins: [pin({ name: "天氣卡片", display: { name: "天氣卡片", data: "{}" } })] }));
    const again = messageElement({ ...message([]), specs: [built] }, components);
    expect(again.querySelector(".spec-built .pin-badge")?.textContent).toContain("Pinned");
  });

  it("a pin waiting for its command says it is being made live", () => {
    const waiting = pin({ name: "天氣卡片", refresh: "manual", makingLive: true, display: { name: "天氣卡片", data: "{}" } });
    setUp().update(state({ board: true, pins: [waiting] }));
    expect(document.querySelector(".board-card .pin-live-note")?.textContent).toContain("Making it live");
    setUp().update(state({ board: true, pins: [pin({ name: "天氣卡片", display: { name: "天氣卡片", data: "{}" } })] }));
    expect(document.querySelector(".pin-live-note")).toBeNull();
  });
});

describe("a pin's refresh interval", () => {
  const menu = (overrides: Partial<PinView> = {}) => {
    setUp().update(state({ board: true, pins: [pin(overrides)] }));
    sent.length = 0;
    click(document.querySelector(".board-card [aria-label='More']"));
    return [...document.querySelectorAll<HTMLButtonElement>(".pin-menu > button")];
  };
  const enter = (target: Element) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

  it("reads a typed number in sec or min, from 2 sec to 24 h", () => {
    expect(parseInterval("30", "sec")).toEqual({ interval: { seconds: 30 } });
    expect(parseInterval(" 2 ", "min")).toEqual({ interval: { minutes: 2 } });
    expect(parseInterval("2", "sec")).toEqual({ interval: { seconds: 2 } });
    expect(parseInterval("86400", "sec")).toEqual({ interval: { seconds: 86400 } });
    expect(parseInterval("1440", "min")).toEqual({ interval: { minutes: 1440 } });
    expect(parseInterval("1", "sec")).toEqual({ error: "At least 2 sec" });
    expect(parseInterval("0", "min")).toEqual({ error: "At least 2 sec" });
    expect(parseInterval("86401", "sec")).toEqual({ error: "At most 24 h (1440 min)" });
    expect(parseInterval("1441", "min")).toEqual({ error: "At most 24 h (1440 min)" });
    for (const bad of ["", "abc", "1.5", "-3", "5s"]) expect(parseInterval(bad, "sec")).toEqual({ error: "Type a whole number" });
  });

  it("says the chosen value", () => {
    expect(refreshWords("interval", 15, 30)).toBe("Every 30 sec");
    expect(refreshWords("interval", 2)).toBe("Every 2 min");
    expect(refreshWords("interval", 2, null)).toBe("Every 2 min");
    expect(refreshWords("shown", 2, 30)).toBe("When shown");
    expect(refreshWords("manual", 2)).toBe("Only on ↻");
  });

  const rows = () => [...document.querySelectorAll<HTMLElement>(".pin-menu .refresh-interval")];
  const fields = (row: HTMLElement) => ({
    count: row.querySelector<HTMLInputElement>(".refresh-interval-count")!,
    unit: row.querySelector<HTMLSelectElement>(".refresh-interval-unit")!,
    pick: row.querySelector<HTMLButtonElement>(".refresh-interval-pick")!,
    error: row.querySelector<HTMLElement>(".refresh-interval-error")!,
  });
  const words = () => [...document.querySelectorAll<HTMLElement>(".pin-menu > button, .pin-menu .refresh-interval-pick")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  const ticked = () => [...document.querySelectorAll<HTMLElement>(".pin-menu > button.checked, .pin-menu .refresh-interval.checked .refresh-interval-pick")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  const type = (field: HTMLInputElement | HTMLSelectElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input"));
  };

  it("has no extra entry: the two interval rows show the pin's own interval in its unit, checked", () => {
    menu();
    expect(words().slice(0, 4)).toEqual(["When shown", "Every 15 min", "Every 5 sec", "Only on ↻"]);
    expect(ticked()).toEqual(["When shown"]);
    expect(document.body.textContent).not.toContain("Custom");
    menu({ refresh: "interval", minutes: 15 });
    expect(ticked()).toEqual(["Every 15 min"]);
    menu({ refresh: "interval", minutes: 15, seconds: 30 });
    expect(words().slice(0, 4)).toEqual(["When shown", "Every 15 min", "Every 30 sec", "Only on ↻"]);
    expect(ticked()).toEqual(["Every 30 sec"]);
    expect(fields(rows()[1]).count.value).toBe("30");
    expect(fields(rows()[1]).unit.value).toBe("sec");
    menu({ refresh: "interval", minutes: 2 });
    expect(words().slice(0, 4)).toEqual(["When shown", "Every 2 min", "Every 5 sec", "Only on ↻"]);
    expect(ticked()).toEqual(["Every 2 min"]);
    expect(fields(rows()[0]).unit.value).toBe("min");
    // A seconds value kept from before is not shown while the pin refreshes when shown.
    menu({ refresh: "shown", minutes: 15, seconds: 30 });
    expect(words().slice(0, 4)).toEqual(["When shown", "Every 15 min", "Every 5 sec", "Only on ↻"]);
  });

  it("clicking a row's words picks it as it stands", () => {
    menu();
    click(fields(rows()[1]).pick);
    expect(sent).toEqual([{ type: "setPinRefresh", id: "P1", refresh: "interval", seconds: 5 }]);
    expect(document.querySelector(".pin-menu")).toBeNull();
    menu({ refresh: "interval", minutes: 2 });
    click(rows()[0]);
    expect(sent).toEqual([{ type: "setPinRefresh", id: "P1", refresh: "interval", minutes: 2 }]);
    // Clicking into a field edits it and picks nothing.
    menu();
    click(fields(rows()[0]).count);
    expect(sent).toEqual([]);
    expect(document.querySelector(".pin-menu")).not.toBeNull();
  });

  it("Return in a row's number or unit sets it and closes the menu", () => {
    menu();
    const { count } = fields(rows()[1]);
    type(count, "45");
    enter(count);
    expect(sent).toEqual([{ type: "setPinRefresh", id: "P1", refresh: "interval", seconds: 45 }]);
    expect(document.querySelector(".pin-menu")).toBeNull();
    menu();
    const minutes = fields(rows()[0]);
    type(minutes.count, "90");
    type(minutes.unit, "sec");
    expect(minutes.pick.getAttribute("aria-label")).toBe("Every 90 sec");
    enter(minutes.unit);
    expect(sent).toEqual([{ type: "setPinRefresh", id: "P1", refresh: "interval", seconds: 90 }]);
  });

  it("leaving a row after an edit applies it and checks the row; the menu stays open", () => {
    menu();
    const { count } = fields(rows()[0]);
    count.focus();
    type(count, "2");
    count.blur();
    expect(sent).toEqual([{ type: "setPinRefresh", id: "P1", refresh: "interval", minutes: 2 }]);
    expect(document.querySelector(".pin-menu")).not.toBeNull();
    expect(ticked()).toEqual(["Every 2 min"]);
    // Leaving it again without an edit sends nothing more.
    count.focus();
    count.blur();
    expect(sent).toHaveLength(1);
  });

  it("an edit is dropped by Escape or by choosing another entry", () => {
    menu();
    const { count } = fields(rows()[0]);
    count.focus();
    type(count, "3");
    count.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(document.querySelector(".pin-menu")).toBeNull();
    expect(sent).toEqual([]);
    menu();
    const again = fields(rows()[0]).count;
    again.focus();
    type(again, "3");
    const manual = [...document.querySelectorAll<HTMLButtonElement>(".pin-menu > button")].find((b) => b.textContent === "Only on ↻")!;
    manual.focus();
    manual.click();
    expect(sent).toEqual([{ type: "setPinRefresh", id: "P1", refresh: "manual", minutes: 15 }]);
  });

  it("rejects what is not an interval inline, and keeps the menu open", () => {
    menu();
    const { count, unit, error } = fields(rows()[1]);
    expect(error.hidden).toBe(true);
    for (const [value, inUnit, says] of [["1", "sec", "At least 2 sec"], ["1441", "min", "At most 24 h (1440 min)"], ["abc", "sec", "Type a whole number"]]) {
      type(count, value);
      type(unit, inUnit);
      enter(count);
      expect(error.hidden).toBe(false);
      expect(error.textContent).toBe(says);
      expect(count.getAttribute("aria-invalid")).toBe("true");
    }
    // Leaving the field with it wrong says so too.
    count.focus();
    count.blur();
    expect(sent).toEqual([]);
    expect(document.querySelector(".pin-menu")).not.toBeNull();
    expect(ticked()).toEqual(["When shown"]);
    // Fixing it clears the line as you type.
    type(count, "10");
    expect(error.hidden).toBe(true);
  });

  it("an input method's Return (picking a candidate) never sets it", () => {
    menu();
    const { count } = fields(rows()[1]);
    type(count, "20");
    count.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    expect(sent).toEqual([]);
  });

  it("the pin dialog takes the same intervals, and says what is wrong instead of pinning", () => {
    setUp().update(state());
    const row = messageElement(message([{ name: "提交紀錄", data: "[]", command: "git log -5", folder: "/p", status: "done", pinned: false }]), components);
    document.body.append(row);
    click(row.querySelector("[aria-label='Pin to this bot']"));
    const dialog = document.querySelector(".pin-dialog")!;
    dialog.querySelector<HTMLInputElement>("input[value='interval']")!.checked = true;
    const count = dialog.querySelector<HTMLInputElement>(".pin-minutes")!;
    dialog.querySelector<HTMLSelectElement>(".pin-unit")!.value = "sec";
    count.value = "1";
    click(dialog.querySelector(".primary"));
    expect(sent).toEqual([]);
    expect(dialog.querySelector<HTMLElement>(".refresh-interval-error")?.hidden).toBe(false);
    expect(dialog.querySelector(".refresh-interval-error")?.textContent).toBe("At least 2 sec");
    count.value = "30";
    enter(count);
    expect(sent[0]).toMatchObject({ type: "pin", refresh: "interval", minutes: 15, seconds: 30 });
    expect(document.querySelector(".pin-dialog")).toBeNull();
  });
});
