/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { sent } from "../src/bridge";
import { messageElement } from "../src/messages";
import { PinArea } from "../src/pins";
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
    id: "P1", name: "提交紀錄", headline: "f472a1c · Merge bot/sidebar-a · 20", size: "2x2", refresh: "shown", minutes: 15,
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
    expect(chips[0].textContent).toContain("提交紀錄");
    expect(chips[0].textContent).toContain("f472a1c");
    chips[0].click();
    const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
    expect(sheet.hidden).toBe(false);
    expect(sheet.querySelector(".pin-sheet-title")?.textContent).toBe("提交紀錄");
    expect(sheet.querySelector("iframe.component-frame")).not.toBeNull();
    expect(sent).toEqual([{ type: "pinShown", ids: ["P1"] }]);
    // ↻ on the sheet runs it again.
    click(sheet.querySelector("[aria-label='Refresh']"));
    expect(sent[1]).toEqual({ type: "pinCommand", id: "P1", command: "python3 git-log-json.py 20", folder: "/p", force: true });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(sheet.hidden).toBe(true);
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
    // Only the sizes the component has a layout for (its about.md's Sizes: line)...
    const sizesIn = (items: HTMLButtonElement[]) => items.filter((b) => /×/.test(b.textContent ?? "")).map((b) => b.textContent);
    expect(sizesIn(menuOf(0))).toEqual(["Small 1×1", "Wide 2×1", "Large 2×2"]);
    menuOf(0).find((b) => b.textContent === "Wide 2×1")!.click();
    expect(sent.at(-1)).toEqual({ type: "resizePin", id: "P1", size: "2x1" });
    // ...2×2 alone when it names none, and the size a card has now even if it is not one of them.
    expect(sizesIn(menuOf(1))).toEqual(["Large 2×2", "Extra wide 4×2"]);
    // The size button on the card offers the same.
    click(document.querySelectorAll(".board-card")[0].querySelector(".board-size"));
    expect([...document.querySelectorAll(".pin-menu button")].map((b) => b.textContent)).toEqual(["Small 1×1", "Wide 2×1", "Large 2×2"]);
    expect(document.querySelector(".pin-menu button.checked")?.textContent).toBe("Large 2×2");
    menuOf(1).find((b) => b.textContent === "Move earlier")!.click();
    expect(sent.at(-1)).toEqual({ type: "movePin", id: "P2", to: 0 });
    menuOf(0).find((b) => b.textContent === "Every 15 min")!.click();
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
      // The header gives way by shortening the name, not by squeezing the command to one letter.
      const title = document.querySelector<HTMLElement>(".board-card-title")!;
      expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(document.querySelector<HTMLElement>(".board-card-head .pin-command")!).minWidth).not.toMatch(/^(0|0px|auto)$/);
    } finally {
      style.remove();
    }
  });

  it("a card gives its component the whole width, and a narrow header drops what it can", () => {
    const css = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const area = setUp();
      area.update(state({ board: true, pins: [pin()] }));
      // The report flag sits over the corner instead of keeping a strip beside the component.
      const side = document.querySelector<HTMLElement>(".board-card-body .component-side")!;
      expect(getComputedStyle(side).position).toBe("absolute");
      // A narrow card drops the command, then the time, then the size button from its header.
      expect(getComputedStyle(document.querySelector<HTMLElement>(".board-card")!).getPropertyValue("container-type")).toBe("inline-size");
      expect(css).toMatch(/@container \(max-width: 439px\) \{ \.board-card-head \.pin-command \{ display: none; \} \}/);
      expect(css).toMatch(/@container \(max-width: 299px\) \{ \.board-card-head \.pin-when \{ display: none; \} \}/);
      expect(css).toMatch(/@container \(max-width: 199px\) \{ \.board-card-head \.board-size \{ display: none; \}/);
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
      // Until measured: columns of at least 150px, rows 160px tall, gaps filled densely.
      const look = getComputedStyle(grid());
      expect(look.gridTemplateColumns).toBe("repeat(var(--board-cols, auto-fill), minmax(min(150px, 100%), 1fr))");
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
    expect(frame.srcdoc).toContain('<html data-size="2x2">');
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

  it("a component in the chat is drawn 2×2, or the largest size it has", () => {
    const at = (info: ComponentInfo) => componentElement("x", info, "{}", null)!.querySelector<HTMLIFrameElement>("iframe")!.srcdoc;
    const info = components.提交紀錄;
    expect(at(info)).toContain('data-size="2x2"');
    expect(at({ ...info, sizes: ["1x1", "2x1", "1x2"] })).toContain('data-size="2x1"');
    expect(chatSize({ ...info, sizes: ["1x1", "4x2", "2x2"] })).toBe("2x2");
  });

  it("an empty Board offers to add a component", () => {
    const area = setUp();
    area.update(state({ board: true, pinChoices: [{ name: "天氣卡片", command: null, uses: 1, pinned: false }] }));
    click(document.querySelector(".board-add"));
    expect(document.querySelector(".pin-picker")).not.toBeNull();
  });
});
