// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { feedback, messageElement, messageMenu } from "../../../../Web/src/messages";
import { studioSeam } from "../../../../Web/src/plugins";
import { PinArea } from "../src/pins";
import { installBoard, pageCss, sent } from "./support";
import { parseInterval, refreshWords } from "../../../../Web/src/refresh";
import { chatSize, componentElement } from "../../../../Web/src/components";
import type { ComponentInfo, DisplayView, MessageView, PinSize } from "../../../../Web/src/types";
import type { PinView, BoardState } from "../src/types";

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

function state(overrides: Partial<BoardState> = {}): BoardState {
  return {
    botID: "b1", botName: "ClaudeCodeBot", messages: [], working: false, avatar: "", placeholder: "",
    replyingTo: null, pendingFiles: [], components, pins: [], pinChoices: [], ...overrides,
  };
}

function setUp(): PinArea {
  document.body.innerHTML = `<main id="scroller"></main><div id="pin-area"></div><div id="composer-slot"></div>`;
  return new PinArea(document.getElementById("pin-area")!);
}

const click = (element: Element | null | undefined) => (element as HTMLElement).click();

beforeEach(() => {
  installBoard();
  sent.length = 0;
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("pinning from the chat", () => {
  it("a component you can pin shows pin, refresh and more on hover", () => {
    setUp().update(state());
    const row = messageElement(message([{ name: "提交紀錄", data: "[]", command: "git log", folder: "/p", status: "done" }]), components);
    const bar = row.querySelector(".pin-bar")!;
    expect(bar.querySelector("[aria-label='Pin to this bot']")).not.toBeNull();
    expect(bar.querySelector("[aria-label='Run the command again']")).not.toBeNull();
    expect(bar.querySelector("[aria-label='More']")).not.toBeNull();
    click(bar.querySelector("[aria-label='Run the command again']"));
    expect(sent).toEqual([{ type: "componentCommand", messageID: "m1", index: 0, command: "git log", folder: "/p", force: true }]);
  });

  it("no bar where nothing can be pinned, and a badge once pinned", () => {
    // Where the page has no pins for the chat (a subagent's, or none told yet) nothing can be pinned.
    setUp().update(state({ pins: null }));
    expect(messageElement(message([{ name: "提交紀錄", data: "[]" }]), components).querySelector(".pin-bar")).toBeNull();
    setUp().update(state({ pins: [pin({ id: "P9", name: "天氣卡片", display: { name: "天氣卡片", data: "{}" } })] }));
    const row = messageElement(message([{ name: "天氣卡片", data: "{}" }]), components);
    expect(row.querySelector(".pin-badge")?.textContent).toContain("Pinned");
    // A component without a command has nothing to run again.
    expect(row.querySelector("[aria-label='Run the command again']")).toBeNull();
  });

  it("pin asks how to refresh, shows the command, then offers Undo", () => {
    setUp().update(state());
    const row = messageElement(message([{ name: "提交紀錄", data: "[]", command: "git log -5", folder: "/p", status: "done" }]), components);
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
    const row = messageElement(message([{ name: "天氣卡片", data: "{}" }]), components);
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
    const css = pageCss();
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
      expect([...document.querySelectorAll(".pin-menu button")].some((b) => b.textContent === "Report a problem…")).toBe(true);
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

  it("a pinned command not allowed yet asks the app to run it, with the command it showed (the app's sheet allows)", () => {
    const area = setUp();
    area.update(state({ pins: [pin({ headline: "Needs your OK", display: { name: "提交紀錄", data: "null", command: "git log", folder: "/p", status: "approve" } })] }));
    click(document.querySelector(".pin-chip"));
    click(document.querySelector(".pin-sheet .command-allow"));
    expect(sent.at(-1)).toEqual({ type: "pinCommand", id: "P1", command: "git log", folder: "/p" });
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
    const css = pageCss();
    const rule = css.match(/\.pin-chip \{[^}]*\}/)?.[0] ?? "";
    const px = (name: string) => Number(rule.match(new RegExp(`${name}: (\\d+)px`))?.[1]);
    expect(px("max-width")).toBeLessThanOrEqual(140);
    // One segmented strip: the chips share its border and its height, the controls' 32px.
    expect(rule).toContain("height: calc(var(--control-h) - 2px)");
    expect(Number(css.match(/--control-h: (\d+)px/)?.[1])).toBe(32);
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

});

describe("a bot-filled component made live when pinned", () => {
  it("the component made from a reply can be pinned, and says so once pinned", () => {
    setUp().update(state());
    const built = { id: "S1", name: "天氣卡片", status: "done" as const, suggested: false, open: false, component: "天氣卡片", display: { name: "天氣卡片", data: '{"t":21}', at: null } };
    // The head of the component the studio draws under its reply (botling.component-studio) asks the studio seam's spec buttons for theirs.
    const headOf = () => {
      const head = document.createElement("div");
      for (const { make } of studioSeam.specButtons) { const added = make(built); if (added) head.append(added); }
      document.body.append(head);
      return head;
    };
    const row = headOf();
    click(row.querySelector("[aria-label='Pin to this bot']"));
    const dialog = document.querySelector(".pin-dialog")!;
    click(dialog.querySelector(".primary"));
    expect(sent[0]).toMatchObject({ type: "pin", spec: "S1", refresh: "manual" });
    expect((sent[0] as { messageID?: string }).messageID).toBeUndefined();
    // Pinned: a badge instead.
    setUp().update(state({ pins: [pin({ name: "天氣卡片", display: { name: "天氣卡片", data: "{}" } })] }));
    expect(headOf().querySelector(".pin-badge")?.textContent).toContain("Pinned");
  });

  it("a pin waiting for its command says it is being made live", () => {
    const waiting = pin({ name: "天氣卡片", refresh: "manual", makingLive: true, display: { name: "天氣卡片", data: "{}" } });
    setUp().update(state({ pins: [waiting] }));
    click(document.querySelector(".pin-chip[data-id]"));
    expect(document.querySelector(".pin-sheet .pin-live-note")?.textContent).toContain("Making it live");
    setUp().update(state({ pins: [pin({ name: "天氣卡片", display: { name: "天氣卡片", data: "{}" } })] }));
    expect(document.querySelector(".pin-live-note")).toBeNull();
  });
});

describe("a pin's refresh interval", () => {
  const menu = (overrides: Partial<PinView> = {}) => {
    setUp().update(state({ pins: [pin(overrides)] }));
    click(document.querySelector(".pin-chip[data-id]"));
    sent.length = 0;
    click(document.querySelector(".pin-sheet [aria-label='More']"));
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
    const row = messageElement(message([{ name: "提交紀錄", data: "[]", command: "git log -5", folder: "/p", status: "done" }]), components);
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

describe("a reply that shows a pinnable component, on hover", () => {
  const px = (value: string) => parseFloat(value) || 0;
  // Hidden by the stylesheet (it or a box around it has display: none).
  const shown = (element: Element) => {
    for (let at: Element | null = element; at; at = at.parentElement) {
      if (getComputedStyle(at).display === "none") return false;
    }
    return true;
  };

  it("has one flag, and the reply's toolbar sits beside the card's bar, not over it", () => {
    const style = document.createElement("style");
    style.textContent = pageCss();
    document.head.append(style);
    try {
      setUp().update(state());
      for (const [developer, making] of [[false, false], [true, false], [false, true], [true, true]]) {
        feedback.enabled = developer;
        messageMenu.items = making ? [{ command: "studio.make", title: "Make into component", icon: "cube", quick: true }] : [];
        const row = messageElement({ ...message([{ name: "天氣卡片", data: "{}" }]), text: "" }, components);
        document.getElementById("scroller")!.append(row);
        expect(row.classList.contains("wide")).toBe(true);

        // One flag for the reply: the card's own report is in its ⋯ menu, not a second flag over it.
        const flags = [...row.querySelectorAll(".flag, .feedback-button")].filter(shown);
        expect(flags).toHaveLength(developer ? 1 : 0);

        // The reply's toolbar floats over the row's top-right corner; the card's bar (pin / ⋯) over
        // the card's top-right corner, inside the bubble's padding. Measured from the row's right
        // edge, the card's bar must start left of where the toolbar ends.
        const actions = row.querySelector<HTMLElement>(":scope > .message-actions, :scope > .reply-button")!;
        const a = getComputedStyle(actions);
        const buttons = actions.matches(".message-actions") ? [...actions.querySelectorAll<HTMLElement>(".reply-button")] : [actions];
        const toolbarWidth = buttons.reduce((sum, b) => sum + px(getComputedStyle(b).width), 0)
          + (buttons.length - 1) * px(a.columnGap || a.gap)
          + px(a.paddingLeft) + px(a.paddingRight) + px(a.borderLeftWidth) + px(a.borderRightWidth);
        const toolbarLeft = px(a.right) + toolbarWidth;
        const bubble = row.querySelector<HTMLElement>(".bot-bubble")!;
        const bar = row.querySelector<HTMLElement>(".pin-bar")!;
        const barRight = px(getComputedStyle(bubble).paddingRight) + px(getComputedStyle(bar).right);
        expect(barRight).toBeGreaterThanOrEqual(toolbarLeft + 4);
        row.remove();
      }

      // Report is still there, in the card's ⋯ menu, and opens the report box.
      feedback.enabled = true;
      const row = messageElement(message([{ name: "天氣卡片", data: "{}" }]), components);
      document.getElementById("scroller")!.append(row);
      click(row.querySelector(".pin-bar [aria-label='More']"));
      const report = [...document.querySelectorAll<HTMLButtonElement>(".pin-menu button")].find((b) => b.textContent === "Report a problem…");
      click(report);
      expect(document.querySelector(".report")).not.toBeNull();
      // The card's frame says its name to VoiceOver without a hover tooltip poking out of the reply.
      const frame = row.querySelector<HTMLIFrameElement>(".component-frame")!;
      expect(frame.getAttribute("title")).toBeNull();
      expect(frame.getAttribute("aria-label")).toBe("天氣卡片");
    } finally {
      feedback.enabled = false;
      messageMenu.items = [];
      style.remove();
    }
  });
});
