// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshDueCards } from "../../../../Web/src/components";
import { messageElement } from "../../../../Web/src/messages";
import { FloatLayer } from "../src/float";
import { PinArea } from "../src/pins";
import { installBoard, sent } from "./support";
import { setWindowVisible } from "../../../../Web/src/visible";
import { reportVisiblePins, visiblePinIDs } from "../src/visible";
import type { ComponentInfo, DisplayView, MessageView } from "../../../../Web/src/types";
import type { PinView, BoardState } from "../src/types";

// One rule for every card that refreshes by itself: it reruns only while the user can see it,
// in a window that is shown (Swift says so: not minimized, hidden or covered), scrolled into view.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const components: Record<string, ComponentInfo> = {
  cpu: { template: "<pre></pre>", version: 1, working: false, updated: false, hasPrevious: false },
};

const card = (overrides: Partial<DisplayView> = {}): DisplayView => ({
  name: "cpu", data: `{"cpu":10}`, command: "git status", folder: "/p", status: "done", ranAt: "10:42", every: 5, ...overrides,
});

function message(displays: DisplayView[]): MessageView {
  return {
    id: "m1", role: "bot", text: "", stamp: null, avatar: null,
    choices: null, chosen: null, answer: null, open: false, displays,
    attachments: null, replyTo: null, replyPreview: null, openable: false,
  };
}

function pin(overrides: Partial<PinView> = {}): PinView {
  return { id: "P1", name: "cpu", headline: "", chip: { text: "", tone: "neutral" }, size: "2x2", refresh: "interval", minutes: 15, seconds: 5, display: card({ every: null }), ...overrides };
}

function state(overrides: Partial<BoardState> = {}): BoardState {
  return { botID: "b", botName: "B", messages: [], working: false, avatar: "", placeholder: "", replyingTo: null, pendingFiles: [], components, pins: [], pinChoices: [], ...overrides } as BoardState;
}

function box(element: Element, top: number, height = 100): void {
  (element as HTMLElement).getBoundingClientRect = () => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON() {} }) as DOMRect;
}

const runs = () => sent.filter((action) => action.type === "componentCommand" || action.type === "pinCommand");

beforeEach(() => {
  installBoard();
  sent.length = 0;
  document.body.innerHTML = `<main id="scroller"></main><div id="pin-area"></div><div id="composer-slot"></div>`;
  document.body.className = "";
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  refreshDueCards();
  vi.useFakeTimers();
});

afterEach(() => {
  setWindowVisible(true);
  reportVisiblePins();
  vi.useRealTimers();
  vi.restoreAllMocks();
});


describe("a floating card that refreshes by itself", () => {
  it("does not run while the window is not shown", () => {
    const layer = new FloatLayer(document.body);
    layer.update(state({ floating: [{ botID: "b", botName: "B", pin: pin({ float: { corner: "topRight", width: 280, height: 160, collapsed: false }, floatMenu: "stop" }) }] }));
    const now = Date.now();
    layer.refreshDue(now);
    setWindowVisible(false);
    expect(layer.refreshDue(now + 60_000)).toBe(0);
    expect(runs()).toEqual([]);
    // Shown again after longer than its interval: it runs at once.
    vi.setSystemTime(now + 60_000);
    setWindowVisible(true);
    expect(runs()).toHaveLength(1);
  });
});

describe("which pins the page shows", () => {
  it("tells the app the pins the user can see, and only when that changes", () => {
    const area = new PinArea(document.getElementById("pin-area")!);
    area.update(state({ pins: [pin(), pin({ id: "P2" })] }));
    const chips = document.querySelectorAll<HTMLElement>(".pin-chip[data-id]");
    box(chips[0], 700, 30);
    // The second chip is not laid out (no box): not seen.
    expect(visiblePinIDs()).toEqual(["P1"]);
    reportVisiblePins();
    expect(sent).toContainEqual({ type: "pinsVisible", ids: ["P1"] });
    sent.length = 0;
    reportVisiblePins();
    expect(sent).toEqual([]);
    // The window hidden: none.
    setWindowVisible(false);
    reportVisiblePins(); // what activate() wires to `page.onWindowVisible` (activation.test.ts)
    expect(sent).toContainEqual({ type: "pinsVisible", ids: [] });
  });

});
