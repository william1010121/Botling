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

  it("an opened pin's top edge drags it taller or shorter; then its component fills that height", () => {
    const area = setUp();
    area.update(state({ pins: [pin()] }));
    click(document.querySelector(".pin-chip"));
    sent.length = 0;
    const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
    const frame = sheet.querySelector<HTMLIFrameElement>(".component-frame")!;
    // As tall as its content at first: no height of its own, the page not told to fill.
    expect(sheet.style.height).toBe("");
    expect(frame.srcdoc).not.toContain('data-surface="pinned" data-fill');
    Object.defineProperty(sheet, "offsetHeight", { configurable: true, value: 300 });
    const pointer = (type: string, y: number) => new PointerEvent(type, { clientX: 0, clientY: y, button: 0, bubbles: true });
    sheet.querySelector<HTMLElement>(".pin-sheet-resize")!.dispatchEvent(pointer("pointerdown", 500));
    // It rises from the input box: up is taller.
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
    // Swift keeps it: the panel is that tall and the component is drawn to fill it.
    area.update(state({ pins: [pin({ panelHeight: 420 })] }));
    expect(sheet.style.height).toBe("420px");
    const filled = sheet.querySelector<HTMLIFrameElement>(".component-frame")!;
    expect(filled.srcdoc).toContain('<html data-size="2x2" data-surface="pinned" data-fill>');
    // Another height keeps the same frame (it hears the new size itself).
    area.update(state({ pins: [pin({ panelHeight: 360 })] }));
    expect(sheet.style.height).toBe("360px");
    expect(sheet.querySelector(".component-frame")).toBe(filled);
    // A double-click gives it back its content's height.
    sheet.querySelector<HTMLElement>(".pin-sheet-resize")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(sent.at(-1)).toEqual({ type: "setPinHeight", id: "P1", height: null });
    area.update(state({ pins: [pin({ panelHeight: null })] }));
    expect(sheet.style.height).toBe("");
    expect(sheet.classList.contains("sized")).toBe(false);
  });

  it("an opened pin is its component, like a Board tile: no header, controls float over it on hover", () => {
    const css = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const area = setUp();
      area.update(state({ pins: [pin()] }));
      click(document.querySelector(".pin-chip"));
      const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
      // No header row (title, command, when it ran): the body, then the floating tools.
      expect(sheet.querySelector(".pin-sheet-head, .pin-sheet-title, .pin-command, .pin-when")).toBeNull();
      expect([...sheet.children].map((child) => child.className)).toEqual(["pin-sheet-resize resize-handle", "pin-sheet-body", "pin-sheet-tools"]);
      // The component's frame fills the panel with no padding around it, and draws no frame of its own.
      const body = sheet.querySelector<HTMLElement>(".pin-sheet-body")!;
      expect(getComputedStyle(body).padding).toMatch(/^(0px|)$/);
      const frame = sheet.querySelector<HTMLIFrameElement>(".component-frame")!;
      expect(frame.srcdoc).toContain('data-surface="pinned"');
      expect(frame.srcdoc).toContain('surface: "pinned"');
      // The tools are hidden until hovered or focused: refresh, more and collapse.
      const tools = sheet.querySelector<HTMLElement>(".pin-sheet-tools")!;
      expect(getComputedStyle(tools).position).toBe("absolute");
      expect(getComputedStyle(tools).opacity).toBe("0");
      expect(css).toMatch(/\.pin-sheet:hover > \.pin-sheet-tools, \.pin-sheet\.hovered > \.pin-sheet-tools, \.pin-sheet-tools:focus-within/);
      expect([...tools.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Refresh (Updated 10:42)", "More", "Collapse"]);
      // The pointer over the component (inside its frame) shows them too.
      window.dispatchEvent(new MessageEvent("message", { data: { ccb: "hover", on: true }, source: frame.contentWindow }));
      expect(sheet.classList.contains("hovered")).toBe(true);
      window.dispatchEvent(new MessageEvent("message", { data: { ccb: "hover", on: false }, source: frame.contentWindow }));
      expect(sheet.classList.contains("hovered")).toBe(false);
      // Its name, when it ran and its command are in the more menu.
      click(tools.querySelector("[aria-label='More']"));
      expect(document.querySelector(".pin-menu-heading")?.textContent).toBe("提交紀錄");
      expect([...document.querySelectorAll(".pin-menu-note")].map((n) => n.textContent)).toEqual(["Updated 10:42", "$ python3 git-log-json.py 20"]);
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // Collapse puts it away.
      click(tools.querySelector("[aria-label='Collapse']"));
      expect(sheet.hidden).toBe(true);
    } finally {
      style.remove();
    }
  });

  it("an opened pin's controls never cover its content: the pill sits above the panel, the flag is in ⋯", () => {
    const css = readFileSync(resolve(__dirname, "../src/chat.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    try {
      const area = setUp();
      area.update(state({ pins: [pin()] }));
      click(document.querySelector(".pin-chip"));
      const sheet = document.querySelector<HTMLElement>(".pin-sheet")!;
      const tools = sheet.querySelector<HTMLElement>(".pin-sheet-tools")!;
      // The pill floats just above the panel's top-right corner, outside the component (it covered
      // the first row's right-aligned time), with a bridge so the pointer can reach it.
      const look = getComputedStyle(tools);
      expect(look.top).toMatch(/^(auto|)$/);
      expect(look.bottom).toBe("calc(100% + 6px)");
      expect(css).toMatch(/\.pin-sheet-tools::after \{[^}]*top: 100%/);
      // So the panel does not clip it: the body clips the component to the rounded corners
      // instead (clip-path too, as WebKit does not clip a frame to a radius with overflow alone).
      expect(getComputedStyle(sheet).overflow).toBe("visible");
      const body = sheet.querySelector<HTMLElement>(".pin-sheet-body")!;
      expect(getComputedStyle(body).borderRadius).toBe("19px");
      expect(css).toMatch(/\.pin-sheet-body \{[^}]*clip-path: inset\(0 round 19px\)/);
      // No report flag over the bottom-right corner (it covered the last row's time)...
      expect(getComputedStyle(sheet.querySelector<HTMLElement>(".component-side")!).display).toBe("none");
      // ...it is in the ⋯ menu instead.
      click(tools.querySelector("[aria-label='More']"));
      const report = [...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")].find((b) => b.textContent === "Report this component…")!;
      expect(report).toBeDefined();
      report.click();
      expect(document.querySelector(".report")).not.toBeNull();
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
    // …and over another tile takes its place at once, the others making room.
    window.dispatchEvent(pointer("pointermove", 475, 45));
    expect(cards().map((c) => c.dataset.id)).toEqual(["P2", "P3", "P1"]);
    expect(sent).toEqual([]);
    window.dispatchEvent(pointer("pointerup", 475, 45));
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
